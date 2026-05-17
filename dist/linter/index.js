import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { stopAllLspClients } from "../shared/lsp-service.js";
import { DEFAULT_CONFIG, loadLinterConfig, MAX_MODIFIED_FILES, mergeValidationOutcomes, runQueuedLintChecks, } from "./core.js";
import { runQueuedLspChecks } from "./lsp.js";
function normalizeFilePath(path) {
    if (!path)
        return null;
    try {
        return resolve(path);
    }
    catch {
        return null;
    }
}
function detectModifiedFilesFromToolEvent(event) {
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
            const path = typeof params?.filePath === "string" ? params.filePath : undefined;
            const rename = typeof params?.rename === "string" ? params.rename : undefined;
            if (rename) {
                const renamed = normalizeFilePath(rename);
                return renamed ? [renamed] : [];
            }
            const normalized = normalizeFilePath(path);
            return normalized ? [normalized] : [];
        }
        case "lsp_rename": {
            const path = typeof params?.filePath === "string" ? params.filePath : undefined;
            const normalized = normalizeFilePath(path);
            return normalized ? [normalized] : [];
        }
        case "ast_grep_replace": {
            const paths = params?.paths;
            if (Array.isArray(paths)) {
                return paths
                    .map((p) => (typeof p === "string" ? normalizeFilePath(p) : null))
                    .filter((p) => Boolean(p));
            }
            return [];
        }
        default:
            return [];
    }
}
function detectModifiedFilesFromToolResult(event) {
    // Shared contract: any mutating tool can emit details.modifiedFiles
    if (event.result?.details) {
        const details = event.result.details;
        const modifiedFiles = details.modifiedFiles;
        if (Array.isArray(modifiedFiles)) {
            return modifiedFiles
                .map((p) => (typeof p === "string" ? normalizeFilePath(p) : null))
                .filter((p) => Boolean(p));
        }
    }
    // Legacy fallback for lsp_rename before shared contract adoption
    if (event.toolName === "lsp_rename" && event.result?.details) {
        const details = event.result.details;
        const edit = details.edit;
        if (edit?.changes) {
            const changes = edit.changes;
            return Object.keys(changes)
                .map((uri) => {
                try {
                    return normalizeFilePath(new URL(uri).pathname);
                }
                catch {
                    return null;
                }
            })
                .filter((p) => Boolean(p));
        }
    }
    return null;
}
function buildReportSignature(files, report) {
    return JSON.stringify({ files: [...files].sort(), report });
}
function buildLintMessage(report) {
    return [
        "Post-turn lint check completed.",
        "",
        "Review the findings and code excerpts below, then fix the reported issues in the affected files.",
        "If a lint finding is ambiguous, ask a clarifying question instead of guessing.",
        "",
        report,
    ].join("\n");
}
function getFileStats(filePath, statFn) {
    try {
        const s = statFn(filePath);
        return { mtimeMs: s.mtimeMs, size: s.size };
    }
    catch {
        return null;
    }
}
function isStillClean(filePath, recentlyClean, statFn) {
    const cached = recentlyClean.get(filePath);
    if (!cached)
        return false;
    const current = getFileStats(filePath, statFn);
    if (!current)
        return false;
    return current.mtimeMs === cached.mtimeMs && current.size === cached.size;
}
function parseFixReportId(args) {
    const match = (args || "").match(/(?:^|\s)--report-id=(\d+)(?:\s|$)/);
    if (!match)
        return null;
    const reportId = Number.parseInt(match[1], 10);
    return Number.isFinite(reportId) ? reportId : null;
}
function reconstructLspConfig(ctx) {
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type !== "custom_message")
            continue;
        if (entry.customType !== "post-turn-linter")
            continue;
        const details = entry.details;
        if (details?.lspConfig) {
            return details.lspConfig;
        }
    }
    return null;
}
function tokenizeArgs(input) {
    const tokens = [];
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
            }
            else {
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
    if (current)
        tokens.push(current);
    return tokens;
}
export function createPostTurnLinter(pi, deps = {
    existsSync,
    loadLinterConfig,
    runQueuedLintChecks,
    runQueuedLspChecks,
    mergeValidationOutcomes,
    setTimeout,
    statSync,
}) {
    const state = {
        modifiedFiles: new Set(),
        pendingToolFiles: new Map(),
        lastRunAt: 0,
        runInProgress: false,
        shutDown: false,
        lastReportedSignature: null,
        latestLintMessage: null,
        latestFiles: [],
        latestReportId: 0,
        pendingFixReportId: null,
        cooldownMs: DEFAULT_CONFIG.cooldownMs ?? 15_000,
        reportMode: DEFAULT_CONFIG.reportMode ?? "report-only",
        recentlyClean: new Map(),
        lspConfig: DEFAULT_CONFIG.lsp ?? { enabled: false },
    };
    const cwd = () => process.cwd();
    function safeNotify(ctx, message, level) {
        if (ctx.hasUI) {
            ctx.ui.notify(message, level);
        }
    }
    function safeSetStatus(ctx, text) {
        if (ctx.hasUI) {
            ctx.ui.setStatus("post-turn-linter", text);
        }
    }
    function buildFixInstruction() {
        return [
            "Fix the issues reported by the most recent post-turn-linter message.",
            `Affected files: ${state.latestFiles.join(", ") || "unknown"}`,
            "Use the existing post-turn-linter report and code excerpts already in session context as the source of truth.",
            "After fixing the files, stop.",
        ].join("\n");
    }
    function requestFixTurn(ctx, reportId = state.latestReportId) {
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
    async function reportLintFindings(filesToLint, ctx, options) {
        if (state.shutDown)
            return;
        safeSetStatus(ctx, "post-turn-linter: running");
        const lintResult = await deps.runQueuedLintChecks(filesToLint, cwd());
        if (state.shutDown)
            return;
        let result = lintResult;
        if (state.lspConfig.enabled) {
            const lspResult = await deps.runQueuedLspChecks({
                filePaths: filesToLint,
                cwd: cwd(),
                ctx,
                config: state.lspConfig,
            });
            if (state.shutDown)
                return;
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
            safeNotify(ctx, "post-turn-linter: same findings already reported", "info");
            safeSetStatus(ctx, "post-turn-linter: same findings already reported");
            return;
        }
        state.lastReportedSignature = signature;
        const message = buildLintMessage(report);
        state.latestReportId += 1;
        state.latestLintMessage = message;
        state.latestFiles = result.affectedFiles;
        state.pendingFixReportId = null;
        const shouldTriggerTurn = options?.forceTriggerTurn ?? result.reportMode === "auto-follow-up";
        pi.sendMessage({
            customType: "post-turn-linter",
            content: message,
            display: true,
            details: { lspConfig: state.lspConfig },
        });
        pi.sendMessage({
            customType: "post-turn-linter-status",
            content: `post-turn-linter: findings (${result.affectedFiles.length} file(s) affected)`,
            display: false,
            details: {
                status: "findings",
                files: filesToLint,
                affectedFiles: result.affectedFiles,
            },
        });
        if (shouldTriggerTurn) {
            const queued = requestFixTurn(ctx, state.latestReportId);
            safeNotify(ctx, queued
                ? "post-turn-linter: requesting auto-fix turn"
                : "post-turn-linter: auto-fix already pending", "info");
        }
        safeSetStatus(ctx, "post-turn-linter: findings reported");
    }
    pi.on("session_start", async (_event, ctx) => {
        const config = await deps.loadLinterConfig(cwd());
        const persistedLspConfig = reconstructLspConfig(ctx);
        state.modifiedFiles.clear();
        state.pendingToolFiles.clear();
        state.lastRunAt = 0;
        state.runInProgress = false;
        state.shutDown = false;
        state.lastReportedSignature = null;
        state.cooldownMs = config.cooldownMs ?? DEFAULT_CONFIG.cooldownMs ?? 15_000;
        state.latestLintMessage = null;
        state.latestFiles = [];
        state.latestReportId = 0;
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
        state.recentlyClean.clear();
        safeSetStatus(ctx, "");
    });
    pi.on("tool_execution_start", async (event) => {
        const filePaths = detectModifiedFilesFromToolEvent(event);
        if (filePaths.length === 0)
            return;
        state.pendingToolFiles.set(event.toolCallId, filePaths);
    });
    pi.on("tool_execution_end", async (event, ctx) => {
        const resultFiles = detectModifiedFilesFromToolResult(event);
        let filePaths;
        if (resultFiles) {
            state.pendingToolFiles.delete(event.toolCallId);
            filePaths = resultFiles;
        }
        else {
            filePaths = state.pendingToolFiles.get(event.toolCallId) ?? [];
            state.pendingToolFiles.delete(event.toolCallId);
        }
        if (event.isError || filePaths.length === 0)
            return;
        const beforeSize = state.modifiedFiles.size;
        for (const filePath of filePaths) {
            if (!deps.existsSync(filePath)) {
                state.modifiedFiles.delete(filePath);
                continue;
            }
            if (state.modifiedFiles.size >= MAX_MODIFIED_FILES)
                break;
            if (isStillClean(filePath, state.recentlyClean, deps.statSync)) {
                continue;
            }
            state.modifiedFiles.add(filePath);
            state.recentlyClean.delete(filePath);
        }
        if (state.modifiedFiles.size !== beforeSize) {
            safeSetStatus(ctx, `post-turn-linter: queued ${state.modifiedFiles.size} file(s)`);
        }
    });
    pi.on("turn_end", async (_event, ctx) => {
        if (state.runInProgress)
            return;
        if (state.shutDown)
            return;
        if (state.modifiedFiles.size === 0)
            return;
        const now = Date.now();
        if (now - state.lastRunAt < state.cooldownMs)
            return;
        state.runInProgress = true;
        state.lastRunAt = now;
        try {
            const filesToLint = Array.from(state.modifiedFiles).sort();
            state.modifiedFiles.clear();
            await reportLintFindings(filesToLint, ctx);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            safeNotify(ctx, `post-turn-linter failed: ${errorMessage}`, "error");
            safeSetStatus(ctx, "post-turn-linter: error");
        }
        finally {
            state.runInProgress = false;
        }
    });
    pi.registerCommand("post-turn-linter-run", {
        description: "Run post-turn-linter now. Optionally pass file paths separated by spaces. Use --no-fix to report without triggering a follow-up fix turn.",
        handler: async (args, ctx) => {
            if (state.runInProgress) {
                safeNotify(ctx, "post-turn-linter: lint run already in progress", "info");
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
                .filter((filePath) => Boolean(filePath))
                .filter((filePath) => deps.existsSync(filePath));
            const filesToLint = requestedFiles.length > 0
                ? Array.from(new Set(requestedFiles)).sort()
                : Array.from(state.modifiedFiles).sort();
            state.modifiedFiles.clear();
            if (filesToLint.length === 0) {
                safeNotify(ctx, "post-turn-linter: no files to lint. Pass paths or modify files in-session first.", "info");
                return;
            }
            state.runInProgress = true;
            try {
                safeNotify(ctx, `post-turn-linter: linting ${filesToLint.length} file(s)`, "info");
                await reportLintFindings(filesToLint, ctx, {
                    forceTriggerTurn: shouldTriggerFixTurn,
                    skipDedup: true,
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                safeNotify(ctx, `post-turn-linter failed: ${errorMessage}`, "error");
                safeSetStatus(ctx, "post-turn-linter: error");
            }
            finally {
                state.runInProgress = false;
            }
        },
    });
    pi.registerCommand("post-turn-linter-fix", {
        description: "Start an agent turn to fix the most recent post-turn-linter findings",
        handler: async (args, ctx) => {
            const requestedReportId = parseFixReportId(args);
            if (requestedReportId !== null &&
                state.pendingFixReportId === requestedReportId) {
                state.pendingFixReportId = null;
            }
            if (requestedReportId !== null &&
                requestedReportId !== state.latestReportId) {
                safeNotify(ctx, "post-turn-linter: ignoring stale fix follow-up", "info");
                return;
            }
            if (!state.latestLintMessage) {
                safeNotify(ctx, "post-turn-linter: no prior lint findings to fix", "info");
                return;
            }
            if (!ctx.isIdle()) {
                const queued = requestFixTurn(ctx, requestedReportId ?? state.latestReportId);
                safeNotify(ctx, queued
                    ? "post-turn-linter: agent busy, deferring fix turn until idle"
                    : "post-turn-linter: fix turn already pending", "info");
                return;
            }
            safeNotify(ctx, "post-turn-linter: starting fix turn", "info");
            pi.sendUserMessage(buildFixInstruction());
        },
    });
    pi.registerCommand("post-turn-linter-status", {
        description: "Show post-turn-linter state",
        handler: async (_args, ctx) => {
            safeNotify(ctx, [
                `queued files: ${state.modifiedFiles.size}`,
                `cooldownMs: ${state.cooldownMs}`,
                `reportMode: ${state.reportMode}`,
                `runInProgress: ${state.runInProgress}`,
                `latestReportId: ${state.latestReportId}`,
                `pendingFixReportId: ${state.pendingFixReportId ?? "none"}`,
            ].join(" | "), "info");
        },
    });
}
export default function postTurnLinter(pi) {
    return createPostTurnLinter(pi);
}
export const __test__ = {
    detectModifiedFilesFromToolEvent,
    detectModifiedFilesFromToolResult,
    createPostTurnLinter,
    tokenizeArgs,
};
