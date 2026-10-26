import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatTestExecutionPlan,
	recommendTestCommands,
} from "../src/pr-gate/test-execution.js";
import {
	loadReviewValidationPolicy,
	parseReviewValidationPolicy,
	reviewerTimeoutForPlan,
} from "../src/shared/review-validation-policy.js";

const roots: string[] = [];
function fixture(): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "qg-pytest-partitions-")),
	);
	roots.push(root);
	fs.mkdirSync(path.join(root, "pkg/tests"), { recursive: true });
	fs.writeFileSync(path.join(root, "pyproject.toml"), "");
	fs.writeFileSync(path.join(root, "pkg/tests/test_guard.py"), "");
	return root;
}
const partition = {
	keyword: "fresh_installed",
	matchingTimeoutMs: 210_000,
	remainingTimeoutMs: 300_000,
};
function settings(pytestPartitions: unknown, extra = {}) {
	return { qualityGates: { reviewValidation: { pytestPartitions, ...extra } } };
}
function policyFor(root: string) {
	return parseReviewValidationPolicy(settings({ [root]: partition }), root);
}
function toolArguments(text: string) {
	return text
		.split("\n")
		.filter((line) => line.startsWith("- run_pytest "))
		.map((line) => JSON.parse(line.slice(line.indexOf("{"))));
}
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe("trusted exhaustive pytest partition policy", () => {
	it("accepts only a literal keyword and bounded budgets for the exact repository", () => {
		const root = fixture();
		const policy = policyFor(root);
		expect(policy.pytestPartitions).toEqual({ [root]: partition });
		expect(Object.getPrototypeOf(policy.pytestPartitions)).toBeNull();
		expect(parseReviewValidationPolicy({}).pytestPartitions).toEqual({});
	});

	it("defaults both partition budgets to the trusted review default, never the runner default", () => {
		const root = fixture();
		const policy = parseReviewValidationPolicy(
			settings({ [root]: { keyword: "slow" } }, { defaultTimeoutMs: 120_000 }),
			root,
		);
		expect(policy.pytestPartitions[root]).toEqual({
			keyword: "slow",
			matchingTimeoutMs: 120_000,
			remainingTimeoutMs: 120_000,
		});
	});

	it("reads partitions only from the trusted global file, not repository settings", () => {
		const home = fixture();
		const root = fixture();
		fs.mkdirSync(path.join(root, ".pi"));
		fs.writeFileSync(
			path.join(root, ".pi/settings.json"),
			JSON.stringify(settings({ [root]: partition })),
		);
		expect(
			loadReviewValidationPolicy(home, undefined, root).pytestPartitions,
		).toEqual({});
		fs.mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".pi/agent/settings.json"),
			JSON.stringify(settings({ [root]: partition })),
		);
		expect(
			loadReviewValidationPolicy(home, undefined, root).pytestPartitions,
		).toEqual({
			[root]: partition,
		});
	});

	const malformedMaps = [null, [], 1, "slow"];
	it.each(malformedMaps)("rejects malformed maps: %j", (value) => {
		expect(() => parseReviewValidationPolicy(settings(value))).toThrow(
			"Invalid trusted review validation policy.",
		);
	});

	it.each([
		null,
		[],
		{},
		{ keyword: "" },
		{ keyword: null },
		{ keyword: 1 },
		{ keyword: "and" },
		{ keyword: "OR" },
		{ keyword: "not" },
		{ keyword: "not slow" },
		{ keyword: "slow or fast" },
		{ keyword: "(slow)" },
		{ keyword: "--ignore=tests" },
		{ keyword: "slow\n" },
		{ keyword: "slow\r\n" },
		{ keyword: "slow\u0000" },
		{ keyword: "sl\u043ew" },
		{ keyword: "x".repeat(129) },
		{ ...partition, paths: ["pkg/tests"] },
		{ ...partition, exclude: "fast" },
		{ ...partition, command: "pytest" },
		{ ...partition, matchingTimeoutMs: null },
		{ ...partition, matchingTimeoutMs: 999 },
		{ ...partition, matchingTimeoutMs: 1_800_001 },
		{ ...partition, remainingTimeoutMs: 300_000.5 },
		{ ...partition, remainingTimeoutMs: 1_800_001 },
	])("rejects unsafe declarations: %j", (value) => {
		const root = fixture();
		expect(() =>
			parseReviewValidationPolicy(settings({ [root]: value }), root),
		).toThrow("Invalid trusted review validation policy.");
	});

	it("enforces the same safe-runner ceiling for both partition budgets", () => {
		const root = fixture();
		for (const field of ["matchingTimeoutMs", "remainingTimeoutMs"]) {
			expect(() =>
				parseReviewValidationPolicy(
					{
						...settings({ [root]: { ...partition, [field]: 300_001 } }),
						safeTools: { validation: { maxTimeoutMs: 300_000 } },
					},
					root,
				),
			).toThrow("Invalid trusted review validation policy.");
		}
	});

	it.each([
		"relative",
		"/tmp/../escape",
		"/tmp/*",
		"/tmp/line\n",
		"/tmp/back\\slash",
	])("rejects unsafe repository keys even when inactive: %j", (key) => {
		const root = fixture();
		expect(() =>
			parseReviewValidationPolicy(settings({ [key]: partition }), root),
		).toThrow();
	});

	it("never inspects unrelated repository paths, but still rejects their malformed declarations", () => {
		const root = fixture();
		const missing = path.join(root, "missing");
		expect(
			parseReviewValidationPolicy(
				settings({ [missing]: partition, [root]: partition }),
				root,
			).pytestPartitions,
		).toEqual({ [root]: partition });
		expect(() =>
			parseReviewValidationPolicy(settings({ [missing]: partition })),
		).toThrow();
		expect(() =>
			parseReviewValidationPolicy(
				settings({ [missing]: { ...partition, keyword: "not slow" } }),
				root,
			),
		).toThrow();
	});

	it("refuses symlink repository roots rather than following them", () => {
		const root = fixture();
		const alias = path.join(root, "alias");
		fs.symlinkSync(fixture(), alias);
		expect(() =>
			parseReviewValidationPolicy(settings({ [alias]: partition })),
		).toThrow();
		expect(() =>
			parseReviewValidationPolicy(settings({ [alias]: partition }), alias),
		).toThrow();
	});
});

