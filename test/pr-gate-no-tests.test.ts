import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrGateState } from "../src/pr-gate/index.js";
import { createOrchestratorReviewerExecution } from "../src/pr-gate/orchestrator-reviewer-execution.js";
import { PR_REVIEW_CONFIG } from "../src/pr-gate/pr-review-config.js";
import { getPassBlockingTestExecutionReason } from "../src/pr-gate/pr-review-dispatch.js";
import {
	formatTestExecutionPlan,
	recommendTestCommands,
} from "../src/pr-gate/test-execution.js";
import { parseReviewReport } from "../src/shared/review-report.js";
import { parseReviewValidationPolicy } from "../src/shared/review-validation-policy.js";
import {
	createDispatchContext,
	createDispatchFixture,
	createFixtureReviewerExecution,
	DISPATCH_HEAD_SHA,
} from "./dispatch-fixtures.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

function fixture(required: boolean) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-no-tests-"));
	roots.push(cwd);
	fs.writeFileSync(path.join(cwd, "README.md"), "# Pilot\n");
	if (required) {
		fs.writeFileSync(path.join(cwd, "package.json"), "{}");
		fs.writeFileSync(path.join(cwd, "tsconfig.json"), "{}");
	}
	return cwd;
}

function report(status: string) {
	return parseReviewReport(
		[
			"## Review Report",
			"STATUS: PASS",
			"CONFIDENCE: HIGH",
			"### Findings",
			"None.",
			...(status === "MISSING"
				? []
				: [
						"### Test execution",
						`- **Status:** ${status}`,
						"- **Summary:** No validation calls proposed; documentation inspected.",
					]),
			"### Summary",
			"Documentation reviewed.",
		].join("\n"),
	);
}

async function dispatch(cwd: string, status: string, truncated = false) {
	const parsed = report(status);
	if (!parsed) throw new Error("Invalid fixture report");
	const state = createPrGateState();
	const runAttempt = vi.fn(async () => ({
		report: {
			...parsed,
			...(truncated
				? { diffCoverage: { truncated: true, omittedLines: 1, maxLines: 10 } }
				: {}),
		},
		// A bridge must not be able to erase a nonempty parent plan.
		requiredTestCommandCount: 0,
		rawOutput: "fixture",
		exitCode: 0,
		timedOut: false,
		stderr: "",
		command: "fixture",
	}));
	const reviewer = createDispatchFixture({
		getBaseRef: () => "HEAD~1",
		isWorktreeClean: () => true,
		listChangedFiles: async () => ["README.md"],
		applyDiffFilters: async (files) => files,
		countDiffLines: async () => 1,
		gatherDiff: async () => ({
			text: "docs diff",
			truncated: false,
			omittedLines: 0,
		}),
		reviewerExecution: createFixtureReviewerExecution(runAttempt),
	});
	const result = await reviewer.dispatch({
		ctx: createDispatchContext(cwd),
		state,
		pi: { sendUserMessage: vi.fn() } as never,
	});
	return { result, state, runAttempt };
}

describe("zero-call review validation", () => {
	it("parses explicit NOT_APPLICABLE without treating it as NOT_RUN", () => {
		expect(report("NOT_APPLICABLE")?.testExecution?.status).toBe(
			"NOT_APPLICABLE",
		);
	});

	for (const count of [undefined, -1, 1, Number.NaN]) {
		it(`rejects NOT_APPLICABLE without a confirmed zero count (${count})`, () => {
			const parsed = report("NOT_APPLICABLE");
			if (!parsed) throw new Error("Invalid fixture report");
			expect(getPassBlockingTestExecutionReason(parsed, count)).not.toBeNull();
		});
	}

	for (const count of [0, 1, undefined]) {
		it(`uses parent plan size in orchestrator diagnostics (${count})`, async () => {
			const bridge = createOrchestratorReviewerExecution(
				{ getActiveTools: () => ["orchestrate"], sendUserMessage: vi.fn() },
				{
					deadlineAdapter: {
						protocol: "review-deadline-v1",
						register: () => ({ cancel: () => {}, dispose: () => {} }),
					},
				},
			);
			try {
				const pending = bridge.reviewerExecution.runAttempt({
					task: "Review docs",
					files: ["README.md"],
					cwd: "/fixture",
					config: PR_REVIEW_CONFIG,
					headSha: DISPATCH_HEAD_SHA,
					requiredTestCommandCount: count,
				});
				const requestId = bridge.getStatus().pending[0].requestId;
				bridge.handleToolResult({
					toolName: "orchestrate",
					input: {
						agentType: "verifier",
						profile: "pr-review",
						task: requestId,
					},
					content: [
						{
							type: "text",
							text: "## Review Report\nSTATUS: PASS\nCONFIDENCE: HIGH\n### Findings\nNone.\n### Test execution\n- **Status:** NOT_APPLICABLE\n- **Summary:** Docs only\n### Summary\nReviewed.",
						},
					],
				});
				await pending;
				const detail = bridge.getStatus().lastDiagnostic?.detail;
				expect(detail).toContain(
					count === 0
						? "final authorization belongs to dispatch"
						: "test execution status is NOT_APPLICABLE",
				);
			} finally {
				bridge.dispose();
			}
		});
	}

	it("renders a zero-call plan without inventing an unavailable runner", () => {
		const cwd = fixture(false);
		const plan = recommendTestCommands(
			["README.md"],
			cwd,
			parseReviewValidationPolicy({}),
		);
		expect(plan.runnerCommands).toEqual([]);
		const rendered = formatTestExecutionPlan(plan);
		expect(rendered).toContain("NOT_APPLICABLE");
		expect(rendered).toContain("No validation calls are proposed");
		expect(rendered).not.toContain("No safe validation runner is available");
	});

	it("stamps the exact HEAD for a reviewed zero-call plan", async () => {
		const { result, state } = await dispatch(fixture(false), "NOT_APPLICABLE");
		expect(result.blocked).toBe(false);
		expect(result.stamped).toBe(true);
		expect(result.report?.testExecution?.status).toBe("NOT_APPLICABLE");
		expect(state.tokens.hasPass(DISPATCH_HEAD_SHA)).toBe(true);
	});

	for (const status of ["MISSING", "NOT_RUN", "FAIL"]) {
		it(`still blocks ${status} even with no proposed calls`, async () => {
			const { result, state } = await dispatch(fixture(false), status);
			expect(result.blocked).toBe(true);
			expect(result.stamped).toBe(false);
			expect(state.tokens.hasPass(DISPATCH_HEAD_SHA)).toBe(false);
		});
	}

	for (const status of ["NOT_APPLICABLE", "MISSING", "NOT_RUN", "FAIL"]) {
		it(`blocks ${status} when the parent plan requires validation`, async () => {
			const { result, state } = await dispatch(fixture(true), status);
			expect(result.blocked).toBe(true);
			expect(result.stamped).toBe(false);
			expect(state.tokens.hasPass(DISPATCH_HEAD_SHA)).toBe(false);
		});
	}

	it("still accepts completed required validation", async () => {
		const { result } = await dispatch(fixture(true), "PASS");
		expect(result.stamped).toBe(true);
	});

	it("does not bypass the truncated-diff gate", async () => {
		const { result, state } = await dispatch(
			fixture(false),
			"NOT_APPLICABLE",
			true,
		);
		expect(result.stamped).toBe(false);
		expect(state.tokens.hasPass(DISPATCH_HEAD_SHA)).toBe(false);
		expect(result.message).toContain("PARTIAL");
	});
});
