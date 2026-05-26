import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import qualityGatesExtension from "../src/index.js";
import {
	filterBuiltInIgnoredFiles,
	formatMarkdownlintResults,
	getLinterForFile,
	groupFilesByLinter,
	isBuiltInIgnoredAgentArtifact,
	DEFAULT_CONFIG as LinterDefaultConfig,
	parseJsoncConfig,
} from "../src/linter/core.js";
import { __test__ as linterTest } from "../src/linter/index.js";
import {
	buildSummaryFirstLintMessage,
	isQualityGatesSubAgentRuntime,
	recoverLinterReportSidecar,
	writeLinterReportSidecar,
} from "../src/linter/report-hygiene.js";
import { __test__ as reviewerTest } from "../src/reviewer/index.js";
import {
	capDiff,
	extractOriginalTask,
	parseReviewReport,
} from "../src/reviewer/reviewer.js";
import {
	filterSkipped,
	parseSkipContent,
	shouldSkip,
} from "../src/reviewer/reviewer-skip.js";
import type { ReviewerState } from "../src/reviewer/types.js";
import { DEFAULT_REVIEW_CONFIG } from "../src/reviewer/types.js";
import {
	normalizeAndSortPaths,
	normalizePath,
	pathsEqual,
} from "../src/shared/path-utils.js";

const {
	createPostTurnLinter,
	detectModifiedFilesFromToolEvent,
	detectModifiedFilesFromToolResult,
	tokenizeArgs,
} = linterTest;

const { formatPhaseStatus, severityMeetsThreshold } = reviewerTest;

// ── Post-Turn Linter tests ────────────────────────────────────────────

describe("post-turn-linter: detectModifiedFilesFromToolEvent", () => {
	it("detects a write tool event", () => {
		const files = detectModifiedFilesFromToolEvent({
			toolName: "write",
			args: { path: "/tmp/test.ts" },
		});
		expect(files).toEqual(["/tmp/test.ts"]);
	});

	it("detects an edit tool event", () => {
		const files = detectModifiedFilesFromToolEvent({
			toolName: "edit",
			args: { path: "/tmp/foo.ts" },
		});
		expect(files).toEqual(["/tmp/foo.ts"]);
	});

	it("detects a hashline_edit rename", () => {
		const files = detectModifiedFilesFromToolEvent({
			toolName: "hashline_edit",
			args: { filePath: "/tmp/old.ts", rename: "/tmp/new.ts" },
		});
		expect(files).toEqual(["/tmp/new.ts"]);
	});

	it("detects ast_grep_replace with multiple paths", () => {
		const files = detectModifiedFilesFromToolEvent({
			toolName: "ast_grep_replace",
			args: { paths: ["/tmp/a.ts", "/tmp/b.ts"] },
		});
		expect(files).toEqual(["/tmp/a.ts", "/tmp/b.ts"]);
	});

	it("returns empty for unknown tools", () => {
		const files = detectModifiedFilesFromToolEvent({
			toolName: "read",
			args: { path: "/tmp/test.ts" },
		});
		expect(files).toEqual([]);
	});
});

describe("post-turn-linter: detectModifiedFilesFromToolResult", () => {
	it("extracts modifiedFiles from result details", () => {
		const files = detectModifiedFilesFromToolResult({
			toolName: "write",
			result: {
				details: { modifiedFiles: ["/tmp/a.ts", "/tmp/b.ts"] },
			},
		});
		expect(files).toEqual(["/tmp/a.ts", "/tmp/b.ts"]);
	});

	it("returns null when no modifiedFiles in details", () => {
		const files = detectModifiedFilesFromToolResult({
			toolName: "write",
			result: { details: {} },
		});
		expect(files).toBeNull();
	});
});

describe("post-turn-linter: tokenizeArgs", () => {
	it("tokenizes simple arguments", () => {
		expect(tokenizeArgs("foo bar baz")).toEqual(["foo", "bar", "baz"]);
	});

	it("handles quoted arguments", () => {
		expect(tokenizeArgs('"hello world" foo')).toEqual(["hello world", "foo"]);
	});

	it("handles single quotes", () => {
		expect(tokenizeArgs("'hello world' foo")).toEqual(["hello world", "foo"]);
	});

	it("handles --no-fix flag", () => {
		expect(tokenizeArgs("/tmp/a.ts --no-fix /tmp/b.ts")).toEqual([
			"/tmp/a.ts",
			"--no-fix",
			"/tmp/b.ts",
		]);
	});
});

