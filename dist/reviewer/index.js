/**
 * Post-Turn Reviewer — Extension entry point
 *
 * Lifecycle hooks (session_start, turn_end), state machine, and commands.
 * Coordinates with the post-turn-linter via session-scoped status messages.
 *
 * State machine:
 *   IDLE → GATHERING → REVIEWING → FIX_REQUESTED → RE_REVIEWING → IDLE
 *
 * Commands:
 *   /reviewer-status  — Show current reviewer state
 *   /reviewer-run     — Manually trigger a review
 *   /reviewer-model   — Switch review model mid-session
 *   /reviewer-toggle  — Enable or disable the reviewer
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { registerReviewerModelCommand } from "./commands/reviewer-model.js";
import { loadReviewConfig } from "./config.js";
import { buildBoundedReviewerFailureMessage, buildSummaryFirstReviewerMessage, deriveSessionId, parseReportRecoveryArgs, recoverReviewerReportSidecar, writeReviewerReportSidecar, } from "./report-hygiene.js";
import { countDiffLinesFast, extractOriginalTask, gatherDiff, readSystemPrompt, renderTaskTemplate, spawnReviewer, } from "./reviewer.js";
import { loadSkipFilter } from "./reviewer-skip.js";
import { DEFAULT_REVIEW_CONFIG } from "./types.js";
// ── Package-local prompt resolution ────────────────────────────────────────
const sourcePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(sourcePath), "..", "..");
function getPromptsDir() {
    return path.join(packageRoot, "src", "reviewer", "prompts");
}
// ── Constants ──────────────────────────────────────────────────────────
/** Session message customType the linter emits when it finishes clean. */
const LINTER_STATUS_CUSTOM_TYPE = "post-turn-linter-status";
/** Maximum number of times we escalate to the user before giving up. */
const _MAX_ESCALATION_LOOPS = 1;
// ── Helpers ────────────────────────────────────────────────────────────
function severityMeetsThreshold(severity, threshold) {
    if (threshold === "none")
        return false;
    if (threshold === "warning")
        return severity === "CRITICAL" || severity === "WARNING";
    return severity === "CRITICAL";
}
function formatPhaseStatus(state, config) {
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
        const critical = state.lastReport.findings.filter((f) => f.severity === "CRITICAL").length;
        const warning = state.lastReport.findings.filter((f) => f.severity === "WARNING").length;
        const nit = state.lastReport.findings.filter((f) => f.severity === "NIT").length;
        lines.push(`Last findings: ${critical} critical, ${warning} warning, ${nit} nit`);
    }
    return lines.join("\n");
}
function formatAdvisoryMessage(report, sidecar = null) {
    return buildSummaryFirstReviewerMessage({
        report,
        sidecar,
        title: "📋 **Post-Turn Reviewer — Advisory Report**",
    }).message;
}
function formatFixUpMessage(report, sidecar = null) {
    const criticalFindings = report.findings.filter((f) => f.severity === "CRITICAL");
    const warningFindings = report.findings.filter((f) => f.severity === "WARNING");
    return buildSummaryFirstReviewerMessage({
        report: {
            ...report,
            findings: [...criticalFindings, ...warningFindings],
        },
        sidecar,
        title: "🚨 **Post-Turn Reviewer — Issues Found**",
    }).message;
}
function formatEscalationMessage(report, loopCount, sidecar = null) {
    return buildSummaryFirstReviewerMessage({
        report,
        sidecar,
        title: `⚠️ **Post-Turn Reviewer — Max Re-Review Exceeded** after ${loopCount} pass(es).`,
    }).message;
}
function buildReviewerTranscriptSidecarContent(rawOutput, stderr) {
    if (!stderr || stderr === rawOutput)
        return rawOutput;
    if (!rawOutput)
        return stderr;
    return `${rawOutput}\n\n--- stderr ---\n${stderr}`;
}
// ── State Machine ──────────────────────────────────────────────────────
function createInitialState(config) {
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
function transition(state, nextPhase) {
    state.phase = nextPhase;
}
// ── Extension Entry Point ──────────────────────────────────────────────
export default function postTurnReviewerExtension(pi) {
    let state = createInitialState(DEFAULT_REVIEW_CONFIG);
    let skipFilter = null;
    /** Build DiffFilterOptions from current state and loaded skip filter. */
    function buildFilterOptions() {
        return {
            respectGitignore: state.config.respectGitignore,
            skipFilter,
        };
    }
    async function writeLatestReviewerSidecar(ctx, report) {
        const sidecar = await writeReviewerReportSidecar({
            report,
            sessionId: deriveSessionId(ctx),
        });
        state.latestReportSidecar = sidecar.ok ? sidecar.metadata : null;
        return sidecar;
    }
    function latestReviewerSidecarWriteResult() {
        if (!state.latestReportSidecar)
            return null;
        return {
            ok: true,
            metadata: state.latestReportSidecar,
        };
    }
    // ── session_start ──────────────────────────────────────────────────
    pi.on("session_start", async (_event, ctx) => {
        let config = await loadReviewConfig(ctx.cwd);
        // Validate model against registry early — avoids timeout/hang on invalid model
        if (config.model && ctx.modelRegistry) {
            const available = ctx.modelRegistry.getAvailable();
            const match = available.find((m) => `${m.provider}/${m.id}` === config.model || m.id === config.model);
            if (!match) {
                ctx.ui.notify(`🔍 Post-Turn Reviewer: configured model "${config.model}" not found in registry. Falling back to session default.`, "warning");
                config = { ...config, model: null };
            }
        }
        state = createInitialState(config);
        skipFilter = loadSkipFilter(ctx.cwd, config.skipFile);
        ctx.ui.notify(`🔍 Post-Turn Reviewer: ready (model: ${config.model ?? "session default"}, threshold: ${config.autoFixThreshold})`, "info");
    });
    // ── session_shutdown ───────────────────────────────────────────────
    pi.on("session_shutdown", async (_event, _ctx) => {
        if (state.reviewTimerId) {
            clearTimeout(state.reviewTimerId);
            state.reviewTimerId = null;
        }
        state = createInitialState(state.config);
    });
    // ── Linter status listener ────────────────────────────────────────
    pi.on("turn_end", async (_event, ctx) => {
        // ── Check for linter status messages in recent entries
        checkForLinterStatus(ctx);
        // ── Incrementally scan new entries for user prompts
        updateUserPromptCache(ctx);
        // ── State machine dispatch
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
    });
    // ── User prompt cache ────────────────────────────────────────────
    function updateUserPromptCache(ctx) {
        const branch = ctx.sessionManager.getBranch();
        const startIdx = state.lastScannedIdx;
        for (let i = startIdx; i < branch.length; i++) {
            const entry = branch[i];
            if (entry.type !== "message")
                continue;
            const msg = entry.message;
            if (msg?.role !== "user")
                continue;
            const content = msg.content;
            if (!content)
                continue;
            const text = typeof content === "string"
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
    // ── Linter status detection ───────────────────────────────────────
    function checkForLinterStatus(ctx) {
        const branch = ctx.sessionManager.getBranch();
        for (let i = branch.length - 1; i >= 0; i--) {
            const entry = branch[i];
            if (entry.type !== "custom_message")
                continue;
            if (entry.customType !==
                LINTER_STATUS_CUSTOM_TYPE)
                continue;
            const details = entry;
            if (details.details?.status === "clean") {
                state.linterClean = true;
                state.linterCleanAt = details.details?.timestamp ?? Date.now();
                if (details.details?.files && details.details.files.length > 0) {
                    state.pendingFiles = details.details.files;
                }
            }
            else if (details.details?.status === "findings") {
                state.linterClean = false;
                state.pendingFiles = [];
            }
            break;
        }
    }
    // ── IDLE handler ──────────────────────────────────────────────────
    async function handleIdle(ctx) {
        if (!state.config.enabled)
            return;
        if (!state.linterClean)
            return;
        if (state.pendingFiles.length === 0)
            return;
        if (state.reviewTimerId) {
            clearTimeout(state.reviewTimerId);
            state.reviewTimerId = null;
        }
        const diffLines = await countDiffLinesFast(state.pendingFiles, ctx.cwd);
        if (diffLines < state.config.minChangedLines) {
            ctx.ui.notify(`🔍 Post-Turn Reviewer: skipping — ${diffLines} changed lines below threshold (${state.config.minChangedLines}).`, "info");
            return;
        }
        if (state.config.maxChangedLines > 0 &&
            diffLines > state.config.maxChangedLines) {
            ctx.ui.notify(`🔍 Post-Turn Reviewer: skipping — ${diffLines} changed lines exceed max (${state.config.maxChangedLines}). Too large for effective review.`, "warning");
            return;
        }
        if (state.config.reviewDelayMs > 0) {
            ctx.ui.notify(`🔍 Post-Turn Reviewer: waiting ${state.config.reviewDelayMs}ms for main agent to finish...`, "info");
            state.reviewTimerId = setTimeout(() => {
                state.reviewTimerId = null;
                transition(state, "GATHERING");
                runReview(ctx, false);
            }, state.config.reviewDelayMs);
            return;
        }
        transition(state, "GATHERING");
        await runReview(ctx, false);
    }
    // ── FIX_REQUESTED handler ─────────────────────────────────────────
    async function handleFixRequested(ctx) {
        if (!state.linterClean)
            return;
        if (state.pendingFiles.length === 0)
            return;
        state.loopCount++;
        if (state.loopCount > state.config.maxReReviewPasses) {
            if (state.lastReport) {
                const msg = formatEscalationMessage(state.lastReport, state.loopCount, latestReviewerSidecarWriteResult());
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
    // ── Core review pipeline ──────────────────────────────────────────
    async function runReview(ctx, isReReview) {
        try {
            const task = state.lastUserPrompt ||
                extractOriginalTask(ctx.sessionManager.getBranch());
            if (!task) {
                ctx.ui.notify("🔍 Post-Turn Reviewer: no task found in session, skipping review.", "info");
                transition(state, "IDLE");
                return;
            }
            const diff = await gatherDiff(state.pendingFiles, ctx.cwd, state.config.maxDiffLines, buildFilterOptions());
            transition(state, "REVIEWING");
            ctx.ui.setStatus("post-turn-reviewer", isReReview
                ? `re-reviewing (pass ${state.loopCount}/${state.config.maxReReviewPasses})`
                : "reviewing");
            // Use package-local prompts directory
            const promptsDir = getPromptsDir();
            const systemPrompt = readSystemPrompt(promptsDir);
            const taskPrompt = renderTaskTemplate(promptsDir, task, Array.from(state.pendingFiles), diff);
            const childOutput = await spawnReviewer(taskPrompt, systemPrompt, state.config, ctx.cwd);
            if (!childOutput) {
                ctx.ui.notify("🔍 Post-Turn Reviewer: child process returned no output.", "warning");
                transition(state, "IDLE");
                ctx.ui.setStatus("post-turn-reviewer", "");
                return;
            }
            if (childOutput.timedOut) {
                const modelInfo = state.config.model
                    ? `model: ${state.config.model}`
                    : "model: session default";
                const sidecar = await writeLatestReviewerSidecar(ctx, buildReviewerTranscriptSidecarContent(childOutput.rawOutput, childOutput.stderr));
                ctx.ui.notify(`🔍 Post-Turn Reviewer: timed out after ${state.config.timeoutMs / 1000}s (${modelInfo}). Raw output/stderr omitted; use /reviewer-report preview or slice for redacted details.`, "warning");
                pi.appendEntry("post-turn-reviewer-timeout", {
                    timeoutMs: state.config.timeoutMs,
                    exitCode: childOutput.exitCode,
                    partialOutputLength: childOutput.rawOutput.length,
                    stderrLength: childOutput.stderr.length,
                    model: state.config.model ?? "session-default",
                    command: childOutput.command,
                    promptLength: taskPrompt.length,
                    sidecar: sidecar.ok ? sidecar.metadata : undefined,
                    sidecarError: sidecar.ok ? undefined : sidecar.error,
                });
                transition(state, "IDLE");
                ctx.ui.setStatus("post-turn-reviewer", "");
                return;
            }
            const report = childOutput.report;
            if (!report) {
                const hasReportMarker = childOutput.rawOutput?.includes("## Review Report") ?? false;
                const sidecar = await writeLatestReviewerSidecar(ctx, buildReviewerTranscriptSidecarContent(childOutput.rawOutput, childOutput.stderr));
                ctx.ui.notify(buildBoundedReviewerFailureMessage({
                    title: "🔍 Post-Turn Reviewer: could not parse review report from child output.",
                    rawOutput: childOutput.rawOutput,
                    stderr: childOutput.stderr,
                    sidecar,
                    hints: hasReportMarker
                        ? undefined
                        : [
                            "Missing '## Review Report' marker — model may not have followed the output format.",
                        ],
                }), "warning");
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
                ctx.ui.setStatus("post-turn-reviewer", "");
                return;
            }
            const sidecar = await writeLatestReviewerSidecar(ctx, buildReviewerTranscriptSidecarContent(childOutput.rawOutput, childOutput.stderr));
            state.lastReport = report;
            ctx.ui.setStatus("post-turn-reviewer", "");
            await processReport(report, ctx, isReReview, sidecar);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`🔍 Post-Turn Reviewer error: ${message}`, "error");
            transition(state, "IDLE");
            ctx.ui.setStatus("post-turn-reviewer", "");
        }
    }
    // ── Process parsed report ─────────────────────────────────────────
    async function processReport(report, ctx, isReReview, sidecar) {
        pi.appendEntry("post-turn-reviewer-report", {
            status: report.status,
            confidence: report.confidence,
            findingsCount: report.findings.length,
            loopCount: state.loopCount,
            isReReview,
            sidecar: sidecar?.ok ? sidecar.metadata : undefined,
            sidecarError: sidecar?.ok ? undefined : sidecar?.error,
        });
        const hasActionableFindings = report.findings.some((f) => severityMeetsThreshold(f.severity, state.config.autoFixThreshold));
        if (report.status === "CANNOT_REVIEW") {
            ctx.ui.notify(buildSummaryFirstReviewerMessage({
                report,
                sidecar,
                title: "🔍 Post-Turn Reviewer: could not complete review.",
                maxFindings: 0,
            }).message, "warning");
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
            }
            else {
                ctx.ui.notify(`🔍 Post-Turn Reviewer: PASS (${report.confidence} confidence)`, "info");
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
    // ── Utility: build fix instruction ────────────────────────────────
    function buildFixInstruction(report) {
        const criticalFiles = [
            ...new Set(report.findings
                .filter((f) => severityMeetsThreshold(f.severity, state.config.autoFixThreshold))
                .map((f) => f.file.split(":")[0])),
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
    // ── Commands ──────────────────────────────────────────────────────
    pi.registerCommand("reviewer-status", {
        description: "Show post-turn-reviewer state",
        handler: async (_args, ctx) => {
            ctx.ui.notify(formatPhaseStatus(state, state.config), "info");
        },
    });
    pi.registerCommand("reviewer-run", {
        description: "Manually trigger a post-turn review. Optionally pass file paths.",
        handler: async (args, ctx) => {
            if (state.phase !== "IDLE" && state.phase !== "FIX_REQUESTED") {
                ctx.ui.notify(`🔍 Reviewer busy (phase: ${state.phase}). Wait for the current review to finish.`, "warning");
                return;
            }
            const requestedFiles = (args || "")
                .trim()
                .split(/\s+/)
                .filter((p) => p.length > 0);
            if (requestedFiles.length > 0) {
                state.pendingFiles = requestedFiles;
            }
            if (state.pendingFiles.length === 0) {
                ctx.ui.notify("🔍 No files to review. Pass file paths or edit files in-session first.", "info");
                return;
            }
            state.linterClean = true;
            const isReReview = state.phase === "FIX_REQUESTED";
            if (isReReview) {
                state.loopCount++;
                if (state.loopCount > state.config.maxReReviewPasses) {
                    state.loopCount = state.config.maxReReviewPasses;
                }
                transition(state, "RE_REVIEWING");
            }
            else {
                transition(state, "GATHERING");
            }
            ctx.ui.notify(`🔍 Post-Turn Reviewer: manual review triggered (${state.pendingFiles.length} file(s))`, "info");
            await runReview(ctx, isReReview);
        },
    });
    registerReviewerModelCommand(pi, {
        getConfig: () => state.config,
        setConfig: (updater) => {
            state.config = updater(state.config);
        },
    });
    pi.registerCommand("reviewer-report", {
        description: "Recover the latest redacted post-turn-reviewer sidecar. Usage: /reviewer-report [metadata|preview|slice|full] [--offset=N] [--length=N] [--ack-context-cost]. Full mode always requires --ack-context-cost.",
        handler: async (args, ctx) => {
            if (!state.latestReportSidecar) {
                ctx.ui.notify("reviewer-report: no latest reviewer sidecar is available", "info");
                return;
            }
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
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                ctx.ui.notify(`reviewer-report: ${errorMessage}`, "error");
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
                ctx.ui.notify("🔍 Post-Turn Reviewer: enabled.", "info");
            }
            else if (arg === "off" || arg === "disable") {
                state.config = { ...state.config, enabled: false };
                if (state.phase !== "IDLE") {
                    transition(state, "IDLE");
                }
                ctx.ui.notify("🔍 Post-Turn Reviewer: disabled.", "info");
            }
            else {
                state.config = {
                    ...state.config,
                    enabled: !state.config.enabled,
                };
                if (!state.config.enabled && state.phase !== "IDLE") {
                    transition(state, "IDLE");
                }
                ctx.ui.notify(`🔍 Post-Turn Reviewer: ${state.config.enabled ? "enabled" : "disabled"}.`, "info");
            }
        },
    });
}
// ── Test exports ──────────────────────────────────────────────────────
export const __test__ = {
    createInitialState,
    severityMeetsThreshold,
    formatPhaseStatus,
    formatAdvisoryMessage,
    formatFixUpMessage,
    formatEscalationMessage,
    buildReviewerTranscriptSidecarContent,
    LINTER_STATUS_CUSTOM_TYPE,
};
