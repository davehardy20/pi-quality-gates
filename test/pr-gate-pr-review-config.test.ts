import { describe, expect, it } from "vitest";
import {
  assertPrReviewerToolPolicy,
  PR_REVIEW_CONFIG,
  PR_REVIEWER_FORBIDDEN_TOOLS,
  PR_REVIEWER_TOOLS,
} from "../src/pr-gate/pr-review-config.js";



describe("PR reviewer config", () => {
  it("does not grant any forbidden tool", () => {
    for (const tool of PR_REVIEW_CONFIG.tools) {
      expect(PR_REVIEWER_FORBIDDEN_TOOLS.has(tool)).toBe(false);
    }
  });

  it("grants the test execution runners", () => {
    expect(PR_REVIEWER_TOOLS.has("run_vitest")).toBe(true);
    expect(PR_REVIEWER_TOOLS.has("run_typecheck")).toBe(true);
    expect(PR_REVIEWER_TOOLS.has("run_biome")).toBe(true);
    expect(PR_REVIEWER_TOOLS.has("run_pytest")).toBe(true);
    expect(PR_REVIEWER_TOOLS.has("run_cargo_test")).toBe(true);
  });

  it("does not grant bash", () => {
    expect(PR_REVIEWER_TOOLS.has("bash")).toBe(false);
    expect(PR_REVIEWER_FORBIDDEN_TOOLS.has("bash")).toBe(true);
  });

  it("passes the policy assertion", () => {
    expect(() => assertPrReviewerToolPolicy()).not.toThrow();
  });
});