// DEFAULT_CONFIG already imported as LinterDefaultConfig above
describe("post-turn-linter: core helpers", () => {
	it("parseJsoncConfig strips comments and trailing commas", () => {
		const result = parseJsoncConfig(
			'{ "default": true, // comment\n "MD013": { "line_length": 120 }, }',
		);
		expect(result).toEqual({ default: true, MD013: { line_length: 120 } });
	});

	it("formatMarkdownlintResults formats violations", () => {
		const results = {
			"/tmp/test.md": [
				{
					lineNumber: 10,
					ruleNames: ["MD013", "line-length"],
					ruleDescription: "Line length",
					errorDetail: "Expected: 120",
				},
			],
		};
		const output = formatMarkdownlintResults(results);
		expect(output).toContain("/tmp/test.md:10");
		expect(output).toContain("MD013");
	});

	it("getLinterForFile returns correct linter", () => {
		const linter = getLinterForFile("test.py", LinterDefaultConfig);
		expect(linter).not.toBeNull();
		expect(linter?.name).toBe("Ruff");
	});

	it("groupFilesByLinter groups by extension", () => {
		const groups = groupFilesByLinter(
			new Set(["/tmp/a.ts", "/tmp/b.md", "/tmp/c.ts"]),
			LinterDefaultConfig,
		);
		// .ts files share a linter, .md has its own
		expect(groups.size).toBeGreaterThanOrEqual(2);
	});

	it("filters built-in generated agent plan artifacts across repositories", () => {
		expect(
			isBuiltInIgnoredAgentArtifact("/repo-one/agent/plans/2026-05-26-todo.md"),
		).toBe(true);
		expect(
			isBuiltInIgnoredAgentArtifact(
				"/another/repo/agent/plans/archive/old-todo.md",
			),
		).toBe(true);
		expect(
			isBuiltInIgnoredAgentArtifact("/repo/notes/agent/plans/nested/a.md"),
		).toBe(false);
		expect(
			filterBuiltInIgnoredFiles([
				"/repo-one/agent/plans/2026-05-26-todo.md",
				"/repo/src/index.ts",
				"/another/repo/agent/plans/archive/old-todo.md",
			]),
		).toEqual(["/repo/src/index.ts"]);
	});

	it("builds bounded summary-first lint messages with actionable fields", () => {
		const excerptSecret = ["super", "secret", "token", "value"].join("-");
		const report = [
			"--- markdownlint (4 files) ---",
			"/repo/docs/a.md:10 MD012/no-multiple-blanks Multiple consecutive blank lines — fix: delete 1",
			"/repo/docs/a.md:11 MD013/line-length Line length [https://example.invalid]",
			"/repo/docs/a.md:12 MD013/line-length Line length",
			"/repo/docs/a.md:13 MD013/line-length Line length",
			'/repo/docs/b.md:3 MD022/blanks-around-headings Headings should be surrounded by blank lines — fix: insert "\\n"',
			"/repo/docs/c.md:5 MD009/no-trailing-spaces Trailing spaces",
			"",
			"--- Code excerpts ---",
			"/repo/docs/a.md:8-12",
			"```text",
			`secret: ${excerptSecret}`,
			"```",
		].join("\n");

		const summary = buildSummaryFirstLintMessage({
			report,
			filesChecked: ["/repo/docs/a.md", "/repo/docs/b.md", "/repo/docs/c.md"],
			affectedFiles: ["/repo/docs/a.md", "/repo/docs/b.md", "/repo/docs/c.md"],
			cwd: "/repo",
			reportId: 7,
			sidecar: null,
			maxFindings: 3,
			maxFindingsPerFile: 2,
			maxChars: 1800,
		});

		expect(summary.message.length).toBeLessThanOrEqual(1800);
		expect(summary.message).toContain("Report #7");
		expect(summary.message).toContain("Linters: markdownlint");
		expect(summary.message).toContain("docs/a.md:10");
		expect(summary.message).toContain("MD012/no-multiple-blanks");
		expect(summary.message).toContain("fix: delete 1");
		expect(summary.message).toContain("docs/b.md:3");
		expect(summary.message).not.toContain("Code excerpts");
		expect(summary.message).not.toContain(excerptSecret);
		expect(summary.details.totalFindings).toBe(6);
		expect(summary.details.visibleFindings).toBe(3);
		expect(summary.details.lowPriorityFindings).toBe(3);
		expect(summary.details.excerptsOmitted).toBe(true);

		const ruffSummary = buildSummaryFirstLintMessage({
			report: [
				"--- Ruff (1 file) ---",
				"/repo/app.py:2:1: F401 imported but unused",
			].join("\n"),
			filesChecked: ["/repo/app.py"],
			affectedFiles: ["/repo/app.py"],
			cwd: "/repo",
			reportId: 8,
			sidecar: null,
		});
		expect(ruffSummary.message).toContain("app.py:2:1");
		expect(ruffSummary.message).toContain("F401");
	});

	it("writes redacted sidecar reports and recovers preview/slice/full separately", async () => {
		const tempDir = fs.mkdtempSync(`${tmpdir()}/pi-quality-gates-linter-`);
		const secretValue = ["abcdefghijklmnop", "qrstuvwxyz"].join("");
		const report = [
			"--- Ruff (1 file) ---",
			"/repo/app.py:2:1 F401 imported but unused",
			`apiKey: ${secretValue}`,
		].join("\n");

		const sidecar = await writeLinterReportSidecar({
			report,
			sessionId: "test-session",
			sidecarDir: tempDir,
			now: new Date("2026-05-26T00:00:00.000Z"),
		});

		expect(sidecar.ok).toBe(true);
		expect(sidecar.metadata.originalChars).toBe(report.length);
		const persisted = fs.readFileSync(sidecar.metadata.path, "utf8");
		expect(persisted).toContain("[REDACTED");
		expect(persisted).not.toContain(secretValue);

		const preview = await recoverLinterReportSidecar({
			recordPath: sidecar.metadata.path,
			mode: "preview",
			previewChars: 80,
		});
		expect(preview.content).toContain("F401");
		expect(preview.content).not.toContain(secretValue);

		const slice = await recoverLinterReportSidecar({
			recordPath: sidecar.metadata.path,
			mode: "slice",
			offset: 0,
			length: 20,
		});
		expect(slice.content).toContain("linter report slice offset=0");

		const oversizedSlice = await recoverLinterReportSidecar({
			recordPath: sidecar.metadata.path,
			mode: "slice",
			offset: 0,
			length: 999_999,
		});
		expect(oversizedSlice.content.length).toBeLessThanOrEqual(4_200);

		await expect(
			recoverLinterReportSidecar({
				recordPath: sidecar.metadata.path,
				mode: "full",
			}),
		).rejects.toThrow(/requires --ack-context-cost/);

		const subAgentFull = await recoverLinterReportSidecar({
			recordPath: sidecar.metadata.path,
			mode: "full",
			allowFullWithoutAck: true,
		});
		expect(subAgentFull.content).toContain("[REDACTED");
		expect(subAgentFull.content).not.toContain(secretValue);

		const full = await recoverLinterReportSidecar({
			recordPath: sidecar.metadata.path,
			mode: "full",
			acknowledgeContextCost: true,
		});
		expect(full.content).toContain("[REDACTED");
		expect(full.content).not.toContain(secretValue);
	});

	it("detects orchestrator sub-agent runtime with an explicit override", () => {
		expect(
			isQualityGatesSubAgentRuntime({
				PI_QUALITY_GATES_SUBAGENT_MODE: "1",
			}),
		).toBe(true);
		expect(
			isQualityGatesSubAgentRuntime({
				PI_QUALITY_GATES_SUBAGENT_MODE: "0",
				PI_ORCH_ROLE: "worker",
			}),
		).toBe(false);
		expect(
			isQualityGatesSubAgentRuntime({
				PI_ORCH_RUN_ID: "run-1",
				PI_ORCH_AGENT_ID: "agent-1",
				PI_ORCH_TASK_ID: "task-1",
			}),
		).toBe(true);
		expect(isQualityGatesSubAgentRuntime({}, "sub-agent")).toBe(true);
		expect(
			isQualityGatesSubAgentRuntime(
				{ PI_QUALITY_GATES_SUBAGENT_MODE: "1" },
				"parent",
			),
		).toBe(false);
	});

	it("requires ack for parent full recovery but not sub-agent recovery", async () => {
		type MockMessage = {
			customType: string;
			content: string;
			display?: boolean;
		};
		type MockContext = {
			hasUI: false;
			isIdle: () => boolean;
			sessionManager: {
				getBranch: () => unknown[];
				getSessionFile: () => string;
			};
		};
		type Handler = (
			event: Record<string, unknown>,
			ctx: MockContext,
		) => Promise<void> | void;
		type CommandHandler = (
			args: string | undefined,
			ctx: MockContext,
		) => Promise<void> | void;

		const sidecarMetadata = {
			id: "sidecar-full",
			toolName: "post-turn-linter" as const,
			sessionId: "session-1",
			path: "/tmp/sidecar-full.json",
			createdAt: "2026-05-26T00:00:00.000Z",
			originalChars: 10_000,
			originalBytes: 10_000,
			redactedChars: 9_000,
			redactedBytes: 9_000,
			originalSha256: "original",
			redactedSha256: "redacted",
			summaryMode: "post-turn-linter-summary" as const,
		};
		const branch = [
			{
				type: "custom_message",
				customType: "post-turn-linter",
				content: "bounded summary only",
				details: {
					summary: {
						reportId: 3,
						sidecar: sidecarMetadata,
						affectedFiles: ["/repo/src/a.ts"],
					},
				},
			},
		];

		const createHarness = (isSubAgent: boolean) => {
			const messages: MockMessage[] = [];
			const handlers = new Map<string, Handler>();
			const commands = new Map<string, CommandHandler>();
			let allowFullWithoutAck: boolean | undefined;

			createPostTurnLinter(
				{
					on: (eventName: string, handler: Handler) => {
						handlers.set(eventName, handler);
					},
					registerCommand: (
						name: string,
						command: { handler: CommandHandler },
					) => {
						commands.set(name, command.handler);
					},
					sendMessage: (message: MockMessage) => {
						messages.push(message);
					},
					sendUserMessage: () => undefined,
				} as never,
				{
					existsSync: () => true,
					loadLinterConfig: async () => LinterDefaultConfig,
					runQueuedLintChecks: async () => ({
						kind: "clean",
						report: "",
						affectedFiles: [],
						signature: "clean",
						reportMode: "report-only",
					}),
					runQueuedLspChecks: async () => ({
						kind: "clean",
						report: "",
						affectedFiles: [],
						signature: "lsp-clean",
					}),
					mergeValidationOutcomes: (args) => ({
						kind: args.results[0]?.kind ?? "clean",
						report: args.results[0]?.report ?? "",
						affectedFiles: args.results[0]?.affectedFiles ?? [],
						signature: args.results[0]?.signature ?? "",
						reportMode: args.reportMode,
					}),
					setTimeout: (callback) => {
						callback();
						return undefined;
					},
					statSync: () => ({ mtimeMs: 1, size: 1 }),
					writeLinterReportSidecar: async () => ({
						ok: true,
						metadata: sidecarMetadata,
					}),
					recoverLinterReportSidecar: async (options) => {
						allowFullWithoutAck = options.allowFullWithoutAck;
						if (
							options.mode === "full" &&
							!options.acknowledgeContextCost &&
							!options.allowFullWithoutAck
						) {
							throw new Error("requires --ack-context-cost");
						}
						return {
							mode: options.mode,
							content: "FULL REDACTED REPORT",
							metadata: sidecarMetadata,
						};
					},
					isQualityGatesSubAgentRuntime: () => isSubAgent,
				} satisfies Parameters<typeof createPostTurnLinter>[1],
			);

			const ctx: MockContext = {
				hasUI: false,
				isIdle: () => true,
				sessionManager: {
					getBranch: () => branch,
					getSessionFile: () => "/tmp/session-1.jsonl",
				},
			};
			return {
				allowFullWithoutAck: () => allowFullWithoutAck,
				commands,
				ctx,
				handlers,
				messages,
			};
		};

		const parent = createHarness(false);
		await parent.handlers.get("session_start")?.({}, parent.ctx);
		await parent.commands.get("post-turn-linter-report")?.("full", parent.ctx);
		expect(parent.allowFullWithoutAck()).toBe(false);
		expect(parent.messages.at(-1)?.customType).toBe(
			"post-turn-linter-report-status",
		);
		expect(parent.messages.at(-1)?.content).toContain(
			"requires --ack-context-cost",
		);

		const subAgent = createHarness(true);
		await subAgent.handlers.get("session_start")?.({}, subAgent.ctx);
		await subAgent.commands.get("post-turn-linter-report")?.(
			"full",
			subAgent.ctx,
		);
		expect(subAgent.allowFullWithoutAck()).toBe(true);
		expect(subAgent.messages.at(-1)?.customType).toBe(
			"post-turn-linter-report",
		);
		expect(subAgent.messages.at(-1)?.content).toBe("FULL REDACTED REPORT");
	});

	it("emits bounded custom messages while keeping full reports in sidecars", async () => {
		type MockMessage = {
			customType: string;
			content: string;
			details?: { summary?: { sidecar?: { id?: string } } };
		};
		type MockContext = {
			hasUI: false;
			isIdle: () => boolean;
			sessionManager: {
				getBranch: () => unknown[];
				getSessionFile: () => string;
			};
		};
		type Handler = (
			event: Record<string, unknown>,
			ctx: MockContext,
		) => Promise<void> | void;

		const messages: MockMessage[] = [];
		const userMessages: string[] = [];
		const handlers = new Map<string, Handler>();
		const fullReport = Array.from(
			{ length: 60 },
			(_, index) =>
				`/repo/src/a.ts:${index + 1}:1 RULE${index} RAW-DETAIL-${index}`,
		).join("\n");
		const sidecarMetadata = {
			id: "sidecar-1",
			toolName: "post-turn-linter" as const,
			sessionId: "session-1",
			path: "/tmp/sidecar-1.json",
			createdAt: "2026-05-26T00:00:00.000Z",
			originalChars: fullReport.length,
			originalBytes: fullReport.length,
			redactedChars: fullReport.length,
			redactedBytes: fullReport.length,
			originalSha256: "original",
			redactedSha256: "redacted",
			summaryMode: "post-turn-linter-summary" as const,
		};

		createPostTurnLinter(
			{
				on: (eventName: string, handler: Handler) => {
					handlers.set(eventName, handler);
				},
				registerCommand: () => undefined,
				sendMessage: (message: MockMessage) => {
					messages.push(message);
				},
				sendUserMessage: (message: string) => {
					userMessages.push(message);
				},
			} as never,
			{
				existsSync: () => true,
				loadLinterConfig: async () => ({
					...LinterDefaultConfig,
					reportMode: "auto-follow-up",
				}),
				runQueuedLintChecks: async () => ({
					kind: "findings",
					report: fullReport,
					affectedFiles: ["/repo/src/a.ts"],
					signature: "signature",
					reportMode: "auto-follow-up",
				}),
				runQueuedLspChecks: async () => ({
					kind: "clean",
					report: "",
					affectedFiles: [],
					signature: "lsp-clean",
				}),
				mergeValidationOutcomes: (args) => ({
					kind: args.results[0]?.kind ?? "clean",
					report: args.results[0]?.report ?? "",
					affectedFiles: args.results[0]?.affectedFiles ?? [],
					signature: args.results[0]?.signature ?? "",
					reportMode: args.reportMode,
				}),
				setTimeout: (callback) => {
					callback();
					return undefined;
				},
				statSync: () => ({ mtimeMs: 1, size: 1 }),
				writeLinterReportSidecar: async () => ({
					ok: true,
					metadata: sidecarMetadata,
				}),
				recoverLinterReportSidecar: async () => ({
					mode: "preview",
					content: "",
					metadata: sidecarMetadata,
				}),
				isQualityGatesSubAgentRuntime: () => false,
			} satisfies Parameters<typeof createPostTurnLinter>[1],
		);

		const ctx: MockContext = {
			hasUI: false,
			isIdle: () => true,
			sessionManager: {
				getBranch: () => [],
				getSessionFile: () => "/tmp/session-1.jsonl",
			},
		};

		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("tool_execution_start")?.(
			{
				toolCallId: "tool-1",
				toolName: "write",
				args: { path: "/repo/src/a.ts" },
			},
			ctx,
		);
		await handlers.get("tool_execution_end")?.(
			{
				toolCallId: "tool-1",
				toolName: "write",
				result: { details: { modifiedFiles: ["/repo/src/a.ts"] } },
			},
			ctx,
		);
		await handlers.get("turn_end")?.({}, ctx);

		const lintMessage = messages.find(
			(message) => message.customType === "post-turn-linter",
		);
		const content = lintMessage?.content ?? "";
		expect(content.length).toBeLessThanOrEqual(6000);
		expect(content).toContain("RAW-DETAIL-0");
		expect(content).not.toContain("RAW-DETAIL-59");
		expect(lintMessage?.details?.summary?.sidecar?.id).toBe("sidecar-1");
		expect(userMessages[0]).toContain("Bounded post-turn-linter summary");
		expect(userMessages[0]).toContain("src/a.ts:1:1");
		expect(userMessages[0]).toContain("RULE0");
	});
});

