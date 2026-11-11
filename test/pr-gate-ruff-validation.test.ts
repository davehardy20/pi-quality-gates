import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	PR_REVIEW_CONFIG,
	PR_REVIEWER_FORBIDDEN_TOOLS,
} from "../src/pr-gate/pr-review-config.js";
import { buildReviewerPiArgs } from "../src/pr-gate/reviewer.js";
import {
	CLOSED_REVIEWER_SAFE_TOOLS,
	CLOSED_REVIEWER_TOOLS,
} from "../src/pr-gate/reviewer-closed-session.js";
import {
	formatTestExecutionPlan,
	recommendTestCommands,
} from "../src/pr-gate/test-execution.js";
import { parseReviewValidationPolicy } from "../src/shared/review-validation-policy.js";

// Fabricated projects only: never invoke Ruff, SDK credentials or live reviewers.
const roots: string[] = [];
const policy = parseReviewValidationPolicy({});
function fixture(
	files: string[],
	ecosystem: "python" | "typescript" | "unknown" = "python",
) {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "qg-ruff-plan-")),
	);
	roots.push(root);
	if (ecosystem === "python")
		fs.writeFileSync(path.join(root, "pyproject.toml"), "");
	if (ecosystem === "typescript")
		fs.writeFileSync(path.join(root, "package.json"), "{}");
	for (const file of files) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), "");
	}
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

function lintPlan(files: string[], cwd: string, unfiltered = files) {
	return recommendTestCommands(
		files,
		cwd,
		policy,
		unfiltered,
	).runnerCommands.filter((call) => call.tool === "run_ruff");
}

