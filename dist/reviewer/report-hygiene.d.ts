import { type RecoverReportSidecarOptions, type ReportRecoveryMode, type ReviewerReportSidecarMetadata } from "../shared/report-sidecar.js";
export type { ParsedReportRecoveryArgs, ReportRecoveryMode as ReviewerReportRecoveryMode, ReviewerReportSidecarMetadata, } from "../shared/report-sidecar.js";
export { defaultReportSidecarDir as defaultReviewerReportSidecarDir, deriveSessionId, parseReportRecoveryArgs, redactSecrets, } from "../shared/report-sidecar.js";
export { isQualityGatesSubAgentRuntime } from "../shared/runtime-detection.js";
export interface ReviewerReportSidecarWriteResult {
    ok: boolean;
    metadata: ReviewerReportSidecarMetadata;
    error?: string;
}
export interface ReviewerReportSidecarWriteOptions {
    report: string;
    sessionId?: string;
    sidecarDir?: string;
    now?: Date;
}
export interface ReviewerReportRecoveryOptions extends Omit<RecoverReportSidecarOptions, "mode"> {
    mode: ReportRecoveryMode;
}
export interface ReviewerReportRecoveryResult {
    mode: ReportRecoveryMode;
    content: string;
    metadata: ReviewerReportSidecarMetadata;
}
export interface ReviewerReportSummaryResult {
    message: string;
    details: {
        status: import("./types.js").ReviewReport["status"];
        confidence: import("./types.js").ReviewReport["confidence"];
        totalFindings: number;
        visibleFindings: number;
        omittedFindings: number;
        sidecar?: ReviewerReportSidecarMetadata;
        sidecarError?: string;
    };
}
export declare function writeReviewerReportSidecar(options: ReviewerReportSidecarWriteOptions): Promise<ReviewerReportSidecarWriteResult>;
export declare function recoverReviewerReportSidecar(options: ReviewerReportRecoveryOptions): Promise<ReviewerReportRecoveryResult>;
export declare function buildSummaryFirstReviewerMessage(args: {
    report: import("./types.js").ReviewReport;
    sidecar: ReviewerReportSidecarWriteResult | null;
    maxFindings?: number;
    maxChars?: number;
    title?: string;
}): ReviewerReportSummaryResult;
export declare function buildBoundedReviewerFailureMessage(args: {
    title: string;
    rawOutput?: string;
    stderr?: string;
    sidecar: ReviewerReportSidecarWriteResult | null;
    maxChars?: number;
    hints?: string[];
}): string;