// ── Shared path-utils tests ───────────────────────────────────────────

describe("shared: path-utils", () => {
	it("normalizePath handles backslashes and trailing slashes", () => {
		expect(normalizePath("foo/bar/")).toBe("foo/bar");
		expect(normalizePath("foo\\bar")).toBe("foo/bar");
	});

	it("pathsEqual compares case-insensitively on macOS", () => {
		expect(pathsEqual("Foo/Bar", "foo/bar")).toBe(true);
	});

	it("normalizeAndSortPaths deduplicates and sorts", () => {
		const result = normalizeAndSortPaths(["/b", "/a", "/b"]);
		expect(result).toEqual(["/a", "/b"]);
	});
});

// ── Post-Turn Reviewer tests ──────────────────────────────────────────

describe("post-turn-reviewer: skip filter", () => {
	it("parseSkipContent handles basic patterns", () => {
		const filter = parseSkipContent("*.log\ndist/\n!important.log");
		expect(filter.loaded).toBe(true);
		expect(filter.patternCount).toBe(3);
		expect(shouldSkip(filter, "error.log")).toBe(true);
		expect(shouldSkip(filter, "important.log")).toBe(false);
		expect(shouldSkip(filter, "dist/bundle.js")).toBe(true);
	});

	it("parseSkipContent ignores comments and blank lines", () => {
		const filter = parseSkipContent("# comment\n\n*.tmp\n");
		expect(filter.patternCount).toBe(1);
	});

	it("filterSkipped removes matching paths", () => {
		const filter = parseSkipContent("*.log");
		const result = filterSkipped(filter, ["a.ts", "debug.log", "b.ts"]);
		expect(result).toEqual(["a.ts", "b.ts"]);
	});
});

