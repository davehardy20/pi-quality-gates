import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createReviewDeadline,
	type ReviewDeadline,
} from "../shared/review-deadline.js";
import { parseReviewReport } from "../shared/review-report.js";
import { hasCriticalSecurityFinding } from "../shared/review-severity.js";
import type { PassTokenStore } from "./pass-token-store.js";
import { getPassBlockingTestExecutionReason } from "./pr-review-dispatch.js";
import type { ReviewerExecution, ReviewerResult } from "./reviewer.js";
import {
	createBoundedTextCapture,
	reviewDeadlineExceeded,
} from "./reviewer.js";

interface TextContentLike {
	type?: string;
	text?: string;
}

interface ToolResultEventLike {
	toolName: string;
	input?: Record<string, unknown>;
	content?: TextContentLike[];
	isError?: boolean;
}

interface PendingReview {
	resolve: (result: ReviewerResult) => void;
	timer: ReturnType<typeof setTimeout>;
	command: string;
	/** HEAD sha for correlation; dispatch alone authorizes PASS. */
	headSha: string;
	/** Whether this pending entry has already been resolved. */
	resolved: boolean;
	cleanup: () => boolean;
}

interface KnownReview {
	headSha: string;
	deadline: ReviewDeadline;
	expired: boolean;
	signal?: AbortSignal;
}

export interface OrchestratorReviewerExecutionBridge {
	reviewerExecution: ReviewerExecution;
	handleToolResult(event: ToolResultEventLike): boolean;
	pendingCount(): number;
	/**
	 * Observable status for /pr-review status: pending request ids+heads and
	 * the last parse diagnostic (null when nothing observed yet).
	 */
	getStatus(): OrchestratorReviewerStatus;
	/** Cancel pending work, clear timers/correlation state, and release closures. */
	dispose(reason?: string): void;
}

export interface OrchestratorReviewerStatus {
	pending: ReadonlyArray<{ requestId: string; headSha: string }>;
	lastDiagnostic: OrchestratorReviewerDiagnostic | null;
}

export interface OrchestratorReviewerDiagnostic {
	/** Epoch ms when the diagnostic was recorded. */
	at: number;
	/** The request id this diagnostic is associated with, if known. */
	requestId: string | null;
	/** The HEAD sha this diagnostic is associated with, if known. */
	headSha: string | null;
	/** Last parse/lifecycle outcome. */
	kind:
		| "parsed-pass"
		| "parsed-nonpass"
		| "parse-failed"
		| "error"
		| "timeout"
		| "cancelled";
	/** Human-readable detail. */
	detail: string;
}

export interface OrchestratorReviewDeadlineAdapter {
	readonly protocol: "review-deadline-v1";
	/** Trusted runtime must register request ownership before any dispatch.
	 * Every spawn/fallback/retry must call beforeAttempt and use its remaining
	 * budget and signal. Unregistered requests must refuse, never run unbounded.
	 * cancel must synchronously revoke retries and terminate the owned child;
	 * dispose releases registration only after cancellation/completion. */
	register(request: {
		requestId: string;
		headSha: string;
		deadline: ReviewDeadline;
		signal: AbortSignal;
		beforeAttempt: () => number;
	}): { cancel: () => void; dispose: () => void };
}

export interface OrchestratorReviewerExecutionOptions {
	/** Compatibility only; the bridge never stamps. Dispatch owns authorization. */
	tokens?: PassTokenStore;
	/** Owner-injected runtime capability, never repository/user JSON. Missing or
	 * incompatible support refuses before request allocation/dispatch. */
	deadlineAdapter?: OrchestratorReviewDeadlineAdapter;
	/**
	 * Resolve the HEAD sha captured when runAttempt does not receive one.
	 * This resolver is never used to stamp an uncorrelated result.
	 */
	resolveHeadSha?: () => string;
}

