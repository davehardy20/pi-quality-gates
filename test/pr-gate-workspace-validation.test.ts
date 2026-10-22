import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatTestExecutionPlan,
	recommendTestCommands,
} from "../src/pr-gate/test-execution.js";
import { parseReviewValidationPolicy } from "../src/shared/review-validation-policy.js";

const roots: string[] = [];
function fixture(): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-workspaces-")),
	);
	roots.push(root);
	put(
		root,
		"package.json",
		JSON.stringify({ scripts: { test: "pnpm -r test" } }),
	);
	return root;
}
function put(root: string, file: string, content = ""): void {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), content);
}
function nodePackage(root: string, dir: string, loader?: string): void {
	put(
		root,
		`${dir}/package.json`,
		JSON.stringify({
			scripts: { test: `node --test${loader ? ` --import ${loader}` : ""}` },
		}),
	);
	put(root, `${dir}/tsconfig.json`, "{}");
}
function plan(root: string, files: string[]) {
	return recommendTestCommands(files, root, parseReviewValidationPolicy({}));
}
function renderedCalls(root: string, files: string[]) {
	return formatTestExecutionPlan(plan(root, files))
		.split("\n")
		.filter((line) => /^- run_/.test(line))
		.map((line) => ({
			tool: line.split(" ")[1],
			params: JSON.parse(line.slice(line.indexOf("{"))),
		}));
}
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe("workspace-aware review validation", () => {
	it("reproduces Gondolin: pnpm root delegates Node tests and typecheck to host", () => {
		const root = fixture();
		put(root, "pnpm-workspace.yaml", "packages:\n  - host\n  - packages/*\n");
		nodePackage(root, "host");
		const files = ["host/test/bundle.test.ts", "scripts/bundle.mjs"];
		for (const file of files) put(root, file);
		expect(plan(root, files).discoveryCommand).not.toContain("run_vitest");
		const calls = renderedCalls(root, files);
		expect(calls).toEqual([
			{
				tool: "run_node_test",
				params: {
					cwd: path.join(root, "host"),
					paths: ["test/bundle.test.ts"],
					timeoutMs: 300_000,
				},
			},
			{
				tool: "run_typecheck",
				params: { project: "host/tsconfig.json", timeoutMs: 300_000 },
			},
			{ tool: "run_biome", params: { paths: files, timeoutMs: 300_000 } },
		]);
	});

	it.each([
		["npm/yarn arrays", ["packages/*", "!packages/ignored"]],
		[
			"yarn packages objects",
			{ packages: ["packages/*", "!packages/ignored"] },
		],
	])("supports %s and all workspace projects", (_name, workspaces) => {
		const root = fixture();
		put(root, "package.json", JSON.stringify({ workspaces }));
		nodePackage(root, "packages/node", "./register.mjs");
		put(
			root,
			"packages/vite/package.json",
			JSON.stringify({ devDependencies: { vitest: "3.2.4" } }),
		);
		put(root, "packages/vite/tsconfig.json", "{}");
		nodePackage(root, "packages/unchanged");
		nodePackage(root, "packages/ignored");
		const files = [
			"packages/node/test/a.test.ts",
			"packages/vite/test/b.test.ts",
		];
		for (const file of files) put(root, file);
		const calls = renderedCalls(root, files);
		expect(calls.slice(0, 2)).toEqual([
			{
				tool: "run_node_test",
				params: {
					cwd: path.join(root, "packages/node"),
					paths: ["test/a.test.ts"],
					import: "./register.mjs",
					timeoutMs: 300_000,
				},
			},
			{
				tool: "run_vitest",
				params: {
					cwd: path.join(root, "packages/vite"),
					paths: ["test/b.test.ts"],
					timeoutMs: 300_000,
				},
			},
		]);
		expect(
			calls
				.filter((call) => call.tool === "run_typecheck")
				.map((call) => call.params.project),
		).toEqual([
			"packages/node/tsconfig.json",
			"packages/unchanged/tsconfig.json",
			"packages/vite/tsconfig.json",
		]);
	});

	it("keeps root typechecking when root and workspace projects both exist", () => {
		const root = fixture();
		put(root, "package.json", JSON.stringify({ workspaces: ["host"] }));
		put(root, "tsconfig.json", "{}");
		nodePackage(root, "host");
		put(root, "host/test/a.test.ts");
		const calls = renderedCalls(root, ["host/test/a.test.ts"]);
		expect(calls.filter((call) => call.tool === "run_typecheck")).toEqual([
			{ tool: "run_typecheck", params: { timeoutMs: 300_000 } },
			{
				tool: "run_typecheck",
				params: { project: "host/tsconfig.json", timeoutMs: 300_000 },
			},
		]);
	});

	it("does not infer a workspace runtime for unrelated root files", () => {
		const root = fixture();
		put(root, "pnpm-workspace.yaml", "packages: [host]");
		nodePackage(root, "host", "tsx");
		put(root, "root.test.mjs");
		const calls = renderedCalls(root, ["root.test.mjs"]);
		expect(calls[0]).toEqual({
			tool: "run_vitest",
			params: { paths: ["root.test.mjs"], timeoutMs: 300_000 },
		});
	});

	it("preserves repository-relative trusted timeout keys for package-local test paths", () => {
		const root = fixture();
		put(root, "pnpm-workspace.yaml", "packages: [host]");
		nodePackage(root, "host");
		const file = "host/test/slow.test.ts";
		put(root, file);
		const policy = parseReviewValidationPolicy({
			qualityGates: {
				reviewValidation: { repoOverrides: { [root]: { [file]: 900_000 } } },
			},
		});
		const result = recommendTestCommands([file, file], root, policy);
		expect(
			result.runnerCommands.filter((call) => call.scope === "targeted"),
		).toMatchObject([
			{
				tool: "run_node_test",
				args: ["test/slow.test.ts"],
				timeoutMs: 900_000,
			},
		]);
	});

	it("does not silently drop typechecking when no project can be discovered", () => {
		const root = fixture();
		put(root, "pnpm-workspace.yaml", "packages: [host]");
		put(
			root,
			"host/package.json",
			JSON.stringify({ scripts: { test: "node --test" } }),
		);
		put(root, "host/test/a.test.ts");
		const calls = renderedCalls(root, ["host/test/a.test.ts"]);
		expect(calls.some((call) => call.tool === "run_typecheck")).toBe(true);
	});

	it("infers tsx only within the owning workspace", () => {
		const root = fixture();
		put(root, "pnpm-workspace.yaml", "packages: [packages/*]");
		for (const name of ["ts", "js"]) {
			put(
				root,
				`packages/${name}/package.json`,
				JSON.stringify({
					scripts: { test: "node --test" },
					devDependencies: { tsx: "4.0.0" },
				}),
			);
		}
		const files = ["packages/ts/a.test.ts", "packages/js/a.test.mjs"];
		for (const file of files) put(root, file);
		const calls = renderedCalls(root, files).filter(
			(call) => call.tool === "run_node_test",
		);
		expect(calls).toHaveLength(2);
		expect(calls.map((call) => call.params.import)).toEqual(["tsx", undefined]);
	});

	const invalidPatterns = [
		"../outside",
		"/outside",
		"C:/outside",
		"host/../../outside",
		"!!host",
		"packages/{a,b}",
	];
	it.each(invalidPatterns)("rejects unsafe workspace pattern %s", (pattern) => {
		const root = fixture();
		put(root, "package.json", JSON.stringify({ workspaces: [pattern] }));
		expect(() => plan(root, [])).toThrow(/workspace/i);
	});

	it("rejects malformed workspace metadata rather than falling back to root Vitest", () => {
		const root = fixture();
		put(root, "pnpm-workspace.yaml", "packages: [host");
		expect(() => plan(root, [])).toThrow();
	});

	it.each(["package.json", "tsconfig.json"])("rejects escaped %s", (file) => {
		const root = fixture();
		const outside = fixture();
		put(root, "pnpm-workspace.yaml", "packages: [host]");
		nodePackage(root, "host");
		put(outside, file, "{}");
		fs.unlinkSync(path.join(root, "host", file));
		fs.symlinkSync(path.join(outside, file), path.join(root, "host", file));
		expect(() => plan(root, [])).toThrow(/workspace/i);
	});

	it("cannot replace missing TS project coverage with an unrelated workspace", () => {
		const root = fixture();
		put(root, "pnpm-workspace.yaml", "packages: [host, unrelated]");
		nodePackage(root, "unrelated");
		put(root, "host/package.json", "{}");
		put(root, "host/src/a.ts");
		const calls = renderedCalls(root, ["host/src/a.ts"]);
		expect(calls).toContainEqual({
			tool: "run_typecheck",
			params: { timeoutMs: 300_000 },
		});
	});

	it("rejects excessive workspace metadata", () => {
		const root = fixture();
		put(root, "pnpm-workspace.yaml", " ".repeat(256 * 1024 + 1));
		expect(() => plan(root, [])).toThrow(/bounded/i);
	});

	it("fails closed on directory-depth exhaustion", () => {
		const root = fixture();
		put(root, "pnpm-workspace.yaml", "packages: ['packages/**']");
		put(root, `packages/${"nested/".repeat(17)}package.json`, "{}");
		expect(() => plan(root, [])).toThrow(/limit/i);
	});

	it("rejects declared workspace directory symlink escapes", () => {
		const root = fixture();
		const outside = fixture();
		put(root, "pnpm-workspace.yaml", "packages: [host]");
		fs.symlinkSync(outside, path.join(root, "host"), "dir");
		expect(() => plan(root, [])).toThrow(/workspace/i);
	});
});