describe("required changed-file Ruff planning", () => {
	for (const ecosystem of ["python", "typescript", "unknown"] as const) {
		it(`scopes Python lint in ${ecosystem}`, () => {
			const cwd = fixture(
				["pkg/main.py", "pkg/api.pyi", "README.md", "untouched.py"],
				ecosystem,
			);
			const files = [
				"pkg/main.py",
				"pkg/api.pyi",
				"pkg/main.py",
				"README.md",
				"deleted.py",
			];
			expect(lintPlan(files, cwd)).toEqual([
				{
					tool: "run_ruff",
					args: ["pkg/main.py", "pkg/api.pyi"],
					command: "run_ruff pkg/main.py pkg/api.pyi",
					scope: "format-lint",
					timeoutMs: 300_000,
				},
			]);
		});
	}

	it("keeps pytest and Ruff as separate mandatory calls", () => {
		const files = ["pkg/tests/test_main.py", "pkg/main.py"];
		const cwd = fixture(files);
		const plan = recommendTestCommands(files, cwd, policy);
		expect(plan.runnerCommands.map((call) => [call.tool, call.args])).toEqual([
			["run_pytest", ["pkg/tests/test_main.py"]],
			["run_pytest", []],
			["run_ruff", files],
		]);
		expect(formatTestExecutionPlan(plan)).toContain(
			'run_ruff {"paths":["pkg/tests/test_main.py","pkg/main.py"],"timeoutMs":300000}',
		);
		expect(plan.resultContract).toContain("every required call");
	});

	it("uses the trusted default for Ruff, not a targeted pytest override", () => {
		const files = ["pkg/main.py"];
		const cwd = fixture(files, "unknown");
		const customPolicy = parseReviewValidationPolicy({
			qualityGates: {
				reviewValidation: {
					defaultTimeoutMs: 120_000,
					repoOverrides: { [cwd]: { [files[0]]: 1_800_000 } },
				},
			},
		});
		const plan = recommendTestCommands(files, cwd, customPolicy);
		expect(plan.runnerCommands).toEqual([
			expect.objectContaining({
				tool: "run_ruff",
				args: files,
				timeoutMs: 120_000,
				scope: "format-lint",
			}),
		]);
	});

	it("encodes Python paths as JSON tool arguments, never shell commands", () => {
		const files = ['pkg/a space"b.py'];
		const plan = recommendTestCommands(files, fixture(files), policy);
		const call = formatTestExecutionPlan(plan)
			.split("\n")
			.find((line) => line.startsWith("- run_ruff "));
		expect(call).toBe(
			`- run_ruff ${JSON.stringify({ paths: files, timeoutMs: 300_000 })}`,
		);
	});

	it("rejects invalid review-excluded paths before lint planning", () => {
		const files = ["pkg/main.py"];
		expect(() =>
			lintPlan(files, fixture(files), [...files, "../hidden.py"]),
		).toThrow();
	});

	it("rejects a nonexistent workspace instead of producing a passing plan", () => {
		expect(() =>
			lintPlan(["main.py"], path.join(fixture([]), "missing")),
		).toThrow();
	});

	it("does not lint deleted, non-Python or directory-only changes", () => {
		const cwd = fixture(["README.md", "package.py/entry.txt"]);
		expect(lintPlan(["gone.py", "README.md", "package.py"], cwd)).toEqual([]);
	});

	it("does not target a deleted pytest file", () => {
		const cwd = fixture(["pkg/main.py"]);
		const plan = recommendTestCommands(
			["pkg/tests/test_deleted.py", "pkg/main.py"],
			cwd,
			policy,
		);
		expect(
			plan.runnerCommands
				.filter((call) => call.tool === "run_pytest")
				.map((call) => call.args),
		).toEqual([[]]);
	});

	it.each([
		"../outside.py",
		"/outside.py",
		"C:/outside.py",
		"pkg\\outside.py",
		"bad\n.py",
	])("rejects an invalid Python path: %j", (file) => {
		expect(() => lintPlan([file], fixture([]))).toThrow();
	});

	it("rejects existing file and parent symlinks escaping the workspace", () => {
		const outside = fixture(["secret.py"]);
		for (const parent of [false, true]) {
			const cwd = fixture([]);
			fs.symlinkSync(
				parent ? outside : path.join(outside, "secret.py"),
				path.join(cwd, parent ? "linked" : "linked.py"),
				parent ? "junction" : "file",
			);
			expect(() =>
				lintPlan([parent ? "linked/secret.py" : "linked.py"], cwd),
			).toThrow(/escapes/);
		}
	});

	it("keeps contained symlink paths scoped and deduplicated", () => {
		const cwd = fixture(["pkg/main.py"]);
		fs.symlinkSync(path.join(cwd, "pkg"), path.join(cwd, "linked"), "junction");
		expect(
			lintPlan(["linked/main.py", "./linked/main.py"], cwd)[0]?.args,
		).toEqual(["linked/main.py"]);
	});

	it("does not use review-excluded files as lint arguments", () => {
		const cwd = fixture(["pkg/main.py", "excluded.py"]);
		expect(
			lintPlan(["pkg/main.py"], cwd, ["pkg/main.py", "excluded.py"])[0]?.args,
		).toEqual(["pkg/main.py"]);
	});
});

describe("Ruff reviewer capability", () => {
	it("requires the read-only runner in both closed tool sets and legacy arguments", () => {
		expect(CLOSED_REVIEWER_TOOLS).toContain("run_ruff");
		expect(CLOSED_REVIEWER_SAFE_TOOLS).toContain("run_ruff");
		const args = buildReviewerPiArgs(PR_REVIEW_CONFIG, "/fixture/prompt.md");
		expect(args[args.indexOf("--tools") + 1].split(",")).toContain("run_ruff");
		for (const tool of PR_REVIEW_CONFIG.tools)
			expect(PR_REVIEWER_FORBIDDEN_TOOLS.has(tool)).toBe(false);
	});

	it("names Ruff in both active reviewer prompts", () => {
		for (const name of ["system.md", "task-template.md"]) {
			const prompt = fs.readFileSync(
				new URL(`../src/pr-gate/prompts/${name}`, import.meta.url),
				"utf8",
			);
			expect(prompt).toContain("`run_ruff`");
		}
	});
});
