import type { ReviewConfig } from "../shared/review-config.js";

/**
 * PR reviewer configuration.
 *
 * Differs from the turn-end reviewer in two important ways:
 *  1. The toolset is read-only + safe validation runners; bash is NOT allowed.
 *  2. The diff is scoped to a base ref (e.g. origin/master) instead of HEAD.
 *
 * This config is used by the `/pr-review` dispatch path. The spawned child Pi
 * receives exactly these tools via `--tools`, so the reviewer cannot fall back
 * to arbitrary shell commands.
 */
export const PR_REVIEW_CONFIG: ReviewConfig = {
	model: "openai-codex/gpt-5.5",
	minChangedLines: 0,
	enabled: true,
	maxReReviewPasses: 1,
	autoFixThreshold: "warning",
	maxTokens: 8192,
	timeoutMs: 600_000,
	tools: [
		"read",
		"grep",
		"find",
		"ls",
		"safe_parse_file",
		"ast_grep_search",
		"lsp_goto_definition",
		"lsp_find_references",
		"lsp_diagnostics",
		"lsp_symbols",
		"lsp_prepare_rename",
		"git_inspect_safe",
		"container_safe",
		"pi_docs",
		"context7_library",
		"context7_docs",
		"web_search",
		"mulch_query",
		"mulch_search",
		"seeds_show",
		"seeds_plan_show",
		"run_biome",
		"run_vitest",
		"run_typecheck",
		"run_pytest",
		"run_cargo_test",
		"compact_plus_query_tool_output",
	],
	allowedBashPatterns: [],
	respectGitignore: true,
	skipFile: ".pi/reviewer.skip",
	allowTestDiscovery: true,
	testDiscoveryCommands: {
		python: ["pytest --collect-only -q"],
		rust: ["cargo test --no-run"],
		go: ["go test -list ."],
		typescript: ["npx vitest run --reporter=dot"],
		javascript: ["npx vitest run --reporter=dot"],
	},
	maxDiffLines: 4000,
	maxChangedLines: 5000,
	reviewDelayMs: 0,
};

/**
 * Allowed tool names for the PR reviewer. Useful for tests and policy checks.
 */
export const PR_REVIEWER_TOOLS = new Set(PR_REVIEW_CONFIG.tools);

/**
 * Tools that are explicitly forbidden to the PR reviewer child.
 */
export const PR_REVIEWER_FORBIDDEN_TOOLS = new Set([
	"write",
	"edit",
	"hashline_edit",
	"bash",
	"ast_grep_replace",
	"lsp_rename",
	"git_safe",
	"gh_safe",
	"mulch_record",
	"mulch_sync",
	"mulch_learn",
	"seeds_create",
	"seeds_update",
	"seeds_close",
	"seeds_relation",
	"seeds_doctor",
	"seeds_project",
	"seeds_plan_submit",
	"seeds_plan_review",
	"seeds_plan_outcome",
]);

/**
 * Verify that the PR reviewer config does not grant any forbidden tool.
 * Throws if a forbidden tool is present.
 */
export function assertPrReviewerToolPolicy(): void {
	for (const tool of PR_REVIEW_CONFIG.tools) {
		if (PR_REVIEWER_FORBIDDEN_TOOLS.has(tool)) {
			throw new Error(
				`PR reviewer policy violation: forbidden tool "${tool}" in PR_REVIEW_CONFIG.tools`,
			);
		}
	}
}
