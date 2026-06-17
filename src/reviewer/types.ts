import type { AutoFixThreshold } from "../shared/review-types.js";

// ── Shared review report schema (re-exported for backwards compatibility) ──
export type {
	AutoFixThreshold,
	Finding,
	ReviewConfidence,
	ReviewDomain,
	ReviewReport,
	ReviewStatus,
	Severity,
} from "../shared/review-types.js";

// ── Review Config ────────────────────────────────────────────────────────

/** Reviewer configuration. Used by the pr-gate PR_REVIEW_CONFIG and the
 * reviewer execution core. */
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
