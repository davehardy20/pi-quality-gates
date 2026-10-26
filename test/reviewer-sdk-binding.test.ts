import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PR_REVIEW_CONFIG } from "../src/pr-gate/pr-review-config.js";
import {
	createReviewerExecution,
	type ReviewerAttemptInput,
	type ReviewerResult,
} from "../src/pr-gate/reviewer.js";

const refused: ReviewerResult = {
	report: null,
	rawOutput: "",
	stderr: "fixed fixture refusal",
	exitCode: 1,
	timedOut: false,
	command: "fixed fixture; no process",
};
function fixture(task = "fixed task") {
	const ctx = { cwd: "/owned-binding-fixture" } as ExtensionContext;
	const input: ReviewerAttemptInput = {
		task,
		files: ["fixed.ts"],
		cwd: ctx.cwd,
		config: PR_REVIEW_CONFIG,
		diff: "fixed owned fixture diff",
	};
	const launch = vi.fn(async () => refused);
	const legacy = vi.fn(async () => {
		throw new Error("legacy CLI must not run");
	});
	const bindHostSpawner = vi.fn(() => launch);
	const execution = createReviewerExecution({
		getPromptsDir: () => "/unused-fixture",
		readSystemPrompt: () => "fixed fixture system prompt",
		renderSystemPrompt: (value) => value,
		renderTaskTemplate: () => task,
		spawnReviewer: legacy,
		bindHostSpawner,
	});
	return { ctx, input, launch, legacy, bindHostSpawner, execution };
}

describe("host SDK binding with inert owned execution ports", () => {
	it("binds the actual caller separately from serializable review inputs", async () => {
		const f = fixture();
		const result = await f.execution.runAttempt(f.input, f.ctx);
		expect(result).toEqual(refused);
		expect(f.bindHostSpawner).toHaveBeenCalledWith(f.ctx, f.input);
		expect(f.launch).toHaveBeenCalledOnce();
		expect(f.legacy).not.toHaveBeenCalled();
		expect(f.input).not.toHaveProperty("ctx");
	});

	it("refuses missing caller context without falling back to a CLI", async () => {
		const f = fixture();
		const result = await f.execution.runAttempt(f.input);
		expect(result.report).toBeNull();
		expect(result.stderr).toContain("caller context");
		expect(f.bindHostSpawner).not.toHaveBeenCalled();
		expect(f.launch).not.toHaveBeenCalled();
		expect(f.legacy).not.toHaveBeenCalled();
	});

	it("checks the unchanged full prompt budget before binding any runtime", async () => {
		const f = fixture("x".repeat(100_001));
		const result = await f.execution.runAttempt(f.input, f.ctx);
		expect(result.promptBudgetExceeded).toBe(true);
		expect(f.bindHostSpawner).not.toHaveBeenCalled();
		expect(f.launch).not.toHaveBeenCalled();
		expect(f.legacy).not.toHaveBeenCalled();
	});
});
