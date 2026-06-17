/**
 * Characterization tests for the markdownlint engine + adapter.
 *
 * These lock the observable behaviour that the "deepen the markdownlint
 * adapter" refactor (Seeds plan pl-c5fc, epic pi-quality-gates-e07a) must
 * preserve. The invariant: markdownlint output is byte-identical before and
 * after the engine is moved out of `config-loader.ts` into its own module and
 * the adapter switches to config-injection.
 *
 * Tests against stable entry points (`runMarkdownlint`, `formatMarkdownlintResults`,
 * and the adapter's `.run()` `ValidationOutcome`) must pass UNMODIFIED after the
 * move. Only the adapter *construction* line changes in step 3 (runner -> config);
 * the assertions about produced output stay identical.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMarkdownlintAdapter } from "../src/linter/adapters/markdownlint.js";
import {
	DEFAULT_MARKDOWNLINT_CONFIG,
	formatMarkdownlintResults,
	runMarkdownlint,
} from "../src/linter/config-loader.js";

describe("markdownlint engine characterization", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-quality-gates-mdlint-"));
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

	const LONG_LINE =
		"This is a deliberately long sentence that contains enough words and spaces to exceed the one hundred and twenty character line length limit enforced by markdownlint.\n";

	it("runMarkdownlint returns a clean LinterResult for a conforming markdown file, with full shape", async () => {
		const file = makeFile("ok.md", "# Hello\n");
		const result = await runMarkdownlint([file]);

		expect(result).toEqual({
			kind: "clean",
			output: "",
			fileCount: 1,
			affectedFiles: [],
			name: "markdownlint",
		});
	});

	it("runMarkdownlint returns findings for a long-line violation, with full LinterResult shape", async () => {
		const file = makeFile("long.md", `# Title\n\n${LONG_LINE}`);
		const result = await runMarkdownlint([file]);

		expect(result.kind).toBe("findings");
		expect(result.name).toBe("markdownlint");
		expect(result.fileCount).toBe(1);
		expect(result.affectedFiles).toEqual([resolve(file)]);
		expect(result.output).toContain(file);
		expect(result.output).toContain("MD013");
		expect(result.output).toContain("line-length");
		expect(result.output).toContain(
			"https://github.com/DavidAnson/markdownlint/blob/main/doc/MD013.md",
		);
	});

	it("runMarkdownlint honors a config that disables MD013", async () => {
		const file = makeFile("long.md", `# Title\n\n${LONG_LINE}`);
		const result = await runMarkdownlint([file], {
			...DEFAULT_MARKDOWNLINT_CONFIG,
			MD013: false,
		});

		expect(result).toEqual({
			kind: "clean",
			output: "",
			fileCount: 1,
			affectedFiles: [],
			name: "markdownlint",
		});
	});

	it("runMarkdownlint returns clean when all files are covered by .markdownlintignore", async () => {
		const file = makeFile("ignored/long.md", `# Title\n\n${LONG_LINE}`);
		makeFile("ignored/.markdownlintignore", "long.md\n");

		const result = await runMarkdownlint([file]);

		expect(result).toEqual({
			kind: "clean",
			output: "",
			fileCount: 0,
			affectedFiles: [],
			name: "markdownlint",
		});
	});

	it("runMarkdownlint returns clean (fileCount 0) for an empty file list", async () => {
		const result = await runMarkdownlint([]);

		expect(result).toEqual({
			kind: "clean",
			output: "",
			fileCount: 0,
			affectedFiles: [],
			name: "markdownlint",
		});
	});

	it("runMarkdownlint skips missing files but lints the rest", async () => {
		const present = makeFile("present.md", "# Hi\n");
		const result = await runMarkdownlint([
			present,
			join(tempDir, "missing.md"),
		]);

		expect(result.kind).toBe("clean");
		expect(result.fileCount).toBe(1);
	});
});

describe("formatMarkdownlintResults characterization", () => {
	it("formats a violation with file:line, rule id, description, doc link, and no fix/detail when absent", () => {
		const filePath = "/repo/doc.md";
		const output = formatMarkdownlintResults({
			[filePath]: [
				{
					lineNumber: 4,
					ruleNames: ["MD013", "line-length"],
					ruleDescription: "Line length",
					errorDetail: null,
					errorContext: null,
					fixInfo: null,
				},
			],
		});

		expect(output).toBe(
			`${filePath}:4 MD013/line-length Line length ` +
				`[https://github.com/DavidAnson/markdownlint/blob/main/doc/MD013.md]`,
		);
	});

	it("appends detail, context, and fix info when present", () => {
		const filePath = "/repo/doc.md";
		const output = formatMarkdownlintResults({
			[filePath]: [
				{
					lineNumber: 7,
					ruleNames: ["MD001", "heading-increment"],
					ruleDescription:
						"Heading levels should only increment by one level at a time",
					errorDetail: "Expected: h2; Actual: h3",
					errorContext: "### x",
					fixInfo: {
						lineNumber: 7,
						editColumn: 1,
						deleteCount: 2,
						insertText: "## ",
					},
				},
			],
		});

		expect(output).toContain(`${filePath}:7 MD001/heading-increment`);
		expect(output).toContain(" — Expected: h2; Actual: h3");
		expect(output).toContain(' — context: "### x"');
		expect(output).toContain(' — fix: line 7, col 1, delete 2, insert "## "');
	});

	it("returns an empty string when there are no violations", () => {
		expect(formatMarkdownlintResults({ "/repo/empty.md": [] })).toBe("");
		expect(formatMarkdownlintResults({})).toBe("");
	});
});

describe("markdownlint adapter characterization", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-quality-gates-mdlint-adapter-"));
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

	it("exposes the stable adapter identity (name + key)", () => {
		const adapter = createMarkdownlintAdapter();

		expect(adapter.name).toBe("markdownlint");
		expect(adapter.key).toBe("api:markdownlint");
	});

	it("run() maps a findings file to a ValidationOutcome with the stable report header", async () => {
		const longLine =
			"This is a deliberately long sentence that contains enough words and spaces to exceed the one hundred and twenty character line length limit enforced by markdownlint.\n";
		const file = makeFile("long.md", `# Title\n\n${longLine}`);

		const adapter = createMarkdownlintAdapter();
		const outcome = await adapter.run([file], tempDir);

		expect(outcome.kind).toBe("findings");
		expect(outcome.report).toContain("--- markdownlint (1 file) ---");
		expect(outcome.report).toContain(file);
		expect(outcome.report).toContain("MD013");
		expect(outcome.affectedFiles).toEqual([resolve(file)]);
		expect(typeof outcome.signature).toBe("string");
		expect(outcome.signature.length).toBeGreaterThan(0);
	});

	it("run() maps a clean file to a clean ValidationOutcome", async () => {
		const file = makeFile("ok.md", "# Hello\n");

		const adapter = createMarkdownlintAdapter();
		const outcome = await adapter.run([file], tempDir);

		expect(outcome.kind).toBe("clean");
		expect(outcome.affectedFiles).toEqual([]);
	});

	it("run() reflects the pluralised file count for multiple files", async () => {
		const a = makeFile("a.md", "# A\n");
		const b = makeFile("b.md", "# B\n");

		const adapter = createMarkdownlintAdapter();
		const outcome = await adapter.run([a, b], tempDir);

		expect(outcome.kind).toBe("clean");
		expect(outcome.report).toContain("--- markdownlint (2 files) ---");
	});
});
