import { existsSync, promises as fs } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { minimatch } from "minimatch";
import { normalizeAndSortPaths } from "../shared/path-utils.js";
import type { LinterConfig, MarkdownlintConfig } from "./types.js";

export type {
	ApiLinterDefinition,
	ApiLinterRunner,
	CliLinterDefinition,
	LinterDefinition,
	LinterResult,
	LintOutcomeKind,
	MarkdownlintConfig,
} from "./types.js";

export const MAX_MODIFIED_FILES = 1000;

export const DEFAULT_MARKDOWNLINT_CONFIG: MarkdownlintConfig = {
	default: true,
	MD013: { line_length: 120 },
};

export const DEFAULT_CONFIG: LinterConfig = {
	cooldownMs: 15_000,
	timeoutMs: 60_000,
	reportMode: "auto-follow-up",
	runtimeMode: "auto",
	lsp: {
		enabled: false,
		settleMs: 500,
		timeoutMs: 15_000,
		minSeverity: "warning",
		maxFilesPerWorkspace: 100,
	},
	linters: {
		".md": { type: "api", name: "markdownlint", runner: runMarkdownlint },
		".ts": { type: "cli", command: "biome", args: ["check"], name: "Biome" },
		".tsx": { type: "cli", command: "biome", args: ["check"], name: "Biome" },
		".js": { type: "cli", command: "biome", args: ["check"], name: "Biome" },
		".jsx": { type: "cli", command: "biome", args: ["check"], name: "Biome" },
		".mjs": { type: "cli", command: "biome", args: ["check"], name: "Biome" },
		".cjs": { type: "cli", command: "biome", args: ["check"], name: "Biome" },
		".py": { type: "cli", command: "ruff", args: ["check"], name: "Ruff" },
		".pyi": { type: "cli", command: "ruff", args: ["check"], name: "Ruff" },
		".c": {
			type: "cli",
			command: "cppcheck",
			args: ["--enable=all", "--std=c11", "--quiet", "--template=gcc"],
			name: "cppcheck",
		},
		".cpp": {
			type: "cli",
			command: "cppcheck",
			args: ["--enable=all", "--std=c++17", "--quiet", "--template=gcc"],
			name: "cppcheck",
		},
		".cc": {
			type: "cli",
			command: "cppcheck",
			args: ["--enable=all", "--std=c++17", "--quiet", "--template=gcc"],
			name: "cppcheck",
		},
		".h": {
			type: "cli",
			command: "cppcheck",
			args: ["--enable=all", "--quiet", "--template=gcc"],
			name: "cppcheck",
		},
		".hpp": {
			type: "cli",
			command: "cppcheck",
			args: ["--enable=all", "--std=c++17", "--quiet", "--template=gcc"],
			name: "cppcheck",
		},
		".tf": {
			type: "cli",
			command: "tflint",
			args: [],
			name: "tflint",
			mode: "project-root",
			rootMarker: ".tflint.hcl",
		},
		".tfvars": {
			type: "cli",
			command: "tflint",
			args: [],
			name: "tflint",
			mode: "project-root",
			rootMarker: ".tflint.hcl",
		},
		".rs": {
			type: "cli",
			command: "cargo",
			args: ["clippy", "--all-targets", "--all-features"],
			name: "cargo clippy",
			mode: "project-root",
			rootMarker: "Cargo.toml",
		},
	},
};

export function parseJsoncConfig(configData: string): MarkdownlintConfig {
	let inString = false;
	let escaped = false;
	let inLineComment = false;
	let inBlockComment = false;
	let withoutComments = "";

	for (let i = 0; i < configData.length; i++) {
		const char = configData[i];
		const next = configData[i + 1];

		if (inLineComment) {
			if (char === "\n") {
				inLineComment = false;
				withoutComments += char;
			}
			continue;
		}

		if (inBlockComment) {
			if (char === "*" && next === "/") {
				inBlockComment = false;
				i++;
			}
			continue;
		}

		if (inString) {
			withoutComments += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}

		if (char === '"') {
			inString = true;
			withoutComments += char;
			continue;
		}

		if (char === "/" && next === "/") {
			inLineComment = true;
			i++;
			continue;
		}

		if (char === "/" && next === "*") {
			inBlockComment = true;
			i++;
			continue;
		}

		withoutComments += char;
	}

	let result = "";
	inString = false;
	escaped = false;

	for (let i = 0; i < withoutComments.length; i++) {
		const char = withoutComments[i];

		if (inString) {
			result += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}

		if (char === '"') {
			inString = true;
			result += char;
			continue;
		}

		if (char === ",") {
			let j = i + 1;
			while (j < withoutComments.length && /\s/.test(withoutComments[j])) {
				j++;
			}
			if (
				j < withoutComments.length &&
				(withoutComments[j] === "}" || withoutComments[j] === "]")
			) {
				continue;
			}
		}

		result += char;
	}

	return JSON.parse(result) as MarkdownlintConfig;
}

