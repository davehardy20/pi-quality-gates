import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type {
	LinterReportRecoveryMode,
	LinterReportRecoveryOptions,
	LinterReportRecoveryResult,
	ParsedReportRecoveryArgs,
} from "../linter/report-hygiene.js";
import {
	defaultLinterReportSidecarDir,
	deriveSessionId,
	isQualityGatesSubAgentRuntime,
	parseReportRecoveryArgs,
	redactSecrets,
} from "../linter/report-hygiene.js";
import type { ReviewReport } from "./types.js";

export type {
	LinterReportRecoveryMode as ReviewerReportRecoveryMode,
	ParsedReportRecoveryArgs,
};
export {
	deriveSessionId,
	isQualityGatesSubAgentRuntime,
	parseReportRecoveryArgs,
};

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

export interface ReviewerReportRecoveryOptions
	extends Omit<LinterReportRecoveryOptions, "mode"> {
	mode: LinterReportRecoveryMode;
}

export interface ReviewerReportRecoveryResult
	extends Omit<LinterReportRecoveryResult, "metadata"> {
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

interface PersistedReviewerReportSidecar {
	metadata: ReviewerReportSidecarMetadata;
	content: string;
}

const DEFAULT_MAX_REVIEWER_FINDINGS = 12;
const DEFAULT_REVIEWER_SUMMARY_MAX_CHARS = 6000;
const DEFAULT_PREVIEW_CHARS = 2000;
const DEFAULT_SLICE_CHARS = 4000;
const MAX_SINGLE_SIDECAR_BYTES = 10 * 1024 * 1024;

export function defaultReviewerReportSidecarDir(): string {
	return defaultLinterReportSidecarDir();
}

export async function writeReviewerReportSidecar(options: {
	report: string;
	sessionId?: string;
	sidecarDir?: string;
	now?: Date;
}): Promise<ReviewerReportSidecarWriteResult> {
	const now = options.now ?? new Date();
	const id = randomUUID();
	const sessionId = sanitizePathPart(options.sessionId ?? "default-session");
	const root = resolve(options.sidecarDir ?? defaultReviewerReportSidecarDir());
	const dir = join(root, sessionId);
	const filePath = join(dir, `${id}.json`);
	const redacted = redactSecrets(options.report);
	const metadata: ReviewerReportSidecarMetadata = {
		id,
		toolName: "post-turn-reviewer",
		sessionId,
		path: filePath,
		createdAt: now.toISOString(),
		originalChars: options.report.length,
		originalBytes: byteLength(options.report),
		redactedChars: redacted.length,
		redactedBytes: byteLength(redacted),
		originalSha256: sha256(options.report),
		redactedSha256: sha256(redacted),
		summaryMode: "post-turn-reviewer-summary",
	};

	if (metadata.redactedBytes > MAX_SINGLE_SIDECAR_BYTES) {
		return {
			ok: false,
			metadata: {
				...metadata,
				failureState: "record_exceeds_max_single_record_bytes",
			},
			error: "redacted reviewer report exceeds max single sidecar size",
		};
	}

	try {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const payload: PersistedReviewerReportSidecar = {
			metadata,
			content: redacted,
		};
		const tempPath = join(dir, `.${id}.${process.pid}.tmp`);
		await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.rename(tempPath, filePath);
		return { ok: true, metadata };
	} catch (error) {
		return {
			ok: false,
			metadata: { ...metadata, failureState: "write_failed" },
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function recoverReviewerReportSidecar(
	options: ReviewerReportRecoveryOptions,
): Promise<ReviewerReportRecoveryResult> {
	const raw = await fs.readFile(options.recordPath, "utf8");
	const persisted = JSON.parse(raw) as PersistedReviewerReportSidecar;
	const content = persisted.content;
	const previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;

	if (options.mode === "metadata") {
		return {
			mode: options.mode,
			content: JSON.stringify(persisted.metadata, null, 2),
			metadata: persisted.metadata,
		};
	}

	if (options.mode === "full") {
		if (!options.acknowledgeContextCost) {
			throw new Error(
				"full reviewer report recovery requires --ack-context-cost; use preview or slice first",
			);
		}
		return { mode: options.mode, content, metadata: persisted.metadata };
	}

	if (options.mode === "slice") {
		const offset = Math.max(0, options.offset ?? 0);
		const requestedLength = Math.max(1, options.length ?? DEFAULT_SLICE_CHARS);
		const length = Math.min(requestedLength, DEFAULT_SLICE_CHARS);
		const slice = content.slice(offset, offset + length);
		return {
			mode: options.mode,
			content: [
				`reviewer report slice offset=${offset} length=${slice.length}/${content.length} (cap ${DEFAULT_SLICE_CHARS})`,
				"",
				slice,
			].join("\n"),
			metadata: persisted.metadata,
		};
	}

	const preview = content.slice(0, previewChars);
	const suffix =
		content.length > preview.length
			? `\n\n[preview truncated: ${content.length - preview.length} more character(s); use /reviewer-report slice --offset=${preview.length} --length=${DEFAULT_SLICE_CHARS} or full --ack-context-cost]`
			: "";
	return {
		mode: options.mode,
		content: `${preview}${suffix}`,
		metadata: persisted.metadata,
	};
}

export function buildSummaryFirstReviewerMessage(args: {
	report: ReviewReport;
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

function sanitizePathPart(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
	return sanitized.length > 0 ? sanitized : "default-session";
}

function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function byteLength(input: string): number {
	return Buffer.byteLength(input, "utf8");
}

function formatLocation(file: string, line?: number | null): string {
	return line ? `${file}:${line}` : file;
}

function truncateText(input: string, maxChars: number): string {
	if (input.length <= maxChars) return input;
	return `${input.slice(0, Math.max(0, maxChars - 1))}…`;
}

function capText(input: string, maxChars: number): string {
	if (input.length <= maxChars) return input;
	return `${input.slice(0, Math.max(0, maxChars - 120))}\n\n[reviewer summary truncated to ${maxChars} chars; recover sidecar preview/slice for more]`;
}
