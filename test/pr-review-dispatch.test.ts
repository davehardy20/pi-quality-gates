import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createPassTokenStore } from "../src/pr-gate/pass-token-store.js";
import { createPrReviewDispatch } from "../src/pr-gate/pr-review-dispatch.js";

describe("createPrReviewDispatch", () => {
	it("surfaces a sidecar path when the reviewer returns unparsable output", async () => {
		const dispatch = createPrReviewDispatch({
			getHeadSha: () => "abc123",
			getBaseRef: () => "origin/main",
			listChangedFiles: async () => ["src/foo.ts"],
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
});