describe("post-turn-reviewer: reviewer helpers", () => {
	it("capDiff truncates at maxLines", () => {
		const diff = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
		const capped = capDiff(diff, 5);
		expect(capped).toContain("DIFF TRUNCATED");
		expect(capped.split("\n").length).toBeLessThanOrEqual(7); // 5 lines + blank + truncation notice
	});

	it("capDiff returns original when within limit", () => {
		const diff = "line 1\nline 2\nline 3";
		expect(capDiff(diff, 10)).toBe(diff);
	});

	it("extractOriginalTask finds the last user message", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "First task" } },
			{ type: "message", message: { role: "assistant", content: "Done" } },
			{ type: "message", message: { role: "user", content: "Second task" } },
		];
		expect(extractOriginalTask(entries)).toBe("Second task");
	});

	it("extractOriginalTask handles content arrays", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "Array content" }],
				},
			},
		];
		expect(extractOriginalTask(entries)).toBe("Array content");
	});

	it("extractOriginalTask returns empty string for no entries", () => {
		expect(extractOriginalTask([])).toBe("");
	});
});

describe("post-turn-reviewer: parseReviewReport", () => {
	const validReport = `## Review Report

STATUS: ISSUES
CONFIDENCE: HIGH

### Findings

#### [CRITICAL] Missing null check
- **File:** src/index.ts:42
- **Category:** correctness
- **Rule:** null-check
- **Issue:** Variable may be null
- **Evidence:** \`const x = foo()\`
- **Suggestion:** Add a null check

### What was verified
- Build compiles: src/index.ts:1 — no errors

### What could not be verified
- Runtime behavior: cannot execute code

### Summary
One critical issue found.`;

	it("parses a valid report", () => {
		const report = parseReviewReport(validReport);
		expect(report).not.toBeNull();
		expect(report?.status).toBe("ISSUES");
		expect(report?.confidence).toBe("HIGH");
		expect(report?.findings).toHaveLength(1);
		expect(report?.findings[0]?.severity).toBe("CRITICAL");
		expect(report?.findings[0]?.file).toBe("src/index.ts");
		expect(report?.findings[0]?.line).toBe(42);
		expect(report?.verified).toHaveLength(1);
		expect(report?.unverifiable).toHaveLength(1);
		expect(report?.summary).toBeTruthy();
	});

	it("returns null for missing report marker", () => {
		expect(parseReviewReport("No report here")).toBeNull();
	});

	it("returns null for empty input", () => {
		expect(parseReviewReport("")).toBeNull();
	});

	it("parses a PASS report with no findings", () => {
		const passReport = `## Review Report

STATUS: PASS
CONFIDENCE: MEDIUM

### Findings

None.

### What was verified
- Code compiles: verified

### What could not be verified

### Summary
Everything looks good.`;

		const report = parseReviewReport(passReport);
		expect(report).not.toBeNull();
		expect(report?.status).toBe("PASS");
		expect(report?.findings).toHaveLength(0);
	});
});

