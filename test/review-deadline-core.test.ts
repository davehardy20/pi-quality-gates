import { describe, expect, it } from "vitest";
import {
	createReviewDeadline,
	reviewDeadlineDiagnostic,
} from "../src/shared/review-deadline.js";

describe("review deadline foundation", () => {
	it("uses one monotonic budget across preparation and successive attempts", () => {
		let now = 0;
		const deadline = createReviewDeadline(1_000, () => now);
		expect(deadline.remainingMs()).toBe(1_000);
		now = 100;
		expect(deadline.remainingMs()).toBe(900);
		now = 500;
		expect(deadline.remainingMs()).toBe(500);
		now = 900;
		expect(deadline.remainingMs()).toBe(100);
		now = 1_100;
		expect(deadline.remainingMs()).toBe(0);
		expect(deadline.elapsedMs()).toBe(1_100);
		expect(deadline.budgetMs).toBe(1_000);
		expect(reviewDeadlineDiagnostic(deadline)).toMatch(
			/budget=1000.*elapsed=1100.*remaining=0/,
		);
		expect(reviewDeadlineDiagnostic(deadline)).toContain("unknown");
		expect(reviewDeadlineDiagnostic(deadline)).toContain("not completion");
	});

	it("counts preparation from an explicit review-entry timestamp", () => {
		const deadline = createReviewDeadline(3_900_000, () => 100, 0);
		expect(deadline.remainingMs()).toBe(3_899_900);
	});

	it("allows a genuinely new review request a fresh budget", () => {
		let now = 0;
		const first = createReviewDeadline(1_000, () => now);
		now = 1_100;
		expect(first.remainingMs()).toBe(0);
		const next = createReviewDeadline(1_000, () => now);
		expect(next.remainingMs()).toBe(1_000);
		expect(first.remainingMs()).toBe(0);
	});

	const unsafeBudgets = [
		0,
		-1,
		0.5,
		Number.NaN,
		Number.MAX_SAFE_INTEGER,
		86_400_001,
	];
	for (const budget of unsafeBudgets) {
		it(`rejects unsafe or unbounded budget ${budget}`, () => {
			expect(() => createReviewDeadline(budget)).toThrow(
				"Invalid overall review deadline.",
			);
		});
	}
});
