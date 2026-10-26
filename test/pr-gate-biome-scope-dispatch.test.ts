import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPassTokenStore } from "../src/pr-gate/pass-token-store.js";
import { PR_REVIEW_CONFIG } from "../src/pr-gate/pr-review-config.js";
import { createPrReviewDispatch } from "../src/pr-gate/pr-review-dispatch.js";
import type { ReviewerExecution } from "../src/pr-gate/reviewer.js";
import { parseReviewValidationPolicy } from "../src/shared/review-validation-policy.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe("Biome scope through review dispatch", () => {
	it.each([
		{ config: "biome.json", changed: ["biome.json"] },
		{ config: "biome.jsonc", changed: ["biome.jsonc"] },
		{ config: "biome.json", changed: ["Biome.json"] },
		{ config: "biome.json", changed: ["BIOME.JSON"] },
		{ config: "biome.jsonc", changed: ["Biome.jsonc"] },
		{ config: "biome.jsonc", changed: ["BIOME.JSONC"] },
		{ config: "biome.jsonc", changed: ["biome.json", "biome.jsonc"] },
		{ config: "biome.json", changed: ["biome.jsonc", "biome.json"] },
		// A deleted configuration alone must disable use of the remaining one.
		{ config: "biome.jsonc", changed: ["biome.json"] },
		{ config: "biome.json", changed: ["biome.jsonc"] },
		{ config: "biome.json", changed: [] },
	])("guards config: $config / $changed", async (entry) => {
		const { config, changed } = entry;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "biome-dispatch-"));
		roots.push(root);
		fs.mkdirSync(path.join(root, ".pi"));
		fs.mkdirSync(path.join(root, "src"));
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ devDependencies: { vitest: "3.2.4" } }),
		);
		fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");
		fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
		fs.writeFileSync(
			path.join(root, config),
			JSON.stringify({ files: { includes: ["test/**"] } }),
		);
		fs.writeFileSync(
			path.join(root, ".pi/reviewer.skip"),
			"biome.json\nbiome.jsonc\n",
		);
		const runAttempt = vi.fn<ReviewerExecution["runAttempt"]>(async () => ({
			report: {
				status: "PASS",
				confidence: "HIGH",
				findings: [],
				verified: [],
				unverifiable: [],
				testExecution: { status: "PASS", summary: "fixture" },
				summary: "fixture",
			},
			rawOutput: "fixture",
			exitCode: 0,
			timedOut: false,
			stderr: "",
			command: "fixture",
		}));
		const dispatch = createPrReviewDispatch({
			getHeadSha: () => "fixture-head",
			getBaseRef: () => "master",
			isWorktreeClean: () => true,
			listChangedFiles: async () => ["src/a.ts", ...changed],
			// Exercise the real reviewer.skip loader and diff filters. No Git
			// repository is needed: gitignore filtering is disabled in this fixture.
			reviewConfig: { ...PR_REVIEW_CONFIG, respectGitignore: false },
			loadReviewValidationPolicy: () => parseReviewValidationPolicy({}),
			countDiffLines: async () => 10,
			gatherDiff: async () => ({
				text: "diff",
				truncated: false,
				omittedLines: 0,
			}),
			extractTask: () => "review",
			reviewerExecution: { runAttempt },
		});
		const result = await dispatch.dispatch({
			ctx: { cwd: root } as ExtensionContext,
			state: { tokens: createPassTokenStore(), config: { enabled: true } },
			pi: {} as ExtensionAPI,
		});

		expect(result.blocked).toBe(false);
		expect(runAttempt).toHaveBeenCalledOnce();
		const input = runAttempt.mock.calls[0][0];
		expect(input.files).toEqual(["src/a.ts"]);
		expect(input.testPlan).toContain("run_typecheck");
		if (changed.length) {
			expect(input.testPlan).toContain('run_biome {"paths":["src/a.ts"]');
			expect(input.testPlan).toContain("Biome scope unresolved");
		} else {
			expect(input.testPlan).not.toContain("run_biome");
			expect(input.testPlan).toContain("not linted");
		}
	});
});
