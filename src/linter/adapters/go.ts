import { mergeValidationOutcomes } from "../outcome-merger.js";
import type { CliLinterDefinition, ValidationOutcome } from "../types.js";
import { type CliAdapterOptions, createCliAdapter } from "./cli.js";
import type { LinterAdapter } from "./types.js";

export interface GoAdapterOptions {
	timeoutMs?: number;
}

export interface GoAdapterDependencies {
	createCliAdapter: (options: CliAdapterOptions) => LinterAdapter;
}

const GOFMT_LINTER: CliLinterDefinition = {
	type: "cli",
	command: "gofmt",
	args: ["-l"],
	name: "gofmt",
};

const GO_VET_LINTER: CliLinterDefinition = {
	type: "cli",
	command: "go",
	args: ["vet", "./..."],
	name: "go vet",
	mode: "project-root",
	rootMarker: "go.mod",
};

/**
 * Go validation adapter.
 *
 * Formatting is checked only for the modified files. Semantic/static checks run
 * once per nearest Go module through the CLI adapter's project-root mode.
 */
export function createGoAdapter(
	options: GoAdapterOptions = {},
	deps: GoAdapterDependencies = { createCliAdapter },
): LinterAdapter {
	const gofmt = deps.createCliAdapter({
		linter: GOFMT_LINTER,
		timeoutMs: options.timeoutMs,
	});
	const goVet = deps.createCliAdapter({
		linter: GO_VET_LINTER,
		timeoutMs: options.timeoutMs,
	});

	return {
		name: "Go",
		key: "api:go",
		run: async (
			filePaths: string[],
			cwd: string,
		): Promise<ValidationOutcome> => {
			const results = await Promise.all([
				gofmt.run(filePaths, cwd),
				goVet.run(filePaths, cwd),
			]);
			return mergeValidationOutcomes({
				reportMode: "report-only",
				results,
			});
		},
	};
}
