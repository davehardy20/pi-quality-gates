import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	detectProjectEcosystem,
	formatTestExecutionPlan,
	recommendTestCommands,
	type TestExecutionPlan,
} from "../src/pr-gate/test-execution.js";

describe("detectProjectEcosystem", () => {
	it("detects TypeScript from package.json", () => {
		expect(detectProjectEcosystem("/Users/dave/tools/pi-quality-gates")).toBe(
			"typescript",
		);
	});

	it("returns unknown when no manifest is present", () => {
		expect(detectProjectEcosystem(`/tmp/not-a-repo-${Date.now()}`)).toBe(
			"unknown",
		);
	});
});

describe("recommendTestCommands", () => {
	it("recommends container-safe vitest/typecheck/biome for TypeScript", () => {
		const plan = recommendTestCommands(
			["src/a.ts", "src/a.test.ts"],
			"/Users/dave/tools/pi-quality-gates",
		);
		expect(plan.ecosystem).toBe("typescript");
		expect(plan.executionSandbox).toBe("apple-container");
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
		expect(plan.executionSandbox).toBe("apple-container");
	});
});

describe("formatTestExecutionPlan", () => {
	it("renders the ecosystem and commands", () => {
		const plan: TestExecutionPlan = {
			ecosystem: "typescript",
			recommendedCommands: ["run_vitest src/a.test.ts", "run_typecheck"],
			runnerCommands: [],
			discoveryCommand: "npx vitest run --reporter=dot",
			executionSandbox: "apple-container",
			containerTool: "container_safe",
			resultContract: "bounded summary only",
		};
		const formatted = formatTestExecutionPlan(plan);
		expect(formatted).toContain("typescript");
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
			executionSandbox: "apple-container",
			containerTool: "container_safe",
			resultContract: "bounded summary only",
		};
		expect(formatTestExecutionPlan(plan)).toContain(
			"No safe validation runner is available",
		);
	});
});
