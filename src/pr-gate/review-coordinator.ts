/**
 * Shared PR-review coordinator — the single seam used by BOTH the human
 * `/pr-review` command and the agent-callable `pr_review` custom tool.
 *
 * Why a shared coordinator exists (plan pl-1461, seed ff15 / child 6d6f):
 *  - `/pr-review` and `pr_review` MUST share one dispatch instance, one
 *    in-progress guard, one exact-HEAD token store, and one set of
 *    eligibility checks. Duplicating them would create a second review path
 *    that drifts and re-opens pi-quality-gates-3225.
 *  - The custom tool is asynchronous by design: its `execute` runs the
 *    synchronous eligibility checks and kicks off the background dispatch,
 *    then returns compact structured kickoff state. It must NOT await the
 *    later `orchestrate` tool result — that follow-up tool call cannot run
 *    until the current tool batch completes, so awaiting would deadlock.
 *
 * Actor separation (firm):
 *  - This coordinator NEVER calls git_safe / gh_safe push / pr_create / merge.
 *  - It only requests a review and stamps gate state. The main agent remains
 *    the sole publisher through gated safe tools.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { PrGateState } from "./index.js";
import {
	isLinterClean,
	type PrReviewDispatchInput,
	type PrReviewDispatchResult,
} from "./pr-review-dispatch.js";

/**
 * Compact kickoff state returned synchronously by the coordinator. This is
 * the contract the `pr_review` tool returns to the LLM and the shape the
 * `/pr-review` command message is built from.
 *
 * NOTE: This deliberately carries NO review report content — only status,
 * reason, and identifying state. Bulky reviewer output stays behind the
 * dispatch result + sidecar/report hygiene.
 */
export interface ReviewKickoffResult {
	/** "started" | "already-passed" | "in-progress" | "blocked" | "disabled" */
	status: ReviewKickoffStatus;
	/** HEAD sha the kickoff concerns (best-effort; "" if unknown). */
	headSha: string;
	/** Optional base ref explicitly requested (re-review signal). */
	baseRef?: string;
	/** Human/agent-readable explanation (single concise line or short block). */
	message: string;
	/** True iff a background dispatch was actually started this call. */
	started: boolean;
	/** Whether the gate is currently enabled. */
	gateEnabled: boolean;
	/** Current PASS token count (debug only; tokens are sha-scoped). */
	tokenCount: number;
}

export type ReviewKickoffStatus =
	| "started"
	| "already-passed"
	| "in-progress"
	| "blocked"
	| "disabled";

export interface ReviewCoordinatorDeps {
	/** The Pi API, used to emit status/completion messages from the background path. */
	pi: ExtensionAPI;
	/** Resolve the current HEAD sha for a cwd. */
	resolveHeadSha: (cwd: string) => string;
	/** The single shared dispatch instance (command + tool parity). */
	dispatch: {
		dispatch: (input: PrReviewDispatchInput) => Promise<PrReviewDispatchResult>;
	};
}

export interface StartReviewInput {
	ctx: ExtensionContext;
	state: PrGateState;
	/** Explicit base ref — when set, always treated as an intentional re-review. */
	baseRef?: string;
	/**
	 * Where the kickoff originated. Used only for status message wording; it
	 * does not change gate or stamping behavior, preserving command/tool parity.
	 */
	origin: "command" | "tool";
}

export interface ReviewCoordinator {
	/**
	 * Synchronous eligibility + kickoff. Returns compact kickoff state and
	 * starts the background dispatch (if eligible). Never throws — failures
	 * surface as `{ status: "blocked", message }`.
	 */
	startReview(input: StartReviewInput): ReviewKickoffResult;
	/** Whether a background review is currently running. */
	isInProgress(): boolean;
	/** Stop completion delivery and release session/UI state after shutdown. */
	dispose(): void;
}

/**
 * Create the shared review coordinator. The caller owns the single in-progress
 * flag and dispatch instance and injects them here so command and tool wrappers
 * share exactly one of each.
 */
