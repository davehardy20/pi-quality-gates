import { describe, expect, it } from "vitest";
import {
  detectProjectEcosystem,
  formatTestExecutionPlan,
  recommendTestCommands,
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
  it("recommends vitest/typecheck/biome for TypeScript", () => {
    const plan = recommendTestCommands(
      ["src/a.ts", "src/a.test.ts"],
      "/Users/dave/tools/pi-quality-gates",
    );
    expect(plan.ecosystem).toBe("typescript");
    expect(plan.recommendedCommands).toContain("run_vitest src/a.test.ts");
    expect(plan.recommendedCommands).toContain("run_typecheck");
    expect(plan.recommendedCommands).toContain("run_biome src test");
  });

  it("returns empty recommendations for unknown ecosystems", () => {
    const plan = recommendTestCommands(["src/a.unknown"], "/tmp/not-a-repo");
    expect(plan.ecosystem).toBe("unknown");
    expect(plan.recommendedCommands).toEqual([]);
  });
});

describe("formatTestExecutionPlan", () => {
  it("renders the ecosystem and commands", () => {
    const plan = {
      ecosystem: "typescript" as const,
      recommendedCommands: ["run_vitest src/a.test.ts", "run_typecheck"],
      discoveryCommand: "npx vitest run --reporter=dot",
    };
    const formatted = formatTestExecutionPlan(plan);
    expect(formatted).toContain("typescript");
    expect(formatted).toContain("run_vitest src/a.test.ts");
    expect(formatted).toContain("run_typecheck");
    expect(formatted).toContain("npx vitest run --reporter=dot");
  });

  it("renders a fallback for unknown ecosystems", () => {
    const plan = {
      ecosystem: "unknown" as const,
      recommendedCommands: [],
    };
    expect(formatTestExecutionPlan(plan)).toContain(
      "No test execution recommendations available",
    );
  });
});
