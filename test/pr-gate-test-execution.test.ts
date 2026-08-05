import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PR_REVIEWER_TOOLS } from "../src/pr-gate/pr-review-config.js";
import {
	detectProjectEcosystem,
	detectTypeScriptTestFramework,
	formatTestExecutionPlan,
	recommendTestCommands,
	type TestExecutionPlan,
} from "../src/pr-gate/test-execution.js";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

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

describe("recommendTestCommands", () => {
	it("recommends container-safe vitest/typecheck/biome for TypeScript", () => {
		const plan = recommendTestCommands(
			["src/a.ts", "src/a.test.ts"],
			REPO_ROOT,
		);
		expect(plan.ecosystem).toBe("typescript");
		expect(plan.executionSandbox).toBe("repository-checkout");
		expect(plan.containerTool).toBe("container_safe");
		expect(plan.recommendedCommands).toContain("run_vitest src/a.test.ts");
		expect(plan.recommendedCommands).toContain("run_typecheck");
		expect(plan.recommendedCommands).toContain("run_biome src test");
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

		const plan = recommendTestCommands(["src/a.test.ts"], cwd);

		expect(plan.ecosystem).toBe("typescript");
		expect(plan.recommendedCommands).toContain("run_node_test src/a.test.ts");
		expect(plan.recommendedCommands).toContain("run_typecheck");
		expect(plan.recommendedCommands).toContain("run_biome src test");
		expect(plan.runnerCommands.map((cmd) => cmd.tool)).toEqual([
			"run_node_test",
			"run_typecheck",
			"run_biome",
		]);
		expect(plan.discoveryCommand).toContain("node --test");
	});

	it("only emits tools granted to the reviewer (node-test path)", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-qg-grant-node-"));
		fs.writeFileSync(
			path.join(cwd, "package.json"),
			JSON.stringify({ scripts: { test: "node --test" } }),
		);
		const plan = recommendTestCommands(["src/a.test.ts"], cwd);
		for (const cmd of plan.runnerCommands) {
			expect(PR_REVIEWER_TOOLS.has(cmd.tool)).toBe(true);
		}
	});

	it("only emits tools granted to the reviewer (vitest path)", () => {
		const plan = recommendTestCommands(["src/a.test.ts"], REPO_ROOT);
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
		expect(formatted).toContain("Apple container via container_safe");
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
