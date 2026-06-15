/**
 * ReviewerOrchestrator — hides the reviewer state machine, formatting,
 * sidecar persistence, and fix-request scheduling behind a small event-driven
 * interface.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	buildBoundedReviewerFailureMessage,
	buildSummaryFirstReviewerMessage,
	deriveSessionId,
	type ReviewerReportSidecarWriteResult,
	writeReviewerReportSidecar,
} from "./report-hygiene.js";
import {
	countDiffLinesFast,
	extractOriginalTask,
	gatherDiff,
	type ReviewerResult,
	readSystemPrompt,
	renderTaskTemplate,
	spawnReviewer,
} from "./reviewer.js";
import type {
	AutoFixThreshold,
	ReviewConfig,
	ReviewerPhase,
	ReviewerState,
	ReviewReport,
	Severity,
} from "./types.js";
import { DEFAULT_REVIEW_CONFIG } from "./types.js";

// Re-export types for consumers
export type {
	ReviewConfig,
	ReviewerPhase,
	ReviewerState,
	ReviewReport,
	Severity,
} from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface ReviewerStateSnapshot {
	phase: ReviewerPhase;
	loopCount: number;
	linterClean: boolean;
	pendingFiles: string[];
	config: ReviewConfig;
	lastReport: ReviewReport | null;
	latestReportSidecar: {
		id: string;
		path: string;
		redactedChars: number;
	} | null;
}

export interface ReviewerOrchestratorDeps {
	loadConfig: (cwd: string) => Promise<ReviewConfig>;
	loadSkipFilter: (
		cwd: string,
		skipFile: string | null,
	) => Awaited<ReturnType<typeof import("./reviewer-skip.js").loadSkipFilter>>;
	countDiffLines: (files: string[], cwd: string) => Promise<number>;
	runReview: (
		task: string,
		files: string[],
		cwd: string,
		config: ReviewConfig,
		filterOptions: {
			respectGitignore?: boolean;
			skipFilter?: {
				loaded: boolean;
				patternCount: number;
				ig: {
					ignores: (path: string) => boolean;
					filter: (paths: string[]) => string[];
				};
			} | null;
		},
		signal?: AbortSignal,
	) => Promise<ReviewerResult>;
	writeSidecar: (
		report: string,
		ctx: ExtensionContext,
	) => Promise<ReviewerReportSidecarWriteResult>;
	getSystemPrompt: (promptsDir: string) => string;
	getTaskPrompt: (
		promptsDir: string,
		task: string,
		files: string[],
		diff: string,
	) => string;
	getPromptsDir: () => string;
}

export interface ReviewerOrchestrator {
	initialize(ctx: ExtensionContext): Promise<void>;
	shutdown(ctx: ExtensionContext): Promise<void>;
	onLinterClean(files: string[], timestamp?: number): void;
	onTurnEnd(ctx: ExtensionContext): Promise<void>;
	requestReview(
		ctx: ExtensionContext,
		options?: { isReReview?: boolean; files?: string[] },
	): Promise<void>;
	setModel(model: string | null): void;
	updateConfig(updater: (config: ReviewConfig) => ReviewConfig): void;
	registerCommands(pi: ExtensionAPI): void;
	getStateSnapshot(): ReviewerStateSnapshot;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function severityMeetsThreshold(
	severity: Severity,
	threshold: AutoFixThreshold,
): boolean {
	if (threshold === "none") return false;
	if (threshold === "warning")
		return severity === "CRITICAL" || severity === "WARNING";
	return severity === "CRITICAL";
}

function formatPhaseStatus(state: ReviewerState, config: ReviewConfig): string {
	const lines = [
		`Phase: ${state.phase}`,
		`Enabled: ${config.enabled}`,
		`Loop count: ${state.loopCount}`,
		`Linter clean: ${state.linterClean}`,
		`Pending files: ${state.pendingFiles.length}`,
		`Model: ${config.model ?? "(session default)"}`,
		`Changed lines range: ${config.minChangedLines}–${config.maxChangedLines > 0 ? config.maxChangedLines : "∞"}`,
		`Auto-fix threshold: ${config.autoFixThreshold}`,
		`Max re-review passes: ${config.maxReReviewPasses}`,
		`Last report: ${state.lastReport ? state.lastReport.status : "none"}`,
	];
	if (state.lastReport) {
		const critical = state.lastReport.findings.filter(
			(f) => f.severity === "CRITICAL",
		).length;
		const warning = state.lastReport.findings.filter(
			(f) => f.severity === "WARNING",
		).length;
		const nit = state.lastReport.findings.filter(
			(f) => f.severity === "NIT",
		).length;
		lines.push(
			`Last findings: ${critical} critical, ${warning} warning, ${nit} nit`,
		);
	}
	return lines.join("\n");
}

function formatAdvisoryMessage(
	report: ReviewReport,
	sidecar: ReviewerReportSidecarWriteResult | null = null,
): string {
	return buildSummaryFirstReviewerMessage({
		report,
		sidecar,
		title: "📋 **Post-Turn Reviewer — Advisory Report**",
	}).message;
}

function formatFixUpMessage(
	report: ReviewReport,
	sidecar: ReviewerReportSidecarWriteResult | null = null,
): string {
	const criticalFindings = report.findings.filter(
		(f) => f.severity === "CRITICAL",
	);
	const warningFindings = report.findings.filter(
		(f) => f.severity === "WARNING",
	);
	return buildSummaryFirstReviewerMessage({
		report: {
			...report,
			findings: [...criticalFindings, ...warningFindings],
		},
		sidecar,
		title: "🚨 **Post-Turn Reviewer — Issues Found**",
	}).message;
}

function formatEscalationMessage(
	report: ReviewReport,
	loopCount: number,
	sidecar: ReviewerReportSidecarWriteResult | null = null,
): string {
	return buildSummaryFirstReviewerMessage({
		report,
		sidecar,
		title: `⚠️ **Post-Turn Reviewer — Max Re-Review Exceeded** after ${loopCount} pass(es).`,
	}).message;
}

function buildReviewerTranscriptSidecarContent(
	rawOutput: string,
	stderr: string,
): string {
	if (!stderr || stderr === rawOutput) return rawOutput;
	if (!rawOutput) return stderr;
	return `${rawOutput}\n\n--- stderr ---\n${stderr}`;
}

function createInitialState(config: ReviewConfig): ReviewerState {
	return {
		phase: "IDLE",
		loopCount: 0,
		lastReport: null,
		latestReportSidecar: null,
		pendingFiles: [],
		linterClean: false,
		linterCleanAt: null,
		config,
		reviewTimerId: null,
		lastUserPrompt: "",
		lastScannedIdx: 0,
	};
}

function transition(state: ReviewerState, nextPhase: ReviewerPhase): void {
	state.phase = nextPhase;
}

// ── Orchestrator implementation ──────────────────────────────────────────

export function createReviewerOrchestrator(
	pi: ExtensionAPI,
	deps: Partial<ReviewerOrchestratorDeps> = {},
): ReviewerOrchestrator {
	let state: ReviewerState = createInitialState(DEFAULT_REVIEW_CONFIG);
	let skipFilter: Awaited<
		ReturnType<ReviewerOrchestratorDeps["loadSkipFilter"]>
	> | null = null;

	const fullDeps: ReviewerOrchestratorDeps = {
		loadConfig: async (cwd) =>
			(await import("./config.js")).loadReviewConfig(cwd),
		loadSkipFilter: (cwd, skipFile) =>
			import("./reviewer-skip.js").then((m) =>
				m.loadSkipFilter(cwd, skipFile),
			) as unknown as Awaited<
				ReturnType<ReviewerOrchestratorDeps["loadSkipFilter"]>
			>,
		countDiffLines: countDiffLinesFast,
		runReview: async (task, files, cwd, config, filterOptions, signal) => {
			const promptsDir = fullDeps.getPromptsDir();
			const systemPrompt = fullDeps.getSystemPrompt(promptsDir);
			const diff = await gatherDiff(
				files,
				cwd,
				config.maxDiffLines,
				filterOptions,
			);
			const taskPrompt = fullDeps.getTaskPrompt(promptsDir, task, files, diff);
			return spawnReviewer(taskPrompt, systemPrompt, config, cwd, signal);
		},
		writeSidecar: async (report, ctx) =>
			writeReviewerReportSidecar({
				report,
				sessionId: deriveSessionId(ctx),
			}),
		getSystemPrompt: readSystemPrompt,
		getTaskPrompt: renderTaskTemplate,
		getPromptsDir: () => {
			const sourcePath = fileURLToPath(import.meta.url);
			const packageRoot = path.resolve(path.dirname(sourcePath), "..", "..");
			return path.join(packageRoot, "src", "reviewer", "prompts");
		},
		...deps,
	};

	function safeNotify(
		ctx: ExtensionContext,
		message: string,
		level: "error" | "warning" | "info",
	): void {
		if (ctx.hasUI) {
			ctx.ui.notify(message, level);
		}
	}

	function safeSetStatus(ctx: ExtensionContext, text: string): void {
		if (ctx.hasUI) {
			ctx.ui.setStatus("post-turn-reviewer", text);
		}
	}

	function buildFilterOptions() {
		return {
			respectGitignore: state.config.respectGitignore,
			skipFilter,
		};
	}

	async function writeLatestReviewerSidecar(
		ctx: ExtensionContext,
		report: string,
	): Promise<ReviewerReportSidecarWriteResult> {
		const sidecar = await fullDeps.writeSidecar(report, ctx);
		state.latestReportSidecar = sidecar.ok
			? {
					id: sidecar.metadata.id,
					path: sidecar.metadata.path,
					redactedChars: sidecar.metadata.redactedChars,
				}
			: null;
		return sidecar;
	}

	function latestReviewerSidecarWriteResult(): ReviewerReportSidecarWriteResult | null {
		if (!state.latestReportSidecar) return null;
		return {
			ok: true,
			metadata:
				state.latestReportSidecar as ReviewerReportSidecarWriteResult["metadata"],
		};
	}

	function updateUserPromptCache(ctx: ExtensionContext): void {
		const branch = ctx.sessionManager.getBranch();
		const startIdx = state.lastScannedIdx;

		for (let i = startIdx; i < branch.length; i++) {
			const entry = branch[i];
			if (entry.type !== "message") continue;
			const msg = (
				entry as {
					message?: {
						role?: string;
						content?: string | Array<{ type?: string; text?: string }>;
					};
				}
			).message;
			if (msg?.role !== "user") continue;

			const content = msg.content;
			if (!content) continue;

			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.filter((p) => p.type === "text" && typeof p.text === "string")
								.map((p) => p.text)
								.join("\n")
						: "";

			if (text.trim().length > 0) {
				state.lastUserPrompt = text.trim();
			}
		}

		state.lastScannedIdx = branch.length;
	}

	function checkForLinterStatus(ctx: ExtensionContext): void {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type !== "custom_message") continue;
			if (
				(entry as { customType?: string }).customType !==
				"post-turn-linter-status"
			)
				continue;

			const details = entry as {
				content?: string;
				details?: { status?: string; files?: string[]; timestamp?: number };
			};
			if (details.details?.status === "clean") {
				state.linterClean = true;
				state.linterCleanAt = details.details?.timestamp ?? Date.now();
				if (details.details?.files && details.details.files.length > 0) {
					state.pendingFiles = details.details.files;
				}
			} else if (details.details?.status === "findings") {
				state.linterClean = false;
				state.pendingFiles = [];
			}
			break;
		}
	}

	async function handleIdle(ctx: ExtensionContext): Promise<void> {
		if (!state.config.enabled) return;
		if (!state.linterClean) return;
		if (state.pendingFiles.length === 0) return;

		if (state.reviewTimerId) {
			clearTimeout(state.reviewTimerId);
			state.reviewTimerId = null;
		}

		transition(state, "GATHERING");

		const diffLines = await fullDeps.countDiffLines(
			state.pendingFiles,
			ctx.cwd,
		);
		if (diffLines < state.config.minChangedLines) {
			safeNotify(
				ctx,
				`🔍 Post-Turn Reviewer: skipping — ${diffLines} changed lines below threshold (${state.config.minChangedLines}).`,
				"info",
			);
			transition(state, "IDLE");
			return;
		}
		if (
			state.config.maxChangedLines > 0 &&
			diffLines > state.config.maxChangedLines
		) {
			safeNotify(
				ctx,
				`🔍 Post-Turn Reviewer: skipping — ${diffLines} changed lines exceed max (${state.config.maxChangedLines}). Too large for effective review.`,
				"warning",
			);
			transition(state, "IDLE");
			return;
		}

		if (state.config.reviewDelayMs > 0) {
			safeNotify(
				ctx,
				`🔍 Post-Turn Reviewer: waiting ${state.config.reviewDelayMs}ms for main agent to finish...`,
				"info",
			);
			state.reviewTimerId = setTimeout(() => {
				state.reviewTimerId = null;
				if (!state.config.enabled || state.phase !== "GATHERING") {
					return;
				}
				void runReview(ctx, false);
			}, state.config.reviewDelayMs);
			return;
		}

		transition(state, "GATHERING");
		await runReview(ctx, false);
	}

	async function handleFixRequested(ctx: ExtensionContext): Promise<void> {
		if (!state.linterClean) return;
		if (state.pendingFiles.length === 0) return;

		state.loopCount++;

		if (state.loopCount > state.config.maxReReviewPasses) {
			if (state.lastReport) {
				const msg = formatEscalationMessage(
					state.lastReport,
					state.loopCount,
					latestReviewerSidecarWriteResult(),
				);
				pi.sendMessage({
					customType: "post-turn-reviewer-escalation",
					content: msg,
					display: true,
				});
			}
			transition(state, "IDLE");
			return;
		}

		transition(state, "RE_REVIEWING");
		await runReview(ctx, true);
	}

	async function runReview(
		ctx: ExtensionContext,
		isReReview: boolean,
	): Promise<void> {
		try {
			const task =
				state.lastUserPrompt ||
				extractOriginalTask(ctx.sessionManager.getBranch());
			if (!task) {
				safeNotify(
					ctx,
					"🔍 Post-Turn Reviewer: no task found in session, skipping review.",
					"info",
				);
				transition(state, "IDLE");
				return;
			}

			transition(state, isReReview ? "RE_REVIEWING" : "REVIEWING");
			safeSetStatus(
				ctx,
				isReReview
					? `re-reviewing (pass ${state.loopCount}/${state.config.maxReReviewPasses})`
					: "reviewing",
			);

			const childOutput = await fullDeps.runReview(
				task,
				state.pendingFiles,
				ctx.cwd,
				state.config,
				buildFilterOptions(),
			);

			if (!childOutput) {
				safeNotify(
					ctx,
					"🔍 Post-Turn Reviewer: child process returned no output.",
					"warning",
				);
				transition(state, "IDLE");
				safeSetStatus(ctx, "");
				return;
			}

			if (childOutput.timedOut) {
				const modelInfo = state.config.model
					? `model: ${state.config.model}`
					: "model: session default";
				const sidecar = await writeLatestReviewerSidecar(
					ctx,
					buildReviewerTranscriptSidecarContent(
						childOutput.rawOutput,
						childOutput.stderr,
					),
				);
				safeNotify(
					ctx,
					`🔍 Post-Turn Reviewer: timed out after ${state.config.timeoutMs / 1000}s (${modelInfo}). Raw output/stderr omitted; use /reviewer-report preview or slice for redacted details.`,
					"warning",
				);
				pi.appendEntry("post-turn-reviewer-timeout", {
					timeoutMs: state.config.timeoutMs,
					exitCode: childOutput.exitCode,
					partialOutputLength: childOutput.rawOutput.length,
					stderrLength: childOutput.stderr.length,
					model: state.config.model ?? "session-default",
					command: childOutput.command,
					promptLength: task.length,
					sidecar: sidecar.ok ? sidecar.metadata : undefined,
					sidecarError: sidecar.ok ? undefined : sidecar.error,
				});
				transition(state, "IDLE");
				safeSetStatus(ctx, "");
				return;
			}

			const report = childOutput.report;
			if (!report) {
				const hasReportMarker =
					childOutput.rawOutput?.includes("## Review Report") ?? false;
				const sidecar = await writeLatestReviewerSidecar(
					ctx,
					buildReviewerTranscriptSidecarContent(
						childOutput.rawOutput,
						childOutput.stderr,
					),
				);
				safeNotify(
					ctx,
					buildBoundedReviewerFailureMessage({
						title:
							"🔍 Post-Turn Reviewer: could not parse review report from child output.",
						rawOutput: childOutput.rawOutput,
						stderr: childOutput.stderr,
						sidecar,
						hints: hasReportMarker
							? undefined
							: [
									"Missing '## Review Report' marker — model may not have followed the output format.",
								],
					}),
					"warning",
				);
				pi.appendEntry("post-turn-reviewer-parse-fail", {
					rawOutputLength: childOutput.rawOutput.length,
					hasReportMarker,
					stderrLength: childOutput.stderr.length,
					exitCode: childOutput.exitCode,
					command: childOutput.command,
					sidecar: sidecar.ok ? sidecar.metadata : undefined,
					sidecarError: sidecar.ok ? undefined : sidecar.error,
				});
				transition(state, "IDLE");
				safeSetStatus(ctx, "");
				return;
			}

			const sidecar = await writeLatestReviewerSidecar(
				ctx,
				buildReviewerTranscriptSidecarContent(
					childOutput.rawOutput,
					childOutput.stderr,
				),
			);
			state.lastReport = report;
			safeSetStatus(ctx, "");

			await processReport(report, ctx, isReReview, sidecar);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			safeNotify(ctx, `🔍 Post-Turn Reviewer error: ${message}`, "error");
			transition(state, "IDLE");
			safeSetStatus(ctx, "");
		}
	}

	async function processReport(
		report: ReviewReport,
		ctx: ExtensionContext,
		isReReview: boolean,
		sidecar: ReviewerReportSidecarWriteResult | null,
	): Promise<void> {
		pi.appendEntry("post-turn-reviewer-report", {
			status: report.status,
			confidence: report.confidence,
			findingsCount: report.findings.length,
			loopCount: state.loopCount,
			isReReview,
			sidecar: sidecar?.ok ? sidecar.metadata : undefined,
			sidecarError: sidecar?.ok ? undefined : sidecar?.error,
		});

		const hasActionableFindings = report.findings.some((f) =>
			severityMeetsThreshold(f.severity, state.config.autoFixThreshold),
		);

		if (report.status === "CANNOT_REVIEW") {
			safeNotify(
				ctx,
				buildSummaryFirstReviewerMessage({
					report,
					sidecar,
					title: "🔍 Post-Turn Reviewer: could not complete review.",
					maxFindings: 0,
				}).message,
				"warning",
			);
			transition(state, "IDLE");
			return;
		}

		if (!hasActionableFindings) {
			if (report.findings.length > 0) {
				pi.sendMessage({
					customType: "post-turn-reviewer-advisory",
					content: formatAdvisoryMessage(report, sidecar),
					display: true,
				});
			} else {
				safeNotify(
					ctx,
					`🔍 Post-Turn Reviewer: PASS (${report.confidence} confidence)`,
					"info",
				);
			}
			transition(state, "IDLE");
			return;
		}

		if (isReReview && state.loopCount >= state.config.maxReReviewPasses) {
			pi.sendMessage({
				customType: "post-turn-reviewer-escalation",
				content: formatEscalationMessage(report, state.loopCount, sidecar),
				display: true,
			});
			transition(state, "IDLE");
			return;
		}

		pi.sendMessage({
			customType: "post-turn-reviewer-findings",
			content: formatFixUpMessage(report, sidecar),
			display: true,
		});

		state.linterClean = false;
		transition(state, "FIX_REQUESTED");

		const fixInstruction = buildFixInstruction(report);
		setTimeout(() => pi.sendUserMessage(fixInstruction), 0);
	}

	function buildFixInstruction(report: ReviewReport): string {
		const criticalFiles = [
			...new Set(
				report.findings
					.filter((f) =>
						severityMeetsThreshold(f.severity, state.config.autoFixThreshold),
					)
					.map((f) => f.file.split(":")[0]),
			),
		];
		return [
			"Fix the issues reported by the post-turn-reviewer.",
			`Affected files: ${criticalFiles.join(", ")}`,
			"",
			"Use the post-turn-reviewer findings already in session context as the source of truth.",
			"Address each CRITICAL finding. Focus on the specific files and lines cited.",
			"After fixing the files, stop.",
		].join("\n");
	}

	return {
		async initialize(ctx: ExtensionContext): Promise<void> {
			let config = await fullDeps.loadConfig(ctx.cwd);

			if (config.model && ctx.modelRegistry) {
				const available = ctx.modelRegistry.getAvailable();
				const match = available.find(
					(m) =>
						`${m.provider}/${m.id}` === config.model || m.id === config.model,
				);
				if (!match) {
					safeNotify(
						ctx,
						`🔍 Post-Turn Reviewer: configured model "${config.model}" not found in registry. Falling back to session default.`,
						"warning",
					);
					config = { ...config, model: null };
				}
			}

			state = createInitialState(config);
			skipFilter = await fullDeps.loadSkipFilter(ctx.cwd, config.skipFile);

			safeNotify(
				ctx,
				`🔍 Post-Turn Reviewer: ready (model: ${config.model ?? "session default"}, threshold: ${config.autoFixThreshold})`,
				"info",
			);
		},

		async shutdown(_ctx: ExtensionContext): Promise<void> {
			if (state.reviewTimerId) {
				clearTimeout(state.reviewTimerId);
				state.reviewTimerId = null;
			}
			state = createInitialState(state.config);
		},

		onLinterClean(files: string[], timestamp?: number): void {
			state.linterClean = true;
			state.linterCleanAt = timestamp ?? Date.now();
			state.pendingFiles = files;
		},

		async onTurnEnd(ctx: ExtensionContext): Promise<void> {
			if (
				state.phase === "GATHERING" ||
				state.phase === "REVIEWING" ||
				state.phase === "RE_REVIEWING"
			) {
				return;
			}

			checkForLinterStatus(ctx);
			updateUserPromptCache(ctx);

			switch (state.phase) {
				case "IDLE":
					await handleIdle(ctx);
					break;
				case "FIX_REQUESTED":
					await handleFixRequested(ctx);
					break;
				default:
					break;
			}
		},

		async requestReview(
			ctx: ExtensionContext,
			options: { isReReview?: boolean; files?: string[] } = {},
		): Promise<void> {
			if (state.phase !== "IDLE" && state.phase !== "FIX_REQUESTED") {
				safeNotify(
					ctx,
					`🔍 Reviewer busy (phase: ${state.phase}). Wait for the current review to finish.`,
					"warning",
				);
				return;
			}
			const isReReview = options.isReReview ?? false;
			if (options.files && options.files.length > 0) {
				state.pendingFiles = options.files;
			}
			if (isReReview) {
				state.loopCount++;
				if (state.loopCount > state.config.maxReReviewPasses) {
					state.loopCount = state.config.maxReReviewPasses;
				}
			}
			state.linterClean = true;
			transition(state, isReReview ? "RE_REVIEWING" : "GATHERING");
			await runReview(ctx, isReReview);
		},

		setModel(model: string | null): void {
			state.config = { ...state.config, model };
		},

		updateConfig(updater: (config: ReviewConfig) => ReviewConfig): void {
			state.config = updater(state.config);
		},

		registerCommands(pi: ExtensionAPI): void {
			pi.registerCommand("reviewer-status", {
				description: "Show post-turn-reviewer state",
				handler: async (_args, ctx) => {
					safeNotify(ctx, formatPhaseStatus(state, state.config), "info");
				},
			});

			pi.registerCommand("reviewer-run", {
				description:
					"Manually trigger a post-turn review. Optionally pass file paths.",
				handler: async (args, ctx) => {
					if (state.phase !== "IDLE" && state.phase !== "FIX_REQUESTED") {
						safeNotify(
							ctx,
							`🔍 Reviewer busy (phase: ${state.phase}). Wait for the current review to finish.`,
							"warning",
						);
						return;
					}

					const requestedFiles = (args || "")
						.trim()
						.split(/\s+/)
						.filter((p) => p.length > 0);

					const isReReview = state.phase === "FIX_REQUESTED";
					await this.requestReview(ctx, {
						isReReview,
						files: requestedFiles.length > 0 ? requestedFiles : undefined,
					});
				},
			});

			pi.registerCommand("reviewer-report", {
				description:
					"Recover the latest redacted post-turn-reviewer sidecar. Usage: /reviewer-report [metadata|preview|slice|full] [--offset=N] [--length=N] [--ack-context-cost]. Full mode always requires --ack-context-cost.",
				handler: async (args, ctx) => {
					if (!state.latestReportSidecar) {
						safeNotify(
							ctx,
							"reviewer-report: no latest reviewer sidecar is available",
							"info",
						);
						return;
					}

					const { recoverReviewerReportSidecar, parseReportRecoveryArgs } =
						await import("./report-hygiene.js");
					const parsed = parseReportRecoveryArgs(args);
					try {
						const recovered = await recoverReviewerReportSidecar({
							recordPath: state.latestReportSidecar.path,
							mode: parsed.mode,
							acknowledgeContextCost: parsed.acknowledgeContextCost,
							offset: parsed.offset,
							length: parsed.length,
						});

						pi.sendMessage({
							customType: "post-turn-reviewer-report",
							content: recovered.content,
							display: true,
							details: {
								mode: recovered.mode,
								sidecar: recovered.metadata,
							},
						});
					} catch (error) {
						const errorMessage =
							error instanceof Error ? error.message : String(error);
						safeNotify(ctx, `reviewer-report: ${errorMessage}`, "error");
						pi.sendMessage({
							customType: "post-turn-reviewer-report-status",
							content: `reviewer-report: ${errorMessage}`,
							display: false,
							details: {
								status: "error",
								mode: parsed.mode,
								sidecar: state.latestReportSidecar,
							},
						});
					}
				},
			});

			pi.registerCommand("reviewer-toggle", {
				description: "Enable or disable the post-turn reviewer.",
				handler: async (args, ctx) => {
					const arg = (args || "").trim().toLowerCase();
					if (arg === "on" || arg === "enable") {
						state.config = { ...state.config, enabled: true };
						safeNotify(ctx, "🔍 Post-Turn Reviewer: enabled.", "info");
					} else if (arg === "off" || arg === "disable") {
						state.config = { ...state.config, enabled: false };
						if (state.reviewTimerId) {
							clearTimeout(state.reviewTimerId);
							state.reviewTimerId = null;
						}
						if (state.phase !== "IDLE") {
							transition(state, "IDLE");
						}
						safeNotify(ctx, "🔍 Post-Turn Reviewer: disabled.", "info");
					} else {
						state.config = {
							...state.config,
							enabled: !state.config.enabled,
						};
						if (!state.config.enabled) {
							if (state.reviewTimerId) {
								clearTimeout(state.reviewTimerId);
								state.reviewTimerId = null;
							}
							if (state.phase !== "IDLE") {
								transition(state, "IDLE");
							}
						}
						safeNotify(
							ctx,
							`🔍 Post-Turn Reviewer: ${state.config.enabled ? "enabled" : "disabled"}.`,
							"info",
						);
					}
				},
			});
		},

		getStateSnapshot(): ReviewerStateSnapshot {
			return {
				phase: state.phase,
				loopCount: state.loopCount,
				linterClean: state.linterClean,
				pendingFiles: [...state.pendingFiles],
				config: { ...state.config },
				lastReport: state.lastReport,
				latestReportSidecar: state.latestReportSidecar
					? { ...state.latestReportSidecar }
					: null,
			};
		},
	};
}

// ── Test exports ─────────────────────────────────────────────────────────

export const __test__ = {
	severityMeetsThreshold,
	formatPhaseStatus,
	formatAdvisoryMessage,
	formatFixUpMessage,
	formatEscalationMessage,
	buildReviewerTranscriptSidecarContent,
	createInitialState,
	transition,
};
