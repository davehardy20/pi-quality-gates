import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hasCriticalSecurityFinding } from "../shared/review-severity.js";
import type { ReviewReport } from "../shared/review-types.js";
import type { PassToken, PassTokenStore } from "./pass-token-store.js";
import { getPassBlockingTestExecutionReason } from "./pr-review-dispatch.js";
import type { ReviewerExecution, ReviewerResult } from "./reviewer.js";
import { parseReviewReport } from "./reviewer.js";

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
	/** "parsed-pass" | "parsed-nonpass" | "parse-failed" | "error" | "timeout" */
	kind: "parsed-pass" | "parsed-nonpass" | "parse-failed" | "error" | "timeout";
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

function toolContentToText(content: TextContentLike[] | undefined): string {
	return (content ?? [])
		.map((part) => (part?.type === "text" ? (part.text ?? "") : ""))
		.join("")
		.trim();
}

function inputContainsRequestId(
	input: Record<string, unknown> | undefined,
	requestId: string,
): boolean {
	if (!input) return false;
	return JSON.stringify(input).includes(requestId);
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

function renderParentInstruction(input: {
	requestId: string;
	task: string;
	files: string[];
	diff: string | undefined;
	testPlan: string | undefined;
}): string {
	return [
		`Run the PR review via the sandboxed orchestrator category now. Request id: ${input.requestId}.`,
		"",
		"Call the `orchestrate` tool with:",
		"- category: `pr-reviewer`",
		"- task: the full task below",
		"",
		"Do not review in the parent conversation. Do not use host shell or host mutation tools.",
		"Return the pr-reviewer result normally so the PR gate can parse its `## Review Report` block.",
		"",
		"```text",
		`PR_REVIEW_REQUEST_ID: ${input.requestId}`,
		"",
		input.task || "Review the current HEAD diff before push.",
		"",
		"Changed files:",
		...(input.files.length > 0
			? input.files.map((file) => `- ${file}`)
			: ["(no changed files)"]),
		"",
		"Diff:",
		input.diff || "(no diff available)",
		"",
		"Test execution plan:",
		input.testPlan || "(no test execution plan available)",
		"```",
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
		handleToolResult(event): boolean {
			if (
				event.toolName !== "orchestrate" ||
				event.input?.category !== "pr-reviewer"
			) {
				return false;
			}

			const rawOutput = toolContentToText(event.content);
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

			const report = event.isError ? null : parseReviewReport(rawOutput);
			const correlatedHeadSha = matchedRequestId
				? (knownRequestHeads.get(matchedRequestId) ?? "")
				: "";
			const diagnosticHeadSha = correlatedHeadSha || resolveHeadSha();
			const stamped = matchedRequestId
				? stampPassFromObservedReport(
						correlatedHeadSha || null,
						report,
						report?.summary,
					)
				: false;

			if (event.isError) {
				recordDiagnostic({
					requestId: matchedRequestId,
					headSha: diagnosticHeadSha || null,
					kind: "error",
					detail:
						rawOutput || "orchestrate pr-reviewer returned an error result",
				});
			} else if (report) {
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
				const stderr = event.isError
					? rawOutput || "orchestrate pr-reviewer returned an error"
					: "";
				review.resolve({
					report,
					rawOutput,
					exitCode: event.isError ? 1 : 0,
					timedOut: false,
					stderr,
					command: review.command,
				});
			}
			return true;
		},
		reviewerExecution: {
			async runAttempt(input): Promise<ReviewerResult> {
				const activeTools =
					typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
				if (!activeTools.includes("orchestrate")) {
					return unavailableResult(
						"PR review gate: orchestrate tool is unavailable; cannot route /pr-review through sandboxed pr-reviewer.",
					);
				}

				const requestId = createRequestId();
				const command = `orchestrate category=pr-reviewer requestId=${requestId}`;
				const instruction = renderParentInstruction({
					requestId,
					task: input.task,
					files: input.files,
					diff: input.diff,
					testPlan: input.testPlan,
				});

				// Capture the exact reviewed HEAD before dispatch. Preserve this
				// correlation after timeout so a late result never trusts current HEAD.
				const headSha = input.headSha || resolveHeadSha() || "";
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
