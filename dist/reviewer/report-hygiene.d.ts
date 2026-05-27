import type { LinterReportRecoveryMode, LinterReportRecoveryOptions, LinterReportRecoveryResult, ParsedReportRecoveryArgs } from "../linter/report-hygiene.js";
import { deriveSessionId, isQualityGatesSubAgentRuntime, parseReportRecoveryArgs } from "../linter/report-hygiene.js";
import type { ReviewReport } from "./types.js";
export type { LinterReportRecoveryMode as ReviewerReportRecoveryMode, ParsedReportRecoveryArgs, };
export { deriveSessionId, isQualityGatesSubAgentRuntime, parseReportRecoveryArgs, };
export interface ReviewerReportSidecarMetadata {
    id: string;
    toolName: "post-turn-reviewer";
    sessionId: string;
    path: string;
    createdAt: string;
    originalChars: number;
    originalBytes: number;
    redactedChars: number;
    redactedBytes: number;
    originalSha256: string;
    redactedSha256: string;
    summaryMode: "post-turn-reviewer-summary";
    failureState?: string;
}
export interface ReviewerReportSidecarWriteResult {
    ok: boolean;
    metadata: ReviewerReportSidecarMetadata;
    error?: string;
}
export interface ReviewerReportRecoveryOptions extends Omit<LinterReportRecoveryOptions, "mode"> {
    mode: LinterReportRecoveryMode;
}
export interface ReviewerReportRecoveryResult extends Omit<LinterReportRecoveryResult, "metadata"> {
    metadata: ReviewerReportSidecarMetadata;
}
export interface ReviewerReportSummaryResult {
    message: string;
    details: {
        status: ReviewReport["status"];
        confidence: ReviewReport["confidence"];
        totalFindings: number;
        visibleFindings: number;
        omittedFindings: number;
        sidecar?: ReviewerReportSidecarMetadata;
        sidecarError?: string;
    };
}
export declare function defaultReviewerReportSidecarDir(): string;
export declare function writeReviewerReportSidecar(options: {
    report: string;
    sessionId?: string;
    sidecarDir?: string;
    now?: Date;
}): Promise<ReviewerReportSidecarWriteResult>;
export declare function recoverReviewerReportSidecar(options: ReviewerReportRecoveryOptions): Promise<ReviewerReportRecoveryResult>;
export declare function buildSummaryFirstReviewerMessage(args: {
    report: ReviewReport;
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
