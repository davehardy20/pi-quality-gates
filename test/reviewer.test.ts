import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createBoundedLineProcessor,
	createBoundedTextCapture,
	createReviewerExecution,
	parseReviewReport,
	type ReviewerResult,
	renderTaskTemplate,
} from "../src/pr-gate/reviewer.js";
import type { ReviewConfig } from "../src/shared/review-config.js";
import type { ReviewReport } from "../src/shared/review-types.js";

describe("parseReviewReport", () => {
	it("parses a well-formed review report", () => {
		const output = [
			"## Review Report",
			"STATUS: PASS",
			"CONFIDENCE: HIGH",
			"",
			"### Findings",
			"None.",
			"",
			"### What was verified",
			"- Foo",
			"",
			"### What could not be verified",
			"- Bar",
			"",
			"### Test execution",
			"- **Status:** PASS",
			"- **Summary:** run_vitest and run_typecheck passed",
			"- **Sidecar:** tool-output:abc123",
			"",
			"### Summary",
			"Looks good.",
		].join("\n");

		const report = parseReviewReport(output);
		expect(report).not.toBeNull();
		expect(report?.status).toBe("PASS");
		expect(report?.confidence).toBe("HIGH");
		expect(report?.findings).toEqual([]);
		expect(report?.verified).toEqual(["Foo"]);
		expect(report?.unverifiable).toEqual(["Bar"]);
		expect(report?.testExecution).toEqual({
			status: "PASS",
			summary: "run_vitest and run_typecheck passed",
			sidecarRef: "tool-output:abc123",
		});
		expect(report?.summary).toBe("Looks good.");
	});

	it("defaults malformed test execution status to NOT_RUN", () => {
		const output = [
			"## Review Report",
			"STATUS: CANNOT_REVIEW",
			"CONFIDENCE: LOW",
			"",
			"### Findings",
			"None.",
			"",
			"### Test execution",
			"- **Status:** blocked",
			"- **Summary:** container bridge unavailable",
			"- **Sidecar:** none",
			"",
			"### Summary",
			"Could not validate.",
		].join("\n");

		const report = parseReviewReport(output);

		expect(report?.testExecution).toEqual({
			status: "NOT_RUN",
			summary: "container bridge unavailable",
			sidecarRef: "none",
		});
	});

	it("returns null when the report marker is missing", () => {
		expect(parseReviewReport("just some chatter")).toBeNull();
	});

	it("returns null when STATUS is missing", () => {
		const output = "## Review Report\nCONFIDENCE: HIGH\n";
		expect(parseReviewReport(output)).toBeNull();
	});

	it("is case-insensitive and tolerant of markdown formatting", () => {
		const output = [
			"  ## Review Report  ",
			"**STATUS:** issues",
			"CONFIDENCE: medium",
			"",
			"### Findings",
			"None.",
			"",
			"### Summary",
			"OK.",
		].join("\n");

		const report = parseReviewReport(output);
		expect(report).not.toBeNull();
		expect(report?.status).toBe("ISSUES");
		expect(report?.confidence).toBe("MEDIUM");
	});

	it("finds a report marker embedded in large output", () => {
		const prefix = "a".repeat(500_000);
		const suffix =
			"\n## Review Report\nSTATUS: PASS\nCONFIDENCE: LOW\n### Findings\nNone.\n### Summary\nOK.\n";
		const report = parseReviewReport(prefix + suffix);
		expect(report?.status).toBe("PASS");
		expect(report?.confidence).toBe("LOW");
	});

	it("tolerates preamble/chatter before ## Review Report (orchestrated child output)", () => {
		const output = [
			"Sure, here is my review of this change.",
			"",
			"I checked the diff and ran the tests.",
			"",
			"## Review Report",
			"STATUS: PASS",
			"CONFIDENCE: HIGH",
			"",
			"### Findings",
			"None.",
			"",
			"### What was verified",
			"- No blocking findings",
			"",
			"### What could not be verified",
			"None.",
			"",
			"### Test execution",
			"- **Status:** PASS",
			"- **Summary:** run_typecheck passed",
			"",
			"### Summary",
			"Final summary: PASS",
		].join("\n");
		const report = parseReviewReport(output);
		expect(report).not.toBeNull();
		expect(report?.status).toBe("PASS");
		expect(report?.testExecution?.status).toBe("PASS");
		expect(report?.summary).toBe("Final summary: PASS");
	});
});

