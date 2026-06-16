import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Supported project ecosystems for test execution.
 */
export type ProjectEcosystem =
	| "typescript"
	| "python"
	| "rust"
	| "go"
	| "unknown";

export interface TestExecutionPlan {
	ecosystem: ProjectEcosystem;
	recommendedCommands: string[];
	discoveryCommand?: string;
}

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
 * Recommend test commands for a set of changed files based on the project
 * ecosystem. The recommendations are conservative: they target the narrowest
 * useful checks first, then broader checks.
 *
 * @param files  Changed file paths relative to `cwd`.
 * @param cwd    Project root.
 * @returns      A test execution plan with recommended commands.
 */
export function recommendTestCommands(
	files: string[],
	cwd: string,
): TestExecutionPlan {
	const ecosystem = detectProjectEcosystem(cwd);

	const isTestFile = (file: string): boolean =>
		file.includes(".test.") ||
		file.includes(".spec.") ||
		file.includes("_test.go") ||
		file.includes("/tests/");

	const testFiles = files.filter(isTestFile);

	switch (ecosystem) {
		case "typescript": {
			const commands: string[] = [];
			if (testFiles.length > 0) {
				commands.push(`run_vitest ${testFiles.join(" ")}`);
			}
			commands.push("run_typecheck");
			commands.push("run_biome src test");
			return {
				ecosystem,
				recommendedCommands: commands,
				discoveryCommand: "npx vitest run --reporter=dot",
			};
		}
		case "python": {
			const commands: string[] = [];
			if (testFiles.length > 0) {
				commands.push(`run_pytest ${testFiles.join(" ")}`);
			}
			commands.push("run_pytest");
			return {
				ecosystem,
				recommendedCommands: commands,
				discoveryCommand: "pytest --collect-only -q",
			};
		}
		case "rust": {
			const commands: string[] = [];
			if (testFiles.length > 0) {
				commands.push("run_cargo_test");
			}
			commands.push("run_cargo_test");
			return {
				ecosystem,
				recommendedCommands: commands,
				discoveryCommand: "cargo test --no-run",
			};
		}
		case "go": {
			const commands: string[] = [];
			if (testFiles.length > 0) {
				commands.push(`run_pytest ${testFiles.join(" ")}`);
			}
			commands.push("run_pytest");
			return {
				ecosystem,
				recommendedCommands: commands,
				discoveryCommand: "go test -list .",
			};
		}
		default:
			return {
				ecosystem,
				recommendedCommands: [],
			};
	}
}

/**
 * Format a test execution plan as a markdown section suitable for inclusion
 * in the reviewer task prompt.
 */
export function formatTestExecutionPlan(plan: TestExecutionPlan): string {
	if (plan.ecosystem === "unknown" || plan.recommendedCommands.length === 0) {
		return "No test execution recommendations available for this project.";
	}

	const lines = [
		`**Ecosystem:** ${plan.ecosystem}`,
		"",
		"**Recommended commands (run narrowest first):**",
		...plan.recommendedCommands.map((cmd) => `- ${cmd}`),
	];

	if (plan.discoveryCommand) {
		lines.push("", `**Test discovery:** ${plan.discoveryCommand}`);
	}

	return lines.join("\n");
}