export async function loadMarkdownlintConfig(
	directory: string,
): Promise<MarkdownlintConfig> {
	const configPaths = [
		join(directory, ".markdownlint.jsonc"),
		join(directory, ".markdownlint.json"),
	];

	for (const configPath of configPaths) {
		try {
			const configData = await fs.readFile(configPath, "utf8");
			const userConfig = parseJsoncConfig(configData);
			return { ...DEFAULT_MARKDOWNLINT_CONFIG, ...userConfig };
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				continue;
			}
			console.error(
				`[pi-post-turn-linter] Failed to load markdownlint config from ${configPath}:`,
				error,
			);
			return DEFAULT_MARKDOWNLINT_CONFIG;
		}
	}

	return DEFAULT_MARKDOWNLINT_CONFIG;
}

export function attachMarkdownlintConfig(
	linters: Record<string, import("./types.js").LinterDefinition>,
	markdownlintConfig: MarkdownlintConfig,
): Record<string, import("./types.js").LinterDefinition> {
	const markdownLinter = linters[".md"];
	if (
		markdownLinter &&
		markdownLinter.type === "api" &&
		markdownLinter.name === "markdownlint"
	) {
		return {
			...linters,
			".md": {
				...markdownLinter,
				runner: (filePaths: string[]) =>
					runMarkdownlint(filePaths, markdownlintConfig),
			},
		};
	}

	return linters;
}

export async function loadLinterConfig(
	directory: string,
): Promise<LinterConfig> {
	const markdownlintConfig = await loadMarkdownlintConfig(directory);
	const configPaths = [
		join(directory, ".pi", "linter.config.json"),
		join(directory, ".opencode", "linter.config.json"),
	];

	for (const configPath of configPaths) {
		try {
			const configData = await fs.readFile(configPath, "utf8");
			const userConfig = JSON.parse(configData) as Partial<LinterConfig>;
			return {
				cooldownMs: userConfig.cooldownMs ?? DEFAULT_CONFIG.cooldownMs,
				timeoutMs: userConfig.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
				reportMode: userConfig.reportMode ?? DEFAULT_CONFIG.reportMode,
				runtimeMode: userConfig.runtimeMode ?? DEFAULT_CONFIG.runtimeMode,
				lsp: {
					...(DEFAULT_CONFIG.lsp ?? {}),
					...(userConfig.lsp ?? {}),
				},
				linters: attachMarkdownlintConfig(
					{
						...DEFAULT_CONFIG.linters,
						...(userConfig.linters || {}),
					},
					markdownlintConfig,
				),
			};
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				continue;
			}
			console.error(
				`[pi-post-turn-linter] Failed to load config from ${configPath}:`,
				error,
			);
			break;
		}
	}

	return {
		...DEFAULT_CONFIG,
		linters: attachMarkdownlintConfig(
			DEFAULT_CONFIG.linters,
			markdownlintConfig,
		),
	};
}

export function getLinterForFile(
	filePath: string,
	config: LinterConfig,
): import("./types.js").LinterDefinition | null {
	return config.linters[extname(filePath).toLowerCase()] || null;
}

async function filterExistingFiles(filePaths: string[]): Promise<string[]> {
	const existingFiles: string[] = [];
	for (const filePath of filePaths) {
		try {
			await fs.access(filePath);
			existingFiles.push(filePath);
		} catch {
			// ignore missing files
		}
	}
	return existingFiles;
}

