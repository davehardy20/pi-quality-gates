/**
 * Filter file paths by extension. If no extensions are provided,
 * all files are returned unchanged. Comparison is case-insensitive.
 */
export declare function filterLspEligibleFiles(filePaths: string[], extensions?: string[]): string[];
/**
 * Group file paths by the LSP server that handles them and the
 * workspace root each file belongs to.
 *
 * Returns a Map where keys are `"serverId:root"` and values are
 * arrays of file paths.
 */
export declare function groupFilesByServerAndWorkspace(filePaths: string[]): Map<string, string[]>;
