import { execFileSync } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ReviewConfig } from "../shared/review-config.js";
import {
	applyDiffFilters,
	countDiffLinesFast,
	type DiffFilterOptions,
	extractOriginalTask,
	gatherDiff,
} from "../shared/review-scope.js";
import { hasCriticalSecurityFinding } from "../shared/review-severity.js";
import type { ReviewReport } from "../shared/review-types.js";
import { decidePushGate } from "./gate-decision.js";
import type { PassTokenStore } from "./pass-token-store.js";
import { PR_REVIEW_CONFIG } from "./pr-review-config.js";
import {
	createBoundedTextCapture,
	formatReportForDisplay,
	type ReviewerExecution,
	type ReviewerResult,
} from "./reviewer.js";
import { loadSkipFilter, type SkipFilter } from "./reviewer-skip.js";
import {
	formatTestExecutionPlan,
	recommendTestCommands,
} from "./test-execution.js";

export interface PrReviewDispatchDeps {
	getHeadSha: (cwd: string) => string;
	/**
	 * Whether the worktree has no uncommitted tracked changes vs HEAD. The host
	 * reviewer validates the live checkout, so a dirty worktree would be
	 * validated while a clean committed HEAD is stamped — block before review.
	 */
	isWorktreeClean: (cwd: string) => boolean;
	getBaseRef: (cwd: string) => string;
	listChangedFiles: (cwd: string, baseRef: string) => Promise<string[]>;
	applyDiffFilters: (
		files: string[],
		cwd: string,
		filterOptions?: DiffFilterOptions,
	) => Promise<string[]>;
	countDiffLines: (
		files: string[],
		cwd: string,
		baseRef?: string,
	) => Promise<number>;
	gatherDiff: (
		files: string[],
		cwd: string,
		maxLines: number,
		baseRef?: string,
		filterOptions?: DiffFilterOptions,
	) => Promise<string>;
	extractTask: (
		entries: Array<{
			type: string;
			message?: {
				role?: string;
				content?: string | Array<{ type?: string; text?: string }>;
			};
		}>,
	) => string;
	reviewerExecution: ReviewerExecution;
}

export interface PrReviewDispatchInput {
	ctx: ExtensionContext;
	state: {
		tokens: PassTokenStore;
		config: {
			enabled: boolean;
		};
	};
	pi: ExtensionAPI;
	baseRef?: string;
	isReReview?: boolean;
	/**
	 * Abort signal owned by the coordinator. When aborted (e.g. session
	 * shutdown) the in-flight host child is killed and the result is never
	 * stamped, even if a report slipped through before the process exited.
	 */
	signal?: AbortSignal;
}

export interface PrReviewDispatchResult {
	report: ReviewReport | null;
	stamped: boolean;
	escalated: boolean;
	blocked: boolean;
	message: string;
}

export function isLinterClean(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager?.getBranch() ?? [];
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as {
			type?: string;
			customType?: string;
			details?: { status?: string };
		};
		if (entry.type !== "custom_message") continue;
		if (entry.customType !== "post-turn-linter-status") continue;
		return entry.details?.status === "clean";
	}
	// No linter status entry means the linter has not run (and therefore has
	// not reported findings). Treat this as clean so /pr-review can proceed
	// when no in-session files needed linting.
	return true;
}

function missingReviewerExecution(): ReviewerExecution {
	return {
		async runAttempt(): Promise<ReviewerResult> {
			const message =
				"PR review gate: no reviewer execution bridge was configured; expected sandboxed orchestrator pr-reviewer routing.";
			return {
				report: null,
				rawOutput: message,
				exitCode: 1,
				timedOut: false,
				stderr: message,
				command: "orchestrate category=pr-reviewer",
			};
		},
	};
}

