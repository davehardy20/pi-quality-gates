import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	buildReviewerChildEnv,
	checkReviewerPromptBudget,
	createBoundedLineProcessor,
	createBoundedTextCapture,
	createReviewerExecution,
	type ReviewerResult,
	renderTaskTemplate,
} from "../src/pr-gate/reviewer.js";
import type { ReviewConfig } from "../src/shared/review-config.js";
import {
	formatReportForDisplay,
	parseReviewReport,
} from "../src/shared/review-report.js";
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

	it("delivers execution-policy trace guidance to the host spawn sink", async () => {
		let receivedSystemPrompt = "";
		const spawnReviewer = vi.fn(
			async (_task, systemPrompt: string, config: ReviewConfig) => {
				receivedSystemPrompt = systemPrompt;
				return passResult(config.model ?? "unknown");
			},
		);
		const exec = createReviewerExecution({
			getPromptsDir: () =>
				fileURLToPath(new URL("../src/pr-gate/prompts", import.meta.url)),
			spawnReviewer: spawnReviewer as never,
		});

		await exec.runAttempt({
			task: "change sandbox policy",
			files: ["src/category.ts"],
			cwd: "/repo",
			diff: "policy diff",
			config: makeConfig("review-model"),
		});

		expect(spawnReviewer).toHaveBeenCalledOnce();
		expect(receivedSystemPrompt).toContain("Execution Policy Trace");
		expect(receivedSystemPrompt).toMatch(
			/dispatch\/preflight.*spawn\/runtime/is,
		);
		expect(receivedSystemPrompt).toMatch(/enforcement sink/i);
	});

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

	it("retries when startup noise is the only child output", async () => {
		const calls: Array<string | null> = [];
		const startupNoise =
			"Configuration file not found at /tmp/.pi/settings.json. Using defaults.\n";
		const spawnReviewer = vi.fn(
			async (_task, _prompt, config: ReviewConfig) => {
				calls.push(config.model);
				if (config.model === "primary/model") {
					return {
						...emptyFailureResult(config.model),
						rawOutput: startupNoise,
						stderr: startupNoise,
					};
				}
				return passResult(config.model ?? "unknown");
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
			config: makeConfig("primary/model", ["fallback/model"]),
		});

		expect(calls).toEqual(["primary/model", "fallback/model"]);
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

describe("formatReportForDisplay diff coverage", () => {
	it("surfaces PARTIAL coverage when the diff was truncated", () => {
		const out = formatReportForDisplay({
			status: "PASS",
			confidence: "HIGH",
			findings: [],
			verified: [],
			unverifiable: [],
			summary: "",
			diffCoverage: { truncated: true, omittedLines: 500, maxLines: 4000 },
		});
		expect(out).toContain("Diff coverage");
		expect(out).toContain("PARTIAL review");
		expect(out).toContain("500 lines");
	});

	it("surfaces 100% complete coverage when the diff was not truncated", () => {
		const out = formatReportForDisplay({
			status: "PASS",
			confidence: "HIGH",
			findings: [],
			verified: [],
			unverifiable: [],
			summary: "",
			diffCoverage: { truncated: false, omittedLines: 0, maxLines: 4000 },
		});
		expect(out).toContain("100%");
		expect(out).toContain("complete");
	});

	it("omits the coverage section when diffCoverage is absent", () => {
		const out = formatReportForDisplay({
			status: "PASS",
			confidence: "HIGH",
			findings: [],
			verified: [],
			unverifiable: [],
			summary: "",
		});
		expect(out).not.toContain("Diff coverage");
	});
});

describe("formatReportForDisplay findings and test execution", () => {
	it("renders findings with severity, loc, effort, and suggestion", () => {
		const out = formatReportForDisplay({
			status: "ISSUES",
			confidence: "MEDIUM",
			findings: [
				{
					severity: "WARNING",
					domain: "correctness",
					title: "Missing null check",
					file: "src/foo.ts",
					line: 42,
					rule: "null-guard",
					issue: "Dereference may be null.",
					evidence: "return x.value;",
					effort: 10,
					suggestion: "Guard with optional chaining.",
				},
				{
					severity: "NIT",
					domain: "quality",
					title: "Rename helper",
					file: "",
					rule: "naming",
					issue: "Name is unclear.",
					evidence: "function x() {}",
					suggestion: "",
					effort: null,
				},
			],
			verified: [],
			unverifiable: [],
			summary: "Two findings.",
			testExecution: {
				status: "PASS",
				summary: "vitest and typecheck passed",
				sidecarRef: "tool-output:abc",
			},
		});

		expect(out).toContain("**Review: ISSUES** (confidence: MEDIUM)");
		expect(out).toContain("### Findings");
		expect(out).toContain("- **[WARNING]** Missing null check `src/foo.ts:42`");
		expect(out).toContain("  - ⏱ ~10 min to fix");
		expect(out).toContain("  - 💡 Guard with optional chaining.");
		// NIT finding with no file/line renders an empty loc and no effort line
		expect(out).toContain("- **[NIT]** Rename helper ``");
		expect(out).toContain("### Test execution");
		expect(out).toContain("- **Status:** PASS");
		expect(out).toContain("- **Summary:** vitest and typecheck passed");
		expect(out).toContain("- **Sidecar:** tool-output:abc");
		expect(out).toContain("Two findings.");
	});
});

describe("buildReviewerChildEnv", () => {
	it("sets the Compact+ auto-compaction kill switch without dropping parent env", () => {
		const env = buildReviewerChildEnv({ FOO: "bar" });
		expect(env.COMPACT_PLUS_DISABLE_AUTO_COMPACTION).toBe("true");
		expect(env.FOO).toBe("bar");
	});

	it("overrides an inherited kill-switch value", () => {
		const env = buildReviewerChildEnv({
			COMPACT_PLUS_DISABLE_AUTO_COMPACTION: "false",
		});
		expect(env.COMPACT_PLUS_DISABLE_AUTO_COMPACTION).toBe("true");
	});

	it("defaults to the real process env", () => {
		const env = buildReviewerChildEnv();
		expect(env.COMPACT_PLUS_DISABLE_AUTO_COMPACTION).toBe("true");
		expect(env.PATH).toBe(process.env.PATH);
	});
});

describe("checkReviewerPromptBudget", () => {
	it("allows prompts within the configured budget", () => {
		const result = checkReviewerPromptBudget("x".repeat(1000), {
			...baseBudgetConfig(),
			maxReviewerPromptChars: 1000,
		});
		expect(result.ok).toBe(true);
		expect(result.actualChars).toBe(1000);
		expect(result.maxChars).toBe(1000);
		expect(result.message).toBeUndefined();
	});

	it("rejects prompts over budget with an actionable message", () => {
		const result = checkReviewerPromptBudget("x".repeat(1500), {
			...baseBudgetConfig(),
			maxReviewerPromptChars: 1000,
		});
		expect(result.ok).toBe(false);
		expect(result.actualChars).toBe(1500);
		expect(result.maxChars).toBe(1000);
		expect(result.message).toContain("1500/1000");
	});

	it("defaults to 100000 chars when the config omits the budget", () => {
		const result = checkReviewerPromptBudget(
			"x".repeat(100_001),
			baseBudgetConfig(),
		);
		expect(result.ok).toBe(false);
		expect(result.maxChars).toBe(100_000);
	});
});

function baseBudgetConfig(): ReviewConfig {
	return {
		model: null,
		fallbackModels: [],
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

describe("createReviewerExecution prompt budget", () => {
	function budgetPassResult() {
		const report: ReviewReport = {
			status: "PASS",
			confidence: "HIGH",
			findings: [],
			verified: [],
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
			command: "pi ...",
		};
	}

	it("does not spawn when the rendered task prompt exceeds the budget", async () => {
		const spawnReviewer = vi.fn();
		const exec = createReviewerExecution({
			getPromptsDir: () => "/prompts",
			spawnReviewer: spawnReviewer as never,
			readSystemPrompt: () => "sys",
			renderTaskTemplate: () => "x".repeat(1500),
		});
		const result = await exec.runAttempt({
			task: "t",
			files: ["a.ts"],
			cwd: "/r",
			diff: "(stub)",
			config: { ...baseBudgetConfig(), maxReviewerPromptChars: 1000 },
		});

		expect(spawnReviewer).not.toHaveBeenCalled();
		expect(result.report).toBeNull();
		expect(result.promptBudgetExceeded).toBe(true);
		expect(result.rawOutput).toContain("1000");
		expect(result.rawOutput).toContain("1500");
	});

	it("falls through to the reviewer when within budget", async () => {
		const spawnReviewer = vi.fn(async () => budgetPassResult());
		const exec = createReviewerExecution({
			getPromptsDir: () => "/prompts",
			spawnReviewer: spawnReviewer as never,
			readSystemPrompt: () => "sys",
			renderTaskTemplate: () => "short task",
		});
		const result = await exec.runAttempt({
			task: "t",
			files: ["a.ts"],
			cwd: "/r",
			diff: "(stub)",
			config: { ...baseBudgetConfig(), maxReviewerPromptChars: 1000 },
		});

		expect(spawnReviewer).toHaveBeenCalledOnce();
		expect(result.report?.status).toBe("PASS");
	});
});

describe("checkReviewerPromptBudget disable semantics", () => {
	it("treats 0 as guard-disabled", () => {
		const result = checkReviewerPromptBudget("x".repeat(50_000), {
			...baseBudgetConfig(),
			maxReviewerPromptChars: 0,
		});
		expect(result.ok).toBe(true);
		expect(result.maxChars).toBe(0);
	});

	it("treats negative values as guard-disabled (-1 = no limit convention)", () => {
		const result = checkReviewerPromptBudget("x".repeat(50_000), {
			...baseBudgetConfig(),
			maxReviewerPromptChars: -1,
		});
		expect(result.ok).toBe(true);
	});
});
