/**
 * Markdownlint engine — the deep module behind the markdownlint adapter.
 *
 * Owns: running markdownlint over a file set, `.markdownlintignore`
 * discovery/loading/filtering, violation result + fix formatting, and the
 * default markdownlint config.
 *
 * This module was extracted out of `config-loader.ts` so that config loading
 * and markdownlint execution are separate responsibilities, and so the
 * markdownlint adapter can own its execution behind the `LinterAdapter` seam
 * (convention `mx-295f57`: adapters receive config and run linting, instead of
 * being handed a pre-baked runner closure).
 *
 * `config-loader.ts` re-exports these symbols for transition; new code should
 * import directly from `./markdownlint.js`.
 */

import { existsSync, promises as fs } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { minimatch } from "minimatch";
import { normalizeAndSortPaths } from "../shared/path-utils.js";
import type { LinterResult, MarkdownlintConfig } from "./types.js";

export const DEFAULT_MARKDOWNLINT_CONFIG: MarkdownlintConfig = {
	default: true,
	MD013: { line_length: 120 },
};

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
): Promise<LinterResult> {
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
