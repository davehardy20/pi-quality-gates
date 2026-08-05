import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Supported project ecosystems for review-time validation planning.
 */
export type ProjectEcosystem =
	| "typescript"
	| "python"
	| "rust"
	| "go"
	| "unknown";

export type SafeRunnerTool =
	| "run_vitest"
	| "run_biome"
	| "run_typecheck"
	| "run_pytest"
	| "run_cargo_test"
	| "run_node_test";

export interface RecommendedTestCommand {
	tool: SafeRunnerTool;
	args: string[];
	command: string;
	scope: "targeted" | "broad" | "format-lint" | "typecheck";
}

export interface TestExecutionPlan {
	ecosystem: ProjectEcosystem;
	/** Commands the reviewer should execute, narrowest first. */
	recommendedCommands: string[];
	/** Structured command mapping for unit/policy tests and future dispatch. */
	runnerCommands: RecommendedTestCommand[];
	discoveryCommand?: string;
	/**
	 * Where the plan executes. Defaults to the repository checkout (host bridge);
	 * "apple-container" applies only for PI_PR_REVIEW_BRIDGE=orchestrator.
	 */
	executionSandbox: "repository-checkout" | "apple-container";
	/** Container bridge used when PI_PR_REVIEW_BRIDGE=orchestrator. */
	containerTool: "container_safe";
	/** Reviewer-facing instruction for bounded logs and sidecar references. */
	resultContract: string;
}

const RESULT_CONTRACT =
	"Record a bounded PASS/FAIL/NOT_RUN summary and any tool sidecar ref under the Review Report test-execution section; do not paste raw logs.";

/**
 * Detect the project ecosystem by looking for well-known manifest files.
 */
export function detectProjectEcosystem(cwd: string): ProjectEcosystem {
	const manifestChecks: Array<[string, ProjectEcosystem]> = [
		["package.json", "typescript"],
		["Cargo.toml", "rust"],
		["pyproject.toml", "python"],
		["setup.py", "python"],
		["go.mod", "go"],
	];

	for (const [file, ecosystem] of manifestChecks) {
		if (fs.existsSync(path.join(cwd, file))) return ecosystem;
	}
	return "unknown";
}

/**
 * TypeScript/JavaScript test framework selected for review-time validation.
 * Defaults to Vitest to preserve existing behaviour; switches to Node's
 * built-in runner only when the project clearly signals `node --test`.
 */
export type TypeScriptTestFramework = "vitest" | "node-test";

