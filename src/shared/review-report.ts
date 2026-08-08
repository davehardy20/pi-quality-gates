// ── Review Report — parse reviewer output, render reports for display ──
//
// This module owns the report contract that sits between the reviewer
// subprocesses and the PR gate:
//   1. parseReviewReport — turn a reviewer child's structured text output into
//      a validated ReviewReport (the trust boundary that decides whether a HEAD
//      earns a PASS token).
//   2. formatReportForDisplay — render a parsed ReviewReport back to Markdown
//      for user-facing messages.
//
// Both reviewer bridges (host and orchestrator/sandbox) cross this seam. All
// parse* helpers, type guards, and escapeRegex below are private internals.

import type {
	Finding,
	ReviewConfidence,
	ReviewDomain,
	ReviewReport,
	ReviewStatus,
	Severity,
	TestExecutionStatus,
} from "./review-types.js";
import { diffCoveragePercent } from "./review-types.js";

/**
 * Parse the structured `## Review Report` block from the reviewer child output.
 * Returns null if parsing fails or the report block is not found.
 */
export function parseReviewReport(output: string): ReviewReport | null {
	if (!output?.trim()) return null;

	// Find the report block (case-insensitive, allowing leading whitespace)
	const reportMarker = /^\s*##\s+Review\s+Report\s*$/im;
	const reportMatch = output.match(reportMarker);
	if (!reportMatch) return null;

	const reportText = output.slice(reportMatch.index);

	const statusValue = parseReviewField(reportText, "STATUS");
	if (!isReviewStatus(statusValue)) return null;
	const status = statusValue;

	const confidenceValue = parseReviewField(reportText, "CONFIDENCE");
	const confidence = isReviewConfidence(confidenceValue)
		? confidenceValue
		: "LOW";

	// Parse Findings
	const findings = parseFindings(reportText);

	// Parse "What was verified"
	const verified = parseListSection(reportText, "What was verified");

	// Parse "What could not be verified"
	const notVerified = parseListSection(
		reportText,
		"What could not be verified",
	);

	const testExecution = parseTestExecutionSection(reportText);

	// Parse Summary — take everything between "### Summary" and the end (or next ## header)
	const summary = parseSummarySection(reportText);

	return {
		status,
		confidence,
		findings,
		verified,
		unverifiable: notVerified,
		...(testExecution ? { testExecution } : {}),
		summary,
	};
}

function parseReviewField(reportText: string, fieldName: string): string {
	const fieldPrefix = `${fieldName}:`;
	for (const line of reportText.split("\n")) {
		const normalized = line.replaceAll("**", "").trim().toUpperCase();
		if (normalized.startsWith(fieldPrefix)) {
			return normalized.slice(fieldPrefix.length).trim();
		}
	}
	return "";
}

function isReviewStatus(value: string): value is ReviewStatus {
	return value === "PASS" || value === "ISSUES" || value === "CANNOT_REVIEW";
}

function isReviewConfidence(value: string): value is ReviewConfidence {
	return value === "HIGH" || value === "MEDIUM" || value === "LOW";
}

/**
 * Parse individual findings from the report text.
 * Each finding starts with `#### [SEVERITY] description`.
 */
