import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	assertPrReviewerToolPolicy,
	PR_REVIEW_CONFIG,
	PR_REVIEWER_FORBIDDEN_TOOLS,
	PR_REVIEWER_TOOLS,
	resolveReviewerModelConfig,
} from "../src/pr-gate/pr-review-config.js";

describe("PR reviewer config", () => {
	it("does not grant any forbidden tool", () => {
		for (const tool of PR_REVIEW_CONFIG.tools) {
			expect(PR_REVIEWER_FORBIDDEN_TOOLS.has(tool)).toBe(false);
		}
	});

	it("grants the host read-only/validation tools", () => {
		expect(PR_REVIEWER_TOOLS.has("read")).toBe(true);
		expect(PR_REVIEWER_TOOLS.has("pi_docs")).toBe(false);
		// Host-honesty: the reviewer runs host-side; container_safe is no longer granted.
		expect(PR_REVIEWER_TOOLS.has("container_safe")).toBe(false);
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

	it("resolves the worker profile from model-fallbacks at review time", () => {
		const result = resolveReviewerModelConfig({
			readFile: () =>
				JSON.stringify({
					profiles: {
						worker: {
							primary: "provider/primary",
							fallbacks: [
								"provider/fallback",
								"provider/primary",
								"provider/fallback",
							],
						},
					},
				}),
		});

		expect(result).toEqual({
			model: "provider/primary",
			fallbackModels: ["provider/fallback"],
		});
	});

	it("uses the active session model and scoped retry candidates when model-fallbacks is unavailable", () => {
		const result = resolveReviewerModelConfig({
			readFile: () => {
				throw new Error("ENOENT");
			},
			sessionModel: { provider: "active", id: "primary" },
			sessionFallbackModels: [
				{ provider: "active", id: "primary" },
				{ provider: "fallback", id: "first" },
				{ provider: "fallback", id: "first" },
				{ provider: "fallback", id: "second" },
			],
		});

		expect(result).toEqual({
			model: "active/primary",
			fallbackModels: ["fallback/first", "fallback/second"],
		});
	});

	it("uses the active session model when model-fallbacks is malformed", () => {
		const result = resolveReviewerModelConfig({
			readFile: () => "{ malformed",
			sessionModel: { provider: "session", id: "override" },
		});

		expect(result).toEqual({
			model: "session/override",
			fallbackModels: [],
		});
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

	it("keeps the live host reviewer prompt host-only and package-script-free", () => {
		const prompt = readFileSync(
			new URL("../src/pr-gate/prompts/system.md", import.meta.url),
			"utf8",
		);
		expect(prompt).toContain("Host read-only");
		expect(prompt).toMatch(/do NOT run package/);
		expect(prompt).not.toContain("trusted package scripts");
		// Duplication guard: the intro sentence and the runner bullet each appear once.
		expect(prompt.match(/running on the host/g)?.length).toBe(1);
		expect(
			prompt.match(/`run_biome`, `run_vitest`, `run_typecheck`/g)?.length,
		).toBe(1);
	});

	it("requires policy-to-runtime tracing in the host reviewer prompt", () => {
		const prompt = readFileSync(
			new URL("../src/pr-gate/prompts/system.md", import.meta.url),
			"utf8",
		);
		expect(prompt).toContain("Execution Policy Trace");
		expect(prompt).toMatch(/declaration.*compiler\/normalization/is);
		expect(prompt).toMatch(/dispatch\/preflight.*spawn\/runtime/is);
		expect(prompt).toMatch(/contradictory hard requirements/i);
		expect(prompt).toMatch(/redundant defaults/i);
		expect(prompt).toMatch(/enforcement sink/i);
	});

	it("enables the PR-Agent review-quality features by default", () => {
		// C2 structured diff hunks — labelled-hunk (__new__/__old__) diff format.
		expect(PR_REVIEW_CONFIG.useStructuredHunks).toBe(true);
		// C5 incremental review — scope to lastPassSha..HEAD on re-reviews.
		expect(PR_REVIEW_CONFIG.incrementalReview).toBe(true);
		// C4 can-split — flag large / mixed-concern changes and suggest splits.
		expect(PR_REVIEW_CONFIG.reviewOptions?.canSplit).toBe(true);
		// effortEstimate / todoScan remain opt-in (default off).
		expect(PR_REVIEW_CONFIG.reviewOptions?.effortEstimate).toBeUndefined();
		expect(PR_REVIEW_CONFIG.reviewOptions?.todoScan).toBeUndefined();
	});
});
