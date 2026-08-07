import { readFileSync } from "node:fs";
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

	it("grants the Apple-container validation/read-only tools", () => {
		expect(PR_REVIEWER_TOOLS.has("read")).toBe(true);
		expect(PR_REVIEWER_TOOLS.has("pi_docs")).toBe(false);
		expect(PR_REVIEWER_TOOLS.has("container_safe")).toBe(true);
		expect(PR_REVIEWER_TOOLS.has("git_inspect_safe")).toBe(true);
		expect(PR_REVIEWER_TOOLS.has("web_search")).toBe(true);
		expect(PR_REVIEWER_TOOLS.has("mulch_query")).toBe(true);
		expect(PR_REVIEWER_TOOLS.has("mulch_search")).toBe(true);
		expect(PR_REVIEWER_TOOLS.has("seeds_show")).toBe(true);
		expect(PR_REVIEWER_TOOLS.has("seeds_plan_show")).toBe(true);
		expect(PR_REVIEWER_TOOLS.has("run_vitest")).toBe(true);
		expect(PR_REVIEWER_TOOLS.has("run_typecheck")).toBe(true);
		expect(PR_REVIEWER_TOOLS.has("run_biome")).toBe(true);
		expect(PR_REVIEWER_TOOLS.has("run_pytest")).toBe(true);
		expect(PR_REVIEWER_TOOLS.has("run_cargo_test")).toBe(true);
		expect(PR_REVIEWER_TOOLS.has("run_node_test")).toBe(true);
	});

	it("binds the reviewer to the cross-vendor model with a fallback chain", () => {
		expect(PR_REVIEW_CONFIG.model).toBe("zai/glm-5.2");
		expect(PR_REVIEW_CONFIG.fallbackModels).toEqual([
			"kimi-coding/k3-256k",
			"opencode/deepseek-v4-flash",
		]);
	});

	it("allows enough time for sandbox image startup and deep review", () => {
		expect(PR_REVIEW_CONFIG.timeoutMs).toBeGreaterThanOrEqual(45 * 60_000);
	});

	it("does not grant bash", () => {
		expect(PR_REVIEWER_TOOLS.has("bash")).toBe(false);
		expect(PR_REVIEWER_FORBIDDEN_TOOLS.has("bash")).toBe(true);
	});

	it("passes the policy assertion", () => {
		expect(() => assertPrReviewerToolPolicy()).not.toThrow();
	});

	it("directs Pi documentation research through the native read tool", () => {
		for (const promptPath of [
			"../src/pr-gate/prompts/system.md",
			"../src/pr-gate/prompts/pr-reviewer-system.md",
		]) {
			const prompt = readFileSync(new URL(promptPath, import.meta.url), "utf8");
			expect(prompt).not.toMatch(/\bpi_docs\b/);
			expect(prompt).toMatch(/Pi.*documentation.*read/i);
		}
	});
});