describe("parseReviewReport finding effort", () => {
	const baseReport = (findingsBlock: string) =>
		[
			"## Review Report",
			"STATUS: ISSUES",
			"CONFIDENCE: HIGH",
			"",
			"### Findings",
			findingsBlock,
			"",
			"### Summary",
			"Has a finding.",
		].join("\n");

	it("parses an integer effort estimate in minutes", () => {
		const output = baseReport(
			[
				"#### [WARNING] Off-by-one loop",
				"- **File:** src/loop.ts:12",
				"- **Category:** correctness",
				"- **Rule:** loop boundaries",
				"- **Issue:** exclusive end",
				"- **Evidence:** for i in range(0, n)",
				"- **Suggestion:** use range(0, n + 1)",
				"- **Effort:** 5",
			].join("\n"),
		);
		const report = parseReviewReport(output);
		expect(report?.findings).toHaveLength(1);
		expect(report?.findings[0].effort).toBe(5);
	});

	it("parses effort with a `min` suffix", () => {
		const output = baseReport(
			[
				"#### [NIT] Naming",
				"- **File:** src/x.ts:1",
				"- **Category:** quality",
				"- **Effort:** 10 min",
			].join("\n"),
		);
		expect(parseReviewReport(output)?.findings[0].effort).toBe(10);
	});

	it("parses a leading `~` estimate", () => {
		const output = baseReport(
			[
				"#### [WARNING] Missing test",
				"- **File:** src/x.test.ts",
				"- **Effort:** ~15",
			].join("\n"),
		);
		expect(parseReviewReport(output)?.findings[0].effort).toBe(15);
	});

	it("coerces an explicit N/A to null", () => {
		const output = baseReport(
			[
				"#### [CRITICAL] Something",
				"- **File:** src/x.ts:5",
				"- **Effort:** N/A",
			].join("\n"),
		);
		expect(parseReviewReport(output)?.findings[0].effort).toBeNull();
	});

	it("omits effort when the field is absent", () => {
		const output = baseReport(
			[
				"#### [WARNING] Something",
				"- **File:** src/x.ts:5",
				"- **Category:** quality",
			].join("\n"),
		);
		const finding = parseReviewReport(output)?.findings[0];
		expect(finding).toBeDefined();
		expect(finding?.effort).toBeUndefined();
	});
});

describe("bounded reviewer output capture", () => {
	it("retains a bounded tail and reports oversized multi-chunk output", () => {
		const capture = createBoundedTextCapture(10);
		capture.append("123456");
		capture.append("7890abcdef");
		expect(capture.value()).toBe("7890abcdef");
		expect(capture.totalChars()).toBe(16);
		expect(capture.overflowed()).toBe(true);
	});

	it("bounds an unterminated JSON line before process close", () => {
		const lines: string[] = [];
		const processor = createBoundedLineProcessor(16, (line) =>
			lines.push(line),
		);
		processor.append("x".repeat(1_000_000));
		expect(processor.bufferedChars()).toBe(16);
		expect(processor.overflowed()).toBe(true);
		processor.flush();
		expect(lines).toEqual([]);
	});

	it("continues parsing lines after an oversized line", () => {
		const lines: string[] = [];
		const processor = createBoundedLineProcessor(8, (line) => lines.push(line));
		processor.append(`${"x".repeat(100)}\nok\n`);
		expect(processor.overflowed()).toBe(true);
		expect(lines).toEqual(["ok"]);
	});
});

