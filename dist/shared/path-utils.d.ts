/**
 * Shared path utilities for robust path parsing and comparison.
 *
 * Goals:
 * - Consistent normalization across slash commands and tools.
 * - Safe resolution that rejects empty/whitespace-only inputs.
 * - Platform-agnostic comparison (backslash → slash, collapse duplicates,
 *   resolve . and .., strip trailing slashes).
 */
/**
 * Normalize a file path for use as a Map key or in comparisons.
 *
 * - Runs `path.normalize()` to resolve `.` and `..` segments.
 * - Converts backslashes to forward slashes.
 * - Collapses multiple consecutive slashes.
 * - Strips trailing slashes (except for root `/`).
 */
export declare function normalizePath(filePath: string): string;
/**
 * Compare two paths for equality after normalization.
 *
 * On case-insensitive file systems (Windows, macOS) this performs a
 * case-insensitive comparison. On Linux it is case-sensitive.
 */
export declare function pathsEqual(a: string, b: string): boolean;
/**
 * Expand `~` and `~user` prefixes using the OS home directory.
 */
export declare function expandTilde(filePath: string): string;
/**
 * Resolve a raw slash-command argument into an absolute, normalized path.
 *
 * - Trims whitespace and rejects empty inputs (returns `null`).
 * - Strips matching outer quotes.
 * - Expands `~` prefixes.
 * - Resolves relative paths against `cwd`.
 * - Normalizes the result.
 *
 * Use this in `registerCommand` handlers when parsing file-path arguments.
 */
export declare function resolveCommandPath(input: string, cwd: string): string | null;
/**
 * Convert a `file://` URI to a normalized path.
 *
 * Uses Node's `fileURLToPath` so Windows drive-letter URIs are handled
 * correctly (e.g. `file:///C:/foo` → `C:/foo` after normalization).
 */
export declare function uriToNormalizedPath(uri: string): string;
/**
 * Deduplicate and sort a list of paths after normalization.
 *
 * Useful when collecting affected files from multiple sources to ensure
 * consistent output ordering and eliminate duplicates.
 */
export declare function normalizeAndSortPaths(filePaths: string[]): string[];
/**
 * Options for {@link resolvePath}.
 */
export interface ResolvePathOptions {
    /**
     * When `true` (default), follow symlinks via `fs.realpathSync.native`.
     * When `false`, skip symlink resolution and return the logical path.
     *
     * Set to `false` when you need the path the caller *intended* rather than
     * its physical target (e.g. git secret scanning that should stay within
     * the repo root).
     */
    followSymlinks?: boolean;
}
/**
 * Resolve a path for security comparisons.
 *
 * - Expands `~` to the user's home directory.
 * - Resolves relative paths against `cwd`.
 * - When `followSymlinks` is `true` (default), follows symlinks via
 *   `fs.realpathSync.native`.
 * - Falls back to the unresolved path if `realpath` fails (e.g. path does
 *   not exist yet).
 */
export declare function resolvePath(p: string, cwd: string, options?: ResolvePathOptions): string;
/**
 * Test whether `targetPath` matches a damage-prevention pattern.
 *
 * Supports:
 * - Exact path match
 * - Directory prefix match (`/foo/bar` matches `/foo/bar/baz`)
 * - Relative path match against `cwd`
 * - Glob-style wildcards (`*` = any sequence, `?` = single char)
 *
 * The pattern itself is resolved the same way as `targetPath` (tilde,
 * absolute, symlink-followed by default) before comparison.
 */
export declare function isPathMatch(targetPath: string, pattern: string, cwd: string, options?: ResolvePathOptions): boolean;
