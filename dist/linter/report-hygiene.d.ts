import type { QualityGatesRuntimeMode } from "./types.js";
export type LinterReportRecoveryMode = "metadata" | "preview" | "slice" | "full";
export interface LinterReportSidecarMetadata {
    id: string;
    toolName: "post-turn-linter";
    sessionId: string;
    path: string;
    createdAt: string;
    originalChars: number;
    originalBytes: number;
    redactedChars: number;
    redactedBytes: number;
    originalSha256: string;
    redactedSha256: string;
    summaryMode: "post-turn-linter-summary";
    failureState?: string;
}
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
export interface LinterReportRecoveryOptions {
    recordPath: string;
    mode: LinterReportRecoveryMode;
    acknowledgeContextCost?: boolean;
    allowFullWithoutAck?: boolean;
    offset?: number;
    length?: number;
    previewChars?: number;
}
export interface LinterReportRecoveryResult {
    mode: LinterReportRecoveryMode;
    content: string;
    metadata: LinterReportSidecarMetadata;
}
export interface ParsedReportRecoveryArgs {
    mode: LinterReportRecoveryMode;
    acknowledgeContextCost: boolean;
    offset: number;
    length: number;
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
export declare function isQualityGatesSubAgentRuntime(env?: Record<string, string | undefined>, mode?: QualityGatesRuntimeMode): boolean;
export declare function defaultLinterReportSidecarDir(): string;
export declare function redactSecrets(input: string): string;
export declare function deriveSessionId(ctx: {
    sessionManager?: {
        getSessionFile?: () => string | null | undefined;
    };
}): string;
export declare function writeLinterReportSidecar(options: LinterReportSidecarWriteOptions): Promise<LinterReportSidecarWriteResult>;
export declare function recoverLinterReportSidecar(options: LinterReportRecoveryOptions): Promise<LinterReportRecoveryResult>;
export declare function parseReportRecoveryArgs(args: string | undefined): ParsedReportRecoveryArgs;
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
