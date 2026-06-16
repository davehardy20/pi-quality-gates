import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	decideAutoReview,
	getLatestLinterStatus,
	type LinterStatusEntry,
	registerAutoReview,
} from "../src/pr-gate/auto-review-trigger.js";

function entry(customType: string, status?: string): LinterStatusEntry {
	return {
		type: "custom_message",
		customType,
		details: status ? { status } : undefined,
	};
}

describe("getLatestLinterStatus", () => {
	it("returns 'none' when no linter status exists", () => {
		expect(getLatestLinterStatus([])).toBe("none");
		expect(
			getLatestLinterStatus([entry("some-other-message"), entry("turn_end")]),
		).toBe("none");
	});

	it("returns 'clean' for the most recent clean status", () => {
		expect(
			getLatestLinterStatus([
				entry("post-turn-linter-status", "findings"),
				entry("post-turn-linter-status", "clean"),
			]),
		).toBe("clean");
	});

	it("returns 'findings' when the latest status has findings", () => {
		expect(
			getLatestLinterStatus([
				entry("post-turn-linter-status", "clean"),
				entry("post-turn-linter-status", "findings"),
			]),
		).toBe("findings");
	});

	it("ignores older statuses in favour of the most recent", () => {
		expect(
			getLatestLinterStatus([
				entry("post-turn-linter-status", "clean"),
				entry("post-turn-linter-status", "findings"),
				entry("post-turn-linter-status", "clean"),
				entry("post-turn-linter-status", "findings"),
			]),
		).toBe("findings");
	});
});

describe("decideAutoReview", () => {
	const YES = {
		enabled: true,
		inProgress: false,
		linterStatus: "clean" as const,
		headSha: "abc123",
		hasPass: false,
		lastReviewedSha: "",
	};

	it("reviews when clean + new HEAD + no PASS + enabled + not in progress", () => {
		const d = decideAutoReview(YES);
		expect(d.shouldReview).toBe(true);
	});

	it("skips when gate disabled", () => {
		expect(decideAutoReview({ ...YES, enabled: false }).shouldReview).toBe(
			false,
		);
	});

	it("skips when a review is already in progress", () => {
		expect(decideAutoReview({ ...YES, inProgress: true }).shouldReview).toBe(
			false,
		);
	});

	it("skips when linter has findings", () => {
		expect(
			decideAutoReview({ ...YES, linterStatus: "findings" }).shouldReview,
		).toBe(false);
	});

	it("skips when linter has not run (none)", () => {
		expect(
			decideAutoReview({ ...YES, linterStatus: "none" }).shouldReview,
		).toBe(false);
	});

	it("skips when HEAD is unresolved", () => {
		expect(decideAutoReview({ ...YES, headSha: "" }).shouldReview).toBe(false);
	});

	it("skips when HEAD already has a PASS token", () => {
		expect(decideAutoReview({ ...YES, hasPass: true }).shouldReview).toBe(
			false,
		);
	});

	it("skips when HEAD is unchanged since the last auto-review", () => {
		expect(
			decideAutoReview({ ...YES, lastReviewedSha: "abc123" }).shouldReview,
		).toBe(false);
	});

	it("reviews again after HEAD changes to a new sha", () => {
		const first = decideAutoReview({ ...YES, headSha: "aaa" });
		expect(first.shouldReview).toBe(true);

		const second = decideAutoReview({
			...YES,
			headSha: "bbb",
			lastReviewedSha: "aaa",
		});
		expect(second.shouldReview).toBe(true);
	});

	it("does not re-review a HEAD that already failed review (sticky guard)", async () => {
		// Regression: a failed review must NOT reset lastReviewedSha, otherwise
		// terminal failures like "No files changed" loop forever on turn_end.
		// This drives the real registerAutoReview turn_end path with a failing
		// runReview and asserts the second turn_end does not re-trigger.
		const turnEndHandlers: Array<(event: unknown, ctx: unknown) => unknown> =
			[];
		const pi = {
			on: (
				_event: string,
				handler: (event: unknown, ctx: unknown) => unknown,
			) => {
				turnEndHandlers.push(handler);
			},
		} as unknown as ExtensionAPI;

		const runReview = vi.fn(async () => {
			throw new Error("No files changed between origin/master and HEAD");
		});
		const notify = vi.fn();
		const ctx = {
			sessionManager: {
				getBranch: () =>
					[
						{
							type: "custom_message",
							customType: "post-turn-linter-status",
							details: { status: "clean" },
						},
					] as LinterStatusEntry[],
			},
		};

		registerAutoReview(pi, {
			getHeadSha: () => "abc123",
			hasPass: () => false,
			isEnabled: () => true,
			isInProgress: () => false,
			runReview,
			notify,
		});

		await turnEndHandlers[0](undefined, ctx);
		expect(runReview).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Auto-review failed"),
		);

		// Second turn_end for the SAME head: must not re-trigger.
		await turnEndHandlers[0](undefined, ctx);
		expect(runReview).toHaveBeenCalledTimes(1);
	});
});