function createRequestId(): string {
	return `pr-review-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const MAX_ORCHESTRATOR_RESULT_CHARS = 262_144;
const MAX_PARENT_TASK_CHARS = 2_000;
const MAX_PARENT_TEST_PLAN_CHARS = 4_000;
const MAX_PARENT_FILES = 32;
const MAX_PARENT_FILE_CHARS = 256;

function toolContentToText(content: TextContentLike[] | undefined): {
	text: string;
	overflowed: boolean;
} {
	const capture = createBoundedTextCapture(MAX_ORCHESTRATOR_RESULT_CHARS);
	for (const part of content ?? []) {
		if (part?.type === "text") capture.append(part.text ?? "");
	}
	return { text: capture.value().trim(), overflowed: capture.overflowed() };
}

function inputContainsRequestId(
	input: Record<string, unknown> | undefined,
	requestId: string,
): boolean {
	if (!input) return false;
	const task = input.task;
	return typeof task === "string" && task.includes(requestId);
}

/**
 * Extract a `PR_REVIEW_REQUEST_ID: <id>` token from reviewer output/content.
 * The parent instruction embeds this token so a child that echoes it back
 * can be correlated even when the orchestrate `input` does not contain it.
 */
function extractRequestIdFromText(text: string): string | null {
	const match = text.match(/PR_REVIEW_REQUEST_ID:\s*(pr-review-[^\s`]+)/);
	return match?.[1] ?? null;
}

function unavailableResult(reason: string): ReviewerResult {
	return {
		report: null,
		rawOutput: reason,
		exitCode: 1,
		timedOut: false,
		stderr: reason,
		command: "orchestrate agentType=verifier profile=pr-review",
	};
}

