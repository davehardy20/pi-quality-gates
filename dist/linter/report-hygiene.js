import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
const DEFAULT_MAX_SUMMARY_FINDINGS = 20;
const DEFAULT_MAX_FINDINGS_PER_FILE = 3;
const DEFAULT_SUMMARY_MAX_CHARS = 6000;
const DEFAULT_PREVIEW_CHARS = 2000;
const DEFAULT_SLICE_CHARS = 4000;
const MAX_SINGLE_SIDECAR_BYTES = 10 * 1024 * 1024;
const ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
function parseOptionalBooleanEnv(value) {
    const normalized = value?.trim().toLowerCase();
    if (!normalized)
        return null;
    if (TRUE_ENV_VALUES.has(normalized))
        return true;
    if (FALSE_ENV_VALUES.has(normalized))
        return false;
    return null;
}
export function isQualityGatesSubAgentRuntime(env = process.env, mode = "auto") {
    if (mode === "sub-agent")
        return true;
    if (mode === "parent")
        return false;
    const explicit = parseOptionalBooleanEnv(env.PI_QUALITY_GATES_SUBAGENT_MODE);
    if (explicit !== null)
        return explicit;
    const role = env.PI_ORCH_ROLE?.trim().toLowerCase();
    if (role === "worker" || role === "subagent" || role === "sub-agent") {
        return true;
    }
    return Boolean(env.PI_ORCH_RUN_ID?.trim() &&
        env.PI_ORCH_AGENT_ID?.trim() &&
        env.PI_ORCH_TASK_ID?.trim());
}
export function defaultLinterReportSidecarDir() {
    const configured = process.env.PI_QUALITY_GATES_SIDECAR_DIR?.trim();
    return configured && configured.length > 0
        ? expandHome(configured)
        : join(homedir(), ".pi", "agent", "tool-output");
}
export function redactSecrets(input) {
    let output = input;
    output = output.replace(/(["']?\b(?:api[_-]?key|apiKey|token|secret|password|authorization)\b["']?\s*[:=]\s*)["']?[^\s"',}]{8,}["']?/gi, (_match, prefix) => `${normalizeSecretPrefix(prefix)}[REDACTED]`);
    output = output.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g, "Bearer [REDACTED]");
    output = output.replace(/\b(AWS|AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]");
    output = output.replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_JWT]");
    return output;
}
function normalizeSecretPrefix(prefix) {
    const match = prefix.match(/["']?\b(api[_-]?key|apiKey|token|secret|password|authorization)\b["']?/i);
    return `${match?.[1] ?? "secret"}: `;
}
function expandHome(path) {
    if (path === "~")
        return homedir();
    if (path.startsWith("~/"))
        return join(homedir(), path.slice(2));
    return path;
}
function sanitizePathPart(value) {
    const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
    return sanitized.length > 0 ? sanitized : "default-session";
}
export function deriveSessionId(ctx) {
    const sessionFile = ctx.sessionManager?.getSessionFile?.();
    if (!sessionFile)
        return "default-session";
    return basename(sessionFile).replace(/\.(jsonl|json)$/i, "");
}
function sha256(input) {
    return createHash("sha256").update(input).digest("hex");
}
function byteLength(input) {
    return Buffer.byteLength(input, "utf8");
}
export async function writeLinterReportSidecar(options) {
    const now = options.now ?? new Date();
    const id = randomUUID();
    const sessionId = sanitizePathPart(options.sessionId ?? "default-session");
    const root = resolve(options.sidecarDir ?? defaultLinterReportSidecarDir());
    const dir = join(root, sessionId);
    const filePath = join(dir, `${id}.json`);
    const redacted = redactSecrets(options.report);
    const metadata = {
        id,
        toolName: "post-turn-linter",
        sessionId,
        path: filePath,
        createdAt: now.toISOString(),
        originalChars: options.report.length,
        originalBytes: byteLength(options.report),
        redactedChars: redacted.length,
        redactedBytes: byteLength(redacted),
        originalSha256: sha256(options.report),
        redactedSha256: sha256(redacted),
        summaryMode: "post-turn-linter-summary",
    };
    if (metadata.redactedBytes > MAX_SINGLE_SIDECAR_BYTES) {
        return {
            ok: false,
            metadata: {
                ...metadata,
                failureState: "record_exceeds_max_single_record_bytes",
            },
            error: "redacted linter report exceeds max single sidecar size",
        };
    }
    try {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const payload = {
            metadata,
            content: redacted,
        };
        const tempPath = join(dir, `.${id}.${process.pid}.tmp`);
        await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        await fs.rename(tempPath, filePath);
        return { ok: true, metadata };
    }
    catch (error) {
        return {
            ok: false,
            metadata: { ...metadata, failureState: "write_failed" },
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
export async function recoverLinterReportSidecar(options) {
    const raw = await fs.readFile(options.recordPath, "utf8");
    const persisted = JSON.parse(raw);
    const content = persisted.content;
    const previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;
    if (options.mode === "metadata") {
        return {
            mode: options.mode,
            content: JSON.stringify(persisted.metadata, null, 2),
            metadata: persisted.metadata,
        };
    }
    if (options.mode === "full") {
        if (!options.acknowledgeContextCost && !options.allowFullWithoutAck) {
            throw new Error("full linter report recovery requires --ack-context-cost; use preview or slice first");
        }
        return { mode: options.mode, content, metadata: persisted.metadata };
    }
    if (options.mode === "slice") {
        const offset = Math.max(0, options.offset ?? 0);
        const requestedLength = Math.max(1, options.length ?? DEFAULT_SLICE_CHARS);
        const length = Math.min(requestedLength, DEFAULT_SLICE_CHARS);
        const slice = content.slice(offset, offset + length);
        return {
            mode: options.mode,
            content: [
                `linter report slice offset=${offset} length=${slice.length}/${content.length} (cap ${DEFAULT_SLICE_CHARS})`,
                "",
                slice,
            ].join("\n"),
            metadata: persisted.metadata,
        };
    }
    const preview = content.slice(0, previewChars);
    const suffix = content.length > preview.length
        ? `\n\n[preview truncated: ${content.length - preview.length} more character(s); use /post-turn-linter-report slice --offset=${preview.length} --length=${DEFAULT_SLICE_CHARS} or full --ack-context-cost]`
        : "";
    return {
        mode: options.mode,
        content: `${preview}${suffix}`,
        metadata: persisted.metadata,
    };
}
export function parseReportRecoveryArgs(args) {
    const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
    const modeToken = tokens.find((token) => ["metadata", "preview", "slice", "full"].includes(token));
    const mode = modeToken ?? "preview";
    const acknowledgeContextCost = tokens.includes("--ack-context-cost");
    const offset = parseNumberFlag(tokens, "--offset", 0);
    const length = parseNumberFlag(tokens, "--length", DEFAULT_SLICE_CHARS);
    return { mode, acknowledgeContextCost, offset, length };
}
function parseNumberFlag(tokens, flag, fallback) {
    const inline = tokens.find((token) => token.startsWith(`${flag}=`));
    if (inline) {
        const value = Number.parseInt(inline.slice(flag.length + 1), 10);
        return Number.isFinite(value) ? value : fallback;
    }
    const flagIndex = tokens.indexOf(flag);
    if (flagIndex >= 0) {
        const value = Number.parseInt(tokens[flagIndex + 1] ?? "", 10);
        return Number.isFinite(value) ? value : fallback;
    }
    return fallback;
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
function displayPath(filePath, cwd) {
    const rel = relative(cwd, resolve(filePath));
    if (rel && !rel.startsWith("..") && !resolve(rel).startsWith(resolve(cwd))) {
        return rel;
    }
    if (rel && !rel.startsWith("..") && rel !== "")
        return rel;
    return filePath;
}
function stripAnsi(input) {
    return input.replace(ANSI_PATTERN, "");
}
function truncateText(input, maxChars) {
    if (input.length <= maxChars)
        return input;
    return `${input.slice(0, Math.max(0, maxChars - 1))}…`;
}
function capText(input, maxChars) {
    if (input.length <= maxChars)
        return input;
    return `${input.slice(0, Math.max(0, maxChars - 120))}\n\n[summary truncated to ${maxChars} chars; recover sidecar preview/slice for more]`;
}