function parseFindings(reportText: string): Finding[] {
	const findings: Finding[] = [];

	// Match finding blocks: #### [SEVERITY] description
	const findingRegex = /^####\s*\[(CRITICAL|WARNING|NIT)\]\s*(.+)$/gm;
	const matches = [...reportText.matchAll(findingRegex)];

	for (const match of matches) {
		const severity = match[1] as Severity;
		const description = match[2].trim();
		const blockStart = (match.index ?? 0) + match[0].length;

		// Find the end of this finding block (next #### or ### or end)
		const remainingAfterStart = reportText.slice(blockStart);
		const nextFindingOrSection = remainingAfterStart.search(/^#{3,4}\s/m);
		const blockText =
			nextFindingOrSection !== -1
				? remainingAfterStart.slice(0, nextFindingOrSection)
				: remainingAfterStart;

		const rawFile = extractField(blockText, "File") || "";
		const { file, line } = parseFilePath(rawFile);
		findings.push({
			severity,
			title: description,
			file,
			line,
			domain:
				(extractField(blockText, "Category") as ReviewDomain) || "quality",
			rule: extractField(blockText, "Rule") || "",
			issue: extractField(blockText, "Issue") || "",
			evidence: extractField(blockText, "Evidence") || "",
			suggestion: extractField(blockText, "Suggestion") || "",
			...parseEffortField(extractField(blockText, "Effort")),
		});
	}

	// Handle "None." case
	if (findings.length === 0) {
		const noneMatch = reportText.match(/### Findings\s*\n\s*None\.\s*\n/i);
		if (noneMatch) return [];
	}

	return findings;
}

/**
 * Parse the optional Effort field of a finding.
 *
 * Accepts the reviewer's free-form effort estimate and normalizes it to a
 * whole number of minutes. Tolerates forms like `5`, `5min`, `5 min`,
 * `~5`, or `N/A`/`unknown`. Returns `{}` (no field) when the estimate is
 * absent or unparseable, keeping the schema field strictly optional, and
 * `{ effort: null }` only when the reviewer explicitly writes a blank/
 * not-applicable value.
 */
function parseEffortField(raw: string): { effort?: number | null } {
	if (!raw) return {};
	const normalized = raw.trim();
	const lower = normalized.toLowerCase();
	if (
		lower === "n/a" ||
		lower === "na" ||
		lower === "none" ||
		lower === "unknown"
	) {
		return { effort: null };
	}
	const match = normalized.match(/(-?\d+)/);
	if (!match) return { effort: null };
	const minutes = parseInt(match[1], 10);
	if (!Number.isFinite(minutes) || minutes < 0) return { effort: null };
	return { effort: minutes };
}

/**
 * Extract a bold-labeled field from a finding block.
 * E.g., `- **File:** path/to/file.ts:42` → "path/to/file.ts:42"
 */
function extractField(block: string, fieldName: string): string {
	const regex = new RegExp(`\\*\\*${fieldName}:\\*\\*\\s*(.+?)(?:\\n|$)`, "i");
	const match = block.match(regex);
	return match?.[1]?.trim() ?? "";
}

/**
 * Parse a list section (bullet points under a ### heading).
 * Returns an array of the bullet point contents.
 */
/**
 * Parse the file path from a File field value, stripping any line number suffix.
 * Returns the file path and optionally the line number.
 * E.g., "src/db.ts:42" → { file: "src/db.ts", line: 42 }
 * E.g., "src/style.ts" → { file: "src/style.ts", line: null }
 */
function parseFilePath(fileField: string): {
	file: string;
	line: number | null;
} {
	if (!fileField) return { file: "", line: null };
	const trimmed = fileField.trim();
	const lineMatch = trimmed.match(/:(\d+)\s*$/);
	if (lineMatch) {
		return {
			file: trimmed.slice(0, lineMatch.index),
			line: parseInt(lineMatch[1], 10),
		};
	}
	return { file: trimmed, line: null };
}
function parseListSection(reportText: string, heading: string): string[] {
	const section = parseSectionBody(reportText, heading);
	if (!section) return [];

	const items: string[] = [];
	for (const line of section.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("- ")) {
			items.push(trimmed.slice(2).trim());
		}
	}

	return items;
}

function parseSectionBody(reportText: string, heading: string): string {
	const headingRegex = new RegExp(`^###\\s+${escapeRegex(heading)}\\s*$`, "im");
	const headingMatch = headingRegex.exec(reportText);
	if (!headingMatch) return "";

	const afterHeading = reportText.slice(
		headingMatch.index + headingMatch[0].length,
	);
	const nextHeading = afterHeading.search(/^###\s+/m);
	return (
		nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)
	).trim();
}

function parseTestExecutionSection(
	reportText: string,
): ReviewReport["testExecution"] | undefined {
	const section = parseSectionBody(reportText, "Test execution");
	if (!section) return undefined;

	const statusValue = parseMarkdownField(section, "Status").toUpperCase();
	const status = isTestExecutionStatus(statusValue) ? statusValue : "NOT_RUN";
	const summary = parseMarkdownField(section, "Summary") || section.trim();
	const sidecarRef = parseMarkdownField(section, "Sidecar");

	return {
		status,
		summary,
		...(sidecarRef ? { sidecarRef } : {}),
	};
}

function parseMarkdownField(block: string, fieldName: string): string {
	const fieldPrefix = `${fieldName}:`.toUpperCase();
	for (const line of block.split("\n")) {
		const normalized = line.replaceAll("**", "").trim().replace(/^-\s*/, "");
		if (normalized.toUpperCase().startsWith(fieldPrefix)) {
			return normalized.slice(fieldPrefix.length).trim();
		}
	}
	return "";
}

function isTestExecutionStatus(value: string): value is TestExecutionStatus {
	return value === "PASS" || value === "FAIL" || value === "NOT_RUN";
}

/**
 * Parse the Summary section (free text after "### Summary").
 */
function parseSummarySection(reportText: string): string {
	const match = reportText.match(/^###\s+Summary\s*\n([\s\S]*?)$/m);
	if (!match) return "";

	const text = match[1].trim();
	// Trim to first ## header if present
	const nextHeader = text.search(/^##\s/m);
	return nextHeader !== -1 ? text.slice(0, nextHeader).trim() : text;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Escape special regex characters.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Format a report for display to the user.
 */
export function formatReportForDisplay(report: ReviewReport): string {
	const lines: string[] = [];

	lines.push(`**Review: ${report.status}** (confidence: ${report.confidence})`);
	lines.push("");

	if (report.findings.length > 0) {
		lines.push("### Findings");
		lines.push("");
		for (const f of report.findings) {
			const loc = f.line != null ? `${f.file}:${f.line}` : (f.file ?? "");
			lines.push(`- **[${f.severity}]** ${f.title} \`${loc}\``);
			if (f.effort != null) {
				lines.push(`  - ⏱ ~${f.effort} min to fix`);
			}
			if (f.suggestion) {
				lines.push(`  - 💡 ${f.suggestion}`);
			}
		}
		lines.push("");
	}

	if (report.testExecution) {
		lines.push("### Test execution");
		lines.push("");
		lines.push(`- **Status:** ${report.testExecution.status}`);
		lines.push(`- **Summary:** ${report.testExecution.summary}`);
		if (report.testExecution.sidecarRef) {
			lines.push(`- **Sidecar:** ${report.testExecution.sidecarRef}`);
		}
		lines.push("");
	}

	if (report.diffCoverage) {
		lines.push("### Diff coverage");
		lines.push("");
		const pct = diffCoveragePercent(report.diffCoverage);
		lines.push(
			`- **Coverage:** ${pct}% (${report.diffCoverage.truncated ? "truncated — PARTIAL review" : "complete"})`,
		);
		if (report.diffCoverage.truncated) {
			lines.push(
				`- **Omitted:** ${report.diffCoverage.omittedLines} lines (cap ${report.diffCoverage.maxLines})`,
			);
		}
		lines.push("");
	}

	if (report.summary) {
		lines.push(report.summary);
	}

	return lines.join("\n");
}
