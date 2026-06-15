import {
	DEFAULT_MARKDOWNLINT_CONFIG,
	type MarkdownlintConfig,
	runMarkdownlint,
} from "../config-loader.js";
import type { ApiLinterRunner, ValidationOutcome } from "../types.js";
import type { LinterAdapter } from "./types.js";

export interface MarkdownlintAdapterOptions {
	config?: MarkdownlintConfig;
	runner?: ApiLinterRunner;
}

export function createMarkdownlintAdapter(
	options?: MarkdownlintAdapterOptions,
): LinterAdapter {
	const runner =
		options?.runner ??
		((filePaths: string[]) =>
			runMarkdownlint(
				filePaths,
				options?.config ?? DEFAULT_MARKDOWNLINT_CONFIG,
			));
	return {
		name: "markdownlint",
		key: "api:markdownlint",
		run: async (filePaths: string[]): Promise<ValidationOutcome> => {
			const result = await runner(filePaths);
			return {
				kind: result.kind,
				report: `--- ${result.name} (${result.fileCount} file${result.fileCount === 1 ? "" : "s"}) ---\n${result.output}`,
				affectedFiles: result.kind === "findings" ? result.affectedFiles : [],
				signature: result.output,
			};
		},
	};
}
