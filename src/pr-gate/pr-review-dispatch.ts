import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
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
import {
	DEFAULT_EXTRA_INSTRUCTIONS_PATH,
	loadExtraInstructions,
	loadSkipFilter,
	type SkipFilter,
} from "./reviewer-skip.js";
import {
	formatTestExecutionPlan,
	recommendTestCommands,
} from "./test-execution.js";

/**
 * Resolve per-repo extra instructions for the host reviewer bridge, applying
 * two safety guards:
 *
 * 1. Host-bridge guard: extra instructions are rendered only by the host
 *    bridge (`renderTaskTemplate`). The orchestrator
 *    (`inspectRepositoryDirectly`) bridge renders its own instruction and
 *    cannot forward them, so they are skipped there with a one-time note.
 * 2. Self-injection guard: if the ROOT `.pi/review-instructions.md` is itself
 *    in the PR's UNFILTERED changed-files set (matched case-insensitively, so
 *    a case-variant file can't bypass it on a case-insensitive host FS), the
 *    instructions are NOT loaded — a PR must not inject instructions into its
 *    own review. Only the root path matches: nested package files (e.g.
 *    `packages/widget/.pi/review-instructions.md`) are distinct and never
 *    loaded here, so they must not suppress the trusted root config.
 *    Inspecting the unfiltered set closes a bypass where a PR also edits
 *    `.pi/reviewer.skip` to hide the file from the filtered list. They take
 *    effect from the next review after the file merges to the protected base.
 * 3. Symlink-target guard: a pre-existing symlink at the instructions path can
 *    resolve to a tracked file the PR edits. Since loadExtraInstructions
 *    follows symlinks, the resolved (realpath) instructions file is compared
 *    against the resolved changed files and refused on collision — otherwise
 *    the PR could author the very content injected into its own review.
 *
 * `log` and `state` are injected so diagnostics are testable and the one-time
 * orchestrator note is resettable per dispatch instance (instead of a
 * module-level flag shared across every dispatch in the process).
 *
 * Returns the trimmed instructions, or `undefined` when absent or guarded.
 */
function resolveExtraInstructions(
	cwd: string,
	unfilteredChangedFiles: string[],
	inspectRepositoryDirectly: boolean | undefined,
	log: (msg: string) => void,
	state: { orchestratorSkipLogged: boolean },
): string | undefined {
	if (inspectRepositoryDirectly) {
		const present = loadExtraInstructions(cwd, undefined, { log });
		if (present && !state.orchestratorSkipLogged) {
			state.orchestratorSkipLogged = true;
			log(
				"[pr-review-dispatch] .pi/review-instructions.md is host-bridge-only; ignored by the orchestrator (inspectRepositoryDirectly) reviewer bridge.",
			);
		}
		return undefined;
	}
	// Case-insensitive: on the default macOS host bridge the filesystem is
	// case-insensitive, so a case-variant file (e.g. `.pi/Review-Instructions.md`)
	// is read by the lowercase default path and would bypass an exact match.
	if (
		unfilteredChangedFiles.some(
			(f) => f.toLowerCase() === DEFAULT_EXTRA_INSTRUCTIONS_PATH.toLowerCase(),
		)
	) {
		log(
			"[pr-review-dispatch] .pi/review-instructions.md is in this PR's changed files; refusing to load it to prevent self-injection into the review.",
		);
		return undefined;
	}
	// Symlink-target guard: a pre-existing symlink at the instructions path can
	// resolve to a tracked file the PR edits. loadExtraInstructions follows the
	// symlink, so compare the resolved (realpath) instructions file against the
	// resolved changed files and refuse on collision. Closes a bypass where the
	// PR edits the symlink TARGET (not the literal instructions path).
	const instructionsReal = realpathOrUndefined(
		path.join(cwd, DEFAULT_EXTRA_INSTRUCTIONS_PATH),
	);
	if (instructionsReal) {
		for (const file of unfilteredChangedFiles) {
			if (realpathOrUndefined(path.join(cwd, file)) === instructionsReal) {
				log(
					"[pr-review-dispatch] .pi/review-instructions.md resolves (via symlink) to a file in this PR's changed set; refusing to load it to prevent self-injection into the review.",
				);
				return undefined;
			}
		}
	}
	return loadExtraInstructions(cwd, undefined, { log });
}

/** Resolve a real (symlink-followed) absolute path, or `undefined` if it can't. */
function realpathOrUndefined(filePath: string): string | undefined {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return undefined;
	}
}

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
	/**
	 * Optional logger for diagnostic notes (e.g. the self-injection refusal
	 * and the host-bridge-only orchestrator skip note). Defaults to
	 * `console.error`.
	 */
	log?: (msg: string) => void;
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
		log: console.error,
		reviewerExecution: missingReviewerExecution(),
		...partialDeps,
	};

	// Per-dispatch logger and once-flag: each dispatch instance logs the
	// orchestrator skip note at most once, independent of other instances
	// (resettable per dispatch instead of shared across the whole module).
	const log = deps.log ?? console.error;
	const extraInstructionsState = { orchestratorSkipLogged: false };

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

		const extraInstructions = resolveExtraInstructions(
			cwd,
			unfilteredChangedFiles,
			deps.reviewerExecution.inspectRepositoryDirectly,
			log,
			extraInstructionsState,
		);
		const reviewConfig: ReviewConfig = extraInstructions
			? { ...PR_REVIEW_CONFIG, extraInstructions }
			: PR_REVIEW_CONFIG;

		return deps.reviewerExecution.runAttempt({
			task,
			files: changedFiles,
			cwd,
			config: reviewConfig,
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
