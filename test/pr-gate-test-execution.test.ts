import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PR_REVIEWER_TOOLS } from "../src/pr-gate/pr-review-config.js";
import {
	detectNodeTestLoader,
	detectProjectEcosystem,
	detectTypeScriptTestFramework,
	formatTestExecutionPlan,
	recommendTestCommands,
	type TestExecutionPlan,
} from "../src/pr-gate/test-execution.js";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const fixtureRoots: string[] = [];

function withTestFiles(root: string, files: string[]): string {
	if (!fixtureRoots.includes(root)) fixtureRoots.push(root);
	for (const file of files) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), "");
	}
	return root;
}

function changedFilesFixture(files: string[]): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-plan-"));
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ devDependencies: { vitest: "^3.2.4" } }),
	);
	return withTestFiles(root, files);
}

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("detectProjectEcosystem", () => {
	it("detects TypeScript from package.json", () => {
		expect(detectProjectEcosystem(REPO_ROOT)).toBe("typescript");
	});

	it("returns unknown when no manifest is present", () => {
		expect(detectProjectEcosystem(`/tmp/not-a-repo-${Date.now()}`)).toBe(
			"unknown",
		);
	});
});

describe("detectTypeScriptTestFramework", () => {
	it("detects Vitest when vitest is a devDependency", () => {
		expect(detectTypeScriptTestFramework(REPO_ROOT)).toBe("vitest");
	});

	it("detects node --test from a test script with no vitest", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-fw-node-"));
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({ scripts: { test: "node --test" } }),
		);
		expect(detectTypeScriptTestFramework(cwd)).toBe("node-test");
	});

	it("prefers Vitest when both vitest and a node --test script exist", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-fw-mixed-"));
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({
				devDependencies: { vitest: "^3.0.0" },
				scripts: { test: "node --test" },
			}),
		);
		expect(detectTypeScriptTestFramework(cwd)).toBe("vitest");
	});

	it("does not treat --test-name-pattern as a node --test signal", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-fw-pattern-"));
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({ scripts: { test: "node --test-name-pattern foo" } }),
		);
		expect(detectTypeScriptTestFramework(cwd)).toBe("vitest");
	});

	it("falls back to Vitest when no package.json is present", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-fw-none-"));
		expect(detectTypeScriptTestFramework(cwd)).toBe("vitest");
	});
});

describe("detectNodeTestLoader", () => {
	it("detects the loader from a --import spec in the test script", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-loader-script-"));
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({ scripts: { test: "node --test --import tsx" } }),
		);
		expect(detectNodeTestLoader(cwd)).toBe("tsx");
	});

	it("infers tsx when tsx is a devDependency", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-loader-devdep-"));
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({
				devDependencies: { tsx: "^4.0.0" },
				scripts: { test: "node --test" },
			}),
		);
		expect(detectNodeTestLoader(cwd)).toBe("tsx");
	});

	it("does not infer from ts-node alone (it registers via --loader, not --import)", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-loader-tsnode-"));
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({
				devDependencies: { "ts-node": "^10.0.0" },
				scripts: { test: "node --test" },
			}),
		);
		expect(detectNodeTestLoader(cwd)).toBeUndefined();
	});

	it("detects the loader from a --import=spec (equals form) in the test script", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-loader-equals-"));
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({ scripts: { test: "node --test --import=tsx" } }),
		);
		expect(detectNodeTestLoader(cwd)).toBe("tsx");
	});

	it("returns undefined for build-then-test projects", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-loader-none-"));
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({
				scripts: { test: "tsc && node --test build/**/*.test.js" },
			}),
		);
		expect(detectNodeTestLoader(cwd)).toBeUndefined();
	});

	it("returns undefined when no package.json is present", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-loader-nopkg-"));
		expect(detectNodeTestLoader(cwd)).toBeUndefined();
	});
});

