/**
 * `.pi/reviewer.skip` file parser — gitignore-format skip rules for the
 * post-turn-reviewer.
 *
 * Uses the `ignore` package which implements the full
 * [.gitignore spec 2.22.1](https://git-scm.com/docs/gitignore).
 */
import type { Ignore } from "ignore";
/** Result of loading and parsing a reviewer.skip file. */
export interface SkipFilter {
    /** `true` when the skip file was found and parsed. */
    loaded: boolean;
    /** Absolute path of the parsed skip file, or `null` if not found. */
    filePath: string | null;
    /** Number of non-comment, non-blank pattern lines parsed. */
    patternCount: number;
    /** The underlying `ignore` instance. Use `filter()` or `ignores()`. */
    readonly ig: Ignore;
}
/** Options for loading a skip file. */
export interface SkipFilterOptions {
    /**
     * Optional logger for warnings (file not found is *not* warned by default).
     * Defaults to `console.error`.
     */
    log?: (msg: string) => void;
}
/**
 * Load and parse a `.pi/reviewer.skip` file (gitignore format).
 */
export declare function loadSkipFilter(projectRoot: string, skipFilePath: string | null | undefined, opts?: SkipFilterOptions): SkipFilter;
/**
 * Parse gitignore-format content directly (useful for tests or embedded config).
 */
export declare function parseSkipContent(content: string, labelPath?: string, opts?: SkipFilterOptions): SkipFilter;
/**
 * Check whether a single file path should be skipped.
 */
export declare function shouldSkip(filter: SkipFilter, filePath: string): boolean;
/**
 * Filter a list of file paths, removing those that match skip patterns.
 */
export declare function filterSkipped(filter: SkipFilter, filePaths: string[]): string[];
