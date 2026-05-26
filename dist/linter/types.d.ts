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