describe("recommendTestCommands", () => {
	it("recommends host Vitest, typecheck and scoped lint", () => {
		const files = ["src/a.ts", "src/a.test.ts"];
		const plan = recommendTestCommands(files, changedFilesFixture(files));
		expect(plan.ecosystem).toBe("typescript");
		expect(plan.executionSandbox).toBe("repository-checkout");
		expect(plan.containerTool).toBe("container_safe");
		expect(plan.recommendedCommands).toContain("run_vitest src/a.test.ts");
		expect(plan.recommendedCommands).toContain("run_typecheck");
		expect(
			plan.runnerCommands.find((cmd) => cmd.tool === "run_biome")?.args,
		).toEqual(files);
		expect(plan.runnerCommands.map((cmd) => cmd.tool)).toEqual([
			"run_vitest",
			"run_typecheck",
			"run_biome",
		]);
	});

	it("recommends run_node_test for a node --test project", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-node-test-"));
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({
				name: "node-test-project",
				scripts: { test: "node --test" },
			}),
		);

		const plan = recommendTestCommands(
			["src/a.test.ts"],
			withTestFiles(cwd, ["src/a.test.ts"]),
		);

		expect(plan.ecosystem).toBe("typescript");
		expect(plan.recommendedCommands).toContain("run_node_test src/a.test.ts");
		expect(plan.recommendedCommands).toContain("run_typecheck");
		expect(plan.recommendedCommands).not.toContain("run_biome src test");
		expect(plan.runnerCommands.map((cmd) => cmd.tool)).toEqual([
			"run_node_test",
			"run_typecheck",
			"run_biome",
		]);
		expect(plan.discoveryCommand).toContain("node --test");
	});

	it("surfaces the tsx loader for .test.ts files in a node --test project", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-loader-rec-"));
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({
				devDependencies: { tsx: "^4.0.0" },
				scripts: { test: "node --test" },
			}),
		);
		const plan = recommendTestCommands(
			["src/a.test.ts"],
			withTestFiles(cwd, ["src/a.test.ts"]),
		);
		expect(plan.recommendedCommands).toContain(
			"run_node_test --import tsx src/a.test.ts",
		);
		const nodeCmd = plan.runnerCommands.find((c) => c.tool === "run_node_test");
		expect(nodeCmd?.import).toBe("tsx");
		expect(nodeCmd?.args).toEqual(["src/a.test.ts"]);
		expect(plan.discoveryCommand).toContain("--import tsx");
	});

	it("does not infer tsx for compiled JS-only suites", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-loader-js-"));
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({
				devDependencies: { tsx: "^4.0.0" },
				scripts: { test: "node --test" },
			}),
		);
		const plan = recommendTestCommands(
			["build/a.test.js"],
			withTestFiles(cwd, ["build/a.test.js"]),
		);
		expect(plan.recommendedCommands).toContain("run_node_test build/a.test.js");
		const nodeCmd = plan.runnerCommands.find((c) => c.tool === "run_node_test");
		expect(nodeCmd?.import).toBeUndefined();
	});

	it("plans bounded per-file Vitest calls without duplicates", () => {
		const files = [
			"test/slow.test.ts",
			"test/other.test.ts",
			"agent/worker.ts",
		];
		const plan = recommendTestCommands(
			[...files, files[0]],
			changedFilesFixture(files),
		);
		expect(
			plan.runnerCommands
				.filter((cmd) => cmd.tool === "run_vitest")
				.map((cmd) => cmd.args),
		).toEqual([[files[0]], [files[1]]]);
		for (const cmd of plan.runnerCommands) {
			expect(cmd).toHaveProperty("timeoutMs", 300_000);
		}
	});

	it("selects Vitest entry basenames, not nested helpers or test-like paths", () => {
		const entries = [
			"src/tests/worker.test.ts",
			"src/tests/worker.spec.mts",
			"src/tests/helpers/nested.test.ts",
		];
		const helpers = [
			"src/tests/helpers/setup.ts",
			"src/tests/fixtures/data.mjs",
			"src/tests/worker.test.fixture.ts",
			"src/worker.spec.helpers.ts",
			"src/test-like.test.directory/helper.ts",
			"src/test-worker.js",
			"src/worker_test.js",
		];
		const files = [...helpers, ...entries];
		const plan = recommendTestCommands(files, changedFilesFixture(files));
		expect(
			plan.runnerCommands
				.filter((cmd) => cmd.tool === "run_vitest")
				.map((cmd) => cmd.args),
		).toEqual(entries.map((entry) => [entry]));
		expect(
			plan.runnerCommands.find((cmd) => cmd.tool === "run_biome")?.args,
		).toEqual(files);
		const tools = plan.runnerCommands.map((cmd) => cmd.tool);
		expect(tools).toContain("run_typecheck");
	});

	it("keeps Node entry conventions and imports without directory helpers", () => {
		const entries = [
			"src/tests/test-worker.ts",
			"src/worker-test.mjs",
			"src/worker_test.cjs",
			"src/test.js",
			"src/worker.test.ts",
			"src/worker.spec.mjs",
		];
		const helpers = [
			"src/tests/helpers/setup.ts",
			"src/tests/worker.test.fixture.ts",
			"src/test-like.test.directory/helper.ts",
		];
		const files = [...helpers, ...entries];
		const cwd = changedFilesFixture(files);
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({ scripts: { test: "node --test --import tsx" } }),
		);
		const plan = recommendTestCommands(files, cwd);
		const calls = plan.runnerCommands.filter(
			(cmd) => cmd.tool === "run_node_test",
		);
		expect(calls.map((cmd) => cmd.args)).toEqual(
			entries.map((entry) => [entry]),
		);
		expect(calls.every((cmd) => cmd.import === "tsx")).toBe(true);
		expect(
			plan.runnerCommands.find((cmd) => cmd.tool === "run_biome")?.args,
		).toEqual(files);
	});

	it("does not infer a Node loader from changed TS helpers", () => {
		const files = ["src/tests/helpers/setup.ts", "src/worker.test.js"];
		const cwd = changedFilesFixture(files);
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({
				scripts: { test: "node --test" },
				devDependencies: { tsx: "^4.0.0" },
			}),
		);
		const plan = recommendTestCommands(files, cwd);
		const calls = plan.runnerCommands.filter(
			(cmd) => cmd.tool === "run_node_test",
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].args).toEqual([files[1]]);
		expect(calls[0].import).toBeUndefined();
	});

	it("preserves Vitest entry suffixes across supported JS/TS extensions", () => {
		const extensions = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"];
		const files = extensions.flatMap((ext) => [
			`src/worker.test.${ext}`,
			`src/worker.spec.${ext}`,
		]);
		const plan = recommendTestCommands(files, changedFilesFixture(files));
		expect(
			plan.runnerCommands
				.filter((cmd) => cmd.tool === "run_vitest")
				.map((cmd) => cmd.args),
		).toEqual(files.map((file) => [file]));
	});

	it("lints only existing changed supported files", () => {
		const files = [
			"agent/worker.ts",
			"test/worker.test.ts",
			"config.json",
			"config.jsonc",
			"module.mts",
			"module.cts",
			"web.jsx",
			"README.md",
		];
		const cwd = changedFilesFixture([...files, "test/unrelated.test.ts"]);
		const plan = recommendTestCommands([...files, "deleted.ts"], cwd);
		expect(
			plan.runnerCommands.find((cmd) => cmd.tool === "run_biome")?.args,
		).toEqual(files.slice(0, -1));
		expect(
			plan.runnerCommands.find((cmd) => cmd.tool === "run_vitest")?.args,
		).toEqual(["test/worker.test.ts"]);
	});

	it("does not expand unsupported or deleted-only changes to broad lint", () => {
		const cwd = changedFilesFixture(["README.md"]);
		const plan = recommendTestCommands(["README.md", "removed.test.ts"], cwd);
		expect(plan.runnerCommands.map((cmd) => cmd.tool)).toEqual([
			"run_typecheck",
		]);
	});

	it("rejects symlink escapes in changed files", () => {
		const outside = changedFilesFixture(["outside.ts"]);
		const cwd = changedFilesFixture([]);
		fs.symlinkSync(outside, path.join(cwd, "redirect"), "junction");
		expect(() => recommendTestCommands(["redirect/outside.ts"], cwd)).toThrow(
			/escapes the workspace/,
		);
	});

	it.each([
		"../escape.ts",
		"/outside.ts",
		"src/../escape.ts",
		`bad${String.fromCharCode(0)}.ts`,
		"C:/outside.ts",
		"dir\\escape.ts",
	])("rejects unsafe changed path %j", (file) => {
		const cwd = changedFilesFixture([]);
		expect(() => recommendTestCommands([file], cwd)).toThrow(/changed.*path/i);
	});

	it("preserves project Node imports on every per-file call", () => {
		const files = ["test/a.test.ts", "test/b.test.mjs"];
		const cwd = changedFilesFixture(files);
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({ scripts: { test: "node --test --import tsx" } }),
		);
		const plan = recommendTestCommands(files, cwd);
		const commands = plan.runnerCommands.filter(
			(cmd) => cmd.tool === "run_node_test",
		);
		expect(commands).toMatchObject([
			{ args: [files[0]], import: "tsx", timeoutMs: 300_000 },
			{ args: [files[1]], import: "tsx", timeoutMs: 300_000 },
		]);
		const calls = formatTestExecutionPlan(plan)
			.split("\n")
			.filter((line) => line.startsWith("- run_node_test "));
		for (const call of calls) {
			expect(JSON.parse(call.slice(call.indexOf("{"))).import).toBe("tsx");
		}
	});

	it("preserves inferred tsx across mixed per-file Node calls", () => {
		const files = ["test/a.test.ts", "test/b.test.mjs"];
		const cwd = changedFilesFixture(files);
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({
				scripts: { test: "node --test" },
				devDependencies: { tsx: "^4.0.0" },
			}),
		);
		const commands = recommendTestCommands(files, cwd).runnerCommands.filter(
			(cmd) => cmd.tool === "run_node_test",
		);
		expect(commands).toHaveLength(2);
		expect(commands.map((cmd) => cmd.import)).toEqual(["tsx", "tsx"]);
	});

	it("executes a JS-only test importing loader-dependent code", () => {
		const file = "test/loader.test.mjs";
		const cwd = changedFilesFixture([
			file,
			"src/value.fixture",
			"register.mjs",
			"hooks.mjs",
		]);
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({
				type: "module",
				scripts: { test: "node --test --import ./register.mjs" },
			}),
		);
		fs.writeFileSync(
			path.join(cwd, "register.mjs"),
			'import { register } from "node:module";\nregister("./hooks.mjs", import.meta.url);\n',
		);
		fs.writeFileSync(
			path.join(cwd, "hooks.mjs"),
			[
				'import { readFile } from "node:fs/promises";',
				"export async function load(url, context, nextLoad) {",
				'  if (url.endsWith(".fixture")) {',
				'    return { format: "module", shortCircuit: true,',
				'      source: await readFile(new URL(url), "utf8") };',
				"  }",
				"  return nextLoad(url, context);",
				"}",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(cwd, "src/value.fixture"),
			"export const value = 42;\n",
		);
		fs.writeFileSync(
			path.join(cwd, file),
			[
				'import { strictEqual } from "node:assert";',
				'import { test } from "node:test";',
				'import { value } from "../src/value.fixture";',
				'test("transitive loader dependency", () => strictEqual(value, 42));',
			].join("\n"),
		);
		const plan = recommendTestCommands([file], cwd);
		const commands = plan.runnerCommands.filter(
			(cmd) => cmd.tool === "run_node_test",
		);
		expect(commands).toHaveLength(1);
		const cmd = commands[0];
		const options = {
			cwd,
			encoding: "utf8" as const,
			env: { NODE_OPTIONS: "", NODE_PATH: "" },
			timeout: 5_000,
			maxBuffer: 64 * 1024,
		};
		// Execute the generated structured arguments, never the display string.
		const result = spawnSync(
			process.execPath,
			["--test", ...(cmd.import ? ["--import", cmd.import] : []), ...cmd.args],
			options,
		);
		expect(result.status, result.stdout + result.stderr).toBe(0);
		// Negative control: native JS execution cannot load this dependency.
		const withoutImport = spawnSync(
			process.execPath,
			["--test", ...cmd.args],
			options,
		);
		expect(withoutImport.status).toBe(1);
		expect(withoutImport.stdout + withoutImport.stderr).toContain(
			"ERR_UNKNOWN_FILE_EXTENSION",
		);
	});

	it("only emits tools granted to the reviewer (node-test path)", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-grant-node-"));
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({ scripts: { test: "node --test" } }),
		);
		const plan = recommendTestCommands(
			["src/a.test.ts"],
			withTestFiles(cwd, ["src/a.test.ts"]),
		);
		for (const cmd of plan.runnerCommands) {
			expect(PR_REVIEWER_TOOLS.has(cmd.tool)).toBe(true);
		}
	});

	it("only emits tools granted to the reviewer (vitest path)", () => {
		const files = ["src/a.test.ts"];
		const plan = recommendTestCommands(files, changedFilesFixture(files));
		for (const cmd of plan.runnerCommands) {
			expect(PR_REVIEWER_TOOLS.has(cmd.tool)).toBe(true);
		}
	});

	it("does not map Go to an unsupported safe runner", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-go-"));
		fs.writeFileSync(path.join(cwd, "go.mod"), "module example.test\n");

		const plan = recommendTestCommands(["main_test.go"], cwd);

		expect(plan.ecosystem).toBe("go");
		expect(plan.recommendedCommands).toEqual([]);
		expect(plan.discoveryCommand).toBe("go test -list .");
	});

	it("returns empty recommendations for unknown ecosystems", () => {
		const plan = recommendTestCommands(["src/a.unknown"], "/tmp/not-a-repo");
		expect(plan.ecosystem).toBe("unknown");
		expect(plan.recommendedCommands).toEqual([]);
		expect(plan.executionSandbox).toBe("repository-checkout");
	});
});

