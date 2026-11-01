import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createPrReviewDispatch,
	type PrReviewDispatchDeps,
} from "../src/pr-gate/pr-review-dispatch.js";
import type { ReviewerExecution } from "../src/pr-gate/reviewer.js";
import { parseReviewValidationPolicy } from "../src/shared/review-validation-policy.js";

export const DISPATCH_HEAD_SHA = "a".repeat(40);

/** Partial contexts for inert dispatch fixtures, never a real SDK session. */
export function createDispatchContext(
	cwd: string,
	options: {
		branch?: unknown[];
		model?: { provider: string; id: string };
	} = {},
): ExtensionContext {
	return {
		cwd,
		model: options.model,
		sessionManager: {
			getSessionId: () => "fixture-session",
			getBranch: () => options.branch ?? [],
		},
	} as unknown as ExtensionContext;
}

/** Shared data-only defaults. Per-test dependencies always take precedence. */
export function createDispatchFixture(
	deps: Partial<PrReviewDispatchDeps> = {},
) {
	return createPrReviewDispatch({
		getHeadSha: () => DISPATCH_HEAD_SHA,
		loadReviewValidationPolicy: () => parseReviewValidationPolicy({}),
		resolveReviewModels: () => ({
			model: "fixture/model",
			fallbackModels: [],
		}),
		...deps,
	});
}

/** Only fake execution ports belong here; real bridges bypass this factory. */
export function createFixtureReviewerExecution(
	runAttempt: ReviewerExecution["runAttempt"],
	options: Pick<ReviewerExecution, "inspectRepositoryDirectly"> = {},
): ReviewerExecution {
	return { ...options, runAttempt };
}
