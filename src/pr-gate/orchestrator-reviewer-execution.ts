import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hasCriticalSecurityFinding } from "../shared/review-severity.js";
import type { ReviewReport } from "../shared/review-types.js";
import type { PassToken, PassTokenStore } from "./pass-token-store.js";
import { getPassBlockingTestExecutionReason } from "./pr-review-dispatch.js";
import type { ReviewerExecution, ReviewerResult } from "./reviewer.js";
import { createBoundedTextCapture, parseReviewReport } from "./reviewer.js";

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
	/** HEAD sha this review covers, for exact-HEAD PASS stamping. */
	headSha: string;
	/** Whether this pending entry has already been resolved. */
	resolved: boolean;
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

export interface OrchestratorReviewerExecutionOptions {
	/**
	 * Optional token store used to stamp a PASS only after a sandboxed
	 * `pr-reviewer` result is correlated to a known request and its exact HEAD.
	 * Timed-out requests remain known so a late, explicitly correlated result
	 * can still stamp the reviewed SHA without trusting the current HEAD.
	 */
	tokens?: PassTokenStore;
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
		command: "orchestrate category=pr-reviewer",
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
		`Run the PR review via the sandboxed orchestrator category now. Request id: ${input.requestId}.`,
		"",
		"Call the `orchestrate` tool with category `pr-reviewer` and the bounded task below.",
		"Do not review in the parent conversation. Do not use host mutation or publishing tools.",
		"The full diff is deliberately absent from this follow-up. The sandbox reviewer must inspect the repository directly.",
		"Return the pr-reviewer result normally so the PR gate can parse its `## Review Report` block.",
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
		"Test execution plan (bounded metadata):",
		truncateMetadata(input.testPlan, MAX_PARENT_TEST_PLAN_CHARS),
		"",
		"Reviewer instructions:",
		"- Inspect the current repository and compare the stated base ref with HEAD inside the disposable sandbox.",
		"- Treat the supplied changed-file list as the authoritative filtered review scope for every path shown; never inspect or report findings for excluded paths.",
		...(omittedFiles > 0
			? [
					"- The parent omitted some filtered paths for bounded metadata. Derive only those remaining paths from base..HEAD, then apply the same filters before inspecting content.",
				]
			: []),
		...(input.respectGitignore
			? [
					"- Apply repository `.gitignore` rules to any changed paths derived inside the sandbox before inspecting file content.",
				]
			: []),
		...(input.skipFile
			? [
					`- Read and apply \`${truncateMetadata(input.skipFile, 256)}\` using gitignore semantics to any changed paths derived inside the sandbox before inspecting file content.`,
				]
			: []),
		"- git_inspect_safe is optional: use it first when available; otherwise you MUST use built-in sandbox-local read-only Git commands against the disposable `.git` clone.",
		"- Prefer safe validation runners; when unavailable, use trusted package scripts inside the disposable sandbox according to the supplied test plan.",
		"- Read only the filtered changed files and run the relevant validation. Never use host mutation or publishing commands.",
		"- Fail closed only if HEAD/base still cannot be verified after the disposable Git fallback.",
	].join("\n");
}

