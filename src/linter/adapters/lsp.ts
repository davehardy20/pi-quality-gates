import {
	getLspClient,
	type LspServiceContext,
} from "../../shared/lsp-service.js";
import {
	filterLspEligibleFiles,
	groupFilesByServerAndWorkspace,
} from "../../shared/lsp-utils.js";
import { normalizeAndSortPaths } from "../../shared/path-utils.js";
import type { LspDiagnosticsConfig, ValidationOutcome } from "../types.js";
import type { LinterAdapter } from "./types.js";

export interface LspAdapterOptions {
	config: LspDiagnosticsConfig;
	ctx: LspServiceContext;
}

export function createLspAdapter(options: LspAdapterOptions): LinterAdapter {
	const { config, ctx } = options;
	return {
		name: "LSP diagnostics",
		key: "lsp",
		run: async (filePaths: string[]): Promise<ValidationOutcome> => {
			return runQueuedLspChecks(
				{ filePaths, cwd: process.cwd(), ctx, config },
				{ getLspClient },
			);
		},
	};
}

const SEVERITY_ORDER: Record<
	NonNullable<LspDiagnosticsConfig["minSeverity"]>,
	number
> = {
	error: 1,
	warning: 2,
	info: 3,
	hint: 4,
};

export function resolveMinSeverity(
	value: LspDiagnosticsConfig["minSeverity"],
): NonNullable<LspDiagnosticsConfig["minSeverity"]> {
	if (value && value in SEVERITY_ORDER) return value;
	return "warning";
}

export function severityAtLeast(
	diagnostic: import("../../shared/lsp-client.js").LSPDiagnostic,
	minSeverity: NonNullable<LspDiagnosticsConfig["minSeverity"]>,
): boolean {
	const diagSeverity = diagnostic.severity ?? 1;
	return diagSeverity <= SEVERITY_ORDER[minSeverity];
}

function severityLabel(severity?: number): string {
	switch (severity) {
		case 1:
			return "error";
		case 2:
			return "warning";
		case 3:
			return "info";
		case 4:
			return "hint";
		default:
			return "error";
	}
}

export function formatLspDiagnostic(
	filePath: string,
	diagnostic: import("../../shared/lsp-client.js").LSPDiagnostic,
): string {
	const line = diagnostic.range.start.line + 1;
	const col = diagnostic.range.start.character + 1;
	const severity = severityLabel(diagnostic.severity);
	const code =
		diagnostic.code !== undefined ? ` (${String(diagnostic.code)})` : "";
	return `${filePath}:${line}:${col} [${severity}] ${diagnostic.message}${code}`;
}

export interface LspCheckDependencies {
	getLspClient: typeof getLspClient;
}

export async function runQueuedLspChecks(
	args: {
		filePaths: string[];
		cwd: string;
		ctx: LspServiceContext;
		config: LspDiagnosticsConfig;
	},
	deps: LspCheckDependencies = { getLspClient },
): Promise<ValidationOutcome> {
	const { filePaths, ctx, config } = args;

	if (!config.enabled) {
		return {
			kind: "clean",
			report: "",
			affectedFiles: [],
			signature: JSON.stringify({ lsp: "disabled" }),
		};
	}

	const eligibleFiles = filterLspEligibleFiles(filePaths, config.extensions);
	if (eligibleFiles.length === 0) {
		return {
			kind: "clean",
			report: "",
			affectedFiles: [],
			signature: JSON.stringify({ lsp: "no-eligible-files" }),
		};
	}

	const grouped = groupFilesByServerAndWorkspace(eligibleFiles);
	const maxFiles = config.maxFilesPerWorkspace ?? 100;
	const outcomes: ValidationOutcome[] = [];

	for (const files of grouped.values()) {
		const filesToSync = files
			.slice(0, maxFiles)
			.sort((a, b) => a.localeCompare(b));

		try {
			const client = await deps.getLspClient(filesToSync[0], ctx);
			if (!client) continue;

			await client.syncFiles(filesToSync);
			await client.waitForDiagnostics(config.settleMs ?? 500);

			const reportLines: string[] = [];
			const affectedFiles: string[] = [];

			for (const filePath of filesToSync) {
				const diagnostics = client.getCachedDiagnostics(filePath);
				const filtered = diagnostics.filter((diagnostic) =>
					severityAtLeast(diagnostic, resolveMinSeverity(config.minSeverity)),
				);

				if (filtered.length === 0) continue;

				affectedFiles.push(filePath);
				for (const diagnostic of filtered) {
					reportLines.push(formatLspDiagnostic(filePath, diagnostic));
				}
			}

			if (reportLines.length > 0) {
				outcomes.push({
					kind: "findings",
					report: reportLines.join("\n"),
					affectedFiles: normalizeAndSortPaths(affectedFiles),
					signature: JSON.stringify({
						files: filesToSync,
						lines: reportLines,
					}),
				});
			} else {
				outcomes.push({
					kind: "clean",
					report: "",
					affectedFiles: [],
					signature: JSON.stringify({ files: filesToSync, clean: true }),
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			outcomes.push({
				kind: "tool-error",
				report: `LSP error: ${message}`,
				affectedFiles: [],
				signature: JSON.stringify({ error: message }),
			});
		}
	}

	return mergeLspOutcomes(outcomes);
}

function mergeLspOutcomes(outcomes: ValidationOutcome[]): ValidationOutcome {
	if (outcomes.length === 0) {
		return {
			kind: "clean",
			report: "",
			affectedFiles: [],
			signature: JSON.stringify({ lsp: "no-servers" }),
		};
	}

	const findings = outcomes.filter((outcome) => outcome.kind === "findings");
	const toolErrors = outcomes.filter(
		(outcome) => outcome.kind === "tool-error",
	);

	if (findings.length > 0) {
		return {
			kind: "findings",
			report: [...findings, ...toolErrors]
				.map((outcome) => outcome.report)
				.join("\n\n"),
			affectedFiles: normalizeAndSortPaths(
				findings.flatMap((outcome) => outcome.affectedFiles),
			),
			signature: buildLspCombinedSignature(outcomes),
		};
	}

	if (toolErrors.length > 0) {
		return {
			kind: "tool-error",
			report: toolErrors.map((outcome) => outcome.report).join("\n\n"),
			affectedFiles: [],
			signature: buildLspCombinedSignature(outcomes),
		};
	}

	return {
		kind: "clean",
		report: "",
		affectedFiles: [],
		signature: buildLspCombinedSignature(outcomes),
	};
}

function buildLspCombinedSignature(results: ValidationOutcome[]): string {
	return JSON.stringify(
		results
			.map((result) => ({
				kind: result.kind,
				signature: result.signature,
			}))
			.sort((a, b) => {
				if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
				return a.signature.localeCompare(b.signature);
			}),
	);
}

export const __test__ = {
	severityAtLeast,
	resolveMinSeverity,
	formatLspDiagnostic,
	filterLspEligibleFiles,
	groupFilesByServerAndWorkspace,
};