describe("exhaustive Python review plans", () => {
	it("replaces only the full-suite call with two complementary calls over identical full scope", () => {
		const root = fixture();
		const files = ["pkg/tests/test_guard.py"];
		const baseline = recommendTestCommands(
			files,
			root,
			parseReviewValidationPolicy({}),
		);
		const plan = recommendTestCommands(files, root, policyFor(root));
		expect(plan.runnerCommands).toHaveLength(
			baseline.runnerCommands.length + 1,
		);
		expect(plan.runnerCommands[0]).toEqual(baseline.runnerCommands[0]);
		const broad = plan.runnerCommands.filter((call) => call.scope === "broad");
		expect(broad).toEqual([
			expect.objectContaining({
				tool: "run_pytest",
				args: [],
				keyword: "not (fresh_installed)",
				timeoutMs: 300_000,
			}),
			expect.objectContaining({
				tool: "run_pytest",
				args: [],
				keyword: "fresh_installed",
				timeoutMs: 210_000,
			}),
		]);
		expect(plan.recommendedCommands).toHaveLength(plan.runnerCommands.length);
		expect(new Set(plan.recommendedCommands).size).toBe(
			plan.runnerCommands.length,
		);
		const args = toolArguments(formatTestExecutionPlan(plan));
		expect(args).toEqual([
			{ paths: files, timeoutMs: 300_000 },
			{ keyword: "not (fresh_installed)", timeoutMs: 300_000 },
			{ keyword: "fresh_installed", timeoutMs: 210_000 },
		]);
		expect(formatTestExecutionPlan(plan)).toContain(
			"Both complementary full-suite calls are required",
		);
	});

	it("retains unpartitioned full-suite behavior for absent/unrelated policies and non-Python projects", () => {
		const root = fixture();
		const other = fixture();
		const defaultPolicy = parseReviewValidationPolicy({});
		const baseline = recommendTestCommands([], root, defaultPolicy);
		expect(baseline.runnerCommands).toEqual([
			expect.objectContaining({ args: [], scope: "broad", timeoutMs: 300_000 }),
		]);
		expect(toolArguments(formatTestExecutionPlan(baseline))).toEqual([
			{ timeoutMs: 300_000 },
		]);
		expect(recommendTestCommands([], root, policyFor(other))).toEqual(baseline);
		fs.writeFileSync(path.join(root, "package.json"), "{}");
		expect(recommendTestCommands([], root, policyFor(root))).toEqual(
			recommendTestCommands([], root, defaultPolicy),
		);
	});

	it("preserves whole-file overrides and counts both mandatory partitions in the aggregate deadline", () => {
		const root = fixture();
		const policy = parseReviewValidationPolicy(
			settings(
				{ [root]: partition },
				{ repoOverrides: { [root]: { "pkg/tests/test_guard.py": 1_800_000 } } },
			),
			root,
		);
		const plan = recommendTestCommands(
			["pkg/tests/test_guard.py"],
			root,
			policy,
		);
		expect(plan.runnerCommands[0]).toEqual(
			expect.objectContaining({
				args: ["pkg/tests/test_guard.py"],
				timeoutMs: 1_800_000,
			}),
		);
		expect(reviewerTimeoutForPlan(plan.runnerCommands, policy, 2_700_000)).toBe(
			2_910_000,
		);
		expect(() =>
			reviewerTimeoutForPlan(
				plan.runnerCommands,
				{ ...policy, maxReviewerTimeoutMs: 2_850_000 },
				2_700_000,
			),
		).toThrow(/required 2910000.*2850000/);
	});
});
