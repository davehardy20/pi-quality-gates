import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorReviewerExecution } from "../src/pr-gate/orchestrator-reviewer-execution.js";
import { createPassTokenStore } from "../src/pr-gate/pass-token-store.js";
import { PR_REVIEW_CONFIG } from "../src/pr-gate/pr-review-config.js";
import { createPrReviewDispatch } from "../src/pr-gate/pr-review-dispatch.js";
import {
	type ReviewerAttemptInput,
	type ReviewerExecution,
	renderTaskTemplate,
} from "../src/pr-gate/reviewer.js";
import {
	formatTestExecutionPlan,
	recommendTestCommands,
} from "../src/pr-gate/test-execution.js";
import type { ReviewReport } from "../src/shared/review-types.js";
import { parseReviewValidationPolicy } from "../src/shared/review-validation-policy.js";

// Inert protocol fixtures only: no real reviewers, SDK, credentials or Git.
const roots: string[] = [];
function fixture(maxReviewerTimeoutMs = 7_200_000) {
	const cwd = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "qg-python-dispatch-")),
	);
	roots.push(cwd);
	fs.mkdirSync(path.join(cwd, "pkg/tests"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "pyproject.toml"), "");
	const files = ["pkg/tests/test_guard.py"];
	fs.writeFileSync(path.join(cwd, files[0]), "");
	const policy = parseReviewValidationPolicy(
		{
			qualityGates: {
				reviewValidation: {
					maxReviewerTimeoutMs,
					repoOverrides: { [cwd]: { [files[0]]: 1_800_000 } },
					pytestPartitions: {
						[cwd]: {
							keyword: "fresh_installed",
							matchingTimeoutMs: 210_000,
							remainingTimeoutMs: 300_000,
						},
					},
				},
			},
		},
		cwd,
	);
	const testPlan = formatTestExecutionPlan(
		recommendTestCommands(files, cwd, policy),
	);
	const input: ReviewerAttemptInput = {
		task: "fixture review",
		files,
		cwd,
		config: { ...PR_REVIEW_CONFIG, model: "fixture/model", fallbackModels: [] },
		diff: "fixture diff",
		baseRef: "fixture-base",
		headSha: "fixture-head",
		testPlan,
	};
	return { cwd, files, policy, input };
}
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

function syntheticReport(status: "PASS" | "FAIL" | "NOT_RUN"): ReviewReport {
	return {
		status: "PASS",
		confidence: "HIGH",
		findings: [],
		verified: [],
		unverifiable: [],
		testExecution: {
			status,
			summary:
				status === "PASS"
					? "synthetic fixture: targeted and both full-suite calls complete"
					: "synthetic fixture: matching partition incomplete",
		},
		summary: "synthetic protocol fixture, not actual validation evidence",
	};
}

function dispatchFixture(
	f: ReturnType<typeof fixture>,
	report: ReviewReport | null,
) {
	const runAttempt = vi.fn<ReviewerExecution["runAttempt"]>(async () => ({
		report,
		rawOutput: "fixture",
		exitCode: 0,
		timedOut: false,
		stderr: "",
		command: "fixture",
	}));
	const tokens = createPassTokenStore();
	const dispatch = createPrReviewDispatch({
		getHeadSha: () => "fixture-head",
		getBaseRef: () => "fixture-base",
		isWorktreeClean: () => true,
		listChangedFiles: async () => f.files,
		applyDiffFilters: async (files) => files,
		reviewConfig: f.input.config,
		loadReviewValidationPolicy: () => f.policy,
		countDiffLines: async () => 10,
		gatherDiff: async () => ({
			text: "fixture diff",
			truncated: false,
			omittedLines: 0,
		}),
		extractTask: () => "fixture review",
		reviewerExecution: { runAttempt },
	});
	return {
		runAttempt,
		tokens,
		run: () =>
			dispatch.dispatch({
				ctx: { cwd: f.cwd } as ExtensionContext,
				state: { tokens, config: { enabled: true } },
				pi: {} as ExtensionAPI,
			}),
	};
}

describe("Python partition plan transport and gate", () => {
	const statuses = ["PASS", "FAIL", "NOT_RUN", "MISSING"] as const;
	it.each(statuses)("preserves report gating: %s", async (status) => {
		const f = fixture();
		const report = syntheticReport(status === "MISSING" ? "PASS" : status);
		if (status === "MISSING") delete report.testExecution;
		const d = dispatchFixture(f, report);
		const result = await d.run();
		expect(d.runAttempt).toHaveBeenCalledOnce();
		const attempt = d.runAttempt.mock.calls[0][0];
		expect(attempt.testPlan).toBe(f.input.testPlan);
		expect(attempt.config.timeoutMs).toBe(2_910_000);
		expect(result.stamped).toBe(status === "PASS");
		expect(result.blocked).toBe(status !== "PASS");
		expect(d.tokens.hasPass("fixture-head")).toBe(status === "PASS");
	});

	it("refuses the total partition budget before invoking any reviewer", async () => {
		const d = dispatchFixture(fixture(2_850_000), syntheticReport("PASS"));
		const result = await d.run();
		expect(result.blocked).toBe(true);
		expect(result.message).toMatch(/required 2910000.*2850000/);
		expect(d.runAttempt).not.toHaveBeenCalled();
		expect(d.tokens.hasPass("fixture-head")).toBe(false);
	});

	it("renders the complete partition plan into the host task without starting the SDK", () => {
		const f = fixture();
		const prompts = fileURLToPath(
			new URL("../src/pr-gate/prompts/", import.meta.url),
		);
		const task = renderTaskTemplate(
			prompts,
			f.input.task,
			f.files,
			"fixture diff",
			f.input.testPlan,
		);
		expect(task).toContain(f.input.testPlan);
		expect(task).toContain('"keyword":"not (fresh_installed)"');
		expect(task).toContain('"keyword":"fresh_installed"');
	});

	it("relays complete JSON through inert orchestrator ports, never dispatching a real agent", async () => {
		const f = fixture();
		const sendUserMessage = vi.fn();
		const controller = new AbortController();
		const bridge = createOrchestratorReviewerExecution(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage },
			{
				deadlineAdapter: {
					protocol: "review-deadline-v1",
					register: () => ({ cancel: () => {}, dispose: () => {} }),
				},
			},
		);
		try {
			const pending = bridge.reviewerExecution.runAttempt({
				...f.input,
				signal: controller.signal,
			});
			expect(sendUserMessage).toHaveBeenCalledOnce();
			const instruction = String(sendUserMessage.mock.calls[0][0]);
			expect(instruction).toContain(f.input.testPlan);
			controller.abort();
			expect((await pending).report).toBeNull();
		} finally {
			controller.abort();
			bridge.dispose();
		}
	});
});