interface PackageJsonScripts {
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

/** Matches a `node --test` flag in an npm script (--test at end or space-separated; ignores --test-name-pattern). */
const NODE_TEST_SCRIPT_PATTERN = /--test(?:$|\s)/;

function readPackageJson(cwd: string): PackageJsonScripts | undefined {
	const pkgPath = path.join(cwd, "package.json");
	if (!fs.existsSync(pkgPath)) return undefined;
	try {
		return JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageJsonScripts;
	} catch {
		return undefined;
	}
}

/**
 * Detect whether a TypeScript/JavaScript project runs tests with Vitest or
 * Node's built-in runner. Vitest wins when declared as a dependency; otherwise
 * a `node --test` script selects the built-in runner. Anything ambiguous falls
 * back to Vitest so existing reviews are unchanged.
 */
export function detectTypeScriptTestFramework(
	cwd: string,
): TypeScriptTestFramework {
	const pkg = readPackageJson(cwd);
	if (!pkg) return "vitest";
	const vitestDep = pkg.dependencies?.vitest || pkg.devDependencies?.vitest;
	if (vitestDep) return "vitest";
	const testScript = pkg.scripts?.test;
	if (testScript && NODE_TEST_SCRIPT_PATTERN.test(testScript)) {
		return "node-test";
	}
	return "vitest";
}

function isTestFile(file: string): boolean {
	return (
		file.includes(".test.") ||
		file.includes(".spec.") ||
		file.endsWith("_test.go") ||
		file.includes("/tests/") ||
		file.includes("\\tests\\")
	);
}

function command(tool: SafeRunnerTool, args: string[] = []): string {
	return [tool, ...args].join(" ");
}

function makePlan(
	ecosystem: ProjectEcosystem,
	runnerCommands: RecommendedTestCommand[],
	discoveryCommand?: string,
): TestExecutionPlan {
	return {
		ecosystem,
		recommendedCommands: runnerCommands.map((c) => c.command),
		runnerCommands,
		discoveryCommand,
		executionSandbox: "repository-checkout",
		containerTool: "container_safe",
		resultContract: RESULT_CONTRACT,
	};
}

/**
 * Recommend safe validation runners for a set of changed files based on the
 * project ecosystem. Recommendations are conservative: target the narrowest
 * useful checks first, then broader checks.
 *
 * @param files Changed file paths relative to `cwd`.
 * @param cwd Project root.
 */
export function recommendTestCommands(
	files: string[],
	cwd: string,
): TestExecutionPlan {
	const ecosystem = detectProjectEcosystem(cwd);
	const testFiles = files.filter(isTestFile);

	switch (ecosystem) {
		case "typescript": {
			const framework = detectTypeScriptTestFramework(cwd);
			const testRunner: SafeRunnerTool =
				framework === "node-test" ? "run_node_test" : "run_vitest";
			const runnerCommands: RecommendedTestCommand[] = [];
			if (testFiles.length > 0) {
				runnerCommands.push({
					tool: testRunner,
					args: testFiles,
					command: command(testRunner, testFiles),
					scope: "targeted",
				});
			}
			runnerCommands.push(
				{
					tool: "run_typecheck",
					args: [],
					command: command("run_typecheck"),
					scope: "typecheck",
				},
				{
					tool: "run_biome",
					args: ["src", "test"],
					command: command("run_biome", ["src", "test"]),
					scope: "format-lint",
				},
			);
			return makePlan(
				"typescript",
				runnerCommands,
				framework === "node-test"
					? "node --test -- discovers *.test.* / node:test files"
					: "run_vitest -- test discovery handled by Vitest project config",
			);
		}
		case "python": {
			const runnerCommands: RecommendedTestCommand[] = [];
			if (testFiles.length > 0) {
				runnerCommands.push({
					tool: "run_pytest",
					args: testFiles,
					command: command("run_pytest", testFiles),
					scope: "targeted",
				});
			}
			runnerCommands.push({
				tool: "run_pytest",
				args: [],
				command: command("run_pytest"),
				scope: "broad",
			});
			return makePlan(ecosystem, runnerCommands, "pytest --collect-only -q");
		}
		case "rust": {
			return makePlan(
				ecosystem,
				[
					{
						tool: "run_cargo_test",
						args: [],
						command: command("run_cargo_test"),
						scope: testFiles.length > 0 ? "targeted" : "broad",
					},
				],
				"cargo test --no-run",
			);
		}
		case "go":
			return makePlan(ecosystem, [], "go test -list .");
		default:
			return makePlan(ecosystem, []);
	}
}

/**
 * Format a test execution plan as a markdown section suitable for inclusion in
 * the reviewer task prompt.
 */
export function formatTestExecutionPlan(plan: TestExecutionPlan): string {
	const lines = [
		`**Ecosystem:** ${plan.ecosystem}`,
		`**Execution:** safe validation runners (run_*) against the repository checkout (Apple container via ${plan.containerTool} only when PI_PR_REVIEW_BRIDGE=orchestrator)`,
		`**Result contract:** ${plan.resultContract}`,
	];

	if (plan.recommendedCommands.length === 0) {
		lines.push(
			"",
			"No safe validation runner is available for this project. Mark test execution as NOT_RUN and explain why under What could not be verified.",
		);
	} else {
		lines.push(
			"",
			"**Recommended commands (run narrowest first):**",
			...plan.recommendedCommands.map((cmd) => `- ${cmd}`),
		);
	}

	if (plan.discoveryCommand) {
		lines.push("", `**Test discovery:** ${plan.discoveryCommand}`);
	}

	lines.push(
		"",
		"**ReviewReport requirement:** Include a `### Test execution` section with `Status`, `Summary`, and `Sidecar` fields before the final summary.",
	);

	return lines.join("\n");
}
