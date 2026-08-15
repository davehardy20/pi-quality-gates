/**
 * Agent-callable `pr_review` custom tool.
 *
 * Exposes the SAME reviewer-bridge workflow that `/pr-review` triggers,
 * so an autonomous agent can request the gate-compatible review without asking
 * a human to run a slash command (plan pl-1461, seed pi-quality-gates-ff15).
 *
 * Design (see review-coordinator.ts for the full rationale):
 *  - `execute` is asynchronous-by-design: it runs the synchronous eligibility
 *    checks through the shared coordinator and returns compact kickoff state.
 *  - It does NOT await the later `orchestrate` tool result — that follow-up
 *    tool call cannot run until the current tool batch completes, so awaiting
 *    would deadlock. The existing matching `tool_result` handler resumes the
 *    dispatch and stamps the exact-HEAD PASS token.
 *  - It is strictly read-only w.r.t. publication: it never calls git_safe,
 *    gh_safe, push, pr_create, update, or merge. Actor separation is enforced
 *    structurally — this tool only requests a review and stamps gate state.
 */

import type {
	AgentToolResult,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PrGateState } from "./index.js";
import type { ReviewCoordinator } from "./review-coordinator.js";

/** Tool result details — compact structured kickoff state for the LLM/UI. */
export interface PrReviewToolDetails {
	/** "started" | "already-passed" | "in-progress" | "blocked" | "disabled" */
	status: string;
	headSha: string;
	baseRef?: string;
	started: boolean;
	gateEnabled: boolean;
	tokenCount: number;
	/** Epoch ms when the background dispatch kicked off (set iff started). */
	startedAt?: number;
}

/** TypeBox input schema: an optional base ref for an intentional re-review. */
export const PrReviewToolParams = Type.Object({
	baseRef: Type.Optional(
		Type.String({
			description:
				"Optional base ref to review against (e.g. origin/main). Supplying a base ref is treated as an intentional re-review and bypasses the already-passed early return.",
		}),
	),
});

export interface PrReviewToolDeps {
	/** The shared coordinator — must be the same instance /pr-review uses. */
	coordinator: ReviewCoordinator;
	/** Shared gate state (tokens + config). */
	state: PrGateState;
}

/**
 * Build the `pr_review` ToolDefinition. The tool is registered once in
 * index.ts; this factory keeps it injectable for tests.
 */
export function createPrReviewToolDefinition(deps: PrReviewToolDeps): {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	parameters: typeof PrReviewToolParams;
	execute: (
		toolCallId: string,
		params: { baseRef?: string },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<PrReviewToolDetails>>;
} {
	const { coordinator, state } = deps;
	return {
		name: "pr_review",
		label: "PR Review",
		description:
			"Request a PR review for the current HEAD via the configured reviewer bridge (default host; orchestrator verifier child via PI_PR_REVIEW_BRIDGE=orchestrator — runs on the host, not in a container) to obtain the PASS token required by the PR gate before git_safe push / gh_safe pr_create. Asynchronous: returns kickoff state; the review completes in the background and emits a pr-review-pass message. Never publishes.",
		promptSnippet:
			"pr_review — request a PR review for the current HEAD via the configured reviewer bridge (default host); required to obtain the PASS token before git_safe push / gh_safe pr_create. Returns kickoff state; wait for the pr-review-pass message before publishing.",
		promptGuidelines: [
			"Call pr_review before calling git_safe push or gh_safe pr_create; the PR gate blocks publication until the exact HEAD has a PASS token.",
			"pr_review is asynchronous: it returns kickoff state and the review completes in the background. Do NOT call git_safe push / gh_safe pr_create in the same batch — wait for the pr-review-pass message, then re-check before publishing.",
			"Never rely on pr_review to push, create, update, or merge a PR. It only requests review and stamps gate state; you remain the sole publisher.",
		],
		parameters: PrReviewToolParams,
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<PrReviewToolDetails>> {
			const baseRef =
				typeof params?.baseRef === "string" && params.baseRef.trim()
					? params.baseRef.trim()
					: undefined;

			const result = coordinator.startReview({
				ctx,
				state,
				baseRef,
				origin: "tool",
			});

			const details: PrReviewToolDetails = {
				status: result.status,
				headSha: result.headSha,
				baseRef: result.baseRef,
				started: result.started,
				gateEnabled: result.gateEnabled,
				tokenCount: result.tokenCount,
				startedAt: result.startedAt,
			};

			return {
				content: [
					{
						type: "text",
						text: result.message,
					},
				],
				details,
			};
		},
	};
}
