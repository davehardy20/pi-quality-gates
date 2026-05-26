import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { stopAllLspClients } from "../shared/lsp-service.js";
import {
	DEFAULT_CONFIG,
	loadLinterConfig,
	MAX_MODIFIED_FILES,
	mergeValidationOutcomes,
	runQueuedLintChecks,
} from "./core.js";
import { runQueuedLspChecks } from "./lsp.js";
import {
	buildSummaryFirstLintMessage,
	deriveSessionId,
	type LinterReportSidecarMetadata,
	type LinterReportSidecarWriteResult,
	parseReportRecoveryArgs,
	recoverLinterReportSidecar,
	writeLinterReportSidecar,
} from "./report-hygiene.js";
import type {
	CombinedValidationOutcome,
	LspDiagnosticsConfig,
	ReportMode,
} from "./types.js";

interface PostTurnLinterDependencies {
	existsSync: typeof existsSync;
	loadLinterConfig: typeof loadLinterConfig;
	runQueuedLintChecks: typeof runQueuedLintChecks;
	runQueuedLspChecks: typeof runQueuedLspChecks;
	mergeValidationOutcomes: typeof mergeValidationOutcomes;
	setTimeout: (callback: () => void, ms?: number) => unknown;
	statSync: (path: string) => { mtimeMs: number; size: number };
	writeLinterReportSidecar: typeof writeLinterReportSidecar;
	recoverLinterReportSidecar: typeof recoverLinterReportSidecar;
}

interface State {
	modifiedFiles: Set<string>;
	pendingToolFiles: Map<string, string[]>;
	lastRunAt: number;
	runInProgress: boolean;
	shutDown: boolean;
	lastReportedSignature: string | null;
	latestLintMessage: string | null;
	latestFiles: string[];
	latestReportId: number;
	latestReportSidecar: LinterReportSidecarMetadata | null;
	pendingFixReportId: number | null;
	cooldownMs: number;
	reportMode: ReportMode;
	recentlyClean: Map<string, { mtimeMs: number; size: number }>;
	lspConfig: LspDiagnosticsConfig;
}

function normalizeFilePath(path: string | undefined): string | null {
	if (!path) return null;
	try {
		return resolve(path);
	} catch {
		return null;
	}
}

function detectModifiedFilesFromToolEvent(event: {
	toolName?: string;
	args?: Record<string, unknown>;
	input?: Record<string, unknown>;
}): string[] {
	const params = event.args ?? event.input;
	switch (event.toolName) {
		case "write":
		case "edit":
		case "create_text_file": {
			const path = typeof params?.path === "string" ? params.path : undefined;
			const normalized = normalizeFilePath(path);
			return normalized ? [normalized] : [];
		}
		case "hashline_edit": {
			const path =
				typeof params?.filePath === "string" ? params.filePath : undefined;
			const rename =
				typeof params?.rename === "string" ? params.rename : undefined;
			if (rename) {
				const renamed = normalizeFilePath(rename);
				return renamed ? [renamed] : [];
			}
			const normalized = normalizeFilePath(path);
			return normalized ? [normalized] : [];
		}
		case "lsp_rename": {
			const path =
				typeof params?.filePath === "string" ? params.filePath : undefined;
			const normalized = normalizeFilePath(path);
			return normalized ? [normalized] : [];
		}
		case "ast_grep_replace": {
			const paths = params?.paths;
			if (Array.isArray(paths)) {
				return paths
					.map((p) => (typeof p === "string" ? normalizeFilePath(p) : null))
					.filter((p): p is string => Boolean(p));
			}
			return [];
		}
		default:
			return [];
	}
}

