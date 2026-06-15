/**
 * Backward-compatibility re-exports for the linter subsystem.
 *
 * New code should import from the smaller modules:
 *   - src/linter/pipeline.ts        — LinterPipeline orchestration
 *   - src/linter/config-loader.ts   — config loading
 *   - src/linter/adapters/*.ts      — linter adapters
 *   - src/linter/report-builder.ts  — issue parsing and code excerpts
 *   - src/linter/outcome-merger.ts  — outcome merging
 *
 * This file is kept only so existing consumers (including tests) continue to
 * compile during the transition. It will be removed once all callers migrate.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getLinterForFile, loadLinterConfig } from "./config-loader.js";
import { mergeValidationOutcomes } from "./outcome-merger.js";
import { createLinterPipeline, __test__ as pipelineTest } from "./pipeline.js";
import { buildCodeExcerptSection } from "./report-builder.js";
import type { CombinedValidationOutcome, LinterConfig } from "./types.js";

export {
	attachMarkdownlintConfig,
	DEFAULT_CONFIG,
	DEFAULT_MARKDOWNLINT_CONFIG,
	formatMarkdownlintResults,
	getLinterForFile,
	loadLinterConfig,
	loadMarkdownlintConfig,
	MAX_MODIFIED_FILES,
	parseJsoncConfig,
	runMarkdownlint,
} from "./config-loader.js";

export {
	buildCombinedSignature,
	mergeValidationOutcomes,
} from "./outcome-merger.js";
export { createLinterPipeline } from "./pipeline.js";
export {
	buildCodeExcerptSection,
	extractAffectedFiles,
	extractIssueLocations,
} from "./report-builder.js";

export const BATCH_SIZE = 50;

const WORKSPACE_ROOT_MARKERS = [
	"Cargo.toml",
	"package.json",
	".tflint.hcl",
	".tflint.hcl.json",
	".git",
];

/** @deprecated Use LinterPipeline from src/linter/pipeline.ts */
export async function runQueuedLintChecks(
	filePaths: string[],
	directory: string,
	providedConfig?: LinterConfig,
): Promise<CombinedValidationOutcome> {
	const config = providedConfig ?? (await loadLinterConfig(directory));
	const pipeline = createLinterPipeline({
		cwd: directory,
		config,
	});
	return pipeline.runChecks(filePaths);
}

function findProjectRoot(startDir: string, marker?: string | string[]): string {
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

/** @deprecated Use src/linter/pipeline.ts internals */
export function groupFilesByLinter(
	files: Set<string>,
	config: LinterConfig,
): Map<string, string[]> {
	const groups = new Map<string, string[]>();

	for (const filePath of files) {
		const linter = getLinterForFile(filePath, config);
		if (!linter) continue;

		let key: string;
		if (
			linter.type === "cli" &&
			(linter.mode === "project-root" || linter.mode === "workspace")
		) {
			const root =
				linter.mode === "workspace" && !linter.rootMarker
					? findProjectRoot(resolve(filePath, ".."), WORKSPACE_ROOT_MARKERS)
					: findProjectRoot(
							resolve(filePath, ".."),
							linter.rootMarker || ".git",
						);
			key = `${linter.command}:${linter.args.join(" ")}:root=${root}`;
		} else {
			key =
				linter.type === "cli"
					? `${linter.command}:${linter.args.join(" ")}`
					: `api:${linter.name}`;
		}
		const group = groups.get(key) ?? [];
		group.push(filePath);
		groups.set(key, group);
	}

	return groups;
}

/** @deprecated Use src/linter/pipeline.ts internals */
export function isBuiltInIgnoredAgentArtifact(filePath: string): boolean {
	return pipelineTest.isBuiltInIgnoredAgentArtifact(filePath);
}

/** @deprecated Use src/linter/pipeline.ts internals */
export function filterBuiltInIgnoredFiles(filePaths: string[]): string[] {
	return filePaths.filter(
		(f) => !pipelineTest.isBuiltInIgnoredAgentArtifact(f),
	);
}

export const __test__ = {
	parseJsoncConfig: async (
		...args: Parameters<typeof import("./config-loader.js").parseJsoncConfig>
	) => (await import("./config-loader.js")).parseJsoncConfig(...args),
	loadMarkdownlintConfig: async (
		...args: Parameters<
			typeof import("./config-loader.js").loadMarkdownlintConfig
		>
	) => (await import("./config-loader.js")).loadMarkdownlintConfig(...args),
	loadLinterConfig: async (
		...args: Parameters<typeof import("./config-loader.js").loadLinterConfig>
	) => (await import("./config-loader.js")).loadLinterConfig(...args),
	getLinterForFile,
	mergeValidationOutcomes,
	buildCodeExcerptSection,
	extractIssueLocations: async (
		...args: Parameters<
			typeof import("./report-builder.js").extractIssueLocations
		>
	) => (await import("./report-builder.js")).extractIssueLocations(...args),
	extractAffectedFiles: async (
		...args: Parameters<
			typeof import("./report-builder.js").extractAffectedFiles
		>
	) => (await import("./report-builder.js")).extractAffectedFiles(...args),
	buildCombinedSignature: async (
		...args: Parameters<
			typeof import("./outcome-merger.js").buildCombinedSignature
		>
	) => (await import("./outcome-merger.js")).buildCombinedSignature(...args),
	isBuiltInIgnoredAgentArtifact,
	filterBuiltInIgnoredFiles,
	formatMarkdownlintResults: async (
		...args: Parameters<
			typeof import("./config-loader.js").formatMarkdownlintResults
		>
	) => (await import("./config-loader.js")).formatMarkdownlintResults(...args),
	groupFilesByLinter,
};
