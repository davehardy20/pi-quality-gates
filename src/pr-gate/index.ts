/**
 * pr-gate extension entry — wires the push gate hook and /pr-review command
 * into a Pi extension.
 *
 * ACTOR SEPARATION (firm):
 *  - This module ONLY registers the veto hook + the /pr-review command.
 *  - It NEVER calls gh_safe / git_safe push/pr_create itself.
 *  - The main agent remains the sole publisher; this gate only vetoes.
 *
 * Loop (driven by the main agent, not by this extension):
 *   agent calls gh_safe pr_create/push
 *     -> tool_call hook vetoes (no PASS token) with a steer
 *     -> agent runs /pr-review
 *     -> review executes (in the Apple container via the pr-reviewer category)
 *     -> on PASS, token stamped; agent retries the push; hook allows
 *     -> on ISSUES, agent fixes -> lint-clean -> re-review
 *     -> on CRITICAL security, escalate for human ack
 */

import { execSync } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { decidePushGate } from "./gate-decision.js";
import {
	createPassTokenStore,
	type PassTokenStore,
} from "./pass-token-store.js";
import {
	createPrReviewDispatch,
	type PrReviewDispatchResult,
} from "./pr-review-dispatch.js";
import {
	DEFAULT_GATED_ACTIONS,
	registerPushGateHook,
} from "./push-gate-hook.js";

export interface PrGateConfig {
	/** Whether the push gate is active. Default: true. */
	enabled: boolean;
	/** Mutating actions to gate. Default: push + pr_create. */
	gatedActions: ReadonlySet<string>;
}

export const DEFAULT_PR_GATE_CONFIG: PrGateConfig = {
	enabled: true,
	gatedActions: DEFAULT_GATED_ACTIONS,
};

/**
 * Resolve the current HEAD sha. Returns "" if unknown (the hook fails closed
 * on empty). Kept here so tests can inject a fake without spawning git.
 */
