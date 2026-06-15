import { resolve } from "node:path";
import { capText, displayPath, recoverReportSidecar, redactSecrets, stripAnsi, truncateText, writeReportSidecar, } from "../shared/report-sidecar.js";
// Re-export runtime detection and shared helpers so existing callers keep working.
export { defaultReportSidecarDir as defaultLinterReportSidecarDir, deriveSessionId, parseReportRecoveryArgs, redactSecrets, } from "../shared/report-sidecar.js";
export { isQualityGatesSubAgentRuntime } from "../shared/runtime-detection.js";
const DEFAULT_MAX_SUMMARY_FINDINGS = 20;
const DEFAULT_MAX_FINDINGS_PER_FILE = 3;
const DEFAULT_SUMMARY_MAX_CHARS = 6000;
export async function writeLinterReportSidecar(options) {
    return writeReportSidecar({
        report: options.report,
        toolName: "post-turn-linter",
        summaryMode: "post-turn-linter-summary",
        sessionId: options.sessionId,
        sidecarDir: options.sidecarDir,
        now: options.now,
    });
}
export async function recoverLinterReportSidecar(options) {
    return recoverReportSidecar({
        recordPath: options.recordPath,
        mode: options.mode,
        acknowledgeContextCost: options.acknowledgeContextCost,
        allowFullWithoutAck: options.allowFullWithoutAck,
        offset: options.offset,
        length: options.length,
        previewChars: options.previewChars,
        reportLabel: "linter",
        commandName: "/post-turn-linter-report",
    });
}
export function buildSummaryFirstLintMessage(args) {
    const maxFindings = args.maxFindings ?? DEFAULT_MAX_SUMMARY_FINDINGS;
    const maxFindingsPerFile = args.maxFindingsPerFile ?? DEFAULT_MAX_FINDINGS_PER_FILE;
    const maxChars = args.maxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
    const parsed = parseLintReport(args.report, args.cwd);
    const selectedFindings = selectTopFindings(parsed.findings, maxFindings, maxFindingsPerFile);
    const omittedFindings = Math.max(0, parsed.findings.length - selectedFindings.length);
    const affectedFiles = args.affectedFiles.map((filePath) => displayPath(filePath, args.cwd));
    const linterNames = parsed.linterNames.length > 0 ? parsed.linterNames : ["unknown"];
    const lines = [
        "Post-turn lint check completed: findings.",
        `Report #${args.reportId}. Checked ${args.filesChecked.length} file(s); affected ${args.affectedFiles.length} file(s).`,
        `Linters: ${linterNames.join(", ")}.`,
        `Summary caps: showing ${selectedFindings.length} of ${parsed.findings.length} parsed finding(s) (max ${maxFindings} global, ${maxFindingsPerFile} per file).`,
    ];
    if (affectedFiles.length > 0) {
        lines.push(`Affected files: ${affectedFiles.slice(0, 12).join(", ")}${affectedFiles.length > 12 ? `, +${affectedFiles.length - 12} more` : ""}.`);
    }
    if (args.sidecar?.ok) {
        lines.push(`Full redacted report sidecar: ${args.sidecar.metadata.id} (${args.sidecar.metadata.redactedChars} chars).`, "Recover manually with /post-turn-linter-report preview, /post-turn-linter-report slice --offset=0 --length=4000, or /post-turn-linter-report full --ack-context-cost.");
    }
    else {
        const error = args.sidecar?.error ?? "sidecar unavailable";
        lines.push(`Full report sidecar unavailable (${truncateText(error, 160)}); raw report omitted from parent context.`);
    }
    lines.push("", "Top actionable findings:");
    if (selectedFindings.length === 0) {
        lines.push("- No path-localized findings could be parsed for the concise summary; recover the sidecar report for full redacted details.");
    }
    else {
        for (const finding of selectedFindings) {
            lines.push(formatFindingForSummary(finding));
        }
    }
    if (omittedFindings > 0 ||
        parsed.lowPriorityFindings > 0 ||
        parsed.excerptsOmitted) {
        const omittedParts = [];
        if (omittedFindings > 0) {
            omittedParts.push(`${omittedFindings} finding(s) omitted by caps`);
        }
        if (parsed.lowPriorityFindings > 0) {
            omittedParts.push(`${parsed.lowPriorityFindings} low-priority MD013/line-length finding(s)`);
        }
        if (parsed.excerptsOmitted)
            omittedParts.push("code excerpts omitted");
        lines.push("", `Omitted from parent context: ${omittedParts.join("; ")}.`);
    }
    lines.push("Fix the listed findings first. If the summary is insufficient, recover only the needed sidecar preview/slice before requesting the full report.");
    const redactedMessage = redactSecrets(lines.join("\n"));
    const message = capText(redactedMessage, maxChars);
    return {
        message,
        details: {
            reportId: args.reportId,
            checkedFileCount: args.filesChecked.length,
            affectedFileCount: args.affectedFiles.length,
            affectedFiles,
            linterNames,
            totalFindings: parsed.findings.length,
            visibleFindings: selectedFindings.length,
            omittedFindings,
            lowPriorityFindings: parsed.lowPriorityFindings,
            maxFindings,
            maxFindingsPerFile,
            excerptsOmitted: parsed.excerptsOmitted,
            sidecar: args.sidecar?.ok ? args.sidecar.metadata : undefined,
            sidecarError: args.sidecar?.ok ? undefined : args.sidecar?.error,
            findings: selectedFindings,
        },
    };
}
function parseLintReport(report, cwd) {
    const linterNames = new Set();
    const findings = [];
    let currentLinter = "unknown";
    let inCodeExcerpts = false;
    let excerptsOmitted = false;
    for (const rawLine of report.split(/\r?\n/)) {
        const line = stripAnsi(rawLine).trimEnd();
        const section = line.match(/^---\s+(.+?)\s+---$/);
        if (section) {
            const sectionName = section[1]?.replace(/\s+\(\d+ files?\)$/, "") ?? "unknown";
            if (/^code excerpts$/i.test(sectionName)) {
                inCodeExcerpts = true;
                excerptsOmitted = true;
                continue;
            }
            currentLinter = sectionName;
            linterNames.add(currentLinter);
            continue;
        }
        if (inCodeExcerpts || !line.trim())
            continue;
        const finding = parseFindingLine(line, currentLinter, cwd);
        if (!finding)
            continue;
        findings.push(finding);
        linterNames.add(finding.linter);
    }
    const lowPriorityFindings = findings.filter((finding) => finding.lowPriority).length;
    return {
        linterNames: Array.from(linterNames),
        findings,
        lowPriorityFindings,
        excerptsOmitted,
    };
}
function parseFindingLine(line, currentLinter, cwd) {
    const match = line.match(/^(.+?):(\d+)(?::(\d+))?:?\s+(.+)$/);
    if (!match)
        return null;
    const rawPath = match[1]?.trim();
    const lineNumber = Number.parseInt(match[2] ?? "", 10);
    const column = match[3] ? Number.parseInt(match[3], 10) : undefined;
    const tail = match[4]?.trim() ?? "";
    if (!rawPath || !Number.isFinite(lineNumber) || tail.length === 0) {
        return null;
    }
    const normalizedTail = redactSecrets(tail);
    const fixMatch = normalizedTail.match(/(?:\s+—\s+fix:\s+|\s+-\s+fix:\s+)(.+)$/i);
    const fix = fixMatch?.[1] ? truncateText(fixMatch[1], 180) : undefined;
    const withoutFix = fixMatch
        ? normalizedTail.slice(0, fixMatch.index).trim()
        : normalizedTail;
    const firstTokenMatch = withoutFix.match(/^(\S+)\s+(.+)$/);
    const firstToken = firstTokenMatch?.[1];
    const looksLikeRule = Boolean(firstToken &&
        (/^(?:MD\d+|[A-Z]\d+|[A-Za-z]+\d+)(?:[\w./:-]*)?$/i.test(firstToken) ||
            firstToken.includes("/") ||
            /^\[(?:error|warning|info|hint)\]$/i.test(firstToken)));
    const linter = /^\[(?:error|warning|info|hint)\]$/i.test(firstToken ?? "")
        ? "LSP diagnostics"
        : currentLinter;
    const ruleId = looksLikeRule ? firstToken : undefined;
    const message = truncateText(looksLikeRule ? (firstTokenMatch?.[2] ?? "") : withoutFix, 260);
    const lowPriority = /(?:^|\b)(MD013|line-length)(?:\b|$)/i.test(`${ruleId ?? ""} ${message}`);
    const filePath = resolve(cwd, rawPath);
    return {
        filePath,
        displayPath: displayPath(filePath, cwd),
        line: lineNumber,
        column: Number.isFinite(column) ? column : undefined,
        linter,
        ruleId,
        message,
        fix,
        lowPriority,
    };
}
function selectTopFindings(findings, maxFindings, maxFindingsPerFile) {
    const selected = [];
    const perFileCounts = new Map();
    const ranked = findings
        .map((finding, index) => ({ finding, index }))
        .sort((a, b) => {
        if (a.finding.lowPriority !== b.finding.lowPriority) {
            return a.finding.lowPriority ? 1 : -1;
        }
        return a.index - b.index;
    });
    for (const { finding } of ranked) {
        if (selected.length >= maxFindings)
            break;
        const count = perFileCounts.get(finding.filePath) ?? 0;
        if (count >= maxFindingsPerFile)
            continue;
        selected.push(finding);
        perFileCounts.set(finding.filePath, count + 1);
    }
    return selected;
}
function formatFindingForSummary(finding) {
    const location = `${finding.displayPath}:${finding.line}${finding.column ? `:${finding.column}` : ""}`;
    const rule = finding.ruleId ? ` ${finding.ruleId}` : "";
    const priority = finding.lowPriority ? " [low-priority]" : "";
    const fix = finding.fix ? ` — fix: ${finding.fix}` : "";
    return `- ${location} — ${finding.linter}${rule}${priority} — ${finding.message}${fix}`;
}
