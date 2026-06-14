import { createCliAdapter } from "./adapters/cli.js";
import { createLspAdapter } from "./adapters/lsp.js";
import { createMarkdownlintAdapter } from "./adapters/markdownlint.js";
import type { LinterAdapter } from "./adapters/types.js";
import {
	DEFAULT_CONFIG,
	getLinterForFile,
	loadLinterConfig,
} from "./config-loader.js";
import { mergeValidationOutcomes } from "./outcome-merger.js";
import { buildCodeExcerptSection } from "./report-builder.js";
import {
	buildSummaryFirstLintMessage,
	deriveSessionId,
	type LinterReportSidecarWriteResult,
	writeLinterReportSidecar,
} from "./report-hygiene.js";
import type {
	ApiLinterDefinition,
	CliLinterDefinition,
	CombinedValidationOutcome,
	LinterConfig,
	LinterDefinition,
	LspDiagnosticsConfig,
} from "./types.js";

export type { LinterAdapter } from "./adapters/types.js";

export interface LinterPipeline {
	runChecks(filePaths: string[]): Promise<CombinedValidationOutcome>;
	summarize(
		outcome: CombinedValidationOutcome,
		reportId: number,
	): ReturnType<typeof buildSummaryFirstLintMessage>;
	persist(report: string): Promise<LinterReportSidecarWriteResult>;
}

export interface LinterPipelineOptions {
	cwd: string;
	loadConfig?: (directory: string) => Promise<LinterConfig> | LinterConfig;
	config?: LinterConfig;
	lspConfig?: LspDiagnosticsConfig;
	lspContext?: import("../shared/lsp-service.js").LspServiceContext;
}

export interface TestLinterPipelineOptions {
	cwd: string;
	adapters: LinterAdapter[];
	loadConfig?: () => Promise<LinterConfig> | LinterConfig;
}

export function createLinterPipeline(
	options: LinterPipelineOptions | TestLinterPipelineOptions,
): LinterPipeline {
	const isTestMode = "adapters" in options;
	const cwd = options.cwd;

	async function loadConfig(): Promise<LinterConfig> {
		if (isTestMode) {
			return (await options.loadConfig?.()) ?? { ...DEFAULT_CONFIG };
		}
		if ("config" in options && options.config) {
			return options.config;
		}
		const loader = options.loadConfig ?? loadLinterConfig;
		return loader(cwd);
	}

	function getAdapters(config: LinterConfig): LinterAdapter[] {
		if (isTestMode) {
			return options.adapters;
		}
		return buildAdaptersFromConfig(
			config,
			options.lspConfig,
			options.lspContext,
		);
	}

	async function runChecks(
		filePaths: string[],
	): Promise<CombinedValidationOutcome> {
		const config = await loadConfig();
		const adapters = getAdapters(config);
		const filteredFiles = filePaths.filter(
			(f) => !isBuiltInIgnoredAgentArtifact(f),
		);

		const lspAdapter = adapters.find((a) => a.key === "lsp");
		const extensionAdapters = adapters.filter((a) => a.key !== "lsp");

		const groups = groupFilesByAdapter(
			filteredFiles,
			extensionAdapters,
			config,
		);

		const results = await Promise.all(
			Array.from(groups.entries()).map(async ([adapter, paths]) => {
				const outcome = await adapter.run(paths, cwd);
				return outcome;
			}),
		);

		if (lspAdapter) {
			const lspResult = await lspAdapter.run(filteredFiles, cwd);
			results.push(lspResult);
		}

		const merged = mergeValidationOutcomes({
			reportMode: config.reportMode ?? "auto-follow-up",
			results,
		});

		if (merged.kind !== "findings") {
			return merged;
		}

		const excerpts = await buildCodeExcerptSection(merged.report, cwd);
		return {
			...merged,
			report: excerpts ? `${merged.report}\n\n${excerpts}` : merged.report,
		};
	}

	function summarize(
		outcome: CombinedValidationOutcome,
		reportId: number,
	): ReturnType<typeof buildSummaryFirstLintMessage> {
		return buildSummaryFirstLintMessage({
			report: outcome.report,
			filesChecked: [],
			affectedFiles: outcome.affectedFiles,
			cwd,
			reportId,
			sidecar: null,
		});
	}

	async function persist(
		report: string,
	): Promise<LinterReportSidecarWriteResult> {
		return writeLinterReportSidecar({
			report,
			sessionId: deriveSessionId({
				sessionManager: { getSessionFile: () => null },
			}),
		});
	}

	return {
		runChecks,
		summarize,
		persist,
	};
}

function groupFilesByAdapter(
	filePaths: string[],
	adapters: LinterAdapter[],
	config: LinterConfig,
): Map<LinterAdapter, string[]> {
	const groups = new Map<LinterAdapter, string[]>();

	for (const filePath of filePaths) {
		const adapter = adapters.find((a) => adapterHandles(a, filePath, config));
		if (!adapter) continue;
		const group = groups.get(adapter) ?? [];
		group.push(filePath);
		groups.set(adapter, group);
	}

	return groups;
}

function adapterHandles(
	adapter: LinterAdapter,
	filePath: string,
	config: LinterConfig,
): boolean {
	const linter = getLinterForFile(filePath, config);
	if (!linter) return false;
	return adapter.key === definitionKey(linter);
}

function definitionKey(linter: LinterDefinition): string {
	if (linter.type === "api") return `api:${linter.name}`;
	const cli = linter as CliLinterDefinition;
	if (cli.mode === "project-root" || cli.mode === "workspace") {
		return `cli:${cli.command}:${cli.args.join(" ")}:mode=${cli.mode ?? "per-file"}:root=${cli.rootMarker ?? ""}`;
	}
	return `cli:${cli.command}:${cli.args.join(" ")}`;
}

function buildAdaptersFromConfig(
	config: LinterConfig,
	lspConfig?: LspDiagnosticsConfig,
	lspContext?: import("../shared/lsp-service.js").LspServiceContext,
): LinterAdapter[] {
	const seen = new Set<string>();
	const adapters: LinterAdapter[] = [];

	for (const linter of Object.values(config.linters)) {
		const key = definitionKey(linter);
		if (seen.has(key)) continue;
		seen.add(key);

		if (linter.type === "api" && linter.name === "markdownlint") {
			adapters.push(
				createMarkdownlintAdapter({
					runner: (linter as ApiLinterDefinition).runner,
				}),
			);
		} else if (linter.type === "cli") {
			adapters.push(
				createCliAdapter({
					linter,
					timeoutMs: config.timeoutMs,
				}),
			);
		}
	}

	if (lspConfig?.enabled && lspContext) {
		adapters.push(createLspAdapter({ config: lspConfig, ctx: lspContext }));
	}

	return adapters;
}

function isBuiltInIgnoredAgentArtifact(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return (
		/(?:^|\/)agent\/plans\/[^/]+\.md$/i.test(normalized) ||
		/(?:^|\/)agent\/plans\/archive\/[^/]+\.md$/i.test(normalized)
	);
}

export const __test__ = {
	groupFilesByAdapter,
	definitionKey,
	isBuiltInIgnoredAgentArtifact,
};
