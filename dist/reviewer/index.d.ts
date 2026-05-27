/**
 * Post-Turn Reviewer — Extension entry point
 *
 * Lifecycle hooks (session_start, turn_end), state machine, and commands.
 * Coordinates with the post-turn-linter via session-scoped status messages.
 *
 * State machine:
 *   IDLE → GATHERING → REVIEWING → FIX_REQUESTED → RE_REVIEWING → IDLE
 *
 * Commands:
 *   /reviewer-status  — Show current reviewer state
 *   /reviewer-run     — Manually trigger a review
 *   /reviewer-model   — Switch review model mid-session
 *   /reviewer-toggle  — Enable or disable the reviewer
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ReviewerReportSidecarWriteResult } from "./report-hygiene.js";
import type { AutoFixThreshold, ReviewConfig, ReviewerState, ReviewReport, Severity } from "./types.js";
declare function severityMeetsThreshold(severity: Severity, threshold: AutoFixThreshold): boolean;
declare function formatPhaseStatus(state: ReviewerState, config: ReviewConfig): string;
declare function formatAdvisoryMessage(report: ReviewReport, sidecar?: ReviewerReportSidecarWriteResult | null): string;
declare function formatFixUpMessage(report: ReviewReport, sidecar?: ReviewerReportSidecarWriteResult | null): string;
declare function formatEscalationMessage(report: ReviewReport, loopCount: number, sidecar?: ReviewerReportSidecarWriteResult | null): string;
declare function buildReviewerTranscriptSidecarContent(rawOutput: string, stderr: string): string;
declare function createInitialState(config: ReviewConfig): ReviewerState;
export default function postTurnReviewerExtension(pi: ExtensionAPI): void;
export declare const __test__: {
    createInitialState: typeof createInitialState;
    severityMeetsThreshold: typeof severityMeetsThreshold;
    formatPhaseStatus: typeof formatPhaseStatus;
    formatAdvisoryMessage: typeof formatAdvisoryMessage;
    formatFixUpMessage: typeof formatFixUpMessage;
    formatEscalationMessage: typeof formatEscalationMessage;
    buildReviewerTranscriptSidecarContent: typeof buildReviewerTranscriptSidecarContent;
    LINTER_STATUS_CUSTOM_TYPE: string;
};
export {};
