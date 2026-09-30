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
	/** Explicit initial budget; never rely on the safe runner's 60s default. */
	timeoutMs?: number;
	/**
	 * For run_node_test: the `--import` loader spec (e.g. "tsx") to pass for
	 * `.test.ts` files Node cannot run natively. Omitted for `.test.js`/`.mjs`.
	 */
	import?: string;
}

export interface TestExecutionPlan {
	ecosystem: ProjectEcosystem;
	/** Commands the reviewer should execute, narrowest first. */
	recommendedCommands: string[];
	/** Structured command mapping for unit/policy tests and future dispatch. */
	runnerCommands: RecommendedTestCommand[];
	discoveryCommand?: string;
	/**
	 * Where the plan executes. Always the repository checkout on the host
	 * bridge (the reviewer never runs in an Apple container).
	 */
	executionSandbox: "repository-checkout";
	/** Retained for schema compatibility; no container bridge is wired. */
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

/** Matches `--import <spec>` (space or `=` form) in an npm test script. */
const IMPORT_SPEC_PATTERN = /--import[=\s]+([^\s]+)/;

/**
 * Detect the project runtime import to preserve on every `run_node_test`
 * call. JavaScript tests can import loader-dependent modules transitively.
 * Returns the script's `--import <spec>` (space or `=` form), or optionally
 * infers `"tsx"` when it is a devDependency. Does not infer `ts-node`, which uses
 * `--loader ts-node/esm`, or invent an import for projects with no configured
 * or inferred runtime (e.g. plain build-then-test projects).
 */
export function detectNodeTestLoader(
	cwd: string,
	inferTsx = true,
): string | undefined {
	const pkg = readPackageJson(cwd);
	if (!pkg) return undefined;
	const testScript = pkg.scripts?.test ?? "";
	const scriptMatch = testScript.match(IMPORT_SPEC_PATTERN);
	if (scriptMatch) return scriptMatch[1];
	const dev = pkg.devDependencies ?? {};
	// Only tsx can be confidently surfaced for `--import`; ts-node registers via
	// `--loader ts-node/esm` (a different mechanism), so it is not inferred here.
	if (inferTsx && dev.tsx) return "tsx";
	return undefined;
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

// The safe runners cap execution at five minutes. Choose that bounded
// budget up front, rather than retrying a timeout with a larger window.
const REVIEW_VALIDATION_TIMEOUT_MS = 300_000;
const CODE_EXTENSIONS = new Set([
	".js",
	".jsx",
	".mjs",
	".cjs",
	".ts",
	".tsx",
	".mts",
	".cts",
]);

function existingChangedFiles(files: string[], cwd: string): string[] {
	const root = fs.realpathSync(cwd);
	const existing = new Set<string>();
	for (const file of files) {
		const hasControls = Array.from(file).some(
			(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
		);
		if (
			!file ||
			path.isAbsolute(file) ||
			/^[A-Za-z]:/.test(file) ||
			file.includes("\\") ||
			hasControls ||
			file.split("/").includes("..")
		) {
			throw new Error("PR review changed path is invalid.");
		}
		const resolved = path.resolve(root, file);
		try {
			const real = fs.realpathSync(resolved);
			const relative = path.relative(root, real);
			if (
				relative === ".." ||
				relative.startsWith(`..${path.sep}`) ||
				path.isAbsolute(relative)
			) {
				throw new Error("PR review changed path escapes the workspace.");
			}
			if (fs.statSync(real).isFile()) {
				existing.add(path.relative(root, resolved).split(path.sep).join("/"));
			}
		} catch (error) {
			// Deleted paths cannot be executed/linted. Other inspection
			// failures must not quietly remove validation coverage.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return [...existing];
}

function makePlan(
	ecosystem: ProjectEcosystem,
	runnerCommands: RecommendedTestCommand[],
	discoveryCommand?: string,
): TestExecutionPlan {
	const boundedCommands = runnerCommands.map((cmd) => ({
		...cmd,
		timeoutMs: REVIEW_VALIDATION_TIMEOUT_MS,
	}));
	return {
		ecosystem,
		recommendedCommands: boundedCommands.map((c) => c.command),
		runnerCommands: boundedCommands,
		discoveryCommand,
		executionSandbox: "repository-checkout",
		containerTool: "container_safe",
		resultContract: RESULT_CONTRACT,
	};
}

function formatRunnerCommand(cmd: RecommendedTestCommand): string {
	const params = {
		...(cmd.args.length > 0 ? { paths: cmd.args } : {}),
		...(cmd.import ? { import: cmd.import } : {}),
		timeoutMs: cmd.timeoutMs ?? REVIEW_VALIDATION_TIMEOUT_MS,
	};
	return `${cmd.tool} ${JSON.stringify(params)}`;
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
			const changedFiles = existingChangedFiles(files, cwd);
			const changedTests = changedFiles.filter(
				(file) =>
					isTestFile(file) &&
					CODE_EXTENSIONS.has(path.extname(file).toLowerCase()),
			);
			const lintFiles = changedFiles.filter((file) => {
				const extension = path.extname(file).toLowerCase();
				return (
					CODE_EXTENSIONS.has(extension) ||
					extension === ".json" ||
					extension === ".jsonc"
				);
			});
			const framework = detectTypeScriptTestFramework(cwd);
			const testRunner: SafeRunnerTool =
				framework === "node-test" ? "run_node_test" : "run_vitest";
			// Explicit imports belong to the Node process, regardless of test
			// suffix. Only infer a dependency-based runtime when TS tests changed;
			// all per-file calls then inherit that same project runtime.
			const hasTsTests = changedTests.some((file) =>
				/\.(?:ts|tsx|mts|cts)$/.test(file),
			);
			const loader =
				framework === "node-test"
					? detectNodeTestLoader(cwd, hasTsTests)
					: undefined;
			const runnerCommands: RecommendedTestCommand[] = [];
			for (const file of changedTests) {
				const cmdArgs = loader ? ["--import", loader, file] : [file];
				runnerCommands.push({
					tool: testRunner,
					args: [file],
					command: command(testRunner, cmdArgs),
					scope: "targeted",
					...(loader ? { import: loader } : {}),
				});
			}
			runnerCommands.push({
				tool: "run_typecheck",
				args: [],
				command: command("run_typecheck"),
				scope: "typecheck",
			});
			if (lintFiles.length > 0) {
				runnerCommands.push({
					tool: "run_biome",
					args: lintFiles,
					command: command("run_biome", lintFiles),
					scope: "format-lint",
				});
			}
			const discovery =
				framework === "node-test"
					? loader
						? `node --test --import ${loader} -- preserves the project runtime on each test call`
						: "node --test -- discovers *.test.* / node:test files"
					: "run_vitest -- test discovery handled by Vitest project config";
			return makePlan("typescript", runnerCommands, discovery);
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
		`**Execution:** safe validation runners (run_*) on the host against the repository checkout (host bridge only)`,
		`**Result contract:** ${plan.resultContract}`,
	];

	if (plan.recommendedCommands.length === 0) {
		lines.push(
			"",
			"No safe validation runner is available for this project. Mark test execution as NOT_RUN and explain why under What could not be verified.",
		);
	} else {
		const calls =
			plan.runnerCommands.length > 0
				? plan.runnerCommands.map(formatRunnerCommand)
				: plan.recommendedCommands;
		lines.push(
			"",
			"**Recommended commands (run narrowest first):**",
			"Pass JSON as tool arguments, not shell commands. Keep per-file calls separate and lint only the listed paths.",
			...calls.map((call) => `- ${call}`),
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