export function resolveHeadSha(cwd: string): string {
	try {
		const sha = execSync("git rev-parse HEAD", {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return sha || "";
	} catch {
		return "";
	}
}

export interface PrGateState {
	tokens: PassTokenStore;
	config: PrGateConfig;
}

export function createPrGateState(
	config: Partial<PrGateConfig> = {},
): PrGateState {
	return {
		tokens: createPassTokenStore(),
		config: { ...DEFAULT_PR_GATE_CONFIG, ...config },
	};
}

export interface StampFromReviewInput {
	/** HEAD sha the review covered. */
	headSha: string;
	/** The review report status. Only "PASS" stamps. */
	reportStatus: "PASS" | "ISSUES" | "CANNOT_REVIEW";
	/** Optional summary from the report. */
	summary?: string;
}

/**
 * Stamp a PASS token from a review result. Called by the observation path
 * (the tool_result hook on the review orchestrator call) — NOT by the veto
 * hook. Returns true if a token was stamped.
 */
export function stampPassFromReview(
	state: PrGateState,
	input: StampFromReviewInput,
): boolean {
	if (input.reportStatus !== "PASS") return false;
	// Re-use decidePushGate's stamping path by feeding it a PASS report-shaped
	// input. This keeps a single source of truth for "what stamps a token".
	const before = state.tokens.size;
	decidePushGate({
		action: "push",
		headSha: input.headSha,
		baseSha: "unknown",
		tokens: state.tokens,
		// Minimal report stub: decidePushGate only reads .status for the PASS
		// branch (no security findings here).
		reviewReport: {
			status: "PASS",
			confidence: "HIGH",
			findings: [],
			verified: [],
			unverifiable: [],
			summary: input.summary ?? "",
		},
	});
	return state.tokens.size > before;
}

function sendPrReviewStatus(
	pi: ExtensionAPI,
	state: PrGateState,
	ctx: ExtensionContext,
): void {
	const headSha = resolveHeadSha(ctx.cwd);
	const hasPass = headSha ? state.tokens.hasPass(headSha) : false;
	pi.sendMessage({
		customType: "pr-review-status",
		content: [
			`PR gate enabled: ${state.config.enabled}`,
			`HEAD sha: ${headSha || "(unknown)"}`,
			`HEAD has PASS: ${hasPass}`,
			`Total PASS tokens: ${state.tokens.size}`,
			state.config.enabled
				? "Run /pr-review to request a PASS token for the current HEAD."
				: "Reviews are not required while the gate is disabled.",
		].join("\n"),
		display: true,
		details: {
			headSha,
			hasPass,
			enabled: state.config.enabled,
			tokenCount: state.tokens.size,
		},
	});
}

export default function prGateExtension(pi: ExtensionAPI): void {
	const state = createPrGateState();

	registerPushGateHook(pi, {
		tokens: state.tokens,
		getHeadSha: () => {
			// Best-effort; the hook fails closed on empty/throw.
			try {
				return resolveHeadSha(process.cwd());
			} catch {
				return "";
			}
		},
		enabled: () => state.config.enabled,
		gatedActions: () => state.config.gatedActions,
	});

	const dispatch = createPrReviewDispatch({
		getHeadSha: resolveHeadSha,
	});

	pi.registerCommand("pr-review", {
		description:
			"Run a PR review for the current HEAD, then stamp a PASS token if clean. Required before gh_safe push / pr_create when the gate is enabled.",
		handler: async (args, ctx: ExtensionContext) => {
			const rawArgs = (args ?? "").trim();
			if (rawArgs === "status" || rawArgs === "--status") {
				sendPrReviewStatus(pi, state, ctx);
				return;
			}

			const baseRef = rawArgs || undefined;
			const headSha = resolveHeadSha(ctx.cwd);
			const hasPass = headSha ? state.tokens.hasPass(headSha) : false;

			if (!state.config.enabled) {
				pi.sendMessage({
					customType: "pr-review-status",
					content: "PR gate is disabled. Reviews are not required.",
					display: true,
				});
				return;
			}

			if (hasPass && !baseRef) {
				pi.sendMessage({
					customType: "pr-review-status",
					content: `PR gate: HEAD ${headSha} already has a PASS token. Push/pr_create will be allowed.`,
					display: true,
					details: {
						headSha,
						hasPass: true,
						verdict: "allow",
						enabled: state.config.enabled,
						tokenCount: state.tokens.size,
					},
				});
				return;
			}

			const result: PrReviewDispatchResult = await dispatch.dispatch({
				ctx,
				state,
				pi,
				baseRef,
			});

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
		},
	});

	pi.registerCommand("pr-review-status", {
		description:
			"Show PR review gate status without running a review or treating status as a base ref.",
		handler: async (_args, ctx: ExtensionContext) => {
			sendPrReviewStatus(pi, state, ctx);
		},
	});

	pi.registerCommand("pr-gate-status", {
		description: "Show PR review gate state: enabled, HEAD sha, PASS tokens.",
		handler: async (_args, ctx: ExtensionContext) => {
			const headSha = resolveHeadSha(ctx.cwd);
			pi.sendMessage({
				customType: "pr-gate-status",
				content: [
					`PR gate enabled: ${state.config.enabled}`,
					`Gated actions: ${[...state.config.gatedActions].join(", ")}`,
					`HEAD sha: ${headSha || "(unknown)"}`,
					`HEAD has PASS: ${headSha ? state.tokens.hasPass(headSha) : false}`,
					`Total PASS tokens: ${state.tokens.size}`,
				].join("\n"),
				display: true,
			});
		},
	});

	pi.registerCommand("pr-gate-test-block", {
		description:
			"Simulate a git_safe push tool_call to verify the gate blocks without a PASS token.",
		handler: async (_args, ctx: ExtensionContext) => {
			const headSha = resolveHeadSha(ctx.cwd);

			if (!state.config.enabled) {
				pi.sendMessage({
					customType: "pr-gate-test-block",
					content:
						"PR gate test: tool_call would NOT be blocked (gate is disabled).",
					display: true,
					details: {
						headSha,
						enabled: false,
					},
				});
				return;
			}

			const decision = decidePushGate({
				action: "push",
				headSha,
				baseSha: "unknown",
				tokens: state.tokens,
			});

			if (decision.verdict === "allow") {
				pi.sendMessage({
					customType: "pr-gate-test-block",
					content:
						"PR gate test: tool_call would NOT be blocked (PASS token present).",
					display: true,
					details: {
						headSha,
						verdict: decision.verdict,
						hasPass: state.tokens.hasPass(headSha),
					},
				});
				return;
			}

			pi.sendMessage({
				customType: "pr-gate-test-block",
				content: `PR gate test: tool_call would be BLOCKED.\n${decision.steer ?? decision.reason ?? "PASS required before push."}`,
				display: true,
				details: {
					headSha,
					verdict: decision.verdict,
					hasPass: state.tokens.hasPass(headSha),
				},
			});
		},
	});

	pi.registerCommand("pr-gate-toggle", {
		description: "Enable or disable the PR review gate (on|off).",
		handler: async (args, ctx: ExtensionContext) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "on" || arg === "enable") {
				state.config.enabled = true;
			} else if (arg === "off" || arg === "disable") {
				state.config.enabled = false;
			} else {
				state.config.enabled = !state.config.enabled;
			}
			pi.sendMessage({
				customType: "pr-gate-toggle",
				content: `PR gate ${state.config.enabled ? "enabled" : "disabled"}.`,
				display: true,
			});
			void ctx;
		},
	});
}
