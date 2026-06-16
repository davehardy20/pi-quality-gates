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
	/** 1–3 sentence overall assessment */
	summary: string;
}
