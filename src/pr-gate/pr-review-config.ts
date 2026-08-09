import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReviewConfig } from "../shared/review-config.js";

/**
 * PR reviewer configuration.
 *
 * Shared PR review limits and legacy tool policy. The reviewer model is
 * resolved from the canonical `worker` profile at review time, rather than
 * copied into source.
 */
const REVIEWER_MODEL_PROFILE = "worker";
const MODEL_FALLBACKS_PATH = join(
	homedir(),
	".pi",
	"agent",
	"model-fallbacks.json",
);

export interface ResolveReviewerModelConfigOptions {
	configPath?: string;
	readFile?: (path: string) => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizedModel(value: unknown): string | null {
	if (typeof value !== "string") return null;
	return value.trim() || null;
}

/**
 * Resolve the PR reviewer model from ~/.pi/agent/model-fallbacks.json.
 * Missing or malformed config deliberately falls back to Pi's session model.
 */
export function resolveReviewerModelConfig(
	options: ResolveReviewerModelConfigOptions = {},
): Pick<ReviewConfig, "model" | "fallbackModels"> {
	const readFile =
		options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	try {
		const parsed: unknown = JSON.parse(
			readFile(options.configPath ?? MODEL_FALLBACKS_PATH),
		);
		if (!isRecord(parsed) || !isRecord(parsed.profiles)) {
			return { model: null, fallbackModels: [] };
		}
		const profile = parsed.profiles[REVIEWER_MODEL_PROFILE];
		if (!isRecord(profile)) return { model: null, fallbackModels: [] };
		const model = normalizedModel(profile.primary);
		if (!model) return { model: null, fallbackModels: [] };
		const fallbackModels: string[] = [];
		if (Array.isArray(profile.fallbacks)) {
			for (const candidate of profile.fallbacks) {
				const fallback = normalizedModel(candidate);
				if (
					fallback &&
					fallback !== model &&
					!fallbackModels.includes(fallback)
				) {
					fallbackModels.push(fallback);
				}
			}
		}
		return { model, fallbackModels };
	} catch {
		return { model: null, fallbackModels: [] };
	}
}

/**
 * PR reviewer configuration.
 *
 * The default `/pr-review` extension path spawns a read-only host child Pi
 * (`src/pr-gate/reviewer.ts`); the sandboxed orchestrator `pr-reviewer` is
 * opt-in via PI_PR_REVIEW_BRIDGE=orchestrator. Model values are populated by
 * `resolvePrReviewConfig()` at review time.
 */
export const PR_REVIEW_CONFIG: ReviewConfig = {
	// When model-fallbacks.json is unavailable, let Pi select the session
	// model rather than preserving stale provider/model literals in source.
	model: null,
	fallbackModels: [],
	minChangedLines: 0,
	enabled: true,
	maxReReviewPasses: 1,
	autoFixThreshold: "warning",
	maxTokens: 8192,
	timeoutMs: 45 * 60_000,
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
		"run_node_test",
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
	// C2 structured diff hunks — ON by default. Adopts the PR-Agent
	// labelled-hunk (__new hunk__ / __old hunk__) diff format so the reviewer
	// can unambiguously separate added vs removed lines.
	useStructuredHunks: true,
	// C5 incremental review — ON by default. Scopes each review to
	// lastPassSha..HEAD (PR-Agent incremental review) instead of the full
	// base..HEAD range, so commits already covered by a prior PASS are not
	// re-reviewed.
	incrementalReview: true,
	// C4 review option toggles. `canSplit` flags changes that are too large
	// or mixed in concern and suggests split points (PR-Agent
	// require_can_be_split_review). Effort estimate / TODO scan stay off.
	reviewOptions: {
		canSplit: true,
	},
};

/** Resolve the default reviewer config immediately before a review starts. */
export function resolvePrReviewConfig(): ReviewConfig {
	return { ...PR_REVIEW_CONFIG, ...resolveReviewerModelConfig() };
}

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
