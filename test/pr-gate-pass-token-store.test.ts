import { describe, expect, it } from "vitest";
import { createPassTokenStore } from "../src/pr-gate/pass-token-store.js";

describe("PassTokenStore", () => {
	it("starts empty (no pass for any sha)", () => {
		const store = createPassTokenStore();
		expect(store.hasPass("abc123")).toBe(false);
		expect(store.size).toBe(0);
	});

	it("stamps and recognizes a pass for a sha", () => {
		const store = createPassTokenStore();
		store.stampPass({ sha: "abc123", passedAt: 1000, reportStatus: "PASS" });
		expect(store.hasPass("abc123")).toBe(true);
		expect(store.size).toBe(1);
	});

	it("is per-sha: a different sha is NOT covered by a stamped pass", () => {
		const store = createPassTokenStore();
		store.stampPass({ sha: "abc123", passedAt: 1000, reportStatus: "PASS" });
		expect(store.hasPass("abc123")).toBe(true);
		expect(store.hasPass("def456")).toBe(false);
	});

	it("re-stamping a sha replaces the prior entry (idempotent)", () => {
		const store = createPassTokenStore();
		store.stampPass({ sha: "abc123", passedAt: 1000, reportStatus: "PASS" });
		store.stampPass({ sha: "abc123", passedAt: 2000, reportStatus: "PASS" });
		expect(store.size).toBe(1);
		expect(store.hasPass("abc123")).toBe(true);
	});

	it("invalidate removes a single sha's pass", () => {
		const store = createPassTokenStore();
		store.stampPass({ sha: "abc123", passedAt: 1000, reportStatus: "PASS" });
		store.stampPass({ sha: "def456", passedAt: 2000, reportStatus: "PASS" });
		store.invalidate("abc123");
		expect(store.hasPass("abc123")).toBe(false);
		expect(store.hasPass("def456")).toBe(true);
		expect(store.size).toBe(1);
	});

	it("invalidate on unknown sha is a no-op", () => {
		const store = createPassTokenStore();
		store.invalidate("never-stamped");
		expect(store.size).toBe(0);
	});

	it("clear removes all passes", () => {
		const store = createPassTokenStore();
		store.stampPass({ sha: "abc123", passedAt: 1000, reportStatus: "PASS" });
		store.stampPass({ sha: "def456", passedAt: 2000, reportStatus: "PASS" });
		store.clear();
		expect(store.size).toBe(0);
		expect(store.hasPass("abc123")).toBe(false);
	});

	it("get returns the stamped entry or null", () => {
		const store = createPassTokenStore();
		store.stampPass({
			sha: "abc123",
			passedAt: 1000,
			reportStatus: "PASS",
			summary: "all clear",
		});
		expect(store.get("abc123")).toEqual({
			sha: "abc123",
			passedAt: 1000,
			reportStatus: "PASS",
			summary: "all clear",
		});
		expect(store.get("def456")).toBeNull();
	});

	it("rejects stamping a non-PASS reportStatus (defensive — only PASS stamps)", () => {
		const store = createPassTokenStore();
		// @ts-expect-error — intentionally wrong shape at the call site
		store.stampPass({ sha: "abc123", passedAt: 1000, reportStatus: "ISSUES" });
		expect(store.hasPass("abc123")).toBe(false);
		expect(store.size).toBe(0);
	});

	it("rejects empty/malformed sha (defensive)", () => {
		const store = createPassTokenStore();
		store.stampPass({ sha: "", passedAt: 1000, reportStatus: "PASS" });
		store.stampPass({
			sha: "   ",
			passedAt: 1000,
			reportStatus: "PASS",
		});
		expect(store.size).toBe(0);
	});
});

describe("PassTokenStore.lastPassSha (C5 incremental review)", () => {
	it("returns null when no token has been stamped", () => {
		const store = createPassTokenStore();
		expect(store.lastPassSha()).toBeNull();
	});

	it("returns the only stamped sha", () => {
		const store = createPassTokenStore();
		store.stampPass({ sha: "abc123", passedAt: 1000, reportStatus: "PASS" });
		expect(store.lastPassSha()).toBe("abc123");
	});

	it("tracks the most recently stamped sha across multiple stamps", () => {
		const store = createPassTokenStore();
		store.stampPass({ sha: "abc123", passedAt: 1000, reportStatus: "PASS" });
		store.stampPass({ sha: "def456", passedAt: 2000, reportStatus: "PASS" });
		expect(store.lastPassSha()).toBe("def456");
	});

	it("re-stamping the same sha keeps it as last pass", () => {
		const store = createPassTokenStore();
		store.stampPass({ sha: "abc123", passedAt: 1000, reportStatus: "PASS" });
		store.stampPass({ sha: "abc123", passedAt: 2000, reportStatus: "PASS" });
		expect(store.lastPassSha()).toBe("abc123");
		expect(store.size).toBe(1);
	});

	it("a rejected stamp (non-PASS / empty sha) does not move lastPassSha", () => {
		const store = createPassTokenStore();
		store.stampPass({ sha: "abc123", passedAt: 1000, reportStatus: "PASS" });
		// @ts-expect-error — intentionally wrong shape at the call site
		store.stampPass({ sha: "def456", passedAt: 2000, reportStatus: "ISSUES" });
		store.stampPass({ sha: "  ", passedAt: 3000, reportStatus: "PASS" });
		expect(store.lastPassSha()).toBe("abc123");
	});

	it("invalidate of the last-pass sha falls back to the newest remaining token", () => {
		const store = createPassTokenStore();
		store.stampPass({ sha: "abc123", passedAt: 1000, reportStatus: "PASS" });
		store.stampPass({ sha: "def456", passedAt: 2000, reportStatus: "PASS" });
		store.invalidate("def456");
		expect(store.lastPassSha()).toBe("abc123");
	});

	it("invalidate of the last remaining token resets lastPassSha to null", () => {
		const store = createPassTokenStore();
		store.stampPass({ sha: "abc123", passedAt: 1000, reportStatus: "PASS" });
		store.invalidate("abc123");
		expect(store.lastPassSha()).toBeNull();
	});

	it("invalidate of a non-last sha keeps lastPassSha unchanged", () => {
		const store = createPassTokenStore();
		store.stampPass({ sha: "abc123", passedAt: 1000, reportStatus: "PASS" });
		store.stampPass({ sha: "def456", passedAt: 2000, reportStatus: "PASS" });
		store.invalidate("abc123");
		expect(store.lastPassSha()).toBe("def456");
	});

	it("clear resets lastPassSha to null", () => {
		const store = createPassTokenStore();
		store.stampPass({ sha: "abc123", passedAt: 1000, reportStatus: "PASS" });
		store.clear();
		expect(store.lastPassSha()).toBeNull();
	});
});
