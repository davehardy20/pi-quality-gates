import * as fs from "node:fs";
import * as path from "node:path";
import {
	loadReviewValidationPolicy,
	type ReviewValidationPolicy,
} from "../shared/review-validation-policy.js";
import { scopeBiomeValidation } from "./biome-validation-scope.js";
import { discoverWorkspaceValidationProjects } from "./workspace-validation.js";

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
	/** Canonical package directory for workspace-local test execution */
	cwd?: string;
	/** TypeScript configuration relative to the repository root */
	project?: string;
	/** Explicit initial budget; never rely on the safe runner's 60s default. */
	timeoutMs?: number;
	/**
	 * For run_node_test: the project `--import` runtime (e.g. "tsx"),
	 * preserved on each call, including JS/MJS tests with transitive loader
	 * dependencies. Omitted when no configured or inferred import is needed.
	 */
	import?: string;
	/** Trusted pytest literal or the planner-generated complement. */
	keyword?: string;
}

export interface TestExecutionPlan {
	ecosystem: ProjectEcosystem;
	/** Commands the reviewer should execute, narrowest first. */
	recommendedCommands: string[];
	/** Structured command mapping for unit/policy tests and future dispatch. */
	runnerCommands: RecommendedTestCommand[];
	discoveryCommand?: string;
	/**
	 * Where the plan executes. Both reviewer bridges validate the repository
	 * checkout on the host, never in an Apple container.
	 */
	executionSandbox: "repository-checkout";
	/** Retained for schema compatibility; no container bridge is wired. */
	containerTool: "container_safe";
	/** Reviewer-facing instruction for bounded logs and sidecar references. */
	resultContract: string;
}

const RESULT_CONTRACT =
	"For every required call, record bounded PASS/FAIL/NOT_RUN, requested/effective/elapsed budgets (ms), bounded redacted progress and any tool sidecar ref under Test execution. Use trusted runner evidence only; absent values are unknown. Progress/timeout is not completion; incomplete required calls remain FAIL/NOT_RUN. Do not paste raw logs.";

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

