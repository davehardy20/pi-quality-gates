import { describe, expect, it } from "vitest";
import { renderSystemPrompt } from "../src/pr-gate/reviewer.js";
import type { ReviewConfig } from "../src/shared/review-config.js";

// Synthetic raw prompt carrying the C4 placeholder tokens. renderSystemPrompt
// only reads `config.reviewOptions`, so a partial cast is sufficient here.
const RAW_PROMPT = [
	"## Review Domains",
	"Work through every domain for each changed file.",
	"{{REVIEW_OPTIONAL_DOMAINS}}",
	"",
	"## Output Format",
	"- **Suggestion:** Concrete fix with code if helpful",
	"{{EFFORT_FIELD}}",
].join("\n");

function config(reviewOptions: ReviewConfig["reviewOptions"]): ReviewConfig {
	return { reviewOptions } as ReviewConfig;
}

describe("renderSystemPrompt (C4 review toggles)", () => {
	it("emits the baseline prompt with no toggles enabled", () => {
		const out = renderSystemPrompt(RAW_PROMPT, config(undefined));
		expect(out).not.toContain("Optional Domain");
		expect(out).not.toContain("Effort:");
		// Placeholders are fully substituted (no leftover tokens).
		expect(out).not.toContain("{{");
	});

	it("appends the TODO scan domain when todoScan is enabled", () => {
		const out = renderSystemPrompt(RAW_PROMPT, config({ todoScan: true }));
		expect(out).toContain("Optional Domain: TODO / FIXME");
		expect(out).not.toContain("Can-Be-Split");
		expect(out).not.toContain("Effort:");
	});

	it("appends the can-split domain when canSplit is enabled", () => {
		const out = renderSystemPrompt(RAW_PROMPT, config({ canSplit: true }));
		expect(out).toContain("Optional Domain: Change Cohesion (Can-Be-Split)");
		expect(out).not.toContain("TODO / FIXME");
	});

	it("appends the effort domain AND the Effort output field when effortEstimate is enabled", () => {
		const out = renderSystemPrompt(
			RAW_PROMPT,
			config({ effortEstimate: true }),
		);
		expect(out).toContain("Optional Domain: Effort Estimate");
		expect(out).toContain("- **Effort:**");
	});

	it("appends all three optional domains in a fixed order when every toggle is on", () => {
		const out = renderSystemPrompt(
			RAW_PROMPT,
			config({ todoScan: true, canSplit: true, effortEstimate: true }),
		);
		const todoIdx = out.indexOf("TODO / FIXME");
		const splitIdx = out.indexOf("Can-Be-Split");
		const effortIdx = out.indexOf("Effort Estimate");
		expect(todoIdx).toBeGreaterThan(-1);
		expect(splitIdx).toBeGreaterThan(todoIdx);
		expect(effortIdx).toBeGreaterThan(splitIdx);
		expect(out).toContain("- **Effort:**");
	});

	it("is deterministic: identical config yields identical output", () => {
		const cfg = config({ todoScan: true, effortEstimate: true });
		expect(renderSystemPrompt(RAW_PROMPT, cfg)).toEqual(
			renderSystemPrompt(RAW_PROMPT, cfg),
		);
	});
});
