import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createPrGateState, resolveHeadSha } from "../src/pr-gate/index.js";
import { PR_REVIEW_CONFIG } from "../src/pr-gate/pr-review-config.js";
import {
	createPrReviewDispatch,
	type PrReviewDispatchDeps,
	type PrReviewDispatchInput,
} from "../src/pr-gate/pr-review-dispatch.js";
import type {
	ReviewerExecution,
	ReviewerResult,
} from "../src/pr-gate/reviewer.js";
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

function createMockContext(
	linterClean = true,
	model?: { provider: string; id: string },
): ExtensionContext {
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
		model,
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
		testExecution: {
			status: "PASS",
			summary: "container-safe validation passed",
		},
		summary,
	};
}

function makePassReportWithoutTestExecution(): ReviewReport {
	const { testExecution: _testExecution, ...report } = makePassReport();
	return report;
}

function makePassReportWithFailedTestExecution(): ReviewReport {
	return {
		...makePassReport(),
		testExecution: {
			status: "FAIL",
			summary: "container-safe validation failed",
		},
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
		isWorktreeClean: () => true,
		listChangedFiles: async () => ["src/a.ts", "src/b.ts"],
		applyDiffFilters: async (files) => files,
		countDiffLines: async () => 42,
		gatherDiff: async () => ({
			text: "mock diff",
			truncated: false,
			omittedLines: 0,
		}),
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

	it("passes the active extension context to runtime config resolution", async () => {
		const pi = createMockPi();
		const ctx = createMockContext(true, {
			provider: "session",
			id: "override",
		});
		const resolveReviewConfig = vi.fn(() => PR_REVIEW_CONFIG);
		const dispatch = createPrReviewDispatch({
			...createTestDeps(makePassReport()),
			resolveReviewConfig,
		});

		await dispatch.dispatch(createInput(pi, { ctx }));

		expect(resolveReviewConfig).toHaveBeenCalledWith(ctx);
	});

	it("blocks PASS reports that omit required test execution", async () => {
		const pi = createMockPi();
		const dispatch = createPrReviewDispatch(
			createTestDeps(makePassReportWithoutTestExecution()),
		);
		const input = createInput(pi);

		const result = await dispatch.dispatch(input);

		expect(result.stamped).toBe(false);
		expect(result.blocked).toBe(true);
		expect(result.report?.status).toBe("CANNOT_REVIEW");
		expect(input.state.tokens.hasPass(HEAD_SHA)).toBe(false);
		expect(result.message).toContain("omitted the required");
	});

	it("blocks PASS reports with failed test execution", async () => {
		const pi = createMockPi();
		const dispatch = createPrReviewDispatch(
			createTestDeps(makePassReportWithFailedTestExecution()),
		);
		const input = createInput(pi);

		const result = await dispatch.dispatch(input);

		expect(result.stamped).toBe(false);
		expect(result.blocked).toBe(true);
		expect(result.report?.status).toBe("CANNOT_REVIEW");
		expect(input.state.tokens.hasPass(HEAD_SHA)).toBe(false);
		expect(result.message).toContain("test execution status is FAIL");
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

	it("blocks when review filters exclude every changed file", async () => {
		const pi = createMockPi();
		const reviewerExecution = createMockReviewerExecution(makePassReport());
		const countDiffLines = vi.fn(async () => 42);
		const dispatch = createPrReviewDispatch({
			...createTestDeps(makePassReport()),
			applyDiffFilters: async () => [],
			countDiffLines,
			reviewerExecution,
		});

		const result = await dispatch.dispatch(createInput(pi));

		expect(result.blocked).toBe(true);
		expect(result.stamped).toBe(false);
		expect(result.message).toContain("excluded by review filters");
		expect(countDiffLines).not.toHaveBeenCalled();
		expect(reviewerExecution.runAttempt).not.toHaveBeenCalled();
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

	it("fails closed when no reviewer execution bridge is configured", async () => {
		const pi = createMockPi();
		const dispatch = createPrReviewDispatch({
			getHeadSha: () => HEAD_SHA,
			getBaseRef: () => BASE_REF,
			isWorktreeClean: () => true,
			listChangedFiles: async () => ["src/a.ts"],
			applyDiffFilters: async (files) => files,
			countDiffLines: async () => 42,
			gatherDiff: async () => ({
				text: "mock diff",
				truncated: false,
				omittedLines: 0,
			}),
		});
		const input = createInput(pi);

		const result = await dispatch.dispatch(input);

		expect(result.blocked).toBe(true);
		expect(result.stamped).toBe(false);
		expect(result.report).toBeNull();
		expect(result.message).toContain(
			"expected sandboxed orchestrator pr-reviewer routing",
		);
	});

	it("respects an explicit base ref argument", async () => {
		const pi = createMockPi();
		const listChangedFiles = vi.fn().mockResolvedValue(["src/a.ts"]);
		const dispatch = createPrReviewDispatch({
			getHeadSha: () => HEAD_SHA,
			getBaseRef: () => "origin/main",
			isWorktreeClean: () => true,
			listChangedFiles,
			applyDiffFilters: async (files) => files,
			countDiffLines: async () => 42,
			gatherDiff: async () => ({
				text: "mock diff",
				truncated: false,
				omittedLines: 0,
			}),
			reviewerExecution: createMockReviewerExecution(makePassReport()),
		});
		const input = createInput(pi, { baseRef: "feature/base" });

		await dispatch.dispatch(input);

		expect(listChangedFiles).toHaveBeenCalledWith("/repo", "feature/base");
	});

	it("applies skip filters before repository-direct review scope", async () => {
		const pi = createMockPi();
		const gatherDiff = vi.fn(async () => ({
			text: "FULL_DIFF_SENTINEL",
			truncated: false,
			omittedLines: 0,
		}));
		const listChangedFiles = vi.fn(async () => [
			"src/a.ts",
			"generated/vendor.js",
		]);
		const applyDiffFilters = vi.fn(async () => ["src/a.ts"]);
		const countDiffLines = vi.fn(async () => 42);
		const runAttempt = vi.fn(async () => ({
			report: makePassReport(),
			rawOutput: "report",
			exitCode: 0,
			timedOut: false,
			stderr: "",
			command: "orchestrate category=pr-reviewer",
		}));
		const reviewerExecution: ReviewerExecution = {
			inspectRepositoryDirectly: true,
			runAttempt,
		};
		const dispatch = createPrReviewDispatch({
			...createTestDeps(makePassReport()),
			listChangedFiles,
			applyDiffFilters,
			countDiffLines,
			gatherDiff,
			reviewerExecution,
		});

		const result = await dispatch.dispatch(
			createInput(pi, { baseRef: "origin/main" }),
		);

		expect(result.stamped).toBe(true);
		expect(applyDiffFilters).toHaveBeenCalledWith(
			["src/a.ts", "generated/vendor.js"],
			"/repo",
			expect.objectContaining({ respectGitignore: true }),
		);
		expect(countDiffLines).toHaveBeenCalledWith(
			["src/a.ts"],
			"/repo",
			"origin/main",
		);
		expect(gatherDiff).not.toHaveBeenCalled();
		expect(runAttempt).toHaveBeenCalledWith(
			expect.objectContaining({
				baseRef: "origin/main",
				diff: undefined,
				files: ["src/a.ts"],
				headSha: HEAD_SHA,
			}),
		);
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

describe("C5 incremental review (lastPassSha..HEAD scoping)", () => {
	const OLD_PASS_SHA = "0ldpass5ha0000";

	function createIncrementalDeps(report: ReviewReport) {
		const listChangedFiles = vi.fn().mockResolvedValue(["src/a.ts"]);
		const countDiffLines = vi.fn(async () => 42);
		const gatherDiff = vi.fn(async () => ({
			text: "mock diff",
			truncated: false,
			omittedLines: 0,
		}));
		const log = vi.fn();
		const deps: Partial<PrReviewDispatchDeps> = {
			...createTestDeps(report),
			listChangedFiles,
			countDiffLines,
			gatherDiff,
			log,
			verifyRef: () => true,
			verifyAncestry: () => true,
			// Isolate C5 incremental scoping from the C2 structured-hunks default so
			// this suite asserts incremental behaviour regardless of the C2 toggle.
			reviewConfig: {
				...PR_REVIEW_CONFIG,
				incrementalReview: true,
				useStructuredHunks: false,
			},
		};
		return { deps, listChangedFiles, countDiffLines, gatherDiff, log };
	}

	it("scopes the review to lastPassSha..HEAD when incremental review is enabled", async () => {
		const pi = createMockPi();
		const reviewer = createMockReviewerExecution(makePassReport());
		const { deps, listChangedFiles, countDiffLines, gatherDiff, log } =
			createIncrementalDeps(makePassReport());
		const dispatch = createPrReviewDispatch({
			...deps,
			reviewerExecution: reviewer,
		});
		const input = createInput(pi);
		input.state.tokens.stampPass({
			sha: OLD_PASS_SHA,
			passedAt: 1000,
			reportStatus: "PASS",
		});

		const result = await dispatch.dispatch(input);

		expect(result.stamped).toBe(true);
		expect(listChangedFiles).toHaveBeenCalledWith("/repo", OLD_PASS_SHA);
		expect(countDiffLines).toHaveBeenCalledWith(
			["src/a.ts"],
			"/repo",
			OLD_PASS_SHA,
		);
		expect(gatherDiff).toHaveBeenCalledWith(
			["src/a.ts"],
			"/repo",
			PR_REVIEW_CONFIG.maxDiffLines,
			OLD_PASS_SHA,
			expect.objectContaining({ respectGitignore: true }),
			false,
		);
		expect(reviewer.runAttempt).toHaveBeenCalledWith(
			expect.objectContaining({ baseRef: OLD_PASS_SHA }),
		);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("incremental review: scoping review"),
		);
		// The fresh PASS for HEAD becomes the new last-PASS sha.
		expect(input.state.tokens.lastPassSha()).toBe(HEAD_SHA);
	});

	it("ignores the last-PASS sha when incremental review is disabled", async () => {
		const pi = createMockPi();
		const listChangedFiles = vi.fn().mockResolvedValue(["src/a.ts"]);
		const dispatch = createPrReviewDispatch({
			...createTestDeps(makePassReport()),
			listChangedFiles,
			reviewConfig: { ...PR_REVIEW_CONFIG, incrementalReview: false },
		});
		const input = createInput(pi);
		input.state.tokens.stampPass({
			sha: OLD_PASS_SHA,
			passedAt: 1000,
			reportStatus: "PASS",
		});

		await dispatch.dispatch(input);

		expect(listChangedFiles).toHaveBeenCalledWith("/repo", BASE_REF);
	});

	it("prefers an explicit base ref over incremental scoping", async () => {
		const pi = createMockPi();
		const { deps, listChangedFiles } = createIncrementalDeps(makePassReport());
		const dispatch = createPrReviewDispatch(deps);
		const input = createInput(pi, { baseRef: "feature/base" });
		input.state.tokens.stampPass({
			sha: OLD_PASS_SHA,
			passedAt: 1000,
			reportStatus: "PASS",
		});

		await dispatch.dispatch(input);

		expect(listChangedFiles).toHaveBeenCalledWith("/repo", "feature/base");
	});

	it("falls back to the default base when the last-PASS sha IS the current HEAD (re-review)", async () => {
		const pi = createMockPi();
		const { deps, listChangedFiles } = createIncrementalDeps(makePassReport());
		const dispatch = createPrReviewDispatch(deps);
		const input = createInput(pi, { isReReview: true });
		input.state.tokens.stampPass({
			sha: HEAD_SHA,
			passedAt: 1000,
			reportStatus: "PASS",
		});

		const result = await dispatch.dispatch(input);

		expect(result.stamped).toBe(true);
		expect(listChangedFiles).toHaveBeenCalledWith("/repo", BASE_REF);
	});

	it("falls back to the default base when the last-PASS sha no longer resolves", async () => {
		const pi = createMockPi();
		const { deps, listChangedFiles, log } = createIncrementalDeps(
			makePassReport(),
		);
		const dispatch = createPrReviewDispatch({
			...deps,
			verifyRef: () => false,
		});
		const input = createInput(pi);
		input.state.tokens.stampPass({
			sha: OLD_PASS_SHA,
			passedAt: 1000,
			reportStatus: "PASS",
		});

		await dispatch.dispatch(input);

		expect(listChangedFiles).toHaveBeenCalledWith("/repo", BASE_REF);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("no longer resolves"),
		);
	});

	it("falls back to the default base when the last-PASS sha is not an ancestor of HEAD", async () => {
		const pi = createMockPi();
		const { deps, listChangedFiles, log } = createIncrementalDeps(
			makePassReport(),
		);
		const dispatch = createPrReviewDispatch({
			...deps,
			verifyAncestry: () => false,
		});
		const input = createInput(pi);
		input.state.tokens.stampPass({
			sha: OLD_PASS_SHA,
			passedAt: 1000,
			reportStatus: "PASS",
		});

		await dispatch.dispatch(input);

		expect(listChangedFiles).toHaveBeenCalledWith("/repo", BASE_REF);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("not an ancestor of HEAD"),
		);
	});

	it("uses the default base for the first review (no PASS token yet)", async () => {
		const pi = createMockPi();
		const { deps, listChangedFiles } = createIncrementalDeps(makePassReport());
		const dispatch = createPrReviewDispatch(deps);

		await dispatch.dispatch(createInput(pi));

		expect(listChangedFiles).toHaveBeenCalledWith("/repo", BASE_REF);
	});
});

describe("resolveHeadSha", () => {
	it("returns empty string outside a git repo", () => {
		const sha = resolveHeadSha(`/tmp/not-a-repo-${Date.now()}`);
		expect(sha).toBe("");
	});
});

describe("C6 opt-in below-threshold auto-PASS (dispatch wiring)", () => {
	function makeNitOnlyIssuesReport(): ReviewReport {
		return {
			status: "ISSUES",
			confidence: "MEDIUM",
			findings: [
				{
					severity: "NIT",
					domain: "quality",
					title: "naming",
					file: "src/x.ts",
					rule: "naming",
					issue: "x",
					evidence: "x",
					suggestion: "x",
				},
			],
			verified: [],
			unverifiable: [],
			testExecution: {
				status: "PASS",
				summary: "container-safe validation passed",
			},
			summary: "nits only",
		};
	}

	it("auto-stamps and does NOT block a NIT-only ISSUES report when autoPassOnNitOnly is ON", async () => {
		const pi = createMockPi();
		const dispatch = createPrReviewDispatch(
			createTestDeps(makeNitOnlyIssuesReport()),
		);
		const input = createInput(pi, {
			state: createPrGateState({ autoPassOnNitOnly: true }),
		});

		const result = await dispatch.dispatch(input);

		expect(result.stamped).toBe(true);
		expect(result.blocked).toBe(false);
		expect(input.state.tokens.hasPass(HEAD_SHA)).toBe(true);
	});

	it("blocks a NIT-only ISSUES report when autoPassOnNitOnly is OFF (default)", async () => {
		const pi = createMockPi();
		const dispatch = createPrReviewDispatch(
			createTestDeps(makeNitOnlyIssuesReport()),
		);
		const input = createInput(pi);

		const result = await dispatch.dispatch(input);

		expect(result.stamped).toBe(false);
		expect(result.blocked).toBe(true);
		expect(input.state.tokens.hasPass(HEAD_SHA)).toBe(false);
	});

	it("does NOT auto-pass a WARNING ISSUES report even when autoPassOnNitOnly is ON", async () => {
		const pi = createMockPi();
		const dispatch = createPrReviewDispatch(createTestDeps(makeIssuesReport()));
		const input = createInput(pi, {
			state: createPrGateState({ autoPassOnNitOnly: true }),
		});

		const result = await dispatch.dispatch(input);

		expect(result.stamped).toBe(false);
		expect(result.blocked).toBe(true);
		expect(input.state.tokens.hasPass(HEAD_SHA)).toBe(false);
	});
});
