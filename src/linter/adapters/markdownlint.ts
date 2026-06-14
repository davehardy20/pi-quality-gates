import {
	DEFAULT_MARKDOWNLINT_CONFIG,
	runMarkdownlint,
} from "../config-loader.js";
import type { ValidationOutcome } from "../types.js";
import type { LinterAdapter } from "./types.js";

export interface MarkdownlintAdapterOptions {
	config?: import("../config-loader.js").MarkdownlintConfig;
}

export function createMarkdownlintAdapter(
	options?: MarkdownlintAdapterOptions,
): LinterAdapter {
	const config = options?.config ?? DEFAULT_MARKDOWNLINT_CONFIG;
	return {
		name: "markdownlint",
		run: async (filePaths: string[]): Promise<ValidationOutcome> => {
			const result = await runMarkdownlint(filePaths, config);
			return {
				kind: result.kind,
				report: `--- ${result.name} (${result.fileCount} file${result.fileCount === 1 ? "" : "s"}) ---\n${result.output}`,
				affectedFiles: result.kind === "findings" ? result.affectedFiles : [],
				signature: result.output,
			};
		},
	};
}
