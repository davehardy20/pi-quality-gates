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
import { getLinterForFile } from "./config-loader.js";
import { mergeValidationOutcomes } from "./outcome-merger.js";
import { buildCodeExcerptSection } from "./report-builder.js";
import type { CombinedValidationOutcome, LinterConfig } from "./types.js";
export { attachMarkdownlintConfig, DEFAULT_CONFIG, DEFAULT_MARKDOWNLINT_CONFIG, formatMarkdownlintResults, getLinterForFile, loadLinterConfig, loadMarkdownlintConfig, MAX_MODIFIED_FILES, parseJsoncConfig, runMarkdownlint, } from "./config-loader.js";
export { buildCombinedSignature, mergeValidationOutcomes, } from "./outcome-merger.js";
export { createLinterPipeline } from "./pipeline.js";
export { buildCodeExcerptSection, extractAffectedFiles, extractIssueLocations, } from "./report-builder.js";
export declare const BATCH_SIZE = 50;
/** @deprecated Use LinterPipeline from src/linter/pipeline.ts */
export declare function runQueuedLintChecks(filePaths: string[], directory: string, providedConfig?: LinterConfig): Promise<CombinedValidationOutcome>;
/** @deprecated Use src/linter/pipeline.ts internals */
export declare function groupFilesByLinter(files: Set<string>, config: LinterConfig): Map<string, string[]>;
/** @deprecated Use src/linter/pipeline.ts internals */
export declare function isBuiltInIgnoredAgentArtifact(filePath: string): boolean;
/** @deprecated Use src/linter/pipeline.ts internals */
export declare function filterBuiltInIgnoredFiles(filePaths: string[]): string[];
export declare const __test__: {
    parseJsoncConfig: (configData: string) => Promise<import("./types.js").MarkdownlintConfig>;
    loadMarkdownlintConfig: (directory: string) => Promise<import("./types.js").MarkdownlintConfig>;
    loadLinterConfig: (directory: string) => Promise<LinterConfig>;
    getLinterForFile: typeof getLinterForFile;
    mergeValidationOutcomes: typeof mergeValidationOutcomes;
    buildCodeExcerptSection: typeof buildCodeExcerptSection;
    extractIssueLocations: (report: string, directory: string) => Promise<import("./report-builder.js").IssueLocation[]>;
    extractAffectedFiles: (output: string, directory: string) => Promise<string[]>;
    buildCombinedSignature: (results: import("./types.js").ValidationOutcome[]) => Promise<string>;
    isBuiltInIgnoredAgentArtifact: typeof isBuiltInIgnoredAgentArtifact;
    filterBuiltInIgnoredFiles: typeof filterBuiltInIgnoredFiles;
    formatMarkdownlintResults: (results: Record<string, {
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
    }[]>) => Promise<string>;
    groupFilesByLinter: typeof groupFilesByLinter;
};
