import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scopeBiomeValidation } from "../src/pr-gate/biome-validation-scope.js";
import {
	formatTestExecutionPlan,
	recommendTestCommands,
} from "../src/pr-gate/test-execution.js";
import { parseReviewValidationPolicy } from "../src/shared/review-validation-policy.js";

const roots: string[] = [];
function put(root: string, file: string, text = ""): void {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), text);
}
function fixture(config?: unknown, configName = "biome.json"): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-biome-scope-")),
	);
	roots.push(root);
	put(
		root,
		"package.json",
		JSON.stringify({ devDependencies: { vitest: "3.2.4" } }),
	);
	put(root, "tsconfig.json", "{}");
	if (config !== undefined) put(root, configName, JSON.stringify(config));
	return root;
}
function plan(root: string, files: string[]) {
	for (const file of files) put(root, file);
	return recommendTestCommands(files, root, parseReviewValidationPolicy({}));
}
function lintPaths(root: string, files: string[]): string[] {
	return (
		plan(root, files).runnerCommands.find((call) => call.tool === "run_biome")
			?.args ?? []
	);
}
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe("PR review Biome scope", () => {
	it("reproduces Gondolin's JSON-only preparatory slice without an impossible lint call", () => {
		const root = fixture({
			files: {
				includes: [
					"host/src/**/*.ts",
					"host/test/**/*.ts",
					"scripts/**/*.mjs",
					"!host/src/vendored",
				],
			},
		});
		put(root, "package.json", JSON.stringify({ workspaces: ["host"] }));
		put(
			root,
			"host/package.json",
			JSON.stringify({ scripts: { test: "node --test" } }),
		);
		put(root, "host/tsconfig.json", "{}");
		const files = [
			"images/pi-node-base.bundle/package.json",
			"images/pi-node-base.bundle/package-lock.json",
		];
		const result = plan(root, files);
		expect(
			result.runnerCommands.some((call) => call.tool === "run_biome"),
		).toBe(false);
		expect(
			result.runnerCommands
				.filter((call) => call.tool === "run_typecheck")
				.map((call) => call.project),
		).toEqual([undefined, "host/tsconfig.json"]);
		expect(result.discoveryCommand).toContain("excluded by Biome");
		for (const file of files)
			expect(formatTestExecutionPlan(result)).toContain(file);
		expect(result.discoveryCommand).toContain("not linted");
	});

	it("keeps test and typecheck calls while linting only included changed paths", () => {
		const root = fixture({
			files: { includes: ["src/**/*.ts", "test/**/*.ts"] },
		});
		const result = plan(root, [
			"src/a.ts",
			"test/a.test.ts",
			"images/bundle/package.json",
		]);
		expect(result.runnerCommands.map((call) => call.tool)).toEqual([
			"run_vitest",
			"run_typecheck",
			"run_biome",
		]);
		expect(result.runnerCommands.at(-1)?.args).toEqual([
			"src/a.ts",
			"test/a.test.ts",
		]);
		expect(
			result.runnerCommands.every((call) => call.timeoutMs === 300_000),
		).toBe(true);
	});

	it("preserves default lint coverage when no file scope is configured", () => {
		const files = ["src/a.ts", "images/package.json"];
		expect(lintPaths(fixture(), files)).toEqual(files);
		expect(lintPaths(fixture({ formatter: { enabled: true } }), files)).toEqual(
			files,
		);
	});

	it("honors ordered simple includes, exclusions and reinclusions", () => {
		const root = fixture({
			files: {
				includes: ["src/**", "!src/generated/**", "src/generated/keep.ts"],
			},
		});
		expect(
			lintPaths(root, [
				"src/a.ts",
				"src/generated/drop.ts",
				"src/generated/keep.ts",
				"images/package.json",
			]),
		).toEqual(["src/a.ts", "src/generated/keep.ts"]);
	});

	it("matches directory patterns against descendants and force exclusions", () => {
		const root = fixture({
			files: { includes: ["src", "!!src/generated"] },
		});
		expect(
			lintPaths(root, [
				"src/nested/a.ts",
				"src/generated/drop.ts",
				"images/package.json",
			]),
		).toEqual(["src/nested/a.ts"]);
	});

	it("reads a strict-JSON biome.jsonc configuration", () => {
		const root = fixture({ files: { includes: ["src/**"] } }, "biome.jsonc");
		expect(lintPaths(root, ["src/a.ts", "images/package.json"])).toEqual([
			"src/a.ts",
		]);
	});

	it.each([
		{ extends: ["./base.json"], files: { includes: ["src/**"] } },
		{ root: false, files: { includes: ["src/**"] } },
		{ files: { includes: ["src/*.{ts,js}"] } },
		{ files: { includes: ["src/*a*b.ts"] } },
		{ files: { includes: ["**/src/**/a.ts"] } },
		{ files: { includes: ["src/**"], ignore: ["generated/**"] } },
		{ files: { includes: ["src/**"], experimentalScannerIgnores: ["dist"] } },
		{ files: { includes: [] } },
		{ files: { includes: ["!images/**"] } },
		{ files: { includes: "src/**" } },
		{
			$schema: "https://biomejs.dev/schemas/1.9.4/schema.json",
			files: { includes: ["src/**"] },
		},
	])("retains checks for unresolved metadata: %j", (config) => {
		const root = fixture(config);
		const files = ["src/a.ts", "images/package.json"];
		const result = plan(root, files);
		expect(
			result.runnerCommands.find((call) => call.tool === "run_biome")?.args,
		).toEqual(files);
		expect(result.discoveryCommand).toContain("unresolved");
	});

	it("retains lint for paths with a nested config rather than assuming root exclusion", () => {
		const root = fixture({ files: { includes: ["src/**"] } });
		put(
			root,
			"images/biome.json",
			JSON.stringify({ root: false, files: { includes: ["**"] } }),
		);
		expect(
			lintPaths(root, [
				"src/a.ts",
				"images/package.json",
				"other/package.json",
			]),
		).toEqual(["src/a.ts", "images/package.json"]);
	});

	it.each([
		"{ invalid",
		'{ /* comment */ "files": { "includes": ["src/**"] } }',
	])("retains checks for unparsed config", (text) => {
		const root = fixture();
		put(root, "biome.jsonc", text);
		const result = plan(root, ["images/package.json"]);
		expect(result.runnerCommands.at(-1)?.tool).toBe("run_biome");
		expect(result.discoveryCommand).toContain("unresolved");
		expect(result.discoveryCommand).not.toContain(text);
	});

	it("retains required lint when the root configuration is itself changed", () => {
		const root = fixture({ files: { includes: ["src/**"] } });
		put(root, "images/package.json", "{}");
		const files = ["biome.json", "images/package.json"];
		const result = recommendTestCommands(
			files,
			root,
			parseReviewValidationPolicy({}),
		);
		expect(
			result.runnerCommands.find((call) => call.tool === "run_biome")?.args,
		).toEqual(files);
		expect(result.discoveryCommand).toContain("unresolved");
	});

	it.each([
		["biome.json", "biome.jsonc"],
		["biome.jsonc", "biome.json"],
		["./biome.json", "biome.jsonc"],
	])("retains lint after deleting %s", (deleted, remaining) => {
		const root = fixture({ files: { includes: ["src/**"] } }, remaining);
		put(root, deleted, "{}");
		fs.unlinkSync(path.join(root, deleted));
		put(root, "images/package.json", "{}");
		const result = recommendTestCommands(
			[deleted, "images/package.json"],
			root,
			parseReviewValidationPolicy({}),
		);
		expect(
			result.runnerCommands.find((call) => call.tool === "run_biome")?.args,
		).toEqual(["images/package.json"]);
		expect(result.discoveryCommand).toContain("unresolved");
	});

	it("uses separately supplied unfiltered paths only for the configuration guard", () => {
		const root = fixture({ files: { includes: ["test/**"] } });
		put(root, "src/a.ts", "export const a = 1;");
		const result = recommendTestCommands(
			["src/a.ts"],
			root,
			parseReviewValidationPolicy({}),
			["src/a.ts", "./biome.json"],
		);
		expect(
			result.runnerCommands.find((call) => call.tool === "run_biome")?.args,
		).toEqual(["src/a.ts"]);
		expect(result.discoveryCommand).toContain("unresolved");
	});

	it.each([
		"../biome.json",
		"/biome.json",
		"src/../biome.json",
		"src\\\\a.ts",
	])("rejects invalid unfiltered paths before normalization: %s", (file) => {
		const root = fixture({ files: { includes: ["test/**"] } });
		put(root, "src/a.ts", "export const a = 1;");
		expect(() =>
			recommendTestCommands(
				["src/a.ts"],
				root,
				parseReviewValidationPolicy({}),
				[file],
			),
		).toThrow(/changed path/);
	});

	it("rejects external symlinks in unfiltered paths even when review filters hide them", () => {
		const outside = fixture();
		put(outside, "target.json", "{}");
		const root = fixture({ files: { includes: ["test/**"] } });
		put(root, "src/a.ts", "export const a = 1;");
		fs.symlinkSync(
			path.join(outside, "target.json"),
			path.join(root, "hidden.json"),
		);
		expect(() =>
			recommendTestCommands(
				["src/a.ts"],
				root,
				parseReviewValidationPolicy({}),
				["src/a.ts", "hidden.json"],
			),
		).toThrow(/escapes the workspace/);
	});

	const invalidPaths = [
		"../outside.json",
		"/outside.json",
		"src/../a.ts",
		"src\\\\a.ts",
	];
	it.each(invalidPaths)("rejects invalid paths: %s", (file) => {
		expect(() => scopeBiomeValidation([file], fixture())).toThrow(
			/Invalid.*candidate path/,
		);
	});

	it("does not guess config precedence when both config names exist", () => {
		const root = fixture({ files: { includes: ["src/**"] } });
		put(root, "biome.jsonc", "{}");
		expect(lintPaths(root, ["images/package.json"])).toEqual([
			"images/package.json",
		]);
	});

	it("rejects oversized configuration rather than reading unbounded metadata", () => {
		const root = fixture();
		put(root, "biome.json", " ".repeat(256 * 1024 + 1));
		expect(() => plan(root, ["images/package.json"])).toThrow(/Biome.*bounded/);
	});

	it("rejects external config symlinks without exposing their contents", () => {
		const outside = fixture({
			files: { includes: ["secret-path/**"] },
		});
		const root = fixture();
		fs.symlinkSync(
			path.join(outside, "biome.json"),
			path.join(root, "biome.json"),
		);
		expect(() => plan(root, ["images/package.json"])).toThrow(
			/Biome.*repository/,
		);
	});
});
