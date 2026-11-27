import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrGateState } from "../src/pr-gate/index.js";
import { createOrchestratorReviewerExecution } from "../src/pr-gate/orchestrator-reviewer-execution.js";
import { PR_REVIEW_CONFIG } from "../src/pr-gate/pr-review-config.js";
import type { ReviewerAttemptInput } from "../src/pr-gate/reviewer.js";
import { parseReviewReport } from "../src/shared/review-report.js";
import {
	createDispatchContext,
	createDispatchFixture,
	createFixtureReviewerExecution,
} from "./dispatch-fixtures.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
function fixture(valid: boolean) {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "qg-config-dispatch-")),
	);
	roots.push(root);
	fs.mkdirSync(path.join(root, ".pi"));
	for (const file of ["package.json", "test.test.ts", "config.ts"])
		fs.writeFileSync(
			path.join(root, file),
			file === "package.json" ? "{}" : "",
		);
	fs.writeFileSync(
		path.join(root, ".pi/vitest-routing.json"),
		JSON.stringify({
			version: 1,
			routes: [
				{ files: ["test.test.ts"], config: valid ? "config.ts" : "missing.ts" },
			],
		}),
	);
	return root;
}
function pass() {
	const report = parseReviewReport(
		"## Review Report\nSTATUS: PASS\nCONFIDENCE: HIGH\n### Findings\nNone.\n### Test execution\n- **Status:** PASS\n- **Summary:** fixture\n### Summary\nfixture",
	);
	if (!report) throw new Error("Bad fixture report");
	return {
		report,
		rawOutput: "fixture",
		stderr: "",
		command: "fixture",
		exitCode: 0,
		timedOut: false,
	};
}
async function dispatch(valid: boolean) {
	const root = fixture(valid);
	const runAttempt = vi.fn(async (_input: ReviewerAttemptInput) => pass());
	const state = createPrGateState();
	const reviewer = createDispatchFixture({
		isWorktreeClean: () => true,
		listChangedFiles: async () => ["test.test.ts"],
		applyDiffFilters: async (files) => files,
		countDiffLines: async () => 1,
		gatherDiff: async () => ({
			text: "fixture",
			truncated: false,
			omittedLines: 0,
		}),
		reviewerExecution: createFixtureReviewerExecution(runAttempt),
	});
	const result = await reviewer.dispatch({
		ctx: createDispatchContext(root),
		state,
		pi: { sendUserMessage: vi.fn() } as never,
	});
	return { result, runAttempt, root, state };
}
describe("mechanical config-routing guards", () => {
	it("refuses an unresolved plan before a reviewer can claim PASS", async () => {
		const { result, runAttempt, state } = await dispatch(false);
		expect(runAttempt).not.toHaveBeenCalled();
		expect(result.blocked).toBe(true);
		expect(result.message).toContain("NOT_RUN");
		expect(state.tokens.size).toBe(0);
	});
	it("transports structured required configs separately from model prose", async () => {
		const { runAttempt, root } = await dispatch(true);
		expect(runAttempt).toHaveBeenCalledOnce();
		expect(runAttempt.mock.calls[0][0]).toMatchObject({
			requiredVitestCalls: [
				{
					cwd: root,
					config: "config.ts",
					paths: ["test.test.ts"],
					timeoutMs: 300000,
				},
			],
		});
		expect(runAttempt.mock.calls[0][0].testPlan).toContain(
			'"config":"config.ts"',
		);
	});
	it("blocks bridges without trusted selected-config completion capability", async () => {
		const sendUserMessage = vi.fn();
		const bridge = createOrchestratorReviewerExecution({
			getActiveTools: () => ["orchestrate"],
			sendUserMessage,
		});
		try {
			const result = await bridge.reviewerExecution.runAttempt({
				task: "fixture",
				files: ["test.test.ts"],
				cwd: "/fixture",
				config: PR_REVIEW_CONFIG,
				requiredVitestCalls: [
					{
						cwd: "/fixture",
						config: "config.ts",
						paths: ["test.test.ts"],
						timeoutMs: 300000,
					},
				],
			});
			expect(result.report).toBeNull();
			expect(result.stderr).toContain("selected-config");
			expect(sendUserMessage).not.toHaveBeenCalled();
		} finally {
			bridge.dispose();
		}
	});
});
