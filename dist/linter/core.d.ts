import type { CombinedValidationOutcome, LspDiagnosticsConfig, ReportMode, ValidationKind, ValidationOutcome } from "./types.js";
export type ApiLinterRunner = (filePaths: string[], config?: unknown) => Promise<LinterResult>;
export type LintOutcomeKind = ValidationKind;
export interface LinterResult {
    kind: LintOutcomeKind;
    output: string;
    fileCount: number;
    affectedFiles: string[];
}
export interface CliLinterDefinition {
    type: "cli";
    command: string;
    args: string[];
    name: string;
    /**
     * `"per-file"` (default) — runs once per batch of files, appending file paths to args.
     * `"workspace"` — runs once per discovered project root; does not append files.
     *   Project root is discovered by walking up from modified files looking for
     *   `Cargo.toml`, `package.json`, `.tflint.hcl`, or `.git`.
     * `"project-root"` — runs once per explicit `rootMarker`; does not append files.
     */
    mode?: "per-file" | "workspace" | "project-root";
    rootMarker?: string;
}
export interface ApiLinterDefinition {
    type: "api";
    name: string;
    runner: ApiLinterRunner;
}
export type LinterDefinition = CliLinterDefinition | ApiLinterDefinition;
interface MarkdownlintFixInfo {
    lineNumber?: number;
    editColumn?: number;
    deleteCount?: number;
    insertText?: string;
}
interface MarkdownlintViolation {
    lineNumber: number;
    ruleNames: string[];
    ruleDescription: string;
    errorDetail?: string | null;
    errorContext?: string | null;
    fixInfo?: MarkdownlintFixInfo | null;
}
interface MarkdownlintResult {
    [filePath: string]: MarkdownlintViolation[];
}
export interface MarkdownlintConfig {
    default?: boolean;
    [ruleName: string]: unknown;
}
export interface LinterConfig {
    linters: Record<string, LinterDefinition>;
    cooldownMs?: number;
    timeoutMs?: number;
    reportMode?: ReportMode;
    lsp?: LspDiagnosticsConfig;
}
export declare const DEFAULT_MARKDOWNLINT_CONFIG: MarkdownlintConfig;
export declare const DEFAULT_CONFIG: LinterConfig;
export declare const MAX_MODIFIED_FILES = 1000;
export declare const BATCH_SIZE = 50;
export declare function parseJsoncConfig(configData: string): MarkdownlintConfig;
export declare function loadMarkdownlintConfig(directory: string): Promise<MarkdownlintConfig>;
export declare function runMarkdownlint(filePaths: string[], config?: unknown): Promise<LinterResult>;
export declare function formatMarkdownlintResults(results: MarkdownlintResult): string;
export declare function attachMarkdownlintConfig(linters: Record<string, LinterDefinition>, markdownlintConfig: MarkdownlintConfig): Record<string, LinterDefinition>;
export declare function loadLinterConfig(directory: string): Promise<LinterConfig>;
export declare function getLinterForFile(filePath: string, config: LinterConfig): LinterDefinition | null;
declare function findProjectRoot(startDir: string, marker?: string | string[]): string;
export declare function groupFilesByLinter(files: Set<string>, config: LinterConfig): Map<string, string[]>;
export declare function runLinter(filePaths: string[], linter: LinterDefinition, timeoutMs?: number, directory?: string): Promise<{
    kind: LintOutcomeKind;
    name: string;
    output: string;
    fileCount: number;
    affectedFiles: string[];
} | null>;
export declare function buildCombinedSignature(results: ValidationOutcome[]): string;
export declare function mergeValidationOutcomes(args: {
    reportMode: ReportMode;
    results: ValidationOutcome[];
}): CombinedValidationOutcome;
export declare function runQueuedLintChecks(filePaths: string[], directory: string, providedConfig?: LinterConfig): Promise<CombinedValidationOutcome>;
declare function extractAffectedFiles(output: string, directory: string): string[];
declare function extractIssueLocations(report: string, directory: string): Array<{
    filePath: string;
    lineNumber: number;
}>;
declare function buildCodeExcerptSection(report: string, directory: string): Promise<string>;
export declare const __test__: {
    parseJsoncConfig: typeof parseJsoncConfig;
    loadMarkdownlintConfig: typeof loadMarkdownlintConfig;
    loadLinterConfig: typeof loadLinterConfig;
    groupFilesByLinter: typeof groupFilesByLinter;
    getLinterForFile: typeof getLinterForFile;
    extractIssueLocations: typeof extractIssueLocations;
    extractAffectedFiles: typeof extractAffectedFiles;
    buildCodeExcerptSection: typeof buildCodeExcerptSection;
    formatMarkdownlintResults: typeof formatMarkdownlintResults;
    findProjectRoot: typeof findProjectRoot;
    mergeValidationOutcomes: typeof mergeValidationOutcomes;
    buildCombinedSignature: typeof buildCombinedSignature;
};
export {};