export async function runMarkdownlint(
	filePaths: string[],
	config?: unknown,
): Promise<import("./types.js").LinterResult> {
	const { lint } = await import("markdownlint/promise");

	let existingFiles = await filterExistingFiles(filePaths);
	if (existingFiles.length === 0) {
		return {
			kind: "clean",
			output: "",
			fileCount: 0,
			affectedFiles: [],
			name: "markdownlint",
		};
	}

	const ignoreFile = findMarkdownlintIgnore(existingFiles);
	if (ignoreFile) {
		const ignorePatterns = await loadMarkdownlintIgnorePatterns(ignoreFile);
		existingFiles = filterIgnoredFiles(existingFiles, ignorePatterns);
	}

	if (existingFiles.length === 0) {
		return {
			kind: "clean",
			output: "",
			fileCount: 0,
			affectedFiles: [],
			name: "markdownlint",
		};
	}

	try {
		const lintOptions: Record<string, unknown> = {
			files: existingFiles,
			config:
				(config as MarkdownlintConfig | undefined) ??
				DEFAULT_MARKDOWNLINT_CONFIG,
		};
		const results = (await lint(lintOptions)) as Record<
			string,
			{
				lineNumber: number;
				ruleNames: string[];
				ruleDescription: string;
				errorDetail?: string | null;
				errorContext?: string | null;
				fixInfo?: {
					lineNumber?: number;
					editColumn?: number;
					deleteCount?: number;
					insertText?: string;
				} | null;
			}[]
		>;

		const output = formatMarkdownlintResults(results);
		const affectedFiles = normalizeAndSortPaths(
			Object.entries(results)
				.filter(([, violations]) => violations.length > 0)
				.map(([filePath]) => resolve(filePath)),
		);

		return {
			kind: output ? "findings" : "clean",
			output,
			fileCount: existingFiles.length,
			affectedFiles,
			name: "markdownlint",
		};
	} catch (error) {
		return {
			kind: "tool-error",
			output: `Error running markdownlint: ${error instanceof Error ? error.message : String(error)}`,
			fileCount: existingFiles.length,
			affectedFiles: [],
			name: "markdownlint",
		};
	}
}

function findMarkdownlintIgnore(filePaths: string[]): string | undefined {
	const dirs = new Set<string>(
		filePaths.map((f) => {
			const parts = resolve(f).split("/");
			parts.pop();
			return parts.join("/");
		}),
	);
	for (const dir of dirs) {
		let current = dir;
		for (let i = 0; i < 10; i++) {
			const candidate = join(current, ".markdownlintignore");
			if (existsSync(candidate)) return candidate;
			const parent = resolve(current, "..");
			if (parent === current) break;
			current = parent;
		}
	}
	return undefined;
}

async function loadMarkdownlintIgnorePatterns(
	ignorePath: string,
): Promise<string[]> {
	const content = await fs.readFile(ignorePath, "utf8");
	const baseDir = resolve(ignorePath, "..");
	return content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.map((pattern) => (isAbsolute(pattern) ? pattern : join(baseDir, pattern)));
}

function filterIgnoredFiles(
	filePaths: string[],
	ignorePatterns: string[],
): string[] {
	return filePaths.filter((filePath) => {
		const absPath = resolve(filePath);
		return !ignorePatterns.some((pattern) => minimatch(absPath, pattern));
	});
}

function formatMarkdownlintFixInfo(
	fixInfo:
		| {
				lineNumber?: number;
				editColumn?: number;
				deleteCount?: number;
				insertText?: string;
		  }
		| null
		| undefined,
): string {
	if (!fixInfo) return "";

	const parts: string[] = [];
	if (typeof fixInfo.lineNumber === "number") {
		parts.push(`line ${fixInfo.lineNumber}`);
	}
	if (typeof fixInfo.editColumn === "number") {
		parts.push(`col ${fixInfo.editColumn}`);
	}
	if (typeof fixInfo.deleteCount === "number") {
		parts.push(`delete ${fixInfo.deleteCount}`);
	}
	if (typeof fixInfo.insertText === "string") {
		parts.push(`insert ${JSON.stringify(fixInfo.insertText)}`);
	}

	return parts.length > 0 ? ` — fix: ${parts.join(", ")}` : "";
}

export function formatMarkdownlintResults(
	results: Record<
		string,
		{
			lineNumber: number;
			ruleNames: string[];
			ruleDescription: string;
			errorDetail?: string | null;
			errorContext?: string | null;
			fixInfo?: {
				lineNumber?: number;
				editColumn?: number;
				deleteCount?: number;
				insertText?: string;
			} | null;
		}[]
	>,
): string {
	const lines: string[] = [];

	for (const [filePath, violations] of Object.entries(results)) {
		if (violations.length === 0) continue;
		for (const violation of violations) {
			const ruleId = violation.ruleNames.join("/");
			const ruleDocLink = `https://github.com/DavidAnson/markdownlint/blob/main/doc/${violation.ruleNames[0]}.md`;
			const detail = violation.errorDetail ? ` — ${violation.errorDetail}` : "";
			const context = violation.errorContext
				? ` — context: ${JSON.stringify(violation.errorContext)}`
				: "";
			const fix = formatMarkdownlintFixInfo(violation.fixInfo);
			lines.push(
				`${filePath}:${violation.lineNumber} ${ruleId} ${violation.ruleDescription}${detail}${context}${fix} [${ruleDocLink}]`,
			);
		}
	}

	return lines.join("\n");
}
