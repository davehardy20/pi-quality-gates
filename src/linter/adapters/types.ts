import type { ValidationOutcome } from "../types.js";

/**
 * Adapter that runs lint checks for one or more files.
 *
 * The pipeline collects all files that match this adapter's linter definition
 * and invokes run() with the grouped paths. The adapter returns a ready-to-merge
 * ValidationOutcome.
 */
export interface LinterAdapter {
	readonly name: string;
	readonly key: string;
	run(filePaths: string[], cwd: string): Promise<ValidationOutcome>;
}