function truncateMetadata(value: string | undefined, maxChars: number): string {
	const text = (value ?? "").trim();
	if (!text) return "(not provided)";
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function renderParentInstruction(input: {
	requestId: string;
	task: string;
	files: string[];
	diff: string | undefined;
	testPlan: string | undefined;
	baseRef: string | undefined;
	headSha: string | undefined;
	respectGitignore: boolean;
	skipFile: string | null;
}): string {
	const visibleFiles = input.files.slice(0, MAX_PARENT_FILES);
	const omittedFiles = Math.max(0, input.files.length - visibleFiles.length);
	const fileLines = visibleFiles.map(
		(file) => `- ${truncateMetadata(file, MAX_PARENT_FILE_CHARS)}`,
	);
	if (omittedFiles > 0)
		fileLines.push(`- … ${omittedFiles} more file(s) omitted`);
	return [
		`Run the PR review via the orchestrator verifier bridge now. Request id: ${input.requestId}.`,
		"",
		"Call the `orchestrate` tool with agentType `verifier` and profile `pr-review` and the bounded task below.",
		"Do not review in the parent conversation. Do not use host mutation or publishing tools.",
		"The full diff is deliberately absent from this follow-up. The verifier child must inspect the repository directly.",
		"Return the verifier result normally so the PR gate can parse its `## Review Report` block.",
		"",
		`PR_REVIEW_REQUEST_ID: ${input.requestId}`,
		`HEAD: ${truncateMetadata(input.headSha, 80)}`,
		`Base ref: ${truncateMetadata(input.baseRef, 256)}`,
		`Changed file count: ${input.files.length}`,
		`Parent diff omitted: ${input.diff?.length ?? 0} chars`,
		"",
		"Review scope/task (bounded metadata):",
		truncateMetadata(input.task, MAX_PARENT_TASK_CHARS),
		"",
		"Changed files (bounded summary):",
		...(fileLines.length > 0 ? fileLines : ["(no changed files)"]),
		"",
		"Test execution plan (complete required instructions):",
		// runAttempt refuses plans that exceed the relay budget. Required
		// validation instructions must never be truncated like display metadata.
		input.testPlan || "(not provided)",
		"",
		"Reviewer instructions:",
		"- Inspect the current repository and compare the stated base ref with HEAD directly.",
		"- Treat the supplied changed-file list as the authoritative filtered review scope for every path shown; never inspect or report findings for excluded paths.",
		...(omittedFiles > 0
			? [
					"- The parent omitted some filtered paths for bounded metadata. Derive only those remaining paths from base..HEAD, then apply the same filters before inspecting content.",
				]
			: []),
		...(input.respectGitignore
			? [
					"- Apply repository `.gitignore` rules to any changed paths derived by the verifier child before inspecting file content.",
				]
			: []),
		...(input.skipFile
			? [
					`- Read and apply \`${truncateMetadata(input.skipFile, 256)}\` using gitignore semantics to any changed paths derived by the verifier child before inspecting file content.`,
				]
			: []),
		"- git_inspect_safe is optional: use it first when available; otherwise you MUST use built-in read-only Git commands against the repository.",
		"- Prefer safe validation runners. When a needed runner is unavailable, do NOT run package scripts from the reviewed checkout on the host; record that validation as NOT_RUN under Test execution.",
		"- Read only the filtered changed files and run the relevant validation. Never use host mutation or publishing commands.",
		"- Fail closed only if HEAD/base still cannot be verified after the Git fallback.",
	].join("\n");
}

export function createOrchestratorReviewerExecution(
	pi: Pick<ExtensionAPI, "sendUserMessage" | "getActiveTools">,
	options: OrchestratorReviewerExecutionOptions = {},
): OrchestratorReviewerExecutionBridge {
	const pending = new Map<string, PendingReview>();
	// Retain exact request→HEAD evidence after timeout, never late PASS authority.
	// Bound the map to avoid unbounded session growth.
	const knownRequestHeads = new Map<string, KnownReview>();
	const resolveHeadSha = options.resolveHeadSha ?? (() => "");
	let lastDiagnostic: OrchestratorReviewerDiagnostic | null = null;
	let disposed = false;

	function recordDiagnostic(
		d: Omit<OrchestratorReviewerDiagnostic, "at">,
	): void {
		lastDiagnostic = { ...d, at: Date.now() };
	}

	function refuse(
		reason: string,
		headSha = "",
		requestId: string | null = null,
	): ReviewerResult {
		recordDiagnostic({
			requestId,
			headSha: headSha || null,
			kind: "error",
			detail: reason,
		});
		return unavailableResult(reason);
	}

	return {
		pendingCount: () => pending.size,
		getStatus: () => ({
			pending: [...pending.entries()].map(([requestId, review]) => ({
				requestId,
				headSha: review.headSha,
			})),
			lastDiagnostic,
		}),
		dispose(
			reason = "PR review cancelled because the Pi session shut down.",
		): void {
			if (disposed) return;
			disposed = true;
			for (const [requestId, review] of pending) {
				clearTimeout(review.timer);
				review.cleanup();
				review.resolved = true;
				review.resolve(unavailableResult(`${reason} Request ${requestId}.`));
			}
			pending.clear();
			knownRequestHeads.clear();
			recordDiagnostic({
				requestId: null,
				headSha: null,
				kind: "cancelled",
				detail: reason,
			});
		},
		handleToolResult(event): boolean {
			if (
				event.toolName !== "orchestrate" ||
				event.input?.agentType !== "verifier" ||
				event.input?.profile !== "pr-review"
			) {
				return false;
			}
			if (disposed) return false;

			const captured = toolContentToText(event.content);
			const rawOutput = captured.overflowed
				? `[orchestrate reviewer output exceeded ${MAX_ORCHESTRATOR_RESULT_CHARS} characters; review failed closed]\n${captured.text}`
				: captured.text;
			let matchedRequestId: string | null = null;
			for (const requestId of knownRequestHeads.keys()) {
				if (inputContainsRequestId(event.input, requestId)) {
					matchedRequestId = requestId;
					break;
				}
			}
			if (!matchedRequestId) {
				const fromText = extractRequestIdFromText(rawOutput);
				if (fromText && knownRequestHeads.has(fromText)) {
					matchedRequestId = fromText;
				}
			}
			const hasExplicitCorrelation = matchedRequestId !== null;
			const report = captured.overflowed ? null : parseReviewReport(rawOutput);
			const resultReport =
				event.isError && !hasExplicitCorrelation ? null : report;
			if (
				!matchedRequestId &&
				pending.size === 1 &&
				(event.isError || captured.overflowed || report?.status !== "PASS")
			) {
				matchedRequestId = pending.keys().next().value ?? null;
			}
			const known = matchedRequestId
				? knownRequestHeads.get(matchedRequestId)
				: undefined;
			const correlatedHeadSha = known?.headSha ?? "";
			const expired = Boolean(
				known &&
					(known.expired ||
						known.deadline.remainingMs() <= 0 ||
						known.signal?.aborted),
			);
			const diagnosticHeadSha = correlatedHeadSha || resolveHeadSha();
			if (captured.overflowed) {
				recordDiagnostic({
					requestId: matchedRequestId,
					headSha: diagnosticHeadSha || null,
					kind: "error",
					detail: `orchestrate pr-reviewer output exceeded ${MAX_ORCHESTRATOR_RESULT_CHARS} characters; PASS refused`,
				});
			} else if (report && (!event.isError || hasExplicitCorrelation)) {
				if (report.status === "PASS") {
					const criticalBlocker = hasCriticalSecurityFinding(report)
						? "report contains CRITICAL security finding(s)"
						: null;
					const testBlocker = getPassBlockingTestExecutionReason(report);
					const blocker = expired
						? "review deadline expired or review was cancelled"
						: (criticalBlocker ?? testBlocker);
					const detail = blocker
						? `Parsed PASS for HEAD ${diagnosticHeadSha || "(unknown)"} but token NOT stamped: ${blocker}.`
						: !matchedRequestId
							? `Parsed PASS for HEAD ${diagnosticHeadSha || "(unknown)"} but token NOT stamped: result was not correlated to a known PR review request.`
							: `Parsed PASS for HEAD ${diagnosticHeadSha || "(unknown)"} but token NOT stamped: final authorization belongs to dispatch.`;
					recordDiagnostic({
						requestId: matchedRequestId,
						headSha: diagnosticHeadSha || null,
						kind: "parsed-pass",
						detail,
					});
				} else {
					recordDiagnostic({
						requestId: matchedRequestId,
						headSha: diagnosticHeadSha || null,
						kind: "parsed-nonpass",
						detail: `Parsed ${report.status} (${report.confidence} confidence) for HEAD ${diagnosticHeadSha || "(unknown)"}; no token stamped.`,
					});
				}
			} else if (event.isError) {
				recordDiagnostic({
					requestId: matchedRequestId,
					headSha: diagnosticHeadSha || null,
					kind: "error",
					detail:
						rawOutput || "orchestrate pr-reviewer returned an error result",
				});
			} else if (rawOutput) {
				recordDiagnostic({
					requestId: matchedRequestId,
					headSha: diagnosticHeadSha || null,
					kind: "parse-failed",
					detail:
						`Could not parse a '## Review Report' block from orchestrate pr-reviewer output for HEAD ${diagnosticHeadSha || "(unknown)"}. ` +
						`Preview: ${rawOutput.slice(0, 200)}${rawOutput.length > 200 ? "…" : ""}`,
				});
			}

			if (!matchedRequestId) return false;
			knownRequestHeads.delete(matchedRequestId);

			const review = pending.get(matchedRequestId);
			if (!review) return false;

			if (!review.resolved) {
				clearTimeout(review.timer);
				review.resolved = true;
				pending.delete(matchedRequestId);
				if (!review.cleanup()) {
					review.resolve(
						refuse(
							"Trusted deadline adapter cleanup failed; PASS refused.",
							review.headSha,
							matchedRequestId,
						),
					);
					return true;
				}
				if (expired && known) {
					review.resolve({
						...reviewDeadlineExceeded(known.deadline),
						command: review.command,
					});
					return true;
				}
				const failed = Boolean(event.isError || captured.overflowed);
				const stderr = failed
					? rawOutput || "orchestrate pr-reviewer returned an error"
					: "";
				review.resolve({
					report: resultReport,
					rawOutput,
					exitCode: failed ? 1 : 0,
					timedOut: false,
					stderr,
					command: review.command,
				});
			}
			return true;
		},
		reviewerExecution: {
			inspectRepositoryDirectly: true,
			async runAttempt(input): Promise<ReviewerResult> {
				const deadline =
					input.deadline ?? createReviewDeadline(input.config.timeoutMs);
				if (deadline.remainingMs() <= 0)
					return reviewDeadlineExceeded(deadline);
				if (input.signal?.aborted)
					return unavailableResult("PR review cancelled before dispatch.");
				if (disposed) {
					return unavailableResult(
						"PR review gate: reviewer bridge is disposed after session shutdown.",
					);
				}
				const activeTools =
					typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
				if (!activeTools.includes("orchestrate")) {
					return unavailableResult(
						"PR review gate: orchestrate tool is unavailable; cannot route /pr-review through the orchestrator verifier bridge.",
					);
				}

				const testPlan = (input.testPlan ?? "").trim();
				if (testPlan.length > MAX_PARENT_TEST_PLAN_CHARS) {
					const reason =
						"PR review gate: required test execution plan exceeds orchestrator " +
						`relay budget (${testPlan.length} > ${MAX_PARENT_TEST_PLAN_CHARS} characters). ` +
						"No reviewer was started. Split the PR or use a bridge that relays " +
						"the complete plan; required checks must not be dropped.";
					recordDiagnostic({
						requestId: null,
						headSha: input.headSha || null,
						kind: "error",
						detail: reason,
					});
					return { ...unavailableResult(reason), testPlanBudgetExceeded: true };
				}

				const adapter = options.deadlineAdapter;
				if (adapter?.protocol !== "review-deadline-v1") {
					return refuse(
						"PR review refused: trusted execution deadline/cancellation adapter unavailable. Use the host bridge; no orchestrator reviewer was dispatched.",
						input.headSha,
					);
				}
				if (deadline.remainingMs() <= 0)
					return reviewDeadlineExceeded(deadline);
				const requestId = createRequestId();
				const command = `orchestrate agentType=verifier profile=pr-review requestId=${requestId}`;
				const headSha = input.headSha || resolveHeadSha() || "";
				const instruction = renderParentInstruction({
					requestId,
					task: input.task,
					files: input.files,
					diff: input.diff,
					testPlan,
					baseRef: input.baseRef,
					headSha,
					respectGitignore:
						input.filterOptions?.respectGitignore ??
						input.config.respectGitignore,
					skipFile: input.config.skipFile,
				});

				// Preserve exact request→HEAD correlation after timeout so a late
				// result never trusts the current HEAD.
				if (knownRequestHeads.size >= 100) {
					const oldestRequestId = knownRequestHeads.keys().next().value;
					if (oldestRequestId) knownRequestHeads.delete(oldestRequestId);
				}
				if (deadline.remainingMs() <= 0)
					return reviewDeadlineExceeded(deadline);
				const known: KnownReview = {
					headSha,
					deadline,
					expired: false,
					signal: input.signal,
				};
				const controller = new AbortController();
				let registration: ReturnType<
					OrchestratorReviewDeadlineAdapter["register"]
				>;
				try {
					registration = adapter.register({
						requestId,
						headSha,
						deadline,
						signal: controller.signal,
						beforeAttempt: () => {
							const remaining = deadline.remainingMs();
							if (remaining <= 0 || controller.signal.aborted)
								throw new Error(
									"Orchestrator review deadline exhausted/cancelled.",
								);
							return remaining;
						},
					});
					if (
						typeof registration.cancel !== "function" ||
						typeof registration.dispose !== "function"
					)
						throw new Error("Unsupported adapter.");
					if (deadline.remainingMs() <= 0 || input.signal?.aborted) {
						controller.abort();
						try {
							registration.cancel();
						} finally {
							registration.dispose();
						}
						return deadline.remainingMs() <= 0
							? reviewDeadlineExceeded(deadline)
							: unavailableResult("PR review cancelled before dispatch.");
					}
				} catch {
					controller.abort();
					return refuse(
						"PR review refused: invalid trusted deadline adapter; no dispatch.",
						headSha,
						requestId,
					);
				}
				known.signal = controller.signal;
				knownRequestHeads.set(requestId, known);

				return new Promise<ReviewerResult>((resolve) => {
					const cleanup = () => {
						controller.abort();
						let ok = true;
						try {
							registration.cancel();
						} catch {
							ok = false;
						}
						try {
							registration.dispose();
						} catch {
							ok = false;
						}
						input.signal?.removeEventListener("abort", onAbort);
						return ok;
					};
					const onAbort = () => {
						known.expired = true;
						clearTimeout(timer);
						pending.delete(requestId);
						cleanup();
						resolve(unavailableResult("PR review cancelled during dispatch."));
					};
					const timer = setTimeout(() => {
						known.expired = true;
						pending.delete(requestId);
						cleanup();
						recordDiagnostic({
							requestId,
							headSha: headSha || null,
							kind: "timeout",
							detail: `Timed out waiting for orchestrate pr-reviewer result for ${requestId} (HEAD ${headSha || "(unknown)"}).`,
						});
						resolve({ ...reviewDeadlineExceeded(deadline), command });
					}, deadline.remainingMs());

					pending.set(requestId, {
						resolve,
						timer,
						command,
						headSha,
						resolved: false,
						cleanup,
					});
					input.signal?.addEventListener("abort", onAbort, { once: true });
					if (input.signal?.aborted) onAbort();
					else {
						try {
							pi.sendUserMessage(instruction, { deliverAs: "followUp" });
						} catch {
							known.expired = true;
							clearTimeout(timer);
							pending.delete(requestId);
							cleanup();
							resolve({
								...refuse(
									"PR review dispatch failed; PASS refused.",
									headSha,
									requestId,
								),
								command,
							});
						}
					}
				});
			},
		},
	};
}
