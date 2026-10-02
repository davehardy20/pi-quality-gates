import { performance } from "node:perf_hooks";

export interface ReviewDeadline {
	readonly budgetMs: number;
	remainingMs(): number;
	elapsedMs(): number;
}

/** Created once at review entry, carried through preparation and all attempts.
 * now/start are internal fake-clock seams, never user/repository configuration. */
export function createReviewDeadline(
	budgetMs: number,
	now: () => number = () => performance.now(),
	startedAt = now(),
): ReviewDeadline {
	if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 86_400_000)
		throw new Error("Invalid overall review deadline.");
	return {
		budgetMs,
		elapsedMs: () => Math.max(0, now() - startedAt),
		remainingMs: () => Math.max(0, Math.floor(budgetMs - (now() - startedAt))),
	};
}

export function reviewDeadlineDiagnostic(deadline: ReviewDeadline): string {
	return (
		`Overall review deadline exhausted: budget=${deadline.budgetMs} ms, ` +
		`elapsed=${Math.floor(deadline.elapsedMs())} ms, remaining=${deadline.remainingMs()} ms. ` +
		"Validation remains incomplete; no PASS. Per-call progress/elapsed is unknown unless supplied by trusted runner evidence; progress alone is not completion."
	);
}
