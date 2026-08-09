import type { AutoFixThreshold } from "./review-types.js";

// ── Review Options (C4 toggles) ───────────────────────────────────────────

/**
 * Optional per-review feature toggles that enable extra reviewer domains,
 * mirroring PR-Agent's `require_*` flags. Effective defaults are set in
 * `PR_REVIEW_CONFIG` — `canSplit` is on; `todoScan`/`effortEstimate` are off.
 * Rendering is deterministic: each
 * toggle adds (or omits) a fixed prompt section via `renderSystemPrompt`.
 */
export interface ReviewOptions {
	/**
	 * Scan changed code for leftover `TODO`/`FIXME`/`HACK`/`XXX` markers and
	 * placeholder/stub implementations (PR-Agent `require_todo_scan`).
	 * Default off.
	 */
	todoScan?: boolean;
	/**
	 * Assess whether the change is too large or mixed in concern to review as
	 * one unit and suggest split points (PR-Agent `require_can_be_split_review`).
	 * Default on (see `PR_REVIEW_CONFIG.reviewOptions`).
	 */
	canSplit?: boolean;
	/**
	 * Ask the reviewer to estimate per-finding fix effort in whole minutes
	 * (PR-Agent `require_estimate_effort_to_review`) and emit the `Effort:`
	 * output field. Default off. The optional `Finding.effort` schema field
	 * (C3) is parsed-and-tolerated regardless of this toggle.
	 */
	effortEstimate?: boolean;
}

// ── Review Config ────────────────────────────────────────────────────────

/** Reviewer configuration. Used by the pr-gate PR_REVIEW_CONFIG and the
 * reviewer execution core. */
export interface ReviewConfig {
	/** Model override for the reviewer (null = spawned Pi selects its default) */
	model: string | null;
	/** Ordered fallback models tried when the primary model fails with an
	 * empty-output model failure (e.g. quota exhaustion, empty response).
	 * Each is tried in order until a parseable review report is produced. */
	fallbackModels?: string[];
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
	/** Max diff lines before truncation. A truncated text-diff downgrades a PASS to
	 *  PARTIAL (no stamp). The orchestrator/direct path sees the full base..HEAD
	 *  diff, so it never truncates. */
	maxDiffLines: number;
	/** Max changed lines before skipping review entirely (cost guard). -1 = no limit. */
	maxChangedLines: number;
	/** Delay in ms before triggering a review after linter goes clean.
	 *  This debounces reviews so the main agent can finish multi-step work
	 *  before the reviewer interrupts. 0 = immediate (legacy behavior). */
	reviewDelayMs: number;
	/**
	 * Per-repo extra instructions appended to the reviewer task prompt.
	 * Populated at dispatch time from `.pi/review-instructions.md` when
	 * present (see `loadExtraInstructions`), or set directly on the config.
	 * Empty/undefined emits no section in the rendered task.
	 *
	 * Trust boundary: trusted repo config (same tier as
	 * `.pi/reviewer.skip`) — populated only for the repo under review, never
	 * from untrusted diffs without a prior trust check.
	 */
	extraInstructions?: string;
	/**
	 * When true, `gatherDiff` rewrites the unified diff into deterministic
	 * `__new hunk__` / `__old hunk__` blocks (see `toStructuredHunks`) before
	 * it is fed to the reviewer prompt. Mirrors PR-Agent's labelled-hunk
	 * format so the model can unambiguously tell added lines from removed
	 * ones. Defaults to on (`true`) in `PR_REVIEW_CONFIG`; set `false` to
	 * preserve the raw unified-diff format.
	 */
	useStructuredHunks?: boolean;
	/**
	 * When true, the PR gate scopes each review to the changes since the most
	 * recent PASS token (`lastPassSha..HEAD`, see `PassTokenStore.lastPassSha`)
	 * instead of the full `baseRef..HEAD` range — mirrors PR-Agent's
	 * incremental review, where commits covered by an earlier PASS are not
	 * re-reviewed. Applies only when no explicit base ref was given and the
	 * last-PASS sha still resolves in the repo; otherwise the review falls
	 * back to the default full-range base ref. Defaults to on (`true`) in
	 * `PR_REVIEW_CONFIG`; set `false` to always review the full PR range.
	 */
	incrementalReview?: boolean;
	/**
	 * Optional per-review feature toggles (TODO scan, can-split, effort
	 * estimate) that conditionally extend the reviewer system prompt. See
	 * {@link ReviewOptions}. `canSplit` is on by default; the others are off.
	 */
	reviewOptions?: ReviewOptions;
}