async function defaultListChangedFiles(
	cwd: string,
	baseRef: string,
): Promise<string[]> {
	const { spawn } = await import("node:child_process");
	return new Promise((resolve, reject) => {
		const proc = spawn("git", ["diff", "--name-only", `${baseRef}..HEAD`], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout = createBoundedTextCapture(262_144);
		const stderr = createBoundedTextCapture(65_536);
		proc.stdout.on("data", (data: Buffer) => {
			stdout.append(data.toString());
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr.append(data.toString());
		});
		proc.on("close", (code) => {
			const stderrValue = stderr.value();
			if (stdout.overflowed() || stderr.overflowed()) {
				reject(
					new Error(
						`git diff --name-only ${baseRef}..HEAD exceeded bounded output limits`,
					),
				);
				return;
			}
			if (code !== 0) {
				reject(
					new Error(
						`git diff --name-only ${baseRef}..HEAD exited ${code ?? 0}${stderrValue ? `: ${stderrValue.trim()}` : ""}`,
					),
				);
				return;
			}
			resolve(
				stdout
					.value()
					.split("\n")
					.map((l) => l.trim())
					.filter((l) => l.length > 0),
			);
		});
	});
}

function truncateReviewDiagnostic(
	value: string | undefined,
	maxChars = 1200,
): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return "(empty)";
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars)}… [truncated ${trimmed.length - maxChars} chars]`;
}

function formatUnparseableReviewerOutput(result: ReviewerResult): string {
	const lines = [
		"Reviewer diagnostics:",
		`- exitCode: ${result.exitCode}`,
		`- timedOut: ${result.timedOut}`,
	];
	if (result.usage) lines.push(`- usage: ${result.usage}`);
	lines.push(`- command: ${result.command}`);
	if (result.stderr.trim()) {
		lines.push("", "stderr preview:", truncateReviewDiagnostic(result.stderr));
	}
	if (result.rawOutput.trim() && result.rawOutput !== result.stderr) {
		lines.push(
			"",
			"raw output preview:",
			truncateReviewDiagnostic(result.rawOutput),
		);
	}
	return lines.join("\n");
}

export function getPassBlockingTestExecutionReason(
	report: ReviewReport,
): string | null {
	if (report.status !== "PASS") return null;
	if (!report.testExecution) {
		return "reviewer omitted the required ### Test execution section";
	}
	if (report.testExecution.status !== "PASS") {
		return `test execution status is ${report.testExecution.status}`;
	}
	return null;
}

type GitRefVerifier = (cwd: string, ref: string) => boolean;

function verifyGitRef(cwd: string, ref: string): boolean {
	try {
		execFileSync("git", ["rev-parse", "--verify", ref], {
			cwd,
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
}

export function resolveDefaultBaseRef(
	cwd: string,
	verifyRef: GitRefVerifier = verifyGitRef,
): string {
	const candidates = ["origin/master", "origin/main", "master", "main"];
	for (const ref of candidates) {
		if (verifyRef(cwd, ref)) return ref;
	}
	return "HEAD~1";
}
/**
 * Default worktree-clean check: `git status --porcelain` is empty only when the
 * working tree matches HEAD with no staged, unstaged, OR untracked changes.
 * Blocking on any non-empty output prevents an untracked file (e.g. a generated
 * module) from letting the host reviewer PASS+stamp a HEAD whose exact content
 * was never validated. If `git status` itself fails (e.g. a corrupt
 * status.showUntrackedFiles config while HEAD still resolves), this fails
 * CLOSED (returns false) so an unprovable worktree blocks the review.
 *
 * Accepted residuals (trusted single-session host reviewer; immutable-checkout
 * fix tracked in Seeds pi-quality-gates-52c9):
 *  - a tracked edit introduced AND reverted while the child runs (bookend
 *    sampling cannot see it);
 *  - IGNORED files (`--porcelain` omits them; `--ignored` can't be used since
 *    node_modules etc. are always ignored) — an ignored generated source that
 *    satisfies a tracked import could let a stale/ignored file influence
 *    validation. The immutable-checkout removes all live-worktree influence.
 */
export function defaultIsWorktreeClean(cwd: string): boolean {
	try {
		const out = execFileSync("git", ["status", "--porcelain"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.trim().length === 0;
	} catch {
		return false;
	}
}

export function createPrReviewDispatch(
	partialDeps: Partial<PrReviewDispatchDeps> = {},
): {
	dispatch(input: PrReviewDispatchInput): Promise<PrReviewDispatchResult>;
} {
	const deps: PrReviewDispatchDeps = {
		getHeadSha: (cwd: string) => {
			try {
				return execFileSync("git", ["rev-parse", "HEAD"], {
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim();
			} catch {
				return "";
			}
		},
		getBaseRef: resolveDefaultBaseRef,
		isWorktreeClean: defaultIsWorktreeClean,
		listChangedFiles: defaultListChangedFiles,
		applyDiffFilters,
		countDiffLines: countDiffLinesFast,
		gatherDiff,
		extractTask: extractOriginalTask,
		reviewerExecution: missingReviewerExecution(),
		...partialDeps,
	};

	async function loadSkipFilterForConfig(
		cwd: string,
		config: ReviewConfig,
	): Promise<SkipFilter | null> {
		if (!config.skipFile) return null;
		return loadSkipFilter(cwd, config.skipFile);
	}

	async function runPrReview(
		input: PrReviewDispatchInput,
		reviewedHeadSha: string,
	): Promise<ReviewerResult> {
		const { ctx, baseRef: explicitBaseRef } = input;
		const cwd = ctx.cwd;

		const baseRef = explicitBaseRef ?? deps.getBaseRef(cwd);

		const unfilteredChangedFiles = await deps.listChangedFiles(cwd, baseRef);
		if (unfilteredChangedFiles.length === 0) {
			throw new Error(
				`No files changed between ${baseRef} and HEAD. Nothing to review.`,
			);
		}

		const skipFilter = await loadSkipFilterForConfig(cwd, PR_REVIEW_CONFIG);
		const filterOptions: DiffFilterOptions = {
			respectGitignore: PR_REVIEW_CONFIG.respectGitignore,
			skipFilter,
		};
		const changedFiles = await deps.applyDiffFilters(
			unfilteredChangedFiles,
			cwd,
			filterOptions,
		);
		if (changedFiles.length === 0) {
			throw new Error(
				`All files changed between ${baseRef} and HEAD are excluded by review filters. Nothing to review.`,
			);
		}

		const diffLines = await deps.countDiffLines(changedFiles, cwd, baseRef);
		if (diffLines > PR_REVIEW_CONFIG.maxChangedLines) {
			throw new Error(
				`Diff too large: ${diffLines} changed lines exceed the PR review limit (${PR_REVIEW_CONFIG.maxChangedLines}).`,
			);
		}

		const diff = deps.reviewerExecution.inspectRepositoryDirectly
			? undefined
			: await deps.gatherDiff(
					changedFiles,
					cwd,
					PR_REVIEW_CONFIG.maxDiffLines,
					baseRef,
					filterOptions,
				);

		const extractedTask =
			deps.extractTask(ctx.sessionManager?.getBranch() ?? []) ||
			"Review the current HEAD diff before push.";
		const task = truncateReviewDiagnostic(extractedTask, 8_000);

		const testPlan = formatTestExecutionPlan(
			recommendTestCommands(changedFiles, cwd),
		);

		const currentHeadSha = deps.getHeadSha(cwd);
		if (currentHeadSha !== reviewedHeadSha) {
			throw new Error(
				`HEAD changed while preparing PR review (${reviewedHeadSha} → ${currentHeadSha || "unknown"}). Re-run /pr-review.`,
			);
		}

		return deps.reviewerExecution.runAttempt({
			task,
			files: changedFiles,
			cwd,
			config: PR_REVIEW_CONFIG,
			filterOptions,
			diff,
			baseRef,
			testPlan,
			headSha: reviewedHeadSha,
			signal: input.signal,
		});
	}

	async function dispatch(
		input: PrReviewDispatchInput,
	): Promise<PrReviewDispatchResult> {
		const { ctx, state, pi } = input;

		const headSha = deps.getHeadSha(ctx.cwd);
		if (!headSha) {
			return {
				report: null,
				stamped: false,
				escalated: false,
				blocked: true,
				message:
					"PR review gate: could not resolve HEAD sha. Resolve HEAD and retry /pr-review.",
			};
		}

		if (state.tokens.hasPass(headSha) && !input.isReReview) {
			return {
				report: null,
				stamped: false,
				escalated: false,
				blocked: false,
				message: `HEAD ${headSha} already has a PASS token. Push will be allowed.`,
			};
		}

		if (!isLinterClean(ctx)) {
			return {
				report: null,
				stamped: false,
				escalated: false,
				blocked: true,
				message:
					"PR review gate: post-turn linter is not clean. Fix linter findings and wait for a clean lint status before running /pr-review.",
			};
		}

		// Stamp integrity: the host reviewer validates the live checkout, so a
		// dirty worktree would be validated while a clean committed HEAD is
		// stamped. Require a clean worktree before running the review.
		if (!deps.isWorktreeClean(ctx.cwd)) {
			return {
				report: null,
				stamped: false,
				escalated: false,
				blocked: true,
				message:
					"PR review gate: worktree has uncommitted changes. The host reviewer validates the live checkout, so commit or stash before requesting a review.",
			};
		}

		try {
			const childOutput = await runPrReview(input, headSha);
			const currentHeadSha = deps.getHeadSha(ctx.cwd);
			if (currentHeadSha !== headSha) {
				return {
					report: childOutput.report,
					stamped: false,
					escalated: false,
					blocked: true,
					message: `PR review gate: HEAD changed during review (${headSha} → ${currentHeadSha || "unknown"}). The result was not applied; re-run /pr-review for the current HEAD.`,
				};
			}
			// Abort fail-closed: if the coordinator aborted (session shutdown)
			// before we stamped, never apply the result even if a report slipped
			// through as the child was being killed.
			if (input.signal?.aborted) {
				return {
					report: childOutput.report,
					stamped: false,
					escalated: false,
					blocked: true,
					message: `PR review gate: review was aborted (session shutdown) before stamping HEAD ${headSha}. Not stamped; re-run /pr-review.`,
				};
			}
			// Re-verify worktree cleanliness: edits made while the async review ran
			// would mean the validated content no longer matches the stamped HEAD.
			if (!deps.isWorktreeClean(ctx.cwd)) {
				return {
					report: childOutput.report,
					stamped: false,
					escalated: false,
					blocked: true,
					message: `PR review gate: worktree changed during review of HEAD ${headSha}. The result was not applied; re-run /pr-review with a clean worktree.`,
				};
			}
			const report = childOutput.report;

			if (!report) {
				const sidecarHint = childOutput.sidecarPath
					? `Reviewer output preserved at: ${childOutput.sidecarPath}`
					: "Reviewer output was not preserved (sidecar unavailable).";
				return {
					report: null,
					stamped: false,
					escalated: false,
					blocked: true,
					message: [
						"PR review gate: could not parse review report from child output.",
						sidecarHint,
						formatUnparseableReviewerOutput(childOutput),
						"Re-run /pr-review after investigating the reviewer output.",
					].join("\n\n"),
				};
			}

			if (hasCriticalSecurityFinding(report)) {
				return {
					report,
					stamped: false,
					escalated: true,
					blocked: true,
					message: `⚠️ **CRITICAL security finding(s)** in review for HEAD ${headSha}. Human acknowledgement required before push.\n\n${formatReportForDisplay(report)}`,
				};
			}

			const testExecutionBlocker = getPassBlockingTestExecutionReason(report);
			if (testExecutionBlocker) {
				return {
					report: { ...report, status: "CANNOT_REVIEW" },
					stamped: false,
					escalated: false,
					blocked: true,
					message: `❓ **PR review could not complete** for HEAD ${headSha}: ${testExecutionBlocker}. Re-run /pr-review after the reviewer reports container-safe test execution.\n\n${formatReportForDisplay(report)}`,
				};
			}

			if (report.status === "PASS") {
				const decision = decidePushGate({
					action: "push",
					headSha,
					baseSha: input.baseRef ?? "unknown",
					tokens: state.tokens,
					reviewReport: report,
				});
				return {
					report,
					stamped: decision.verdict === "allow",
					escalated: false,
					blocked: false,
					message: `✅ **PR review PASS** for HEAD ${headSha} (${report.confidence} confidence). Push is now allowed.\n\n${formatReportForDisplay(report)}`,
				};
			}

			if (report.status === "CANNOT_REVIEW") {
				return {
					report,
					stamped: false,
					escalated: false,
					blocked: true,
					message: `❓ **PR review could not complete** for HEAD ${headSha}.\n\n${formatReportForDisplay(report)}\n\nInvestigate the reviewer output and re-run /pr-review.`,
				};
			}

			// ISSUES
			const fixInstruction = buildFixInstruction(report);
			pi.sendUserMessage(fixInstruction);

			return {
				report,
				stamped: false,
				escalated: false,
				blocked: true,
				message: `🚨 **PR review found issues** for HEAD ${headSha}.\n\n${formatReportForDisplay(report)}\n\nFix the findings, wait for lint-clean, then re-run /pr-review.`,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				report: null,
				stamped: false,
				escalated: false,
				blocked: true,
				message: `PR review gate: review failed — ${message}`,
			};
		}
	}

	function buildFixInstruction(report: ReviewReport): string {
		const criticalFiles = [
			...new Set(
				report.findings
					.filter((f) => f.severity === "CRITICAL" || f.severity === "WARNING")
					.map((f) => (f.file ? f.file.split(":")[0] : "")),
			),
		].filter(Boolean);

		return [
			"Fix the PR review findings before pushing.",
			`Affected files: ${criticalFiles.join(", ") || "(see report)"}`,
			"",
			"Use the PR review findings already in session context as the source of truth.",
			"Address each CRITICAL finding. Focus on the specific files and lines cited.",
			"After fixing, wait for lint-clean, then re-run /pr-review.",
		].join("\n");
	}

	return { dispatch };
}