function detectModifiedFilesFromToolResult(event: {
	toolName?: string;
	result?: Record<string, unknown>;
}): string[] | null {
	// Shared contract: any mutating tool can emit details.modifiedFiles
	if (event.result?.details) {
		const details = event.result.details as Record<string, unknown>;
		const modifiedFiles = details.modifiedFiles;
		if (Array.isArray(modifiedFiles)) {
			return modifiedFiles
				.map((p) => (typeof p === "string" ? normalizeFilePath(p) : null))
				.filter((p): p is string => Boolean(p));
		}
	}

	// Legacy fallback for lsp_rename before shared contract adoption
	if (event.toolName === "lsp_rename" && event.result?.details) {
		const details = event.result.details as Record<string, unknown>;
		const edit = details.edit as Record<string, unknown> | undefined;
		if (edit?.changes) {
			const changes = edit.changes as Record<string, unknown[]>;
			return Object.keys(changes)
				.map((uri) => {
					try {
						return normalizeFilePath(new URL(uri).pathname);
					} catch {
						return null;
					}
				})
				.filter((p): p is string => Boolean(p));
		}
	}
	return null;
}

function buildReportSignature(files: string[], report: string): string {
	return JSON.stringify({ files: [...files].sort(), report });
}

function getFileStats(
	filePath: string,
	statFn: PostTurnLinterDependencies["statSync"],
): { mtimeMs: number; size: number } | null {
	try {
		const s = statFn(filePath);
		return { mtimeMs: s.mtimeMs, size: s.size };
	} catch {
		return null;
	}
}

function isStillClean(
	filePath: string,
	recentlyClean: Map<string, { mtimeMs: number; size: number }>,
	statFn: PostTurnLinterDependencies["statSync"],
): boolean {
	const cached = recentlyClean.get(filePath);
	if (!cached) return false;
	const current = getFileStats(filePath, statFn);
	if (!current) return false;
	return current.mtimeMs === cached.mtimeMs && current.size === cached.size;
}

function parseFixReportId(args: string | undefined): number | null {
	const match = (args || "").match(/(?:^|\s)--report-id=(\d+)(?:\s|$)/);
	if (!match) return null;
	const reportId = Number.parseInt(match[1], 10);
	return Number.isFinite(reportId) ? reportId : null;
}

function reconstructLspConfig(
	ctx: ExtensionContext,
): LspDiagnosticsConfig | null {
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom_message") continue;
		if (entry.customType !== "post-turn-linter") continue;
		const details = entry.details as
			| { lspConfig?: LspDiagnosticsConfig }
			| undefined;
		if (details?.lspConfig) {
			return details.lspConfig;
		}
	}
	return null;
}

function reconstructLatestReport(ctx: ExtensionContext): {
	reportId: number;
	sidecar: LinterReportSidecarMetadata | null;
	affectedFiles: string[];
	message: string | null;
} | null {
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom_message") continue;
		if (entry.customType !== "post-turn-linter") continue;
		const details = entry.details as
			| {
					summary?: {
						reportId?: number;
						sidecar?: LinterReportSidecarMetadata;
						affectedFiles?: string[];
					};
			  }
			| undefined;
		const reportId = details?.summary?.reportId;
		if (typeof reportId !== "number" || !Number.isFinite(reportId)) {
			continue;
		}
		const content = (entry as { content?: unknown }).content;
		return {
			reportId,
			sidecar: details?.summary?.sidecar ?? null,
			affectedFiles: details?.summary?.affectedFiles ?? [],
			message: typeof content === "string" ? content : null,
		};
	}
	return null;
}

function tokenizeArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuote = false;
	let quoteChar = "";

	for (let i = 0; i < input.length; i++) {
		const char = input[i];

		if (inQuote) {
			if (char === quoteChar) {
				inQuote = false;
				quoteChar = "";
				tokens.push(current);
				current = "";
			} else {
				current += char;
			}
			continue;
		}

		if (char === '"' || char === "'") {
			inQuote = true;
			quoteChar = char;
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (current) tokens.push(current);
	return tokens;
}

export function createPostTurnLinter(
	pi: ExtensionAPI,
	deps: PostTurnLinterDependencies = {
		existsSync,
		loadLinterConfig,
		runQueuedLintChecks,
		runQueuedLspChecks,
		mergeValidationOutcomes,
		setTimeout,
		statSync,
		writeLinterReportSidecar,
		recoverLinterReportSidecar,
	},
) {
	const state: State = {
		modifiedFiles: new Set<string>(),
		pendingToolFiles: new Map<string, string[]>(),
		lastRunAt: 0,
		runInProgress: false,
		shutDown: false,
		lastReportedSignature: null,
		latestLintMessage: null,
		latestFiles: [],
		latestReportId: 0,
		latestReportSidecar: null,
		pendingFixReportId: null,
		cooldownMs: DEFAULT_CONFIG.cooldownMs ?? 15_000,
		reportMode: DEFAULT_CONFIG.reportMode ?? "report-only",
		recentlyClean: new Map<string, { mtimeMs: number; size: number }>(),
		lspConfig: DEFAULT_CONFIG.lsp ?? { enabled: false },
	};

	const cwd = () => process.cwd();

	function safeNotify(
		ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
		message: string,
		level: "error" | "warning" | "info",
	) {
		if (ctx.hasUI) {
			ctx.ui.notify(message, level);
		}
	}

	function safeSetStatus(
		ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
		text: string,
	) {
		if (ctx.hasUI) {
			ctx.ui.setStatus("post-turn-linter", text);
		}
	}

	function buildFixInstruction(): string {
		const sidecarHint = state.latestReportSidecar
			? "Full redacted report recovery is available with /post-turn-linter-report preview or /post-turn-linter-report slice --offset=0 --length=4000 if the concise summary is insufficient."
			: "No linter sidecar is available; use the concise summary already in session context.";
		return [
			"Fix the issues reported by the most recent post-turn-linter summary.",
			"",
			"Bounded post-turn-linter summary:",
			state.latestLintMessage,
			"",
			`Affected files: ${state.latestFiles.join(", ") || "unknown"}`,
			sidecarHint,
			"After fixing the files, stop.",
		].join("\n");
	}

	function requestFixTurn(
		ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
		reportId = state.latestReportId,
	): boolean {
		if (!state.latestLintMessage || reportId !== state.latestReportId) {
			return false;
		}
		if (state.pendingFixReportId === reportId) {
			return false;
		}

		state.pendingFixReportId = reportId;
		const tryStartFixTurn = () => {
			if (state.pendingFixReportId !== reportId) {
				return;
			}
			if (!state.latestLintMessage || reportId !== state.latestReportId) {
				state.pendingFixReportId = null;
				return;
			}
			if (!ctx.isIdle()) {
				deps.setTimeout(tryStartFixTurn, 250);
				return;
			}

			state.pendingFixReportId = null;
			safeNotify(ctx, "post-turn-linter: starting fix turn", "info");
			pi.sendUserMessage(buildFixInstruction());
		};

		deps.setTimeout(tryStartFixTurn, 0);
		return true;
	}

	async function reportLintFindings(
		filesToLint: string[],
		ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
		options?: { forceTriggerTurn?: boolean; skipDedup?: boolean },
	) {
		if (state.shutDown) return;
		safeSetStatus(ctx, "post-turn-linter: running");

		const lintResult = await deps.runQueuedLintChecks(filesToLint, cwd());
		if (state.shutDown) return;
		let result: CombinedValidationOutcome = lintResult;

		if (state.lspConfig.enabled) {
			const lspResult = await deps.runQueuedLspChecks({
				filePaths: filesToLint,
				cwd: cwd(),
				ctx,
				config: state.lspConfig,
			});
			if (state.shutDown) return;
			result = deps.mergeValidationOutcomes({
				reportMode: lintResult.reportMode,
				results: [lintResult, lspResult],
			});
		}

		state.reportMode = result.reportMode;

		if (result.kind === "tool-error") {
			safeSetStatus(ctx, "post-turn-linter: tool error");
			safeNotify(ctx, `post-turn-linter: ${result.report}`, "error");
			state.lastReportedSignature = null;
			state.latestLintMessage = null;
			state.latestFiles = [];
			state.pendingFixReportId = null;
			state.latestReportSidecar = null;

			pi.sendMessage({
				customType: "post-turn-linter-status",
				content: `post-turn-linter: tool error (${filesToLint.length} file(s) checked)`,
				display: false,
				details: { status: "tool-error", files: filesToLint },
			});

			return;
		}

		if (result.kind === "clean") {
			safeSetStatus(ctx, "post-turn-linter: clean");
			safeNotify(ctx, "post-turn-linter: no lint findings", "info");
			state.lastReportedSignature = null;
			state.latestLintMessage = null;
			state.latestFiles = [];
			state.pendingFixReportId = null;
			state.latestReportSidecar = null;

			pi.sendMessage({
				customType: "post-turn-linter-status",
				content: `post-turn-linter: clean (${filesToLint.length} file(s) checked)`,
				display: false,
				details: { status: "clean", files: filesToLint },
			});

			for (const filePath of filesToLint) {
				const stats = getFileStats(filePath, deps.statSync);
				if (stats) {
					state.recentlyClean.set(filePath, stats);
				}
			}
			return;
		}

		const report = result.report;
		const filesWithErrors = new Set(result.affectedFiles);
		for (const filePath of filesToLint) {
			if (!filesWithErrors.has(filePath)) {
				const stats = getFileStats(filePath, deps.statSync);
				if (stats) {
					state.recentlyClean.set(filePath, stats);
				}
			}
		}

		const signature = buildReportSignature(filesToLint, result.signature);
		if (!options?.skipDedup && signature === state.lastReportedSignature) {
			safeNotify(
				ctx,
				"post-turn-linter: same findings already reported",
				"info",
			);
			safeSetStatus(ctx, "post-turn-linter: same findings already reported");
			return;
		}
		state.lastReportedSignature = signature;

		state.latestReportId += 1;
		const reportId = state.latestReportId;
		let sidecar: LinterReportSidecarWriteResult | null = null;
		try {
			sidecar = await deps.writeLinterReportSidecar({
				report,
				sessionId: deriveSessionId(ctx),
			});
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			safeNotify(
				ctx,
				`post-turn-linter: failed to write report sidecar: ${errorMessage}`,
				"warning",
			);
		}

		const summary = buildSummaryFirstLintMessage({
			report,
			filesChecked: filesToLint,
			affectedFiles: result.affectedFiles,
			cwd: cwd(),
			reportId,
			sidecar,
		});
		const message = summary.message;
		state.latestLintMessage = message;
		state.latestFiles = result.affectedFiles;
		state.latestReportSidecar = summary.details.sidecar ?? null;
		state.pendingFixReportId = null;
		const shouldTriggerTurn =
			options?.forceTriggerTurn ?? result.reportMode === "auto-follow-up";

		pi.sendMessage({
			customType: "post-turn-linter",
			content: message,
			display: true,
			details: { lspConfig: state.lspConfig, summary: summary.details },
		});

		pi.sendMessage({
			customType: "post-turn-linter-status",
			content: `post-turn-linter: findings (${result.affectedFiles.length} file(s) affected)`,
			display: false,
			details: {
				status: "findings",
				files: filesToLint,
				affectedFiles: result.affectedFiles,
				summary: summary.details,
			},
		});

		if (shouldTriggerTurn) {
			const queued = requestFixTurn(ctx, state.latestReportId);
			safeNotify(
				ctx,
				queued
					? "post-turn-linter: requesting auto-fix turn"
					: "post-turn-linter: auto-fix already pending",
				"info",
			);
		}

		safeSetStatus(ctx, "post-turn-linter: findings reported");
	}

	pi.on("session_start", async (_event, ctx) => {
		const config = await deps.loadLinterConfig(cwd());
		const persistedLspConfig = reconstructLspConfig(ctx);
		const persistedLatestReport = reconstructLatestReport(ctx);
		state.modifiedFiles.clear();
		state.pendingToolFiles.clear();
		state.lastRunAt = 0;
		state.runInProgress = false;
		state.shutDown = false;
		state.lastReportedSignature = null;
		state.cooldownMs = config.cooldownMs ?? DEFAULT_CONFIG.cooldownMs ?? 15_000;
		state.latestLintMessage = persistedLatestReport?.message ?? null;
		state.latestFiles = persistedLatestReport?.affectedFiles ?? [];
		state.latestReportId = persistedLatestReport?.reportId ?? 0;
		state.latestReportSidecar = persistedLatestReport?.sidecar ?? null;
		state.pendingFixReportId = null;
		state.recentlyClean.clear();
		state.reportMode =
			config.reportMode ?? DEFAULT_CONFIG.reportMode ?? "report-only";
		state.lspConfig = persistedLspConfig ??
			config.lsp ??
			DEFAULT_CONFIG.lsp ?? { enabled: false };

		safeSetStatus(ctx, "post-turn-linter: ready");
	});

	pi.on("session_tree", async (_event, ctx) => {
		const persistedLspConfig = reconstructLspConfig(ctx);
		if (persistedLspConfig) {
			state.lspConfig = persistedLspConfig;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		state.shutDown = true;
		await stopAllLspClients(ctx);
		state.modifiedFiles.clear();
		state.pendingToolFiles.clear();
		state.runInProgress = false;
		state.latestLintMessage = null;
		state.latestFiles = [];
		state.latestReportId = 0;
		state.pendingFixReportId = null;
		state.latestReportSidecar = null;
		state.recentlyClean.clear();
		safeSetStatus(ctx, "");
	});

	pi.on("tool_execution_start", async (event) => {
		const filePaths = detectModifiedFilesFromToolEvent(event);
		if (filePaths.length === 0) return;
		state.pendingToolFiles.set(event.toolCallId, filePaths);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const resultFiles = detectModifiedFilesFromToolResult(event);
		let filePaths: string[];
		if (resultFiles) {
			state.pendingToolFiles.delete(event.toolCallId);
			filePaths = resultFiles;
		} else {
			filePaths = state.pendingToolFiles.get(event.toolCallId) ?? [];
			state.pendingToolFiles.delete(event.toolCallId);
		}
		if (event.isError || filePaths.length === 0) return;

		const beforeSize = state.modifiedFiles.size;
		for (const filePath of filePaths) {
			if (!deps.existsSync(filePath)) {
				state.modifiedFiles.delete(filePath);
				continue;
			}
			if (state.modifiedFiles.size >= MAX_MODIFIED_FILES) break;

			if (isStillClean(filePath, state.recentlyClean, deps.statSync)) {
				continue;
			}
			state.modifiedFiles.add(filePath);
			state.recentlyClean.delete(filePath);
		}

		if (state.modifiedFiles.size !== beforeSize) {
			safeSetStatus(
				ctx,
				`post-turn-linter: queued ${state.modifiedFiles.size} file(s)`,
			);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (state.runInProgress) return;
		if (state.shutDown) return;
		if (state.modifiedFiles.size === 0) return;

		const now = Date.now();
		if (now - state.lastRunAt < state.cooldownMs) return;

		state.runInProgress = true;
		state.lastRunAt = now;

		try {
			const filesToLint = Array.from(state.modifiedFiles).sort();
			state.modifiedFiles.clear();
			await reportLintFindings(filesToLint, ctx);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			safeNotify(ctx, `post-turn-linter failed: ${errorMessage}`, "error");
			safeSetStatus(ctx, "post-turn-linter: error");
		} finally {
			state.runInProgress = false;
		}
	});

	pi.registerCommand("post-turn-linter-run", {
		description:
			"Run post-turn-linter now. Optionally pass file paths separated by spaces. Use --no-fix to report without triggering a follow-up fix turn.",
		handler: async (args, ctx) => {
			if (state.runInProgress) {
				safeNotify(
					ctx,
					"post-turn-linter: lint run already in progress",
					"info",
				);
				return;
			}
			if (state.shutDown) {
				safeNotify(ctx, "post-turn-linter: session is shutting down", "info");
				return;
			}

			const rawArgs = (args || "").trim();
			const shouldTriggerFixTurn = !rawArgs.includes("--no-fix");
			const requestedFiles = tokenizeArgs(rawArgs)
				.filter((part) => part !== "--no-fix")
				.map((filePath) => normalizeFilePath(filePath))
				.filter((filePath): filePath is string => Boolean(filePath))
				.filter((filePath) => deps.existsSync(filePath));

			const filesToLint =
				requestedFiles.length > 0
					? Array.from(new Set(requestedFiles)).sort()
					: Array.from(state.modifiedFiles).sort();
			state.modifiedFiles.clear();

			if (filesToLint.length === 0) {
				safeNotify(
					ctx,
					"post-turn-linter: no files to lint. Pass paths or modify files in-session first.",
					"info",
				);
				return;
			}

			state.runInProgress = true;
			try {
				safeNotify(
					ctx,
					`post-turn-linter: linting ${filesToLint.length} file(s)`,
					"info",
				);
				await reportLintFindings(filesToLint, ctx, {
					forceTriggerTurn: shouldTriggerFixTurn,
					skipDedup: true,
				});
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				safeNotify(ctx, `post-turn-linter failed: ${errorMessage}`, "error");
				safeSetStatus(ctx, "post-turn-linter: error");
			} finally {
				state.runInProgress = false;
			}
		},
	});

	pi.registerCommand("post-turn-linter-fix", {
		description:
			"Start an agent turn to fix the most recent post-turn-linter findings",
		handler: async (args, ctx) => {
			const requestedReportId = parseFixReportId(args);
			if (
				requestedReportId !== null &&
				state.pendingFixReportId === requestedReportId
			) {
				state.pendingFixReportId = null;
			}

			if (
				requestedReportId !== null &&
				requestedReportId !== state.latestReportId
			) {
				safeNotify(
					ctx,
					"post-turn-linter: ignoring stale fix follow-up",
					"info",
				);
				return;
			}

			if (!state.latestLintMessage) {
				safeNotify(
					ctx,
					"post-turn-linter: no prior lint findings to fix",
					"info",
				);
				return;
			}

			if (!ctx.isIdle()) {
				const queued = requestFixTurn(
					ctx,
					requestedReportId ?? state.latestReportId,
				);
				safeNotify(
					ctx,
					queued
						? "post-turn-linter: agent busy, deferring fix turn until idle"
						: "post-turn-linter: fix turn already pending",
					"info",
				);
				return;
			}

			safeNotify(ctx, "post-turn-linter: starting fix turn", "info");
			pi.sendUserMessage(buildFixInstruction());
		},
	});

	pi.registerCommand("post-turn-linter-report", {
		description:
			"Recover the latest redacted post-turn-linter sidecar. Usage: /post-turn-linter-report [metadata|preview|slice|full] [--offset=N] [--length=N] [--ack-context-cost]",
		handler: async (args, ctx) => {
			if (!state.latestReportSidecar) {
				safeNotify(
					ctx,
					"post-turn-linter-report: no latest report sidecar is available",
					"info",
				);
				return;
			}

			const parsed = parseReportRecoveryArgs(args);
			try {
				const recovered = await deps.recoverLinterReportSidecar({
					recordPath: state.latestReportSidecar.path,
					mode: parsed.mode,
					acknowledgeContextCost: parsed.acknowledgeContextCost,
					offset: parsed.offset,
					length: parsed.length,
				});

				pi.sendMessage({
					customType: "post-turn-linter-report",
					content: recovered.content,
					display: true,
					details: {
						mode: recovered.mode,
						reportId: state.latestReportId,
						sidecar: recovered.metadata,
					},
				});
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				safeNotify(ctx, `post-turn-linter-report: ${errorMessage}`, "error");
				pi.sendMessage({
					customType: "post-turn-linter-report-status",
					content: `post-turn-linter-report: ${errorMessage}`,
					display: false,
					details: {
						status: "error",
						mode: parsed.mode,
						reportId: state.latestReportId,
						sidecar: state.latestReportSidecar,
					},
				});
			}
		},
	});

	pi.registerCommand("post-turn-linter-status", {
		description: "Show post-turn-linter state",
		handler: async (_args, ctx) => {
			safeNotify(
				ctx,
				[
					`queued files: ${state.modifiedFiles.size}`,
					`cooldownMs: ${state.cooldownMs}`,
					`reportMode: ${state.reportMode}`,
					`runInProgress: ${state.runInProgress}`,
					`latestReportId: ${state.latestReportId}`,
					`pendingFixReportId: ${state.pendingFixReportId ?? "none"}`,
					`latestReportSidecar: ${state.latestReportSidecar?.id ?? "none"}`,
				].join(" | "),
				"info",
			);
		},
	});
}

export default function postTurnLinter(pi: ExtensionAPI) {
	return createPostTurnLinter(pi);
}

export const __test__ = {
	detectModifiedFilesFromToolEvent,
	detectModifiedFilesFromToolResult,
	createPostTurnLinter,
	tokenizeArgs,
};
