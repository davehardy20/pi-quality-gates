import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createPassTokenStore } from "../src/pr-gate/pass-token-store.js";
import {
	createPrReviewDispatch,
	resolveDefaultBaseRef,
} from "../src/pr-gate/pr-review-dispatch.js";

describe("createPrReviewDispatch", () => {
	it("surfaces a sidecar path when the reviewer returns unparsable output", async () => {
		const dispatch = createPrReviewDispatch({
			getHeadSha: () => "abc123",
			getBaseRef: () => "origin/main",
			listChangedFiles: async () => ["src/foo.ts"],
			applyDiffFilters: async (files) => files,
			countDiffLines: async () => 10,
			gatherDiff: async () => "diff",
			extractTask: () => "review",
			reviewerExecution: {
				runAttempt: async () => ({
					report: null,
					rawOutput: "garbage",
					exitCode: 0,
					timedOut: false,
					usage: "↑1 ↓2 $0.00",
					stderr: "",
					command: "pi ...",
					sidecarPath: "/tmp/reviewer-failures/abc",
				}),
			},
		});

		const result = await dispatch.dispatch({
			ctx: { cwd: "/tmp" } as ExtensionContext,
			state: { tokens: createPassTokenStore(), config: { enabled: true } },
			pi: {} as ExtensionAPI,
		});

		expect(result.blocked).toBe(true);
		expect(result.message).toContain("could not parse review report");
		expect(result.message).toContain("/tmp/reviewer-failures/abc");
	});

	it("selects the first available default branch ref without CommonJS require", () => {
		const attempted: string[] = [];
		const baseRef = resolveDefaultBaseRef("/repo", (_cwd, ref) => {
			attempted.push(ref);
			return ref === "master";
		});

		expect(baseRef).toBe("master");
		expect(attempted).toEqual(["origin/master", "origin/main", "master"]);
	});

	it("fails closed when HEAD changes during review", async () => {
		const heads = ["head-a", "head-a", "head-b"];
		const getHeadSha = vi.fn(() => heads.shift() ?? "head-b");
		const runAttempt = vi.fn(async () => ({
			report: {
				status: "PASS" as const,
				confidence: "HIGH" as const,
				findings: [],
				verified: ["tests"],
				unverifiable: [],
				testExecution: { status: "PASS" as const, summary: "passed" },
				summary: "ok",
			},
			rawOutput: "## Review Report",
			exitCode: 0,
			timedOut: false,
			stderr: "",
			command: "orchestrate category=pr-reviewer",
		}));
		const tokens = createPassTokenStore();
		const dispatch = createPrReviewDispatch({
			getHeadSha,
			getBaseRef: () => "master",
			listChangedFiles: async () => ["src/foo.ts"],
			applyDiffFilters: async (files) => files,
			countDiffLines: async () => 10,
			gatherDiff: async () => "diff",
			extractTask: () => "review",
			reviewerExecution: { runAttempt },
		});

		const result = await dispatch.dispatch({
			ctx: { cwd: "/repo" } as ExtensionContext,
			state: { tokens, config: { enabled: true } },
			pi: {} as ExtensionAPI,
		});

		expect(runAttempt).toHaveBeenCalledWith(
			expect.objectContaining({ headSha: "head-a" }),
		);
		expect(result.blocked).toBe(true);
		expect(result.stamped).toBe(false);
		expect(result.message).toContain("HEAD changed during review");
		expect(tokens.size).toBe(0);
	});
});
