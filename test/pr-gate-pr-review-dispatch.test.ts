import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createPrGateState, resolveHeadSha } from "../src/pr-gate/index.js";
import {
	createPrReviewDispatch,
	type PrReviewDispatchDeps,
	type PrReviewDispatchInput,
} from "../src/pr-gate/pr-review-dispatch.js";
import type {
	ReviewerExecution,
	ReviewerResult,
} from "../src/reviewer/reviewer.js";
import type { ReviewReport } from "../src/shared/review-types.js";

const HEAD_SHA = "abc123def456";
const BASE_REF = "origin/master";

function createMockPi(): ExtensionAPI & { userMessages: string[] } {
	const userMessages: string[] = [];
	return {
		userMessages,
		sendMessage: vi.fn(),
		sendUserMessage: (msg: string) => {
			userMessages.push(msg);
		},
		on: vi.fn(),
		registerCommand: vi.fn(),
		appendEntry: vi.fn(),
	} as unknown as ExtensionAPI & { userMessages: string[] };
}

function createMockContext(linterClean = true): ExtensionContext {
	const branch: Array<{
		type: string;
		message?: { role: string; content: string };
		customType?: string;
		details?: { status: string };
	}> = [
		{
			type: "message",
			message: { role: "user", content: "Implement feature X" },
		},
	];
	if (linterClean) {
		branch.push({
			type: "custom_message",
			customType: "post-turn-linter-status",
			details: { status: "clean" },
		});
	}
	return {
		cwd: "/repo",
		sessionManager: {
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext;
}

function makePassReport(summary = "clean"): ReviewReport {
	return {
		status: "PASS",
		confidence: "HIGH",
		findings: [],
		verified: ["tests pass"],
		unverifiable: [],
		summary,
	};
}

function makeIssuesReport(): ReviewReport {
	return {
		status: "ISSUES",
		confidence: "MEDIUM",
		findings: [
			{
				severity: "WARNING",
				domain: "correctness",
				title: "missing null check",
				file: "src/x.ts",
				rule: "null-check",
				issue: "x may be null",
				evidence: "x.foo()",
				suggestion: "guard x",
			},
		],
		verified: [],
		unverifiable: [],
		summary: "issues found",
	};
}

function makeCriticalReport(): ReviewReport {
	return {
		status: "ISSUES",
		confidence: "HIGH",
		findings: [
			{
				severity: "CRITICAL",
				domain: "security",
				title: "RCE via eval",
				file: "src/eval.ts",
				rule: "no-eval",
				issue: "user input evaluated",
				evidence: "eval(req.body)",
				suggestion: "remove eval",
			},
		],
		verified: [],
		unverifiable: [],
		summary: "critical security",
	};
}

function createMockReviewerExecution(
	report: ReviewReport | null,
): ReviewerExecution {
	return {
		runAttempt: vi.fn().mockResolvedValue({
			report,
			rawOutput: "raw",
			exitCode: 0,
			timedOut: false,
			stderr: "",
			command: "cmd",
		} satisfies ReviewerResult),
	};
}

function createTestDeps(
	report: ReviewReport | null,
): Partial<PrReviewDispatchDeps> {
	return {
		getHeadSha: () => HEAD_SHA,
		getBaseRef: () => BASE_REF,
		listChangedFiles: async () => ["src/a.ts", "src/b.ts"],
		countDiffLines: async () => 42,
		gatherDiff: async () => "mock diff",
		runContainerValidation: async () => ({
			image: "test-image",
			status: "passed",
			results: [],
			evidence: "mock container validation evidence",
			workspaceMode: "writable-copy",
		}),
		allowLocalReviewerFallback: true,
		reviewerExecution: createMockReviewerExecution(report),
	};
}

function createInput(
	pi: ExtensionAPI,
	overrides: Partial<PrReviewDispatchInput> = {},
): PrReviewDispatchInput {
	return {
		ctx: createMockContext(),
		state: createPrGateState(),
		pi,
		...overrides,
	} as PrReviewDispatchInput;
}

describe("pr-review dispatch", () => {
	it("stamps a PASS token and allows push when review passes", async () => {
		const pi = createMockPi();
		const dispatch = createPrReviewDispatch(createTestDeps(makePassReport()));
		const input = createInput(pi);

		expect(input.state.tokens.hasPass(HEAD_SHA)).toBe(false);
		const result = await dispatch.dispatch(input);

		expect(result.stamped).toBe(true);
		expect(result.blocked).toBe(false);
		expect(result.escalated).toBe(false);
		expect(input.state.tokens.hasPass(HEAD_SHA)).toBe(true);
		expect(result.message).toContain("PASS");
		expect(result.message).toContain(HEAD_SHA);
	});

	it("blocks and sends a fix instruction when review finds issues", async () => {
		const pi = createMockPi();
		const dispatch = createPrReviewDispatch(createTestDeps(makeIssuesReport()));
		const input = createInput(pi);

		const result = await dispatch.dispatch(input);

		expect(result.stamped).toBe(false);
		expect(result.blocked).toBe(true);
		expect(result.escalated).toBe(false);
		expect(pi.userMessages.length).toBe(1);
		expect(pi.userMessages[0]).toContain("Fix the PR review findings");
		expect(result.message).toContain("issues");
	});

	it("escalates and blocks on CRITICAL security findings", async () => {
		const pi = createMockPi();
		const dispatch = createPrReviewDispatch(
			createTestDeps(makeCriticalReport()),
		);
		const input = createInput(pi);

		const result = await dispatch.dispatch(input);

		expect(result.stamped).toBe(false);
		expect(result.blocked).toBe(true);
		expect(result.escalated).toBe(true);
		expect(result.message).toContain("CRITICAL security");
		expect(input.state.tokens.hasPass(HEAD_SHA)).toBe(false);
	});

	it("reports already-passed HEAD without re-running", async () => {
		const pi = createMockPi();
		const reviewer = createMockReviewerExecution(makePassReport());
		const dispatch = createPrReviewDispatch({
			...createTestDeps(makePassReport()),
			reviewerExecution: reviewer,
		});
		const input = createInput(pi);
		input.state.tokens.stampPass({
			sha: HEAD_SHA,
			passedAt: Date.now(),
			reportStatus: "PASS",
		});

		const result = await dispatch.dispatch(input);

		expect(reviewer.runAttempt).not.toHaveBeenCalled();
		expect(result.stamped).toBe(false);
		expect(result.blocked).toBe(false);
		expect(result.message).toContain("already has a PASS token");
	});

	it("blocks when HEAD sha cannot be resolved", async () => {
		const pi = createMockPi();
		const dispatch = createPrReviewDispatch({
			...createTestDeps(makePassReport()),
			getHeadSha: () => "",
		});
		const input = createInput(pi);

		const result = await dispatch.dispatch(input);

		expect(result.blocked).toBe(true);
		expect(result.stamped).toBe(false);
		expect(result.message).toContain("could not resolve HEAD sha");
	});

	it("blocks when the post-turn linter is not clean", async () => {
		const pi = createMockPi();
		const reviewer = createMockReviewerExecution(makePassReport());
		const dispatch = createPrReviewDispatch({
			...createTestDeps(makePassReport()),
			reviewerExecution: reviewer,
		});
		const ctx = createMockContext(false);
		const branch = ctx.sessionManager.getBranch() as unknown as Array<
			Record<string, unknown>
		>;
		branch.push({
			type: "custom_message",
			customType: "post-turn-linter-status",
			details: { status: "findings" },
		});
		const input = createInput(pi, { ctx });

		const result = await dispatch.dispatch(input);

		expect(reviewer.runAttempt).not.toHaveBeenCalled();
		expect(result.blocked).toBe(true);
		expect(result.stamped).toBe(false);
		expect(result.message).toContain("post-turn linter is not clean");
	});

	it("blocks when no files changed against the base ref", async () => {
		const pi = createMockPi();
		const dispatch = createPrReviewDispatch({
			...createTestDeps(makePassReport()),
			listChangedFiles: async () => [],
		});
		const input = createInput(pi);

		const result = await dispatch.dispatch(input);

		expect(result.blocked).toBe(true);
		expect(result.stamped).toBe(false);
		expect(result.message).toContain("No files changed");
	});

	it("blocks when the reviewer report cannot be parsed", async () => {
		const pi = createMockPi();
		const dispatch = createPrReviewDispatch(createTestDeps(null));
		const input = createInput(pi);

		const result = await dispatch.dispatch(input);

		expect(result.blocked).toBe(true);
		expect(result.stamped).toBe(false);
		expect(result.report).toBeNull();
		expect(result.message).toContain("could not parse review report");
	});

	it("fails closed when container validation fails", async () => {
		const pi = createMockPi();
		const reviewer = createMockReviewerExecution(makePassReport());
		const dispatch = createPrReviewDispatch({
			...createTestDeps(makePassReport()),
			reviewerExecution: reviewer,
			allowLocalReviewerFallback: true,
			runContainerValidation: async () => ({
				image: "test-image",
				status: "failed",
				results: [
					{
						name: "typecheck",
						command: "tsc --noEmit",
						exitCode: 1,
						timedOut: false,
						stdout: "",
						stderr: "type error",
					},
				],
				evidence: "container validation failed",
				workspaceMode: "writable-copy",
			}),
		});
		const input = createInput(pi);

		const result = await dispatch.dispatch(input);

		expect(reviewer.runAttempt).not.toHaveBeenCalled();
		expect(result.blocked).toBe(true);
		expect(result.stamped).toBe(false);
		expect(result.report?.status).toBe("CANNOT_REVIEW");
		expect(result.message).toContain("could not complete");
		expect(result.message).toContain("container validation failed");
	});

	it("fails closed after validation passes when local reviewer fallback is disabled", async () => {
		const pi = createMockPi();
		const reviewer = createMockReviewerExecution(makePassReport());
		const dispatch = createPrReviewDispatch({
			...createTestDeps(makePassReport()),
			reviewerExecution: reviewer,
			allowLocalReviewerFallback: false,
		});
		const input = createInput(pi);

		const result = await dispatch.dispatch(input);

		expect(reviewer.runAttempt).not.toHaveBeenCalled();
		expect(result.blocked).toBe(true);
		expect(result.stamped).toBe(false);
		expect(result.report?.status).toBe("CANNOT_REVIEW");
		expect(result.message).toContain("local headless reviewer");
	});

	it("respects an explicit base ref argument", async () => {
		const pi = createMockPi();
		const listChangedFiles = vi.fn().mockResolvedValue(["src/a.ts"]);
		const dispatch = createPrReviewDispatch({
			getHeadSha: () => HEAD_SHA,
			getBaseRef: () => "origin/main",
			listChangedFiles,
			countDiffLines: async () => 42,
			gatherDiff: async () => "mock diff",
			runContainerValidation: async () => ({
				image: "test-image",
				status: "passed",
				results: [],
				evidence: "mock container validation evidence",
				workspaceMode: "writable-copy",
			}),
			allowLocalReviewerFallback: true,
			reviewerExecution: createMockReviewerExecution(makePassReport()),
		});
		const input = createInput(pi, { baseRef: "feature/base" });

		await dispatch.dispatch(input);

		expect(listChangedFiles).toHaveBeenCalledWith("/repo", "feature/base");
	});

	it("re-runs review when isReReview is true even with existing PASS", async () => {
		const pi = createMockPi();
		const reviewer = createMockReviewerExecution(makePassReport());
		const dispatch = createPrReviewDispatch({
			...createTestDeps(makePassReport()),
			reviewerExecution: reviewer,
		});
		const input = createInput(pi);
		input.state.tokens.stampPass({
			sha: HEAD_SHA,
			passedAt: Date.now(),
			reportStatus: "PASS",
		});

		const result = await dispatch.dispatch({ ...input, isReReview: true });

		expect(reviewer.runAttempt).toHaveBeenCalled();
		expect(result.stamped).toBe(true);
	});
});

describe("resolveHeadSha", () => {
	it("returns empty string outside a git repo", () => {
		const sha = resolveHeadSha(`/tmp/not-a-repo-${Date.now()}`);
		expect(sha).toBe("");
	});
});
