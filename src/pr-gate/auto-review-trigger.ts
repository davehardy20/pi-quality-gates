/**
 * auto-review-trigger — bridges the post-turn-linter to the PR review gate.
 *
 * The PR review gate (src/pr-gate) is a command-only surface by default:
 * /pr-review runs a review and stamps a PASS token. This module adds the
 * automatic loop the retired post-turn-reviewer could not reliably provide:
 *
 *   turn_end -> linter reported clean -> /pr-review auto-runs ->
 *   ISSUES -> agent fixes -> commits (new HEAD) -> next clean linter ->
 *   ... loops until PASS (token stamped) or escalation.
 *
 * Loop safety (all required):
 *  - gate must be enabled
 *  - no review already in progress
 *  - a post-turn-linter-status entry MUST exist AND read "clean"
 *  - HEAD must be resolvable
 *  - HEAD must not already hold a PASS token
 *  - HEAD must differ from the last sha this module auto-reviewed
 *
 * The last-sha guard is the anti-recursion anchor: it prevents a clean linter
 * from re-running an identical review of the same HEAD forever.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type LinterStatus = "clean" | "findings" | "none";

export interface LinterStatusEntry {
	type: string;
	customType?: string;
	details?: { status?: string };
}

export interface AutoReviewDecision {
	shouldReview: boolean;
	reason: string;
}

export interface AutoReviewInputs {
	enabled: boolean;
	inProgress: boolean;
	linterStatus: LinterStatus;
	headSha: string;
	hasPass: boolean;
	/** SHA this module last auto-reviewed ("" = never). */
	lastReviewedSha: string;
}

/**
 * Read the most recent post-turn-linter-status entry from a session branch.
 * Returns "none" when no entry exists so callers can treat "linter has not
 * run" and "linter found issues" the same way (do not auto-review).
 */
export function getLatestLinterStatus(
	branch: LinterStatusEntry[],
): LinterStatus {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type !== "custom_message") continue;
		if (entry.customType !== "post-turn-linter-status") continue;
		const status = entry.details?.status;
		if (status === "clean") return "clean";
		if (status === "findings") return "findings";
		return "none";
	}
	return "none";
}

/**
 * Pure decision: should the auto-review path run now? No side effects —
 * callers wire the result into the shared review execution.
 */
export function decideAutoReview(inputs: AutoReviewInputs): AutoReviewDecision {
	if (!inputs.enabled) {
		return {
			shouldReview: false,
			reason: "PR gate is disabled; auto-review is inactive.",
		};
	}
	if (inputs.inProgress) {
		return {
			shouldReview: false,
			reason: "A PR review is already running.",
		};
	}
	if (inputs.linterStatus !== "clean") {
		return {
			shouldReview: false,
			reason: `Post-turn linter is not clean (${inputs.linterStatus}).`,
		};
	}
	if (!inputs.headSha) {
		return {
			shouldReview: false,
			reason: "HEAD sha is unresolved; cannot auto-review.",
		};
	}
	if (inputs.hasPass) {
		return {
			shouldReview: false,
			reason: `HEAD ${inputs.headSha} already has a PASS token.`,
		};
	}
	if (inputs.lastReviewedSha === inputs.headSha) {
		return {
			shouldReview: false,
			reason: `HEAD ${inputs.headSha} was already auto-reviewed.`,
		};
	}
	return {
		shouldReview: true,
		reason: `HEAD ${inputs.headSha} is clean and unreviewed.`,
	};
}

/**
 * Attach the auto-review listener. Returns a holder for the last-reviewed SHA
 * so the index.ts wiring can read/update it as reviews complete.
 */
export interface AutoReviewRuntime {
	lastReviewedSha: string;
}

export interface RegisterAutoReviewDeps {
	getHeadSha: () => string;
	hasPass: (sha: string) => boolean;
	isEnabled: () => boolean;
	isInProgress: () => boolean;
	runReview: () => Promise<void>;
	notify?: (message: string) => void;
}

export function registerAutoReview(
	pi: ExtensionAPI,
	deps: RegisterAutoReviewDeps,
): AutoReviewRuntime {
	const runtime: AutoReviewRuntime = { lastReviewedSha: "" };

	pi.on("turn_end", async (_event, ctx) => {
		const branch =
			(ctx?.sessionManager?.getBranch?.() as LinterStatusEntry[] | undefined) ??
			[];
		const linterStatus = getLatestLinterStatus(branch);
		const headSha = deps.getHeadSha();
		const decision = decideAutoReview({
			enabled: deps.isEnabled(),
			inProgress: deps.isInProgress(),
			linterStatus,
			headSha,
			hasPass: deps.hasPass(headSha),
			lastReviewedSha: runtime.lastReviewedSha,
		});

		if (!decision.shouldReview) {
			return;
		}

		runtime.lastReviewedSha = headSha;
		deps.notify?.(`PR review auto-triggered for HEAD ${headSha.slice(0, 8)}.`);
		try {
			await deps.runReview();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.notify?.(
				`Auto-review failed for HEAD ${headSha.slice(0, 8)}: ${message}`,
			);
			// Do NOT reset lastReviewedSha on failure. The guard is sticky: once a
			// HEAD has been auto-attempted (pass or fail), it is not auto-attempted
			// again until the HEAD changes. This prevents infinite loops on
			// terminal failures such as "No files changed" for an already-pushed
			// HEAD. Manual /pr-review bypasses this guard and always retries.
		}
		void ctx;
	});

	return runtime;
}