function hasTestRunnerSettings(cwd: string): boolean {
	const pkg = readPackageJson(cwd);
	return Boolean(
		pkg?.scripts?.test ||
			pkg?.dependencies?.vitest ||
			pkg?.devDependencies?.vitest,
	);
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

// Explicit default; the trusted global policy wrapper assigns final budgets.
// Never retry a timeout by silently enlarging a required call.
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

/**
 * Conservative entry basenames, not directory membership or a marker anywhere
 * in a path. Project-specific discovery must be inspected separately; never
 * evaluate untrusted runner configuration in the planner.
 */
function isJavaScriptTestEntry(
	file: string,
	framework: TypeScriptTestFramework,
): boolean {
	const extension = path.extname(file);
	if (!CODE_EXTENSIONS.has(extension)) return false;
	const name = path.basename(file, extension);
	// Vitest's default test/spec suffixes, also valid explicit Node entries.
	if (/\.(?:test|spec)$/.test(name)) return true;
	// Node's additional marked names. Deliberately omit directory-only discovery.
	return (
		framework === "node-test" &&
		(name === "test" || name.startsWith("test-") || /[-_]test$/.test(name))
	);
}

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
		...(cmd.cwd ? { cwd: cmd.cwd } : {}),
		...(cmd.project ? { project: cmd.project } : {}),
		...(cmd.args.length > 0 ? { paths: cmd.args } : {}),
		...(cmd.import ? { import: cmd.import } : {}),
		...(cmd.keyword ? { keyword: cmd.keyword } : {}),
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
 * @param unfilteredChangedFiles Full changed-path set for configuration guards,
 * including review-filtered and deleted paths. Never used as runner arguments.
 */
export function recommendTestCommands(
	files: string[],
	cwd: string,
	policy: ReviewValidationPolicy = loadReviewValidationPolicy(),
	unfilteredChangedFiles: string[] = files,
): TestExecutionPlan {
	const plan = buildTestCommands(files, cwd, unfilteredChangedFiles);
	const root =
		Object.keys(policy.repoOverrides).length ||
		Object.keys(policy.pytestPartitions).length
			? fs.realpathSync(cwd)
			: undefined;
	const overrides = root ? policy.repoOverrides[root] : undefined;
	const partition =
		root && plan.ecosystem === "python"
			? policy.pytestPartitions[root]
			: undefined;
	plan.runnerCommands = plan.runnerCommands.flatMap((call) => {
		// Trusted budgets are keyed by repository-relative paths, even when
		// the runner's cwd and test paths are workspace-local.
		const budgetFile =
			call.cwd && call.args.length === 1
				? path
						.relative(
							fs.realpathSync(cwd),
							path.resolve(call.cwd, call.args[0]),
						)
						.split(path.sep)
						.join("/")
				: call.args[0];
		const timeoutMs =
			call.scope === "targeted" && call.args.length === 1
				? (overrides?.[budgetFile] ?? policy.defaultTimeoutMs)
				: policy.defaultTimeoutMs;
		// Partition only the original full-suite call, never targeted entries.
		// Both retain the exact collection scope; the complement is generated,
		// not a separately configurable filter that could omit tests.
		const calls =
			partition && call.tool === "run_pytest" && call.scope === "broad"
				? [
						{
							...call,
							keyword: `not (${partition.keyword})`,
							timeoutMs: partition.remainingTimeoutMs,
						},
						{
							...call,
							keyword: partition.keyword,
							timeoutMs: partition.matchingTimeoutMs,
						},
					].map((next) => ({ ...next, command: formatRunnerCommand(next) }))
				: [{ ...call, timeoutMs }];
		for (const next of calls) {
			if (
				!Number.isSafeInteger(next.timeoutMs) ||
				next.timeoutMs < 1_000 ||
				next.timeoutMs > policy.validationMaxTimeoutMs
			)
				throw new Error(
					"Review validation budget exceeds trusted runner ceiling.",
				);
		}
		return calls;
	});
	plan.recommendedCommands = plan.runnerCommands.map((call) => call.command);
	if (partition)
		plan.resultContract +=
			" Both complementary full-suite calls are required over the same collection scope; targeted checks cannot replace either call. Empty selection, timeout or progress alone is not completion evidence.";
	return plan;
}

function buildTestCommands(
	files: string[],
	cwd: string,
	unfilteredChangedFiles: string[],
): TestExecutionPlan {
	const ecosystem = detectProjectEcosystem(cwd);
	const testFiles = files.filter(isTestFile);

	switch (ecosystem) {
		case "typescript": {
			// Validate before normalization, even when review filters hide a path.
			// Discard the existing-only result: deleted config names still guard lint.
			if (unfilteredChangedFiles !== files)
				existingChangedFiles(unfilteredChangedFiles, cwd);
			const changedFiles = existingChangedFiles(files, cwd);
			const workspace = discoverWorkspaceValidationProjects(cwd);
			const packageDirs = [...workspace.packages].sort(
				(a, b) => b.length - a.length,
			);
			const changedContexts = changedFiles.map((file) => {
				const dir = packageDirs.find((dir) => file.startsWith(`${dir}/`));
				const ownerCwd = dir ? path.join(workspace.root, dir) : workspace.root;
				const runnerDir =
					dir && hasTestRunnerSettings(ownerCwd) ? dir : undefined;
				// Metadata-only packages still use the root-owned runner and loader.
				const packageCwd = runnerDir ? ownerCwd : workspace.root;
				const framework = detectTypeScriptTestFramework(packageCwd);
				return { file, dir, runnerDir, packageCwd, framework };
			});
			const changedTests = changedContexts.filter((test) =>
				isJavaScriptTestEntry(test.file, test.framework),
			);
			const lintFiles = changedFiles.filter((file) => {
				const extension = path.extname(file).toLowerCase();
				return (
					CODE_EXTENSIONS.has(extension) ||
					extension === ".json" ||
					extension === ".jsonc"
				);
			});
			// Guard with the validated, unfiltered set so reviewer.skip/gitignore
			// cannot hide a config change. Runner arguments remain filtered/existing.
			const biomeScope = scopeBiomeValidation(
				lintFiles,
				cwd,
				unfilteredChangedFiles.map((file) => path.posix.normalize(file)),
			);
			const runnerCommands: RecommendedTestCommand[] = [];
			for (const test of changedTests) {
				const testRunner: SafeRunnerTool =
					test.framework === "node-test" ? "run_node_test" : "run_vitest";
				// Runtime inference follows the selected runner's manifest; imports
				// still apply to JS-only tests with transitive loader dependencies.
				const hasTsTests = changedTests.some(
					(other) =>
						other.packageCwd === test.packageCwd &&
						/\.(?:ts|tsx|mts|cts)$/.test(other.file),
				);
				const loader =
					test.framework === "node-test"
						? detectNodeTestLoader(test.packageCwd, hasTsTests)
						: undefined;
				const file = test.runnerDir
					? path
							.relative(test.packageCwd, path.join(workspace.root, test.file))
							.split(path.sep)
							.join("/")
					: test.file;
				const cmdArgs = loader ? ["--import", loader, file] : [file];
				runnerCommands.push({
					tool: testRunner,
					args: [file],
					command: command(testRunner, [
						...(test.runnerDir ? ["--cwd", test.packageCwd] : []),
						...cmdArgs,
					]),
					scope: "targeted",
					...(test.runnerDir ? { cwd: test.packageCwd } : {}),
					...(loader ? { import: loader } : {}),
				});
			}
			if (
				!workspace.projects.includes("tsconfig.json") &&
				changedContexts.some(
					(item) =>
						/\.(?:ts|tsx|mts|cts)$/.test(item.file) &&
						!workspace.projects.includes(`${item.dir ?? ""}/tsconfig.json`),
				)
			) {
				// A missing owning project must still fail validation; checking an
				// unrelated workspace alone is not adequate typecheck coverage.
				workspace.projects.unshift("tsconfig.json");
			}
			for (const project of workspace.projects) {
				const isRoot = project === "tsconfig.json";
				runnerCommands.push({
					tool: "run_typecheck",
					args: [],
					command: command("run_typecheck", isRoot ? [] : ["-p", project]),
					scope: "typecheck",
					...(!isRoot ? { project } : {}),
				});
			}
			if (biomeScope.files.length > 0) {
				runnerCommands.push({
					tool: "run_biome",
					args: biomeScope.files,
					command: command("run_biome", biomeScope.files),
					scope: "format-lint",
				});
			}
			const framework = detectTypeScriptTestFramework(cwd);
			const loader =
				framework === "node-test"
					? detectNodeTestLoader(
							cwd,
							changedTests.some(
								(test) =>
									!test.runnerDir && /\.(?:ts|tsx|mts|cts)$/.test(test.file),
							),
						)
					: undefined;
			const discovery = workspace.packages.length
				? "Workspace test discovery uses explicit package settings or root-owned settings; preserve the selected runner's cwd and test paths"
				: framework === "node-test"
					? loader
						? `node --test --import ${loader} -- preserves the project runtime on each test call`
						: "node --test -- discovers *.test.* / node:test files"
					: "run_vitest -- test discovery handled by Vitest project config";
			return makePlan(
				"typescript",
				runnerCommands,
				`${discovery}. Filename selection is conservative; inspect project ` +
					"configuration and relevant tests for helper/source changes. Run " +
					"additional relevant entries with safe runners, including custom " +
					"configured tests; do not execute config or package scripts directly." +
					(biomeScope.note ? ` ${biomeScope.note}` : ""),
			);
		}
		case "python": {
			const runnerCommands: RecommendedTestCommand[] = [];
			// One whole-file call per entry keeps trusted file budgets meaningful.
			for (const file of new Set(testFiles)) {
				runnerCommands.push({
					tool: "run_pytest",
					args: [file],
					command: command("run_pytest", [file]),
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
		`**Execution:** safe validation runners (run_*) on the host against the repository checkout`,
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
