import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { normalizeAndSortPaths } from "../../shared/path-utils.js";
import type { CliLinterDefinition, ValidationOutcome } from "../types.js";
import type { LinterAdapter } from "./types.js";

export const BATCH_SIZE = 50;

/** Default root markers used when discovering project roots for workspace-mode linters. */
const WORKSPACE_ROOT_MARKERS = [
	"Cargo.toml",
	"package.json",
	".tflint.hcl",
	".tflint.hcl.json",
	".git",
];

export interface CliAdapterOptions {
	linter: CliLinterDefinition;
	timeoutMs?: number;
}

export function createCliAdapter(options: CliAdapterOptions): LinterAdapter {
	const { linter, timeoutMs = 60_000 } = options;
	return {
		name: linter.name,
		key: adapterKey(linter),
		run: async (
			filePaths: string[],
			cwd: string,
		): Promise<ValidationOutcome> => {
			const result = await runCliLinter(filePaths, linter, timeoutMs, cwd);
			return {
				kind: result.kind,
				report: `--- ${result.name} (${result.fileCount} file${result.fileCount === 1 ? "" : "s"}) ---\n${result.output}`,
				affectedFiles: result.kind === "findings" ? result.affectedFiles : [],
				signature: result.output,
			};
		},
	};
}

function adapterKey(linter: CliLinterDefinition): string {
	if (linter.mode === "project-root" || linter.mode === "workspace") {
		return `cli:${linter.command}:${linter.args.join(" ")}:mode=${linter.mode ?? "per-file"}:root=${linter.rootMarker ?? ""}`;
	}
	return `cli:${linter.command}:${linter.args.join(" ")}`;
}

interface CliRunResult {
	kind: import("../types.js").ValidationKind;
	name: string;
	output: string;
	fileCount: number;
	affectedFiles: string[];
}

async function runCliLinter(
	filePaths: string[],
	linter: CliLinterDefinition,
	timeoutMs: number,
	defaultCwd: string,
): Promise<CliRunResult> {
	const existingFiles = await filterExistingFiles(filePaths);
	if (existingFiles.length === 0) {
		return {
			kind: "clean",
			name: linter.name,
			output: "",
			fileCount: 0,
			affectedFiles: [],
		};
	}

	const isWorkspace = linter.mode === "workspace";
	const isProjectRoot = linter.mode === "project-root";

	if (isWorkspace || isProjectRoot) {
		const marker = isWorkspace
			? linter.rootMarker || WORKSPACE_ROOT_MARKERS
			: linter.rootMarker || ".git";
		const rootGroups = groupFilesByRoot(existingFiles, marker);
		const results = await Promise.all(
			Array.from(rootGroups.entries()).map(([root, files]) =>
				runCliCommand(files, linter, timeoutMs, root, true),
			),
		);
		return mergeCliRunResults(results);
	}

	const batches = Array.from(
		{ length: Math.ceil(existingFiles.length / BATCH_SIZE) },
		(_, i) => existingFiles.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE),
	);
	const outputs: string[] = [];

	for (const batch of batches) {
		const result = await runCliCommand(
			batch,
			linter,
			timeoutMs,
			defaultCwd,
			false,
		);
		if (result.kind === "tool-error") {
			return result;
		}
		if (result.output) outputs.push(result.output);
	}

	const output = outputs.join("\n\n").trim();
	return {
		kind: output ? "findings" : "clean",
		name: linter.name,
		output,
		fileCount: existingFiles.length,
		affectedFiles: output ? extractAffectedFiles(output, defaultCwd) : [],
	};
}

function groupFilesByRoot(
	filePaths: string[],
	marker: string | string[],
): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const filePath of filePaths) {
		const root = findProjectRoot(resolve(filePath, ".."), marker);
		const group = groups.get(root) ?? [];
		group.push(filePath);
		groups.set(root, group);
	}
	return groups;
}

async function runCliCommand(
	filePaths: string[],
	linter: CliLinterDefinition,
	timeoutMs: number,
	cwd: string,
	noFileArgs: boolean,
): Promise<CliRunResult> {
	if (filePaths.length === 0) {
		return {
			kind: "clean",
			name: linter.name,
			output: "",
			fileCount: 0,
			affectedFiles: [],
		};
	}

	const cmdParts = noFileArgs
		? [...linter.args]
		: [...linter.args, ...filePaths];
	const result = await spawnCommand(linter.command, cmdParts, timeoutMs, cwd);

	if (result.output.startsWith(`Error running ${linter.command}`)) {
		return {
			kind: "tool-error",
			name: linter.name,
			output: result.output,
			fileCount: filePaths.length,
			affectedFiles: [],
		};
	}

	const output = normalizeCliOutput(
		linter.command,
		result.output,
		result.exitCode,
	);
	return {
		kind: output ? "findings" : "clean",
		name: linter.name,
		output,
		fileCount: filePaths.length,
		affectedFiles: output ? extractAffectedFiles(output, cwd) : [],
	};
}

