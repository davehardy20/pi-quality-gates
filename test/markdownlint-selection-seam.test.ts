/**
 * Characterization tests for the LIVE markdownlint selection seam.
 *
 * Context: Seeds root `pi-quality-gates-ed0f` ("Prune the undocumented
 * remark-lint prototype surface"), plan `pl-1cf4` ("Prune unused remark-lint
 * prototype"). This test file characterizes exactly how a `.md` file is
 * routed to the live markdownlint adapter today, so the upcoming removal of
 * the inactive `remark-lint-poc` runner (and its remark/unified deps) cannot
 * silently change which linter processes markdown.
 *
 * The seam under test (all live, production code paths):
 *
 *   file ".md"
 *     -> DEFAULT_CONFIG[".md"]            (config-loader.ts)
 *     -> getLinterForFile()               (config-loader.ts)  ApiLinterDefinition
 *     -> definitionKey()                  (pipeline.ts)       "api:markdownlint"
 *     -> buildAdaptersFromConfig()        (pipeline.ts)       createMarkdownlintAdapter
 *     -> groupFilesByAdapter()            (pipeline.ts)       routes .md -> adapter
 *     -> adapter.run()                    (adapters/markdownlint.ts)
 *
 * The `remark-lint-poc.ts` runner is intentionally NOT imported here. It is
 * an inactive prototype that is wired into nothing; the seam selects
 * markdownlint by the `api`+`name === "markdownlint"` contract in
 * `buildAdaptersFromConfig`, never by a remark runner.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	getLinterForFile,
} from "../src/linter/config-loader.js";
import {
	createLinterPipeline,
	__test__ as pipelineTest,
} from "../src/linter/pipeline.js";
import type { ApiLinterDefinition, LinterConfig } from "../src/linter/types.js";

const { buildAdaptersFromConfig, definitionKey, groupFilesByAdapter } =
	pipelineTest;

const MD_FILE = join("repo", "doc.md");

describe("markdownlint selection seam — DEFAULT_CONFIG", () => {
	it("routes the .md extension to an api markdownlint definition", () => {
		const linter = getLinterForFile(MD_FILE, DEFAULT_CONFIG);

		expect(linter).not.toBeNull();
		expect(linter?.type).toBe("api");
		expect((linter as ApiLinterDefinition).name).toBe("markdownlint");
	});

	it("does not carry a runner closure (config is data; adapter owns execution)", () => {
		// The seam selects markdownlint by the api+name contract, not by a runner.
		// `runner` is an optional escape hatch used by no built-in linter.
		const linter = getLinterForFile(
			MD_FILE,
			DEFAULT_CONFIG,
		) as ApiLinterDefinition;
		expect(linter.runner).toBeUndefined();
	});

	it("lower-cases the extension before lookup", () => {
		// getLinterForFile normalises via extname().toLowerCase()
		expect(getLinterForFile("DOC.MD", DEFAULT_CONFIG)).not.toBeNull();
		expect(getLinterForFile("Doc.Md", DEFAULT_CONFIG)?.type).toBe("api");
	});

	it("returns null for an extension with no configured linter", () => {
		expect(getLinterForFile("notes.txt", DEFAULT_CONFIG)).toBeNull();
		expect(getLinterForFile("Makefile", DEFAULT_CONFIG)).toBeNull();
	});
});

describe("markdownlint selection seam — adapter key + dispatch", () => {
	it("definitionKey for the markdownlint definition is 'api:markdownlint'", () => {
		const linter = getLinterForFile(MD_FILE, DEFAULT_CONFIG);
		expect(linter).not.toBeNull();
		expect(definitionKey(linter as ApiLinterDefinition)).toBe(
			"api:markdownlint",
		);
	});

	it("buildAdaptersFromConfig produces exactly one markdownlint adapter with the live identity", () => {
		const adapters = buildAdaptersFromConfig(DEFAULT_CONFIG);

		const markdownlintAdapters = adapters.filter(
			(a) => a.key === "api:markdownlint",
		);
		expect(markdownlintAdapters).toHaveLength(1);

		const adapter = markdownlintAdapters[0];
		expect(adapter.name).toBe("markdownlint");
		expect(adapter.key).toBe("api:markdownlint");
	});

	it("buildAdaptersFromConfig never produces a remark-lint adapter", () => {
		// The live seam has no branch that constructs a remark-lint adapter.
		// This is the guard the pruning plan depends on: removing remark-lint-poc
		// and its deps must leave adapter construction unchanged.
		const adapters = buildAdaptersFromConfig(DEFAULT_CONFIG);
		expect(adapters.some((a) => a.name.includes("remark"))).toBe(false);
		expect(adapters.some((a) => a.key.includes("remark"))).toBe(false);
	});

	it("groupFilesByAdapter routes a .md file to the api:markdownlint adapter", () => {
		const adapters = buildAdaptersFromConfig(DEFAULT_CONFIG);
		const groups = groupFilesByAdapter([MD_FILE], adapters, DEFAULT_CONFIG);

		expect(groups.size).toBe(1);
		const [[adapter, files]] = Array.from(groups.entries());
		expect(adapter.key).toBe("api:markdownlint");
		expect(files).toEqual([MD_FILE]);
	});

	it("groupFilesByAdapter does not attach a second adapter for the same .md file", () => {
		const adapters = buildAdaptersFromConfig(DEFAULT_CONFIG);
		const groups = groupFilesByAdapter([MD_FILE], adapters, DEFAULT_CONFIG);

		// A single .md file routes to exactly one adapter (no remark fallback).
		expect(groups.size).toBe(1);
		for (const routedFiles of groups.values()) {
			expect(routedFiles).toHaveLength(1);
		}
	});
});

describe("markdownlint selection seam — end-to-end through the pipeline", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-quality-gates-mdlint-seam-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("runChecks routes a .md file to markdownlint and reports its violations", async () => {
		const longLine =
			"This is a deliberately long sentence that contains enough words and spaces to exceed the one hundred and twenty character line length limit enforced by markdownlint.\n";
		const file = join(tempDir, "doc.md");
		writeFileSync(file, `# Title\n\n${longLine}`, "utf8");

		const pipeline = createLinterPipeline({ cwd: tempDir });
		const outcome = await pipeline.runChecks([file]);

		// The live markdownlint engine — not a remark runner — produced this output.
		expect(outcome.kind).toBe("findings");
		expect(outcome.report).toContain("markdownlint");
		expect(outcome.report).toContain("MD013");
		expect(outcome.report).toContain(file);
		expect(outcome.checkedFiles).toContain(file);
		expect(outcome.skippedFiles).not.toContain(file);
	});

	it("runChecks marks a conforming .md file as checked (not skipped)", async () => {
		const file = join(tempDir, "ok.md");
		writeFileSync(file, "# Hello\n", "utf8");

		const pipeline = createLinterPipeline({ cwd: tempDir });
		const outcome = await pipeline.runChecks([file]);

		expect(outcome.kind).toBe("clean");
		expect(outcome.checkedFiles).toContain(file);
		expect(outcome.skippedFiles).not.toContain(file);
	});

	it("runChecks routes an unconfigured extension to skippedFiles, never to markdownlint", async () => {
		const file = join(tempDir, "notes.txt");
		writeFileSync(file, "anything\n", "utf8");

		const pipeline = createLinterPipeline({ cwd: tempDir });
		const outcome = await pipeline.runChecks([file]);

		// .txt has no adapter -> skipped, and never accidentally linted by markdownlint.
		expect(outcome.skippedFiles).toContain(file);
		expect(outcome.report).not.toContain("MD013");
	});

	it("a config overriding '.md' with a different api name is still selected by the live branch", async () => {
		// Documents the selection contract: buildAdaptersFromConfig only constructs
		// a markdownlint adapter when name === "markdownlint". An unknown api name
		// produces NO adapter for .md, so the file is skipped. This proves the seam
		// is keyed on the markdownlint contract, not a generic api fallback.
		const file = join(tempDir, "doc.md");
		writeFileSync(file, "# Hello\n", "utf8");

		const config: LinterConfig = {
			...DEFAULT_CONFIG,
			linters: { ".md": { type: "api", name: "not-markdownlint" } },
		};
		const pipeline = createLinterPipeline({ cwd: tempDir, config });
		const outcome = await pipeline.runChecks([file]);

		expect(outcome.skippedFiles).toContain(file);
	});
});
