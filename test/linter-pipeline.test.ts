import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mergeValidationOutcomes,
	runQueuedLintChecks,
} from "../src/linter/core.js";
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
});
