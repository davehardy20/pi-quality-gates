import { type LinterReportSidecarMetadata, type RecoverReportSidecarOptions, type ReportRecoveryMode } from "../shared/report-sidecar.js";
export type { LinterReportSidecarMetadata, ParsedReportRecoveryArgs, ReportRecoveryMode as LinterReportRecoveryMode, } from "../shared/report-sidecar.js";
export { defaultReportSidecarDir as defaultLinterReportSidecarDir, deriveSessionId, parseReportRecoveryArgs, redactSecrets, } from "../shared/report-sidecar.js";
export { isQualityGatesSubAgentRuntime } from "../shared/runtime-detection.js";
export interface LinterReportSidecarWriteResult {
    ok: boolean;
    metadata: LinterReportSidecarMetadata;
    error?: string;
}
export interface LinterReportSidecarWriteOptions {
    report: string;
    sessionId?: string;
    sidecarDir?: string;
    now?: Date;
}
export interface LinterReportRecoveryOptions extends Omit<RecoverReportSidecarOptions, "mode"> {
    mode: ReportRecoveryMode;
}
export interface LinterReportRecoveryResult {
    mode: ReportRecoveryMode;
    content: string;
    metadata: LinterReportSidecarMetadata;
}
export interface ParsedLintFinding {
    filePath: string;
    displayPath: string;
    line: number;
    column?: number;
    linter: string;
    ruleId?: string;
    message: string;
    fix?: string;
    lowPriority: boolean;
}
export interface LinterReportSummaryDetails {
    reportId: number;
    checkedFileCount: number;
    affectedFileCount: number;
    affectedFiles: string[];
    linterNames: string[];
    totalFindings: number;
    visibleFindings: number;
    omittedFindings: number;
    lowPriorityFindings: number;
    maxFindings: number;
    maxFindingsPerFile: number;
    excerptsOmitted: boolean;
    sidecar?: LinterReportSidecarMetadata;
    sidecarError?: string;
    findings: ParsedLintFinding[];
}
export interface LinterReportSummaryResult {
    message: string;
    details: LinterReportSummaryDetails;
}
export declare function writeLinterReportSidecar(options: LinterReportSidecarWriteOptions): Promise<LinterReportSidecarWriteResult>;
export declare function recoverLinterReportSidecar(options: LinterReportRecoveryOptions & {
    allowFullWithoutAck?: boolean;
}): Promise<LinterReportRecoveryResult>;
export declare function buildSummaryFirstLintMessage(args: {
    report: string;
    filesChecked: string[];
    affectedFiles: string[];
    cwd: string;
    reportId: number;
    sidecar: LinterReportSidecarWriteResult | null;
    maxFindings?: number;
    maxFindingsPerFile?: number;
    maxChars?: number;
}): LinterReportSummaryResult;