describe("formatTestExecutionPlan", () => {
	it("renders encoded JSON tool arguments with explicit budgets", () => {
		const files = ["test/slow case.test.ts", 'src/quote"file.ts'];
		const plan = recommendTestCommands(files, changedFilesFixture(files));
		const formatted = formatTestExecutionPlan(plan);
		const calls = formatted.split("\n").filter((line) => /^- run_/.test(line));
		expect(calls).toHaveLength(plan.runnerCommands.length);
		for (const [index, line] of calls.entries()) {
			const cmd = plan.runnerCommands[index];
			const args = JSON.parse(line.slice(line.indexOf("{")));
			expect(args.timeoutMs).toBe(300_000);
			if (cmd.args.length) expect(args.paths).toEqual(cmd.args);
		}
		expect(formatted).toContain("tool arguments");
	});
	it("renders the ecosystem and commands", () => {
		const plan: TestExecutionPlan = {
			ecosystem: "typescript",
			recommendedCommands: ["run_vitest src/a.test.ts", "run_typecheck"],
			runnerCommands: [],
			discoveryCommand: "npx vitest run --reporter=dot",
			executionSandbox: "repository-checkout",
			containerTool: "container_safe",
			resultContract: "bounded summary only",
		};
		const formatted = formatTestExecutionPlan(plan);
		expect(formatted).toContain("typescript");
		expect(formatted).toContain("repository checkout");
		// Both bridges validate on the host, never in an Apple container.
		expect(formatted).toContain("on the host");
		expect(formatted).not.toContain("Apple container");
		expect(formatted).not.toContain("host bridge only");
		expect(formatted).not.toContain("PI_PR_REVIEW_BRIDGE");
		expect(formatted).toContain("run_vitest src/a.test.ts");
		expect(formatted).toContain("run_typecheck");
		expect(formatted).toContain("npx vitest run --reporter=dot");
		expect(formatted).toContain("### Test execution");
	});

	it("renders a fallback for unknown ecosystems", () => {
		const plan: TestExecutionPlan = {
			ecosystem: "unknown",
			recommendedCommands: [],
			runnerCommands: [],
			executionSandbox: "repository-checkout",
			containerTool: "container_safe",
			resultContract: "bounded summary only",
		};
		expect(formatTestExecutionPlan(plan)).toContain(
			"No safe validation runner is available",
		);
	});
});
