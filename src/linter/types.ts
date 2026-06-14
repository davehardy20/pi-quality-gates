export type ValidationKind = "clean" | "findings" | "tool-error";

export interface ValidationOutcome {
	kind: ValidationKind;
	report: string;
	affectedFiles: string[];
	signature: string;
}

export type ReportMode = "report-only" | "auto-follow-up";

export interface CombinedValidationOutcome extends ValidationOutcome {
	reportMode: ReportMode;
}

export interface LspDiagnosticsConfig {
	enabled?: boolean;
	settleMs?: number;
	timeoutMs?: number;
	minSeverity?: "error" | "warning" | "info" | "hint";
	extensions?: string[];
	maxFilesPerWorkspace?: number;
}

export type QualityGatesRuntimeMode = "auto" | "parent" | "sub-agent";

export type ApiLinterRunner = (
	filePaths: string[],
	config?: unknown,
) => Promise<LinterResult>;

export type LintOutcomeKind = ValidationKind;

export interface LinterResult {
	kind: LintOutcomeKind;
	output: string;
	fileCount: number;
	affectedFiles: string[];
	name: string;
}

export interface CliLinterDefinition {
	type: "cli";
	command: string;
	args: string[];
	name: string;
	/**
	 * `"per-file"` (default) — runs once per batch of files, appending file paths to args.
	 * `"workspace"` — runs once per discovered project root; does not append files.
	 *   Project root is discovered by walking up from modified files looking for
	 *   `Cargo.toml`, `package.json`, `.tflint.hcl`, or `.git`.
	 * `"project-root"` — runs once per explicit `rootMarker`; does not append files.
	 */
	mode?: "per-file" | "workspace" | "project-root";
	rootMarker?: string;
}

export interface ApiLinterDefinition {
	type: "api";
	name: string;
	runner: ApiLinterRunner;
}

export type LinterDefinition = CliLinterDefinition | ApiLinterDefinition;

export interface MarkdownlintConfig {
	default?: boolean;
	[ruleName: string]: unknown;
}

export interface LinterConfig {
	linters: Record<string, LinterDefinition>;
	cooldownMs?: number;
	timeoutMs?: number;
	reportMode?: ReportMode;
	runtimeMode?: QualityGatesRuntimeMode;
	lsp?: LspDiagnosticsConfig;
}