describe("createReviewerExecution model fallback", () => {
	function makeConfig(
		model: string | null,
		fallbackModels?: string[],
	): ReviewConfig {
		return {
			model,
			fallbackModels,
			minChangedLines: 0,
			enabled: true,
			maxReReviewPasses: 0,
			autoFixThreshold: "warning",
			maxTokens: 8192,
			timeoutMs: 600_000,
			tools: ["read"],
			allowedBashPatterns: [],
			respectGitignore: true,
			skipFile: null,
			allowTestDiscovery: false,
			testDiscoveryCommands: {},
			maxDiffLines: 4000,
			maxChangedLines: 5000,
			reviewDelayMs: 0,
		};
	}

	function emptyFailureResult(model: string): ReviewerResult {
		return {
			report: null,
			rawOutput: "",
			stderr: "",
			exitCode: 0,
			timedOut: false,
			usage: "â0 â0 $0.0000",
			command: `pi --model ${model}`,
		};
	}

	function passResult(model: string): ReviewerResult {
		const report: ReviewReport = {
			status: "PASS",
			confidence: "HIGH",
			findings: [],
			verified: ["tests pass"],
			unverifiable: [],
			testExecution: { status: "PASS", summary: "ok" },
			summary: "ok",
		};
		return {
			report,
			rawOutput: "## Review Report\nSTATUS: PASS\n",
			exitCode: 0,
			timedOut: false,
			stderr: "",
			command: `pi --model ${model}`,
		};
	}

	it("retries fallback models when primary produces an empty-output model failure", async () => {
		const calls: Array<string | null> = [];
		const spawnReviewer = vi.fn(
			async (_task, _prompt, config: ReviewConfig) => {
				const model = config.model ?? "unknown";
				calls.push(model);
				if (model === "openai-codex/gpt-5.5") {
					return emptyFailureResult(model);
				}
				return passResult(model);
			},
		);
		const exec = createReviewerExecution({
			getPromptsDir: () => "/prompts",
			spawnReviewer: spawnReviewer as never,
			readSystemPrompt: () => "sys",
			renderTaskTemplate: () => "task",
		});
		const result = await exec.runAttempt({
			task: "t",
			files: ["a.ts"],
			cwd: "/r",
			diff: "(stub)",
			config: makeConfig("openai-codex/gpt-5.5", [
				"zai/glm-5.2",
				"kimi-coding/kimi-for-coding",
			]),
		});
		expect(calls).toEqual(["openai-codex/gpt-5.5", "zai/glm-5.2"]);
		expect(result.report?.status).toBe("PASS");
	});

	it("returns the primary failure when every fallback also fails empty", async () => {
		const spawnReviewer = vi.fn(async (_task, _prompt, config: ReviewConfig) =>
			emptyFailureResult(config.model ?? "unknown"),
		);
		const exec = createReviewerExecution({
			getPromptsDir: () => "/prompts",
			spawnReviewer: spawnReviewer as never,
			readSystemPrompt: () => "sys",
			renderTaskTemplate: () => "task",
		});
		const result = await exec.runAttempt({
			task: "t",
			files: [],
			cwd: "/r",
			config: makeConfig("openai-codex/gpt-5.5", ["zai/glm-5.2"]),
		});
		expect(result.report).toBeNull();
		expect(result.command).toContain("openai-codex/gpt-5.5");
	});

	it("does not retry when the primary fails with real stderr output", async () => {
		const calls: Array<string | null> = [];
		const spawnReviewer = vi.fn(
			async (_task, _prompt, config: ReviewConfig) => {
				calls.push(config.model);
				return {
					report: null,
					rawOutput: "",
					stderr: "Error: auth failed",
					exitCode: 1,
					timedOut: false,
					command: "pi --model x",
				} satisfies ReviewerResult;
			},
		);
		const exec = createReviewerExecution({
			getPromptsDir: () => "/prompts",
			spawnReviewer: spawnReviewer as never,
			readSystemPrompt: () => "sys",
			renderTaskTemplate: () => "task",
		});
		await exec.runAttempt({
			task: "t",
			files: [],
			cwd: "/r",
			config: makeConfig("openai-codex/gpt-5.5", ["zai/glm-5.2"]),
		});
		expect(calls).toEqual(["openai-codex/gpt-5.5"]);
	});

	it("does not retry when no fallback models are configured", async () => {
		const calls: Array<string | null> = [];
		const spawnReviewer = vi.fn(
			async (_task, _prompt, config: ReviewConfig) => {
				const model = config.model ?? "unknown";
				calls.push(model);
				return emptyFailureResult(model);
			},
		);
		const exec = createReviewerExecution({
			getPromptsDir: () => "/prompts",
			spawnReviewer: spawnReviewer as never,
			readSystemPrompt: () => "sys",
			renderTaskTemplate: () => "task",
		});
		const result = await exec.runAttempt({
			task: "t",
			files: [],
			cwd: "/r",
			config: makeConfig("openai-codex/gpt-5.5"),
		});
		expect(calls).toEqual(["openai-codex/gpt-5.5"]);
		expect(result.report).toBeNull();
	});

	it("stamps self-gathered diffCoverage onto the report (reviewer-direct path)", async () => {
		const gatherDiff = vi.fn(async () => ({
			text: "structured diff",
			truncated: true,
			omittedLines: 1234,
		}));
		const spawnReviewer = vi.fn(async () => passResult("m"));
		const exec = createReviewerExecution({
			getPromptsDir: () => "/prompts",
			spawnReviewer: spawnReviewer as never,
			readSystemPrompt: () => "sys",
			renderTaskTemplate: () => "task",
			gatherDiff: gatherDiff as never,
		});
		const result = await exec.runAttempt({
			task: "t",
			files: ["a.ts"],
			cwd: "/r",
			config: makeConfig("m"),
		});
		expect(gatherDiff).toHaveBeenCalled();
		expect(result.report?.diffCoverage).toEqual({
			truncated: true,
			omittedLines: 1234,
			maxLines: 4000,
		});
	});

	it("stamps caller-supplied diffCoverage onto the report (dispatcher path)", async () => {
		const spawnReviewer = vi.fn(async () => passResult("m"));
		const exec = createReviewerExecution({
			getPromptsDir: () => "/prompts",
			spawnReviewer: spawnReviewer as never,
			readSystemPrompt: () => "sys",
			renderTaskTemplate: () => "task",
		});
		const result = await exec.runAttempt({
			task: "t",
			files: ["a.ts"],
			cwd: "/r",
			diff: "(precomputed)",
			diffCoverage: { truncated: false, omittedLines: 0, maxLines: 4000 },
			config: makeConfig("m"),
		});
		expect(result.report?.diffCoverage).toEqual({
			truncated: false,
			omittedLines: 0,
			maxLines: 4000,
		});
	});
});