export function createReviewCoordinator(
	deps: ReviewCoordinatorDeps,
): ReviewCoordinator {
	let inProgress = false;
	let disposed = false;

	function setStatus(ctx: ExtensionContext, text: string | undefined): void {
		if (disposed) return;
		if (ctx.hasUI) {
			ctx.ui.setStatus("pr-review", text);
		}
	}

	function runInBackground(params: {
		ctx: ExtensionContext;
		state: PrGateState;
		dispatchInput: PrReviewDispatchInput;
		headSha: string;
	}): void {
		const { ctx, state, dispatchInput, headSha } = params;
		const { pi } = deps;
		inProgress = true;
		setStatus(ctx, `PR review: running ${headSha.slice(0, 8) || "unknown"}`);
		pi.sendMessage({
			customType: "pr-review-status",
			content: `PR review started for HEAD ${headSha}${dispatchInput.baseRef ? ` against ${dispatchInput.baseRef}` : ""}. This runs in the background and may take several minutes.`,
			display: true,
			details: {
				headSha,
				baseRef: dispatchInput.baseRef ?? null,
				enabled: state.config.enabled,
				tokenCount: state.tokens.size,
				status: "running",
			},
		});
		void (async () => {
			try {
				const result: PrReviewDispatchResult =
					await deps.dispatch.dispatch(dispatchInput);
				if (disposed) return;
				const statusText = result.stamped
					? `PR review: PASS ${headSha.slice(0, 8)}`
					: result.escalated
						? `PR review: escalation ${headSha.slice(0, 8)}`
						: result.blocked
							? `PR review: blocked ${headSha.slice(0, 8)}`
							: `PR review: complete ${headSha.slice(0, 8)}`;
				setStatus(ctx, statusText);
				pi.sendMessage({
					customType: result.escalated
						? "pr-review-escalation"
						: result.stamped
							? "pr-review-pass"
							: "pr-review-status",
					content: result.message,
					display: true,
					details: {
						headSha,
						stamped: result.stamped,
						escalated: result.escalated,
						blocked: result.blocked,
						verdict: result.report?.status ?? null,
						confidence: result.report?.confidence ?? null,
						enabled: state.config.enabled,
						tokenCount: state.tokens.size,
					},
				});
			} catch (error) {
				if (disposed) return;
				const message = error instanceof Error ? error.message : String(error);
				setStatus(ctx, `PR review: failed ${headSha.slice(0, 8) || "unknown"}`);
				pi.sendMessage({
					customType: "pr-review-status",
					content: `PR review gate: review failed — ${message}`,
					display: true,
					details: {
						headSha,
						baseRef: dispatchInput.baseRef ?? null,
						enabled: state.config.enabled,
						tokenCount: state.tokens.size,
						error: message,
					},
				});
			} finally {
				if (!disposed) inProgress = false;
			}
		})();
	}

	return {
		isInProgress: () => inProgress,
		dispose(): void {
			disposed = true;
			inProgress = false;
		},
		startReview(input: StartReviewInput): ReviewKickoffResult {
			const { ctx, state, baseRef, origin } = input;
			const headSha = deps.resolveHeadSha(ctx.cwd);
			const hasPass = headSha ? state.tokens.hasPass(headSha) : false;
			const base = {
				headSha,
				baseRef,
				gateEnabled: state.config.enabled,
				tokenCount: state.tokens.size,
			};

			if (disposed) {
				return {
					...base,
					status: "blocked",
					message:
						"PR review gate: session is shutting down; review unavailable.",
					started: false,
				};
			}

			if (!state.config.enabled) {
				return {
					...base,
					status: "disabled",
					message:
						"PR gate is disabled. Reviews are not required; publication is not gated.",
					started: false,
				};
			}

			if (!isLinterClean(ctx)) {
				return {
					...base,
					status: "blocked",
					message:
						"PR review gate: post-turn linter is not clean. Run /post-turn-linter-run on the changed files and wait for a clean status before requesting a review.",
					started: false,
				};
			}

			if (!headSha) {
				return {
					...base,
					status: "blocked",
					message:
						"PR review gate: could not resolve HEAD sha. Resolve HEAD (commit something) before requesting a review.",
					started: false,
				};
			}

			if (inProgress) {
				return {
					...base,
					status: "in-progress",
					message:
						"PR review is already running. Wait for the current review to finish before starting another.",
					started: false,
				};
			}

			if (hasPass && !baseRef) {
				return {
					...base,
					status: "already-passed",
					message: `HEAD ${headSha} already has a PASS token. Push/pr_create will be allowed.`,
					started: false,
				};
			}

			// Eligible — kick off the shared background dispatch.
			const { pi } = deps;
			runInBackground({
				ctx,
				state,
				dispatchInput: {
					ctx,
					state,
					pi,
					baseRef,
					isReReview: Boolean(baseRef),
				},
				headSha,
			});

			const source = origin === "tool" ? "pr_review" : "/pr-review";
			return {
				...base,
				status: "started",
				message: `PR review started for HEAD ${headSha}${baseRef ? ` against ${baseRef}` : ""} via ${source}. It runs in the background through the sandboxed pr-reviewer. Do NOT publish yet — wait for the pr-review-pass message / re-check before calling git_safe push or gh_safe pr_create.`,
				started: true,
			};
		},
	};
}
