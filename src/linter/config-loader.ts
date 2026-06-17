import { promises as fs } from "node:fs";
import { extname, join } from "node:path";
import {
	DEFAULT_MARKDOWNLINT_CONFIG,
	formatMarkdownlintResults,
	runMarkdownlint,
} from "./markdownlint.js";
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

export {
	DEFAULT_MARKDOWNLINT_CONFIG,
	formatMarkdownlintResults,
	runMarkdownlint,
};

export const MAX_MODIFIED_FILES = 1000;

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
		".md": { type: "api", name: "markdownlint" },
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
				markdownlintConfig,
				linters: {
					...DEFAULT_CONFIG.linters,
					...(userConfig.linters || {}),
				},
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
		markdownlintConfig,
		linters: { ...DEFAULT_CONFIG.linters },
	};
}

export function getLinterForFile(
	filePath: string,
	config: LinterConfig,
): import("./types.js").LinterDefinition | null {
	return config.linters[extname(filePath).toLowerCase()] || null;
}