describe("renderTaskTemplate extraInstructions", () => {
	function writeTemplate(dir: string): void {
		writeFileSync(
			join(dir, "task-template.md"),
			[
				"# PR Review — Task",
				"",
				"## Original Task",
				"",
				"{{TASK}}",
				"",
				"## Test Execution Plan",
				"",
				"{{TEST_PLAN}}",
				"",
				"{{EXTRA_INSTRUCTIONS}}",
				"",
				"---",
				"",
			].join("\n"),
		);
	}

	it("omits the Extra Instructions section when none is provided", () => {
		const dir = mkdtempSync(join(tmpdir(), "tmpl-none-"));
		try {
			writeTemplate(dir);
			const out = renderTaskTemplate(
				dir,
				"do the thing",
				["src/a.ts"],
				"DIFF",
				"PLAN",
			);
			expect(out).not.toContain("Extra Instructions");
			expect(out).toContain("do the thing");
			expect(out).toContain("PLAN");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("injects an Extra Instructions section when extraInstructions is set", () => {
		const dir = mkdtempSync(join(tmpdir(), "tmpl-extra-"));
		try {
			writeTemplate(dir);
			const out = renderTaskTemplate(
				dir,
				"do the thing",
				["src/a.ts"],
				"DIFF",
				"PLAN",
				"Focus on error-handling and log redaction.",
			);
			expect(out).toContain("## Extra Instructions");
			expect(out).toContain("Focus on error-handling and log redaction.");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores a whitespace-only extraInstructions", () => {
		const dir = mkdtempSync(join(tmpdir(), "tmpl-ws-"));
		try {
			writeTemplate(dir);
			const out = renderTaskTemplate(
				dir,
				"do the thing",
				["src/a.ts"],
				"DIFF",
				"PLAN",
				"  \n\t ",
			);
			expect(out).not.toContain("Extra Instructions");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
