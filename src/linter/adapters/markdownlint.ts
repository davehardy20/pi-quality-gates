import {
	DEFAULT_MARKDOWNLINT_CONFIG,
	runMarkdownlint,
} from "../markdownlint.js";
import type { MarkdownlintConfig, ValidationOutcome } from "../types.js";
import type { LinterAdapter } from "./types.js";

/**
 * Markdownlint adapter.
 *
 * Owns its own execution: it runs `runMarkdownlint` directly with a resolved
 * `MarkdownlintConfig` (convention `mx-295f57`). Config is data — not a
 * pre-baked runner closure — so the markdownlint engine stays behind the
 * `LinterAdapter` seam and is exercisable through `run()`.
 */
export interface MarkdownlintAdapterOptions {
	config?: MarkdownlintConfig;
}

export function createMarkdownlintAdapter(
	options?: MarkdownlintAdapterOptions,
): LinterAdapter {
	const config = options?.config ?? DEFAULT_MARKDOWNLINT_CONFIG;

	return {
		name: "markdownlint",
		key: "api:markdownlint",
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