function mergeCliRunResults(results: CliRunResult[]): CliRunResult {
	if (results.length === 0) {
		return {
			kind: "clean",
			name: "",
			output: "",
			fileCount: 0,
			affectedFiles: [],
		};
	}

	const name = results[0].name;
	const toolErrors = results.filter((r) => r.kind === "tool-error");
	if (toolErrors.length > 0) {
		return {
			kind: "tool-error",
			name,
			output: toolErrors
				.map((r) => r.output)
				.join("\n\n")
				.trim(),
			fileCount: results.reduce((sum, r) => sum + r.fileCount, 0),
			affectedFiles: [],
		};
	}

	const output = results
		.map((r) => r.output)
		.filter(Boolean)
		.join("\n\n")
		.trim();
	return {
		kind: output ? "findings" : "clean",
		name,
		output,
		fileCount: results.reduce((sum, r) => sum + r.fileCount, 0),
		affectedFiles: normalizeAndSortPaths(
			results.flatMap((r) => r.affectedFiles),
		),
	};
}

function extractAffectedFiles(output: string, directory: string): string[] {
	const locations = extractIssueLocations(output, directory);
	return normalizeAndSortPaths(locations.map((loc) => loc.filePath));
}

function extractIssueLocations(
	report: string,
	directory: string,
): Array<{ filePath: string; lineNumber: number }> {
	const locations = new Map<string, Set<number>>();
	const linePattern = /^(.+?):(\d+)(?::\d+)?\b/;

	for (const line of report.split(/\r?\n/)) {
		const match = line.match(linePattern);
		if (!match) continue;

		const rawPath = match[1]?.trim();
		const lineNumber = Number.parseInt(match[2] ?? "", 10);
		if (!rawPath || !Number.isFinite(lineNumber) || lineNumber < 1) continue;
		if (rawPath.startsWith("http://") || rawPath.startsWith("https://"))
			continue;

		const filePath = normalizeAndSortPaths([
			isAbsolute(rawPath) ? rawPath : resolve(directory, rawPath),
		])[0];
		const existing = locations.get(filePath) ?? new Set<number>();
		existing.add(lineNumber);
		locations.set(filePath, existing);
	}

	return Array.from(locations.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([filePath, lineNumbers]) =>
			Array.from(lineNumbers)
				.sort((a, b) => a - b)
				.map((lineNumber) => ({ filePath, lineNumber })),
		);
}

function normalizeCliOutput(
	command: string,
	output: string,
	exitCode: number | null,
): string {
	const trimmed = output.trim();
	if (!trimmed) return "";

	if (
		command === "biome" &&
		exitCode === 0 &&
		trimmed.startsWith("Checked ") &&
		trimmed.includes("No fixes applied.") &&
		!trimmed.includes("Found ")
	) {
		return "";
	}

	return trimmed;
}

export function findProjectRoot(
	startDir: string,
	marker?: string | string[],
): string {
	let dir = resolve(startDir);
	const markers = Array.isArray(marker) ? marker : marker ? [marker] : [".git"];
	let prevDir = "";
	while (dir !== prevDir) {
		for (const m of markers) {
			if (existsSync(join(dir, m))) {
				return dir;
			}
		}
		prevDir = dir;
		dir = resolve(dir, "..");
	}
	return resolve(startDir);
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

async function spawnCommand(
	command: string,
	args: string[],
	timeoutMs: number,
	cwd?: string,
): Promise<{ output: string; exitCode: number | null }> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			...(cwd ? { cwd } : {}),
		});
		let stdout = "";
		let stderr = "";
		let finished = false;

		const timer = setTimeout(() => {
			if (finished) return;
			finished = true;
			proc.kill("SIGKILL");
			resolve({
				output: `Error running ${command}: timed out after ${timeoutMs}ms`,
				exitCode: null,
			});
		}, timeoutMs);

		proc.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});

		proc.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});

		proc.on("error", (error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolve({
				output: `Error running ${command}: ${error instanceof Error ? error.message : String(error)}`,
				exitCode: null,
			});
		});

		proc.on("close", (code) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolve({
				output: [stdout, stderr].filter(Boolean).join("\n"),
				exitCode: code,
			});
		});
	});
}

export const __test__ = {
	extractIssueLocations,
	extractAffectedFiles,
	normalizeCliOutput,
	findProjectRoot,
	groupFilesByRoot,
	mergeCliRunResults,
};
