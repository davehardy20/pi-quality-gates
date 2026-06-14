import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LinterAdapter } from "../src/linter/adapters/types.js";
import {
	mergeValidationOutcomes,
	runQueuedLintChecks,
} from "../src/linter/core.js";
import { createLinterPipeline } from "../src/linter/pipeline.js";
import type { LinterConfig, ValidationOutcome } from "../src/linter/types.js";

describe("linter pipeline characterization", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-quality-gates-linter-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function makeFile(relPath: string, content: string): string {
		const fullPath = join(tempDir, relPath);
		mkdirSync(resolve(fullPath, ".."), { recursive: true });
		writeFileSync(fullPath, content, "utf8");
		return fullPath;
	}

	it("runQueuedLintChecks returns clean for an empty markdown file", async () => {
		const filePath = makeFile("empty.md", "# Hello\n");
		const config: LinterConfig = {
			linters: {},
			cooldownMs: 0,
			timeoutMs: 60_000,
			reportMode: "auto-follow-up",
			runtimeMode: "auto",
			lsp: { enabled: false },
		};

		const outcome = await runQueuedLintChecks([filePath], tempDir, config);
		expect(outcome.kind).toBe("clean");
		expect(outcome.affectedFiles).toEqual([]);
	});

	it("runQueuedLintChecks reports markdownlint violations", async () => {
		const longSentence =
			"This is a deliberately long sentence that contains enough words and spaces to exceed the one hundred and twenty character line length limit enforced by markdownlint.\n";
		const filePath = makeFile("long-line.md", `# Title\n\n${longSentence}`);

		const outcome = await runQueuedLintChecks([filePath], tempDir);
		expect(outcome.kind).toBe("findings");
		expect(outcome.affectedFiles).toContain(filePath);
		expect(outcome.report).toContain("MD013");
		expect(outcome.report).toContain(filePath);
	});

	it("runQueuedLintChecks runs CLI linters per file", async () => {
		const filePath = makeFile("src/a.ts", "const x = 1;\n");
		const linterScript = makeFile(
			"fake-linter.js",
			`#!/usr/bin/env node\nconst files = process.argv.slice(2);\nfor (const f of files) { console.log(\`\${f}:1:1 FAKE_RULE fake finding\`); }\n`,
		);

		const config: LinterConfig = {
			linters: {
				".ts": {
					type: "cli",
					command: "node",
					args: [linterScript],
					name: "FakeCLI",
				},
			},
			cooldownMs: 0,
			timeoutMs: 60_000,
			reportMode: "auto-follow-up",
			runtimeMode: "auto",
			lsp: { enabled: false },
		};

		const outcome = await runQueuedLintChecks([filePath], tempDir, config);
		expect(outcome.kind).toBe("findings");
		expect(outcome.affectedFiles).toEqual([filePath]);
		expect(outcome.report).toContain("FakeCLI");
		expect(outcome.report).toContain("FAKE_RULE");
	});

	it("runQueuedLintChecks groups multiple files by linter", async () => {
		const fileA = makeFile("src/a.ts", "const a = 1;\n");
		const fileB = makeFile("src/b.ts", "const b = 1;\n");
		const linterScript = makeFile(
			"fake-linter.js",
			`#!/usr/bin/env node\nconst files = process.argv.slice(2);\nfor (const f of files) { console.log(\`\${f}:1:1 FAKE_RULE fake finding\`); }\n`,
		);

		const config: LinterConfig = {
			linters: {
				".ts": {
					type: "cli",
					command: "node",
					args: [linterScript],
					name: "FakeCLI",
				},
			},
			cooldownMs: 0,
			timeoutMs: 60_000,
			reportMode: "auto-follow-up",
			runtimeMode: "auto",
			lsp: { enabled: false },
		};

		const outcome = await runQueuedLintChecks([fileA, fileB], tempDir, config);
		expect(outcome.kind).toBe("findings");
		expect(outcome.affectedFiles).toEqual([fileA, fileB].sort());
		expect(outcome.report).toContain("FakeCLI (2 files)");
	});

	it("runQueuedLintChecks uses project-root mode to run from the marked root", async () => {
		const projectRoot = makeFile("project/Cargo.toml", "[package]\n");
		const sourceFile = makeFile("project/src/main.rs", "fn main() {}\n");
		const linterScript = makeFile(
			"root-reporter.js",
			`#!/usr/bin/env node\nconsole.log(\`cwd:\${process.cwd()}\`);\n`,
		);

		const config: LinterConfig = {
			linters: {
				".rs": {
					type: "cli",
					command: "node",
					args: [linterScript],
					name: "RootReporter",
					mode: "project-root",
					rootMarker: "Cargo.toml",
				},
			},
			cooldownMs: 0,
			timeoutMs: 60_000,
			reportMode: "auto-follow-up",
			runtimeMode: "auto",
			lsp: { enabled: false },
		};

		const outcome = await runQueuedLintChecks([sourceFile], tempDir, config);
		expect(outcome.kind).toBe("findings");
		expect(outcome.report).toContain(resolve(projectRoot, ".."));
	});

	it("runQueuedLintChecks discovers workspace root for workspace-mode linters", async () => {
		const projectRoot = makeFile("ws/package.json", '{"name":"ws"}\n');
		const sourceFile = makeFile("ws/src/index.ts", "const x = 1;\n");
		const linterScript = makeFile(
			"root-reporter.js",
			`#!/usr/bin/env node\nconsole.log(\`cwd:\${process.cwd()}\`);\n`,
		);

		const config: LinterConfig = {
			linters: {
				".ts": {
					type: "cli",
					command: "node",
					args: [linterScript],
					name: "WorkspaceReporter",
					mode: "workspace",
				},
			},
			cooldownMs: 0,
			timeoutMs: 60_000,
			reportMode: "auto-follow-up",
			runtimeMode: "auto",
			lsp: { enabled: false },
		};

		const outcome = await runQueuedLintChecks([sourceFile], tempDir, config);
		expect(outcome.kind).toBe("findings");
		expect(outcome.report).toContain(resolve(projectRoot, ".."));
	});

	it("runQueuedLintChecks reports tool-error for a missing CLI linter", async () => {
		const filePath = makeFile("src/a.ts", "const x = 1;\n");
		const config: LinterConfig = {
			linters: {
				".ts": {
					type: "cli",
					command: "this-command-does-not-exist-12345",
					args: [],
					name: "MissingCLI",
				},
			},
			cooldownMs: 0,
			timeoutMs: 60_000,
			reportMode: "auto-follow-up",
			runtimeMode: "auto",
			lsp: { enabled: false },
		};

		const outcome = await runQueuedLintChecks([filePath], tempDir, config);
		expect(outcome.kind).toBe("tool-error");
		expect(outcome.report).toContain(
			"Error running this-command-does-not-exist-12345",
		);
	});

	it("runQueuedLintChecks includes code excerpts for findings", async () => {
		const longSentence =
			"This is a deliberately long sentence that contains enough words and spaces to exceed the one hundred and twenty character line length limit enforced by markdownlint.\n";
		const filePath = makeFile("long-line.md", `# Title\n\n${longSentence}`);

		const outcome = await runQueuedLintChecks([filePath], tempDir);
		expect(outcome.kind).toBe("findings");
		expect(outcome.report).toContain("--- Code excerpts ---");
		expect(outcome.report).toContain("```text");
	});

	it("mergeValidationOutcomes combines findings and tool-errors", () => {
		const findings: ValidationOutcome = {
			kind: "findings",
			report: "file.ts:1:1 R1 issue",
			affectedFiles: ["/file.ts"],
			signature: "findings-sig",
		};
		const toolError: ValidationOutcome = {
			kind: "tool-error",
			report: "linter crashed",
			affectedFiles: [],
			signature: "error-sig",
		};
		const clean: ValidationOutcome = {
			kind: "clean",
			report: "",
			affectedFiles: [],
			signature: "clean-sig",
		};

		const combined = mergeValidationOutcomes({
			reportMode: "auto-follow-up",
			results: [findings, toolError, clean],
		});

		expect(combined.kind).toBe("findings");
		expect(combined.report).toContain("file.ts:1:1 R1 issue");
		expect(combined.report).toContain("linter crashed");
		expect(combined.affectedFiles).toEqual(["/file.ts"]);
	});

	it("mergeValidationOutcomes surfaces tool-error when no findings exist", () => {
		const toolError: ValidationOutcome = {
			kind: "tool-error",
			report: "linter crashed",
			affectedFiles: [],
			signature: "error-sig",
		};

		const combined = mergeValidationOutcomes({
			reportMode: "auto-follow-up",
			results: [toolError],
		});

		expect(combined.kind).toBe("tool-error");
		expect(combined.report).toBe("linter crashed");
	});

	it("mergeValidationOutcomes returns clean when all results are clean", () => {
		const clean: ValidationOutcome = {
			kind: "clean",
			report: "",
			affectedFiles: [],
			signature: "clean-sig",
		};

		const combined = mergeValidationOutcomes({
			reportMode: "report-only",
			results: [clean, clean],
		});

		expect(combined.kind).toBe("clean");
		expect(combined.reportMode).toBe("report-only");
	});

	it("runs the LSP adapter independently of extension-based adapters", async () => {
		const filePath = makeFile("src/a.ts", "const x = 1;\n");
		const calls: { key: string; paths: string[] }[] = [];

		const cliAdapter: LinterAdapter = {
			name: "FakeCLI",
			key: "cli:node:fake.js",
			run: async (paths: string[]) => {
				calls.push({ key: "cli", paths });
				return {
					kind: "clean",
					report: "",
					affectedFiles: [],
					signature: "clean",
				};
			},
		};
		const lspAdapter: LinterAdapter = {
			name: "LSP diagnostics",
			key: "lsp",
			run: async (paths: string[]) => {
				calls.push({ key: "lsp", paths });
				return {
					kind: "findings",
					report: `${filePath}:1:1 LSP_ERROR lsp issue`,
					affectedFiles: [filePath],
					signature: "lsp-sig",
				};
			},
		};

		const pipeline = createLinterPipeline({
			cwd: tempDir,
			adapters: [cliAdapter, lspAdapter],
			loadConfig: async () =>
				({
					linters: {
						".ts": {
							type: "cli",
							command: "node",
							args: ["fake.js"],
							name: "FakeCLI",
						},
					},
					lsp: { enabled: true },
				}) as LinterConfig,
		});

		const outcome = await pipeline.runChecks([filePath]);
		expect(outcome.kind).toBe("findings");
		expect(outcome.affectedFiles).toContain(filePath);
		expect(calls).toHaveLength(2);
		expect(
			calls.some((c) => c.key === "lsp" && c.paths.includes(filePath)),
		).toBe(true);
	});

	it("honors custom markdownlint config loaded from the repo", async () => {
		const longSentence =
			"This is a deliberately long sentence that contains enough words and spaces to exceed the one hundred and twenty character line length limit enforced by markdownlint.\n";
		const filePath = makeFile("long-line.md", `# Title\n\n${longSentence}`);
		makeFile(".markdownlint.jsonc", '{ "MD013": false }\n');

		const outcome = await runQueuedLintChecks([filePath], tempDir);
		expect(outcome.kind).toBe("clean");
		expect(outcome.report).not.toContain("MD013");
	});

	it("routes same-name linters by definition, not display name", async () => {
		const fileC = makeFile("src/a.c", "int main() {}\n");
		const fileCpp = makeFile("src/b.cpp", "int main() {}\n");
		const linterScript = makeFile(
			"mode-reporter.js",
			`#!/usr/bin/env node\nconsole.log(process.argv.join(" "));\n`,
		);

		const config: LinterConfig = {
			linters: {
				".c": {
					type: "cli",
					command: "node",
					args: [linterScript, "--std=c11"],
					name: "MultiLangLinter",
				},
				".cpp": {
					type: "cli",
					command: "node",
					args: [linterScript, "--std=c++17"],
					name: "MultiLangLinter",
				},
			},
			cooldownMs: 0,
			timeoutMs: 60_000,
			reportMode: "auto-follow-up",
			runtimeMode: "auto",
			lsp: { enabled: false },
		};

		const outcome = await runQueuedLintChecks(
			[fileC, fileCpp],
			tempDir,
			config,
		);
		expect(outcome.kind).toBe("findings");
		expect(outcome.report).toContain("--std=c11");
		expect(outcome.report).toContain("--std=c++17");
	});

	it("splits project-root CLI runs across multiple discovered roots", async () => {
		const rootA = makeFile("project-a/Cargo.toml", "[package]\n");
		const sourceA = makeFile("project-a/src/main.rs", "fn main() {}\n");
		const rootB = makeFile("project-b/Cargo.toml", "[package]\n");
		const sourceB = makeFile("project-b/src/main.rs", "fn main() {}\n");
		const linterScript = makeFile(
			"root-reporter.js",
			`#!/usr/bin/env node\nconsole.log(\`cwd:\${process.cwd()}\`);\n`,
		);

		const config: LinterConfig = {
			linters: {
				".rs": {
					type: "cli",
					command: "node",
					args: [linterScript],
					name: "RootReporter",
					mode: "project-root",
					rootMarker: "Cargo.toml",
				},
			},
			cooldownMs: 0,
			timeoutMs: 60_000,
			reportMode: "auto-follow-up",
			runtimeMode: "auto",
			lsp: { enabled: false },
		};

		const outcome = await runQueuedLintChecks(
			[sourceA, sourceB],
			tempDir,
			config,
		);
		expect(outcome.kind).toBe("findings");
		expect(outcome.report).toContain(resolve(rootA, ".."));
		expect(outcome.report).toContain(resolve(rootB, ".."));
	});
});