export function createOrchestratorReviewerExecution(
	pi: Pick<ExtensionAPI, "sendUserMessage" | "getActiveTools">,
	options: OrchestratorReviewerExecutionOptions = {},
): OrchestratorReviewerExecutionBridge {
	const pending = new Map<string, PendingReview>();
	// Keep request→HEAD correlation after timeout so late results can stamp the
	// reviewed SHA. Bound the map to avoid unbounded session growth.
	const knownRequestHeads = new Map<string, string>();
	const tokens = options.tokens;
	const resolveHeadSha = options.resolveHeadSha ?? (() => "");
	let lastDiagnostic: OrchestratorReviewerDiagnostic | null = null;
	let disposed = false;

	function recordDiagnostic(
		d: Omit<OrchestratorReviewerDiagnostic, "at">,
	): void {
		lastDiagnostic = { ...d, at: Date.now() };
	}

	/**
	 * Stamp a PASS token for the exact HEAD captured by a known review request.
	 * A timed-out request can still stamp when its late result echoes the request
	 * id; uncorrelated results never reach this helper.
	 *
	 * Safety invariants (mirroring decidePushGate / pr-review-dispatch):
	 *  - Only a genuine PASS report without CRITICAL security findings stamps.
	 *  - A PASS that omits ### Test execution or reports a non-PASS test
	 *    status does NOT stamp (invariant: PASS requires test execution).
	 */
	function stampPassFromObservedReport(
		headSha: string | null,
		report: ReviewReport | null,
		summary?: string,
	): boolean {
		if (!tokens) return false;
		if (!headSha?.trim()) return false;
		if (report?.status !== "PASS") return false;
		if (hasCriticalSecurityFinding(report)) return false;
		const testBlocker = getPassBlockingTestExecutionReason(report);
		if (testBlocker) return false;
		const token: PassToken = {
			sha: headSha,
			passedAt: Date.now(),
			reportStatus: "PASS",
			summary: summary ?? report.summary,
		};
		tokens.stampPass(token);
		return tokens.hasPass(headSha);
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
				event.input?.category !== "pr-reviewer"
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
			if (
				!matchedRequestId &&
				pending.size === 1 &&
				(event.isError || captured.overflowed || report?.status !== "PASS")
			) {
				matchedRequestId = pending.keys().next().value ?? null;
			}
			const correlatedHeadSha = matchedRequestId
				? (knownRequestHeads.get(matchedRequestId) ?? "")
				: "";
			const diagnosticHeadSha = correlatedHeadSha || resolveHeadSha();
			const stamped =
				matchedRequestId && (!event.isError || hasExplicitCorrelation)
					? stampPassFromObservedReport(
							correlatedHeadSha || null,
							report,
							report?.summary,
						)
					: false;

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
					const blocker = criticalBlocker ?? testBlocker;
					const detail = blocker
						? `Parsed PASS for HEAD ${diagnosticHeadSha || "(unknown)"} but token NOT stamped: ${blocker}.`
						: !matchedRequestId
							? `Parsed PASS for HEAD ${diagnosticHeadSha || "(unknown)"} but token NOT stamped: result was not correlated to a known PR review request.`
							: stamped
								? `Parsed PASS (${report.confidence} confidence) for HEAD ${diagnosticHeadSha}; token stamped.`
								: `Parsed PASS for HEAD ${diagnosticHeadSha || "(unknown)"} but token NOT stamped.`;
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
				const failed = Boolean(event.isError || captured.overflowed);
				const stderr = failed
					? rawOutput || "orchestrate pr-reviewer returned an error"
					: "";
				review.resolve({
					report,
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
				if (disposed) {
					return unavailableResult(
						"PR review gate: reviewer bridge is disposed after session shutdown.",
					);
				}
				const activeTools =
					typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
				if (!activeTools.includes("orchestrate")) {
					return unavailableResult(
						"PR review gate: orchestrate tool is unavailable; cannot route /pr-review through sandboxed pr-reviewer.",
					);
				}

				const requestId = createRequestId();
				const command = `orchestrate category=pr-reviewer requestId=${requestId}`;
				const headSha = input.headSha || resolveHeadSha() || "";
				const instruction = renderParentInstruction({
					requestId,
					task: input.task,
					files: input.files,
					diff: input.diff,
					testPlan: input.testPlan,
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
				knownRequestHeads.set(requestId, headSha);

				return new Promise<ReviewerResult>((resolve) => {
					const timer = setTimeout(() => {
						pending.delete(requestId);
						recordDiagnostic({
							requestId,
							headSha: headSha || null,
							kind: "timeout",
							detail: `Timed out waiting for orchestrate pr-reviewer result for ${requestId} (HEAD ${headSha || "(unknown)"}).`,
						});
						resolve({
							report: null,
							rawOutput: `Timed out waiting for orchestrate pr-reviewer result for ${requestId}.`,
							exitCode: 1,
							timedOut: true,
							stderr: `Timed out waiting for orchestrate pr-reviewer result for ${requestId}.`,
							command,
						});
					}, input.config.timeoutMs);

					pending.set(requestId, {
						resolve,
						timer,
						command,
						headSha,
						resolved: false,
					});
					pi.sendUserMessage(instruction, { deliverAs: "followUp" });
				});
			},
		},
	};
}
