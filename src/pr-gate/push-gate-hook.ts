/**
 * push-gate-hook — the tool_call interceptor that hard-blocks git_safe
 * push / pr_create unless a per-HEAD review PASS has been proven.
 *
 * Thin wrapper around the pure `decidePushGate` core. This module owns the
 * Pi API surface ONLY (reading event.input, returning { block, reason });
 * all policy lives in gate-decision.ts.
 *
 * FAIL-SAFE contract: any error inside this hook (git rev-parse failure,
 * thrown getter, malformed input) results in a BLOCK on the mutating action,
 * never an allow. Mutating actions are fail-closed by design.
 *
 * This hook only VEToes. It never stamps tokens (that is the tool_result
 * observation path's job) and never publishes (only the main agent publishes).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decidePushGate, type GateAction } from "./gate-decision.js";
import type { PassTokenStore } from "./pass-token-store.js";

/** The tool names the gate intercepts (host-side safe git/gh runners). */
export const GATED_TOOL_NAMES: ReadonlySet<string> = new Set([
	"git_safe",
	"gh_safe",
]);

/** Default mutating actions that require a review PASS before execution. */
export const DEFAULT_GATED_ACTIONS: ReadonlySet<string> = new Set([
	"push",
	"pr_create",
]);

export interface PushGateHookDeps {
	/** The PASS token store shared with the review-result observation path. */
	tokens: PassTokenStore;
	/** Returns the current HEAD sha. Empty string if unknown (fails closed). */
	getHeadSha: () => string;
	/** Whether the gate is enabled. Default: always on. */
	enabled?: () => boolean;
	/** Override the set of actions to gate. Default: push + pr_create. */
	gatedActions?: () => ReadonlySet<string>;
	/** Base sha for the PR (informational; future diff scoping). */
	getBaseSha?: () => string;
}

export interface ToolCallEventLike {
	toolName: string;
	toolCallId: string;
	input: {
		action?: string;
		command?: string;
		args?: string[];
		[k: string]: unknown;
	};
}

export interface BlockReturn {
	block: true;
	reason: string;
}

/**
 * Register the push gate as a tool_call hook. Returns an unsubscribe handle
 * so tests can detach the hook (and so a future /pr-gate-toggle could).
 */
export function registerPushGateHook(
	pi: ExtensionAPI,
	deps: PushGateHookDeps,
): () => void {
	const isEnabled = deps.enabled ?? (() => true);
	const getGatedActions = deps.gatedActions ?? (() => DEFAULT_GATED_ACTIONS);

	function inferAction(input: ToolCallEventLike["input"]): string | null {
		if (typeof input.action === "string") return input.action;
		if (typeof input.command === "string") return input.command;
		if (Array.isArray(input.args) && input.args.length > 0)
			return input.args[0];
		return null;
	}

	const handler = async (
		event: ToolCallEventLike,
	): Promise<BlockReturn | undefined> => {
		// Only our gated tools are inspected.
		if (!GATED_TOOL_NAMES.has(event.toolName)) return undefined;

		// Gate disabled — pass through unchanged.
		if (!isEnabled()) return undefined;

		const action = inferAction(event.input ?? {});
		if (typeof action !== "string") return undefined;

		// Only the configured mutating actions are gated; everything else on
		// git_safe (diff, status, add, fetch, etc.) passes through.
		const gated = getGatedActions();
		if (!gated.has(action)) return undefined;

		// Fail-safe HEAD resolution: if we cannot prove which sha is being pushed,
		// block. An empty/throwing getter must never allow a mutating action.
		let headSha: string;
		try {
			headSha = deps.getHeadSha();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				block: true,
				reason: `PR review gate: could not resolve HEAD sha (${message}). Run /pr-review for the current HEAD, then retry the push.`,
			};
		}
		if (!headSha?.trim()) {
			return {
				block: true,
				reason:
					"PR review gate: HEAD sha is empty or detached. Resolve HEAD, run /pr-review, then retry the push.",
			};
		}

		let baseSha = "unknown";
		try {
			baseSha = deps.getBaseSha?.() ?? "unknown";
		} catch {
			// informational only — keep going
		}

		const decision = decidePushGate({
			action: action as GateAction,
			headSha,
			baseSha,
			tokens: deps.tokens,
		});

		switch (decision.verdict) {
			case "allow":
				return undefined;
			case "noop":
				return undefined;
			case "block":
				return {
					block: true,
					reason:
						decision.steer ??
						decision.reason ??
						"PR review gate: PASS required before push.",
				};
			case "escalate":
				return {
					block: true,
					reason: decision.requiresHumanAck
						? `PR review gate: ESCALATION — ${decision.reason ?? "CRITICAL security findings"} Obtain explicit human acknowledgement, then re-run /pr-review.`
						: (decision.reason ?? "PR review gate: escalation."),
				};
			default:
				// Unknown verdict: fail-closed.
				return {
					block: true,
					reason: "PR review gate: unknown decision verdict (fail-closed).",
				};
		}
	};

	pi.on("tool_call", handler);

	// Pi's on() has no official unsubscribe; return a no-op handle for symmetry
	// and future toggling. Tests can rely on the handler map directly.
	return () => {
		/* no-op until Pi exposes off(); gate is disabled via enabled() */
	};
}
