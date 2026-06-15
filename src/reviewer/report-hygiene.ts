import {
	capText,
	type RecoverReportSidecarOptions,
	type ReportRecoveryMode,
	type ReviewerReportSidecarMetadata,
	recoverReportSidecar,
	redactSecrets,
	truncateText,
	writeReportSidecar,
} from "../shared/report-sidecar.js";

export type {
	ParsedReportRecoveryArgs,
	ReportRecoveryMode as ReviewerReportRecoveryMode,
	ReviewerReportSidecarMetadata,
} from "../shared/report-sidecar.js";
// Re-export shared helpers so existing callers keep working.
export {
	defaultReportSidecarDir as defaultReviewerReportSidecarDir,
	deriveSessionId,
	parseReportRecoveryArgs,
	redactSecrets,
} from "../shared/report-sidecar.js";
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

export interface ReviewerReportRecoveryOptions
	extends Omit<RecoverReportSidecarOptions, "mode"> {
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

const DEFAULT_MAX_REVIEWER_FINDINGS = 12;
const DEFAULT_REVIEWER_SUMMARY_MAX_CHARS = 6000;
const DEFAULT_PREVIEW_CHARS = 2000;

export async function writeReviewerReportSidecar(
	options: ReviewerReportSidecarWriteOptions,
): Promise<ReviewerReportSidecarWriteResult> {
	return writeReportSidecar<ReviewerReportSidecarMetadata>({
		report: options.report,
		toolName: "post-turn-reviewer",
		summaryMode: "post-turn-reviewer-summary",
		sessionId: options.sessionId,
		sidecarDir: options.sidecarDir,
		now: options.now,
	});
}

export async function recoverReviewerReportSidecar(
	options: ReviewerReportRecoveryOptions,
): Promise<ReviewerReportRecoveryResult> {
	return recoverReportSidecar<ReviewerReportSidecarMetadata>({
		recordPath: options.recordPath,
		mode: options.mode,
		acknowledgeContextCost: options.acknowledgeContextCost,
		offset: options.offset,
		length: options.length,
		previewChars: options.previewChars ?? DEFAULT_PREVIEW_CHARS,
		reportLabel: "reviewer",
		commandName: "/reviewer-report",
	});
}

export function buildSummaryFirstReviewerMessage(args: {
	report: import("./types.js").ReviewReport;
	sidecar: ReviewerReportSidecarWriteResult | null;
	maxFindings?: number;
	maxChars?: number;
	title?: string;
}): ReviewerReportSummaryResult {
	const maxFindings = args.maxFindings ?? DEFAULT_MAX_REVIEWER_FINDINGS;
	const maxChars = args.maxChars ?? DEFAULT_REVIEWER_SUMMARY_MAX_CHARS;
	const selectedFindings = args.report.findings.slice(0, maxFindings);
	const omittedFindings = Math.max(
		0,
		args.report.findings.length - selectedFindings.length,
	);

	const lines = [
		args.title ?? "Post-turn reviewer completed: actionable summary.",
		`Status: ${args.report.status} | Confidence: ${args.report.confidence}.`,
		`Summary caps: showing ${selectedFindings.length} of ${args.report.findings.length} finding(s) (max ${maxFindings}).`,
	];

	if (args.sidecar?.ok) {
		lines.push(
			`Full redacted reviewer transcript sidecar: ${args.sidecar.metadata.id} (${args.sidecar.metadata.redactedChars} chars).`,
			"Recover manually with /reviewer-report preview, /reviewer-report slice --offset=0 --length=4000, or /reviewer-report full --ack-context-cost.",
		);
	} else {
		const error = args.sidecar?.error ?? "sidecar unavailable";
		lines.push(
			`Full reviewer transcript sidecar unavailable (${truncateText(error, 160)}); raw transcript omitted from parent context.`,
		);
	}

	if (args.report.summary) {
		lines.push(
			"",
			`Reviewer summary: ${truncateText(args.report.summary, 600)}`,
		);
	}

	lines.push("", "Actionable findings:");
	if (selectedFindings.length === 0) {
		lines.push("- No actionable findings reported.");
	} else {
		for (const finding of selectedFindings) {
			lines.push(
				`- [${finding.severity}] ${formatLocation(finding.file, finding.line)} — ${finding.title}`,
				`  Issue: ${truncateText(finding.issue, 500)}`,
				`  Rationale/evidence: ${truncateText(finding.evidence, 500)}`,
				`  Required fix/suggestion: ${truncateText(finding.suggestion, 500)}`,
			);
		}
	}

	if (omittedFindings > 0) {
		lines.push(
			"",
			`Omitted from parent context: ${omittedFindings} finding(s) omitted by caps.`,
		);
	}
	lines.push(
		"Fix the listed findings first. Recover only the needed sidecar preview/slice before requesting the full transcript.",
	);

	const message = capText(redactSecrets(lines.join("\n")), maxChars);
	return {
		message,
		details: {
			status: args.report.status,
			confidence: args.report.confidence,
			totalFindings: args.report.findings.length,
			visibleFindings: selectedFindings.length,
			omittedFindings,
			sidecar: args.sidecar?.ok ? args.sidecar.metadata : undefined,
			sidecarError: args.sidecar?.ok ? undefined : args.sidecar?.error,
		},
	};
}

export function buildBoundedReviewerFailureMessage(args: {
	title: string;
	rawOutput?: string;
	stderr?: string;
	sidecar: ReviewerReportSidecarWriteResult | null;
	maxChars?: number;
	hints?: string[];
}): string {
	const maxChars = args.maxChars ?? DEFAULT_REVIEWER_SUMMARY_MAX_CHARS;
	const lines = [args.title];
	if (args.rawOutput !== undefined) {
		lines.push(
			`Raw output length: ${args.rawOutput.length} chars (omitted from parent context).`,
		);
	}
	if (args.stderr !== undefined) {
		lines.push(
			`Stderr length: ${args.stderr.length} chars (omitted from parent context).`,
		);
	}
	if (args.sidecar?.ok) {
		lines.push(
			`Full redacted reviewer transcript sidecar: ${args.sidecar.metadata.id} (${args.sidecar.metadata.redactedChars} chars).`,
			"Recover with /reviewer-report preview, /reviewer-report slice --offset=0 --length=4000, or /reviewer-report full --ack-context-cost.",
		);
	} else {
		const error = args.sidecar?.error ?? "sidecar unavailable";
		lines.push(
			`Full transcript sidecar unavailable (${truncateText(error, 160)}).`,
		);
	}
	if (args.hints?.length)
		lines.push(...args.hints.map((hint) => `Hint: ${hint}`));
	return capText(redactSecrets(lines.join("\n")), maxChars);
}

function formatLocation(file: string, line?: number | null): string {
	return line ? `${file}:${line}` : file;
}
