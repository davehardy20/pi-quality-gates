import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadReviewValidationPolicy,
	parseReviewValidationPolicy,
	reviewerTimeoutForPlan,
} from "../src/shared/review-validation-policy.js";

const roots: string[] = [];
function fixture(): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "qg-budget-")),
	);
	roots.push(root);
	fs.mkdirSync(path.join(root, ".pi/agent"), { recursive: true });
	fs.mkdirSync(path.join(root, "test"));
	fs.writeFileSync(path.join(root, "test/slow.test.ts"), "");
	return root;
}
function settings(root: string, value: unknown): void {
	fs.writeFileSync(
		path.join(root, ".pi/agent/settings.json"),
		JSON.stringify(value),
	);
}
const review = (value: unknown) => ({
	qualityGates: { reviewValidation: value },
});
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe("trusted review validation policy", () => {
	it("uses explicit defaults only for missing settings/block/fields", () => {
		const root = fixture();
		const defaults = loadReviewValidationPolicy(root);
		expect(defaults).toEqual({
			defaultTimeoutMs: 300_000,
			repoOverrides: {},
			reviewOverheadMs: 600_000,
			maxReviewerTimeoutMs: 7_200_000,
			validationMaxTimeoutMs: 1_800_000,
		});
		settings(root, { theme: "dark", qualityGates: {} });
		expect(loadReviewValidationPolicy(root)).toEqual(defaults);
		expect(parseReviewValidationPolicy(review({}))).toEqual(defaults);
	});

	it("reads only global settings, ignoring repository policy and unrelated keys", () => {
		const root = fixture();
		fs.writeFileSync(
			path.join(root, ".pi/settings.json"),
			JSON.stringify(review({ defaultTimeoutMs: 1 })),
		);
		settings(root, {
			theme: "dark",
			qualityGates: {
				other: true,
				reviewValidation: { defaultTimeoutMs: 400_000 },
			},
		});
		expect(loadReviewValidationPolicy(root).defaultTimeoutMs).toBe(400_000);
	});

	it("accepts exact canonical repo/file overrides and authoritative safeTools limits", () => {
		const root = fixture();
		const policy = parseReviewValidationPolicy({
			...review({
				repoOverrides: { [root]: { "test/slow.test.ts": 1_200_000 } },
			}),
			safeTools: { validation: { maxTimeoutMs: 1_200_000 } },
		});
		expect(policy.repoOverrides[root]["test/slow.test.ts"]).toBe(1_200_000);
		expect(policy.validationMaxTimeoutMs).toBe(1_200_000);
	});

	it.each([
		null,
		[],
		1,
		{ unknown: 1 },
		{ defaultTimeoutMs: 1 },
		{ defaultTimeoutMs: null },
		{ reviewOverheadMs: null },
		{ maxReviewerTimeoutMs: null },
		{ defaultTimeoutMs: 1_800_001 },
		{ defaultTimeoutMs: 300_000.5 },
		{ defaultTimeoutMs: Number.MAX_SAFE_INTEGER },
		{ reviewOverheadMs: -1 },
		{ maxReviewerTimeoutMs: 86_400_001 },
		{ repoOverrides: [] },
	])("rejects malformed/unknown/unsafe review config %j", (value) => {
		expect(() => parseReviewValidationPolicy(review(value))).toThrow(
			"Invalid trusted review validation policy",
		);
	});

	it.each([
		null,
		[],
		{ maxTimeoutMs: 1_800_001 },
		{ maxTimeoutMs: 300_000, defaultTimeoutMs: 400_000 },
		{ typo: 1 },
	])("fails closed on authoritative safeTools config %j", (validation) => {
		expect(() =>
			parseReviewValidationPolicy({ safeTools: { validation } }),
		).toThrow();
	});

	it("refuses incompatible review defaults/overrides rather than clamping", () => {
		const root = fixture();
		expect(() =>
			parseReviewValidationPolicy({
				safeTools: { validation: { maxTimeoutMs: 60_000 } },
			}),
		).toThrow();
		expect(() =>
			parseReviewValidationPolicy({
				...review({
					repoOverrides: { [root]: { "test/slow.test.ts": 1_200_000 } },
				}),
				safeTools: { validation: { maxTimeoutMs: 300_000 } },
			}),
		).toThrow();
	});

	it.each([
		"../test/slow.test.ts",
		"/test/slow.test.ts",
		"test\\slow.test.ts",
		"./test/slow.test.ts",
		"test//slow.test.ts",
		"test/*",
		"test/slow.test.ts\n",
		"test/missing.test.ts",
	])("rejects unsafe/nonexact file %j", (file) => {
		const root = fixture();
		expect(() =>
			parseReviewValidationPolicy(
				review({ repoOverrides: { [root]: { [file]: 1_200_000 } } }),
			),
		).toThrow();
	});

	it("rejects noncanonical roots and symlink file/parent escapes", () => {
		const root = fixture();
		const outside = fixture();
		fs.symlinkSync(outside, path.join(root, "alias"));
		fs.symlinkSync(
			path.join(outside, "test/slow.test.ts"),
			path.join(root, "test/link.test.ts"),
		);
		for (const repo of ["relative", `${root}/`, `${root}/alias`])
			expect(() =>
				parseReviewValidationPolicy(
					review({
						repoOverrides: { [repo]: { "test/slow.test.ts": 1_200_000 } },
					}),
				),
			).toThrow();
		expect(() =>
			parseReviewValidationPolicy(
				review({
					repoOverrides: { [root]: { "test/link.test.ts": 1_200_000 } },
				}),
			),
		).toThrow();
		fs.rmSync(path.join(root, ".pi/agent"), { recursive: true });
		fs.symlinkSync(
			path.join(outside, ".pi/agent"),
			path.join(root, ".pi/agent"),
		);
		settings(outside, {});
		expect(() => loadReviewValidationPolicy(root)).toThrow();
	});

	it("rejects nonregular/symlink/oversized/malformed global files without leaking content", () => {
		const root = fixture();
		const file = path.join(root, ".pi/agent/settings.json");
		for (const value of ["secret-not-json", " ".repeat(1_048_577), "null"]) {
			fs.writeFileSync(file, value);
			expect(() => loadReviewValidationPolicy(root)).toThrow(
				/^Invalid trusted review validation policy\.$/,
			);
		}
		fs.rmSync(file);
		fs.symlinkSync(path.join(root, "test/slow.test.ts"), file);
		expect(() => loadReviewValidationPolicy(root)).toThrow();
		fs.rmSync(file);
		fs.mkdirSync(file);
		expect(() => loadReviewValidationPolicy(root)).toThrow();
	});

	it("rejects settings swaps/disappearance after inspection, never defaults", () => {
		for (const phase of ["open", "after-read"] as const) {
			const root = fixture();
			settings(root, {});
			const file = path.join(root, ".pi/agent/settings.json");
			let mutated = false;
			const swap = () => {
				if (mutated) return;
				mutated = true;
				fs.renameSync(file, `${file}.old`);
				if (phase === "open") fs.writeFileSync(file, "{}");
			};
			const io = {
				...fs,
				openSync: ((...args: Parameters<typeof fs.openSync>) => {
					if (phase === "open") swap();
					return fs.openSync(...args);
				}) as typeof fs.openSync,
				readSync: ((...args: Parameters<typeof fs.readSync>) => {
					const count = fs.readSync(...args);
					if (phase === "after-read") swap();
					return count;
				}) as typeof fs.readSync,
			};
			expect(() => loadReviewValidationPolicy(root, io)).toThrow(
				/^Invalid trusted review validation policy\.$/,
			);
		}
	});

	it("sums all eight call budgets once, plus overhead, not the per-call ceiling", () => {
		const policy = parseReviewValidationPolicy({});
		const commands = [
			{ timeoutMs: 1_200_000 },
			...Array.from({ length: 7 }, () => ({ timeoutMs: 300_000 })),
		];
		expect(reviewerTimeoutForPlan(commands, policy, 2_700_000)).toBe(3_900_000);
		expect(() =>
			reviewerTimeoutForPlan(
				commands,
				{ ...policy, maxReviewerTimeoutMs: 3_000_000 },
				2_700_000,
			),
		).toThrow(/required.*3900000.*3000000/);
		expect(() =>
			reviewerTimeoutForPlan(
				[{ timeoutMs: Number.MAX_SAFE_INTEGER }],
				policy,
				2_700_000,
			),
		).toThrow();
	});
});
