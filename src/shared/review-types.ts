/**
 * Shared review report schema.
 *
 * Used by both the post-turn reviewer and the PR pre-push review gate.
 * Keeping these types in one place guarantees that the reviewer child,
 * the report parser, and the gate decision core all speak the same shape.
 */

/** Finding severity levels, ordered from most to least urgent. */
export type Severity = "CRITICAL" | "WARNING" | "NIT";

/** Review status reported by the reviewer child. */
export type ReviewStatus = "PASS" | "ISSUES" | "CANNOT_REVIEW";

/** Confidence level of the review. */
export type ReviewConfidence = "HIGH" | "MEDIUM" | "LOW";

/** Which severity levels trigger an automatic fix-up turn. */
export type AutoFixThreshold = "critical" | "warning" | "none";

/** The 7-domain review checklist categories. */
export type ReviewDomain =
	| "task-completion"
	| "correctness"
	| "error-handling"
	| "security"
	| "quality"
	| "testing"
	| "documentation";

/** A single review finding with full traceability. */
export interface Finding {
	/** CRITICAL | WARNING | NIT */
	severity: Severity;
	/** Short human-readable title */
	title: string;
	/** File path (without line number suffix) */
	file: string;
	/** Optional line number within the file */
	line?: number | null;
	/** Which of the 7 review domains this belongs to */
	domain: ReviewDomain;
	/** Specific checklist rule that was violated */
	rule: string;
	/** What is wrong, specifically */
	issue: string;
	/** Relevant code excerpt */
	evidence: string;
	/** Concrete fix suggestion, may include code */
	suggestion: string;
	/**
	 * Estimated effort to address this finding, in minutes. Optional; when the
	 * reviewer omits it, this is `undefined` (or `null` if explicitly blank).
	 * Lets the gate and downstream tooling prioritise findings by fix cost.
	 */
	effort?: number | null;
}

export type TestExecutionStatus = "PASS" | "FAIL" | "NOT_RUN";

export interface TestExecutionSummary {
	/** Overall result of review-time validation commands. */
	status: TestExecutionStatus;
	/** Bounded synthesis of the validation output, not raw logs. */
	summary: string;
	/** Optional sidecar/tool-output reference for full logs. */
	sidecarRef?: string;
}

/**
 * How much of the changed-lines diff was actually fed to the reviewer.
 *
 * NOT authored by the reviewer child: the dispatcher / `gatherDiff` compute it
 * and attach it to the {@link ReviewReport} so the PR-gate verdict can tell a
 * truncated (PARTIAL) review apart from a fully-reviewed one. A truncated diff
 * must never yield a verdict indistinguishable from a full PASS.
 */
export interface DiffCoverage {
	/** True when the raw diff exceeded `maxLines` and lines were dropped. */
	truncated: boolean;
	/** Number of raw diff lines dropped to meet `maxLines`. */
	omittedLines: number;
	/** The line cap applied to the raw diff (`config.maxDiffLines`). */
	maxLines: number;
}

/**
 * Percentage of the raw diff that was actually reviewed (0–100, rounded).
 *
 * When not truncated this is 100%; when truncated it reflects `maxLines` as a
 * share of the full raw line count (`maxLines + omittedLines`). Used to surface
 * PARTIAL coverage in the review report and the PR-gate message.
 */
export function diffCoveragePercent(coverage: DiffCoverage): number {
	const total = coverage.maxLines + coverage.omittedLines;
	if (total <= 0) return 100;
	return Math.round((coverage.maxLines / total) * 100);
}

/** Structured report parsed from the reviewer child's output. */
export interface ReviewReport {
	/** Overall status: PASS | ISSUES | CANNOT_REVIEW */
	status: ReviewStatus;
	/** How confident the reviewer is in the assessment */
	confidence: ReviewConfidence;
	/** All findings (may be empty for PASS) */
	findings: Finding[];
	/** Claims the reviewer verified with evidence */
	verified: string[];
	/** Claims the reviewer could not verify, with reasons */
	unverifiable: string[];
	/** Review-time validation results, when the reviewer reports them. */
	testExecution?: TestExecutionSummary;
	/**
	 * Diff coverage (truncation signal). Attached by the dispatcher / reviewer
	 * execution after parsing — not produced by the reviewer child. Drives the
	 * PARTIAL verdict when `truncated` is true.
	 */
	diffCoverage?: DiffCoverage;
	/** 1–3 sentence overall assessment */
	summary: string;
}
