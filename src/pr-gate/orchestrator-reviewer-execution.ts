import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
}

export interface OrchestratorReviewerExecutionBridge {
	reviewerExecution: ReviewerExecution;
	handleToolResult(event: ToolResultEventLike): boolean;
	pendingCount(): number;
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
): OrchestratorReviewerExecutionBridge {
	const pending = new Map<string, PendingReview>();

	return {
		pendingCount: () => pending.size,
		handleToolResult(event): boolean {
			if (event.toolName !== "orchestrate") return false;

			for (const [requestId, review] of pending) {
				if (!inputContainsRequestId(event.input, requestId)) continue;
				clearTimeout(review.timer);
				pending.delete(requestId);

				const rawOutput = toolContentToText(event.content);
				const stderr = event.isError
					? rawOutput || "orchestrate pr-reviewer returned an error"
					: "";
				review.resolve({
					report: event.isError ? null : parseReviewReport(rawOutput),
					rawOutput,
					exitCode: event.isError ? 1 : 0,
					timedOut: false,
					stderr,
					command: review.command,
				});
				return true;
			}

			return false;
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

				return new Promise<ReviewerResult>((resolve) => {
					const timer = setTimeout(() => {
						pending.delete(requestId);
						resolve({
							report: null,
							rawOutput: `Timed out waiting for orchestrate pr-reviewer result for ${requestId}.`,
							exitCode: 1,
							timedOut: true,
							stderr: `Timed out waiting for orchestrate pr-reviewer result for ${requestId}.`,
							command,
						});
					}, input.config.timeoutMs);

					pending.set(requestId, { resolve, timer, command });
					pi.sendUserMessage(instruction, { deliverAs: "followUp" });
				});
			},
		},
	};
}
