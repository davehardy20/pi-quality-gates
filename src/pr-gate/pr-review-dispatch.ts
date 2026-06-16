import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	createReviewerExecution,
	formatReportForDisplay,
	type ReviewerExecution,
	type ReviewerResult,
} from "../reviewer/reviewer.js";
import { loadSkipFilter, type SkipFilter } from "../reviewer/reviewer-skip.js";
import type { ReviewConfig } from "../reviewer/types.js";
import {
	countDiffLinesFast,
	type DiffFilterOptions,
	extractOriginalTask,
	gatherDiff,
} from "../shared/review-scope.js";
import { hasCriticalSecurityFinding } from "../shared/review-severity.js";
import type { ReviewReport } from "../shared/review-types.js";
import { runContainerValidationEvidence } from "./container-validation.js";
import { decidePushGate } from "./gate-decision.js";
import type { PassTokenStore } from "./pass-token-store.js";
import { PR_REVIEW_CONFIG } from "./pr-review-config.js";
import {
	formatTestExecutionPlan,
	recommendTestCommands,
} from "./test-execution.js";

export interface PrReviewDispatchDeps {
	getHeadSha: (cwd: string) => string;
	getBaseRef: (cwd: string) => string;
	listChangedFiles: (cwd: string, baseRef: string) => Promise<string[]>;
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
	runContainerValidation: (files: string[], cwd: string) => Promise<string>;
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
}

export interface PrReviewDispatchResult {
	report: ReviewReport | null;
	stamped: boolean;
	escalated: boolean;
	blocked: boolean;
	message: string;
}

function isLinterClean(ctx: ExtensionContext): boolean {
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

function getDefaultPromptsDir(): string {
	const sourcePath = fileURLToPath(import.meta.url);
	const packageRoot = path.resolve(path.dirname(sourcePath), "..", "..");
	return path.join(packageRoot, "src", "pr-gate", "prompts");
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
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (code !== 0) {
				reject(
					new Error(
						`git diff --name-only ${baseRef}..HEAD exited ${code ?? 0}${stderr ? `: ${stderr.trim()}` : ""}`,
					),
				);
				return;
			}
			resolve(
				stdout
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
		"Reviewer child diagnostics:",
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

function defaultGetBaseRef(cwd: string): string {
	// Prefer the repo's default upstream branch if available.
	const candidates = ["origin/master", "origin/main", "master", "main"];
	for (const ref of candidates) {
		try {
			const { execSync } = require("node:child_process");
			execSync(`git rev-parse --verify ${ref}`, {
				cwd,
				stdio: ["ignore", "ignore", "ignore"],
			});
			return ref;
		} catch {
			// try next candidate
		}
	}
	// Fallback: compare against HEAD's first parent if nothing else works.
	return "HEAD~1";
}

export function createPrReviewDispatch(
	partialDeps: Partial<PrReviewDispatchDeps> = {},
): {
	dispatch(input: PrReviewDispatchInput): Promise<PrReviewDispatchResult>;
} {
	const deps: PrReviewDispatchDeps = {
		getHeadSha: (cwd: string) => {
			const { execSync } = require("node:child_process");
			try {
				return execSync("git rev-parse HEAD", {
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				})
					.toString()
					.trim();
			} catch {
				return "";
			}
		},
		getBaseRef: defaultGetBaseRef,
		listChangedFiles: defaultListChangedFiles,
		countDiffLines: countDiffLinesFast,
		gatherDiff,
		extractTask: extractOriginalTask,
		reviewerExecution: createReviewerExecution({
			getPromptsDir: getDefaultPromptsDir,
		}),
		runContainerValidation: runContainerValidationEvidence,
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
	): Promise<ReviewerResult> {
		const { ctx, baseRef: explicitBaseRef } = input;
		const cwd = ctx.cwd;

		const baseRef = explicitBaseRef ?? deps.getBaseRef(cwd);

		const changedFiles = await deps.listChangedFiles(cwd, baseRef);
		if (changedFiles.length === 0) {
			throw new Error(
				`No files changed between ${baseRef} and HEAD. Nothing to review.`,
			);
		}

		const diffLines = await deps.countDiffLines(changedFiles, cwd, baseRef);
		if (diffLines > PR_REVIEW_CONFIG.maxChangedLines) {
			throw new Error(
				`Diff too large: ${diffLines} changed lines exceed the PR review limit (${PR_REVIEW_CONFIG.maxChangedLines}).`,
			);
		}

		const skipFilter = await loadSkipFilterForConfig(cwd, PR_REVIEW_CONFIG);
		const filterOptions: DiffFilterOptions = {
			respectGitignore: PR_REVIEW_CONFIG.respectGitignore,
			skipFilter,
		};

		const diff = await deps.gatherDiff(
			changedFiles,
			cwd,
			PR_REVIEW_CONFIG.maxDiffLines,
			baseRef,
			filterOptions,
		);

		const task =
			deps.extractTask(ctx.sessionManager?.getBranch() ?? []) ||
			"Review the current HEAD diff before push.";

		const recommendedPlan = formatTestExecutionPlan(
			recommendTestCommands(changedFiles, cwd),
		);
		const containerEvidence = await deps.runContainerValidation(
			changedFiles,
			cwd,
		);
		const testPlan = [
			recommendedPlan,
			"",
			"## Apple Container Validation Evidence",
			containerEvidence,
		].join("\n");

		return deps.reviewerExecution.runAttempt({
			task,
			files: changedFiles,
			cwd,
			config: PR_REVIEW_CONFIG,
			filterOptions,
			diff,
			testPlan,
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

		try {
			const childOutput = await runPrReview(input);
			const report = childOutput.report;

			if (!report) {
				return {
					report: null,
					stamped: false,
					escalated: false,
					blocked: true,
					message: [
						"PR review gate: could not parse review report from child output.",
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
