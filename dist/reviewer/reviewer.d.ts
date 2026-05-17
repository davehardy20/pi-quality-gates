import type { Finding, ReviewConfidence, ReviewConfig, ReviewDomain, ReviewReport, ReviewStatus, Severity } from "./types.js";
export type { Finding, ReviewConfidence, ReviewConfig, ReviewDomain, ReviewReport, ReviewStatus, Severity, };
export interface ReviewerResult {
    report: ReviewReport | null;
    rawOutput: string;
    exitCode: number;
    timedOut: boolean;
    usage?: string;
    stderr: string;
    command: string;
}
/**
 * Options for filtering files before gathering diffs.
 *
 * Two filtering layers are supported:
 *  1. `.gitignore` filtering via `git check-ignore` (accurate, respects nested files)
 *  2. `.pi/reviewer.skip` filtering via the `ignore` package (gitignore-format patterns)
 */
export interface DiffFilterOptions {
    /** Whether to exclude git-ignored files. Defaults to `false`. */
    respectGitignore?: boolean;
    /**
     * A pre-loaded skip filter (from `loadSkipFilter`).
     * Files matching these patterns are excluded regardless of gitignore.
     */
    skipFilter?: {
        loaded: boolean;
        patternCount: number;
        ig: {
            ignores: (path: string) => boolean;
            filter: (paths: string[]) => string[];
        };
    } | null;
}
/**
 * Extract the most recent user task from session entries.
 * Scans entries in reverse, skipping extension-generated messages,
 * and returns the last meaningful user prompt.
 */
export declare function extractOriginalTask(entries: Array<{
    type: string;
    message?: {
        role?: string;
        content?: string | Array<{
            type?: string;
            text?: string;
        }>;
    };
}>): string;
/**
 * Filter a list of file paths by removing those that match .gitignore rules.
 *
 * Uses `git check-ignore` which correctly handles nested `.gitignore` files,
 * `.git/info/exclude`, and other gitignore resolution rules.
 *
 * @param files  File paths relative to `cwd`.
 * @param cwd    The git working tree root.
 * @returns      A new array with gitignored files removed.
 */
export declare function filterGitignoredFiles(files: string[], cwd: string): Promise<string[]>;
/**
 * Apply all configured filters to a file list.
 *
 * Filtering order:
 *  1. `.gitignore` (if `respectGitignore` is true) — via `git check-ignore`
 *  2. `.pi/reviewer.skip` (if `skipFilter` is loaded) — via `ignore` package
 *
 * @param files   File paths relative to `cwd`.
 * @param cwd     The working directory.
 * @param options Filter options.
 * @returns       A new array with filtered files removed.
 */
export declare function applyDiffFilters(files: string[], cwd: string, options?: DiffFilterOptions): Promise<string[]>;
/**
 * Generate a git diff for the given files against HEAD.
 * Returns the diff string, capped at maxLines.
 * If a file has no HEAD (new file), falls back to `git diff --no-index /dev/null`.
 *
 * When `filterOptions` are provided, files matching .gitignore or reviewer.skip
 * patterns are excluded from the diff before it is generated.
 */
export declare function gatherDiff(files: string[], cwd: string, maxLines: number, filterOptions?: DiffFilterOptions): Promise<string>;
/**
 * Count changed lines (+/-) in a diff using `git diff --stat`.
 *
 * This is much cheaper than fetching the full diff text just to count lines.
 * Uses `--numstat` which outputs `added\tdeleted\tfilename` per file.
 * Returns total added + deleted lines.
 *
 * @param files  File paths relative to `cwd`.
 * @param cwd    The working directory.
 * @returns      Total number of added + deleted lines, or -1 on error.
 */
export declare function countDiffLinesFast(files: string[], cwd: string): Promise<number>;
/**
 * Cap a diff string at maxLines, keeping the most recent changes.
 * Adds a truncation notice if truncated.
 */
export declare function capDiff(diff: string, maxLines: number): string;
/**
 * Read the reviewer system prompt from the prompts directory.
 */
export declare function readSystemPrompt(promptsDir: string): string;
/**
 * Render the task template with placeholders replaced.
 */
export declare function renderTaskTemplate(promptsDir: string, task: string, files: string[], diff: string): string;
/**
 * Spawn a headless child Pi process for the review.
 * Uses `--mode json --no-session` with read-only tools.
 */
export declare function spawnReviewer(taskPrompt: string, systemPrompt: string, config: ReviewConfig, cwd: string, signal?: AbortSignal): Promise<ReviewerResult>;
/**
 * Parse the structured `## Review Report` block from the reviewer child output.
 * Returns null if parsing fails or the report block is not found.
 */
export declare function parseReviewReport(output: string): ReviewReport | null;
/**
 * Check whether the report contains findings at or above the threshold.
 */
export declare function hasFindingsAboveThreshold(report: ReviewReport | null, threshold: "critical" | "warning" | "none"): boolean;
/**
 * Format a report for display to the user.
 */
export declare function formatReportForDisplay(report: ReviewReport): string;
