// ── Shared types for the post-turn-reviewer extension ──────────────────
// Consumed by reviewer.ts, index.ts, config.ts, and tests.

// ── Severity ───────────────────────────────────────────────────────────

/** Finding severity levels, ordered from most to least urgent. */
export type Severity = "CRITICAL" | "WARNING" | "NIT";

/** Review status reported by the reviewer child. */
export type ReviewStatus = "PASS" | "ISSUES" | "CANNOT_REVIEW";

/** Confidence level of the review. */
export type ReviewConfidence = "HIGH" | "MEDIUM" | "LOW";

/** Which severity levels trigger an automatic fix-up turn. */
export type AutoFixThreshold = "critical" | "warning" | "none";

/** Reviewer state machine phases. */
export type ReviewerPhase =
	| "IDLE"
	| "GATHERING"
	| "REVIEWING"
	| "FIX_REQUESTED"
	| "RE_REVIEWING";

// ── Review Domains ─────────────────────────────────────────────────────

/** The 7-domain review checklist categories. */
export type ReviewDomain =
	| "task-completion"
	| "correctness"
	| "error-handling"
	| "security"
	| "quality"
	| "testing"
	| "documentation";

// ── Finding ────────────────────────────────────────────────────────────

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

// ── ReviewReport ───────────────────────────────────────────────────────

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

// ── ReviewConfig ───────────────────────────────────────────────────────

/** Configuration loaded from .pi/reviewer.config.json with defaults. */
export interface ReviewConfig {
	/** Model override for the reviewer (null = use session model) */
	model: string | null;
	/** Minimum changed lines to trigger a review */
	minChangedLines: number;
	/** Whether the reviewer is enabled */
	enabled: boolean;
	/** Max re-review passes after the main agent fixes issues (0 = report only) */
	maxReReviewPasses: number;
	/** Which severity levels trigger a fix-up turn */
	autoFixThreshold: AutoFixThreshold;
	/** Max tokens for the reviewer child */
	maxTokens: number;
	/** Timeout for the reviewer child in ms */
	timeoutMs: number;
	/** Tools available to the reviewer child */
	tools: string[];
	/** Bash command allowlist patterns (read-only enforcement) */
	allowedBashPatterns: string[];
	/** Whether to respect .gitignore when gathering diffs */
	respectGitignore: boolean;
	/** Path to a skip file (.gitignore format), relative to project root */
	skipFile: string | null;
	/** Whether to allow Tier 2 test discovery commands */
	allowTestDiscovery: boolean;
	/** Per-ecosystem test discovery commands */
	testDiscoveryCommands: Record<string, string[]>;
	/** Max diff lines before truncation */
	maxDiffLines: number;
	/** Max changed lines before skipping review entirely (cost guard). -1 = no limit. */
	maxChangedLines: number;
	/** Delay in ms before triggering a review after linter goes clean.
	 *  This debounces reviews so the main agent can finish multi-step work
	 *  before the reviewer interrupts. 0 = immediate (legacy behavior). */
	reviewDelayMs: number;
}

/** Sensible defaults used when config fields are missing. */
export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
	model: null,
	minChangedLines: 5,
	enabled: true,
	maxReReviewPasses: 1,
	autoFixThreshold: "critical",
	maxTokens: 8192,
	timeoutMs: 120_000,
	tools: ["read", "grep", "find", "ls", "bash"],
	allowedBashPatterns: [
		"cat",
		"head",
		"tail",
		"wc",
		"diff",
		"git diff*",
		"git log*",
		"git show*",
		"git blame",
		"git status",
		"jq",
		"rg",
		"grep",
		"find",
		"ls",
		"file",
		"stat",
		"cargo test --no-run",
		"npm test --dry-run",
		"pytest --collect-only",
		"go test -list .*",
	],
	respectGitignore: true,
	skipFile: ".pi/reviewer.skip",
	allowTestDiscovery: false,
	testDiscoveryCommands: {
		python: ["pytest --collect-only -q"],
		rust: ["cargo test --no-run"],
		go: ["go test -list ."],
		typescript: ["npx jest --listTests"],
		javascript: ["npx jest --listTests"],
	},
	maxDiffLines: 500,
	maxChangedLines: 500,
	reviewDelayMs: 10_000,
};

export interface ReviewerReportSidecarRef {
	id: string;
	path: string;
	redactedChars: number;
}

// ── ReviewerState ──────────────────────────────────────────────────────

/** Mutable state tracked across the session lifecycle. */
export interface ReviewerState {
	/** Current phase in the state machine */
	phase: ReviewerPhase;
	/** How many re-review loops have run (0 = first review) */
	loopCount: number;
	/** The most recent parsed report, or null */
	lastReport: ReviewReport | null;
	/** Latest redacted reviewer transcript sidecar, if available */
	latestReportSidecar: ReviewerReportSidecarRef | null;
	/** Files that were modified in the current turn */
	pendingFiles: string[];
	/** Whether the post-turn-linter reported clean */
	linterClean: boolean;
	/** Timestamp of the last linter clean signal */
	linterCleanAt: number | null;
	/** Active config (defaults merged with user overrides) */
	config: ReviewConfig;
	/** Active debounce timer for delayed review (null when none) */
	reviewTimerId: ReturnType<typeof setTimeout> | null;

	// ── Entry scan cache ────────────────────────────────────────────

	/** Cached last user prompt extracted from session entries */
	lastUserPrompt: string;
	/** Index into the branch entries up to which we've already scanned */
	lastScannedIdx: number;
}