describe("post-turn-reviewer: severity helpers", () => {
	it("severityMeetsThreshold works correctly", () => {
		expect(severityMeetsThreshold("CRITICAL", "critical")).toBe(true);
		expect(severityMeetsThreshold("WARNING", "critical")).toBe(false);
		expect(severityMeetsThreshold("WARNING", "warning")).toBe(true);
		expect(severityMeetsThreshold("NIT", "warning")).toBe(false);
		expect(severityMeetsThreshold("CRITICAL", "none")).toBe(false);
	});
});

describe("post-turn-reviewer: state machine helpers", () => {
	it("formatPhaseStatus shows current state", () => {
		const state: ReviewerState = {
			phase: "IDLE",
			loopCount: 0,
			lastReport: null,
			pendingFiles: [],
			linterClean: false,
			linterCleanAt: null,
			config: DEFAULT_REVIEW_CONFIG,
			reviewTimerId: null,
			lastUserPrompt: "",
			lastScannedIdx: 0,
		};
		const status = formatPhaseStatus(state, DEFAULT_REVIEW_CONFIG);
		expect(status).toContain("Phase: IDLE");
		expect(status).toContain("Enabled: true");
	});
});

// ── Package manifest and registration tests ───────────────────────────

describe("pi-quality-gates package", () => {
	it("declares the pi-package keyword and extension manifest", () => {
		const packageJson = JSON.parse(
			fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as {
			keywords?: string[];
			pi?: { extensions?: string[] };
		};

		expect(packageJson.keywords).toContain("pi-package");
		expect(packageJson.pi?.extensions).toEqual(["./src/index.ts"]);
	});

	it("registers commands via the bundle entrypoint", () => {
		const registered = {
			commands: [] as string[],
			tools: [] as string[],
		};

		const mockPi = {
			registerCommand: (name: string) => registered.commands.push(name),
			registerTool: (def: { name: string }) => registered.tools.push(def.name),
			sendMessage: () => undefined,
			on: () => undefined,
		};

		qualityGatesExtension(mockPi as never);

		expect(registered.commands).toContain("quality-gates-status");
		expect(registered.commands).toContain("post-turn-linter-run");
		expect(registered.commands).toContain("post-turn-linter-status");
		expect(registered.commands).toContain("reviewer-status");
		expect(registered.commands).toContain("reviewer-run");
		expect(registered.commands).toContain("reviewer-toggle");
		expect(registered.commands).toContain("post-turn-linter-report");
	});
});
