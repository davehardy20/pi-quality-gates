// ── Post-Turn Reviewer — Context gathering, child Pi spawn, report parsing ──
//
// This module handles the "review" pipeline:
//   1. Gather context (original task, changed files, git diff)
//   2. Spawn a headless child Pi process with the reviewer system prompt
//   3. Parse the structured report from the child's output
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// ── Context Gathering ────────────────────────────────────────────────────────
/**
 * Extract the most recent user task from session entries.
 * Scans entries in reverse, skipping extension-generated messages,
 * and returns the last meaningful user prompt.
 */
export function extractOriginalTask(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type !== "message")
            continue;
        const msg = entry.message;
        if (msg?.role !== "user")
            continue;
        const content = msg.content;
        if (!content)
            continue;
        // UserMessage.content can be a plain string or an array of parts
        const text = typeof content === "string"
            ? content
            : Array.isArray(content)
                ? content
                    .filter((p) => p.type === "text" && typeof p.text === "string")
                    .map((p) => p.text)
                    .join("\n")
                : "";
        if (text.trim().length > 0) {
            return text.trim();
        }
    }
    return "";
}
/**
 * Filter a list of file paths by removing those that match .gitignore rules.
 *
 * Uses `git check-ignore` which correctly handles nested `.gitignore` files,
 * `.git/info/exclude`, and other gitignore resolution rules.
 *
 * @param files  File paths relative to `cwd`.
 * @param cwd    The git working tree root.
 * @returns      A new array with gitignored files removed.
 */
export async function filterGitignoredFiles(files, cwd) {
    if (files.length === 0)
        return [];
    // Use `git check-ignore --stdin -z` for NUL-separated I/O.
    // With -z, stdin expects NUL-separated paths and output is NUL-separated too.
    const filesInput = files.join("\0");
    const result = await runReadonlyCommandWithInput(`git check-ignore --stdin -z`, cwd, filesInput);
    // git check-ignore exits 0 if paths match, 1 if none match,
    // and outputs each ignored path separated by NUL bytes.
    if (result.exitCode === 1 || !result.stdout) {
        // No files are ignored — return all
        return [...files];
    }
    // Parse NUL-separated ignored paths
    const ignoredSet = new Set(result.stdout
        .split("\0")
        .map((p) => p.trim())
        .filter((p) => p.length > 0));
    // Keep files that are NOT ignored
    return files.filter((f) => !ignoredSet.has(f));
}
/**
 * Apply all configured filters to a file list.
 *
 * Filtering order:
 *  1. `.gitignore` (if `respectGitignore` is true) — via `git check-ignore`
 *  2. `.pi/reviewer.skip` (if `skipFilter` is loaded) — via `ignore` package
 *
 * @param files   File paths relative to `cwd`.
 * @param cwd     The working directory.
 * @param options Filter options.
 * @returns       A new array with filtered files removed.
 */
export async function applyDiffFilters(files, cwd, options) {
    if (!options || files.length === 0)
        return [...files];
    let filtered = [...files];
    // Layer 1: .gitignore filtering via git check-ignore
    if (options.respectGitignore) {
        filtered = await filterGitignoredFiles(filtered, cwd);
    }
    // Layer 2: reviewer.skip filtering via ignore package
    if (options.skipFilter?.loaded && options.skipFilter.patternCount > 0) {
        const normalized = filtered.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""));
        filtered = options.skipFilter.ig.filter(normalized);
    }
    return filtered;
}
/**
 * Generate a git diff for the given files against HEAD.
 * Returns the diff string, capped at maxLines.
 * If a file has no HEAD (new file), falls back to `git diff --no-index /dev/null`.
 *
 * When `filterOptions` are provided, files matching .gitignore or reviewer.skip
 * patterns are excluded from the diff before it is generated.
 */
export async function gatherDiff(files, cwd, maxLines, filterOptions) {
    // Apply filters first
    const filteredFiles = await applyDiffFilters(files, cwd, filterOptions);
    if (filteredFiles.length === 0)
        return "";
    // First try `git diff HEAD -- <files>` for tracked files
    const headResult = await runReadonlyCommand(`git diff HEAD -- ${filteredFiles.map((f) => shellQuote(f)).join(" ")}`, cwd);
    // Also check for untracked files (new files not yet committed)
    const untracked = [];
    for (const file of filteredFiles) {
        // Check if the file is tracked by git
        const tracked = await runReadonlyCommand(`git ls-files --error-unmatch ${shellQuote(file)} 2>/dev/null`, cwd);
        if (tracked.exitCode !== 0) {
            untracked.push(file);
        }
    }
    let diff = headResult.stdout;
    // Add full content for untracked files
    for (const file of untracked) {
        const content = await runReadonlyCommand(`git diff --no-index /dev/null ${shellQuote(file)}`, cwd);
        if (content.exitCode === 0 || content.exitCode === 1) {
            diff += `\n${content.stdout}`;
        }
    }
    // Cap at maxLines
    return capDiff(diff, maxLines);
}
/**
 * Count changed lines (+/-) in a diff using `git diff --stat`.
 *
 * This is much cheaper than fetching the full diff text just to count lines.
 * Uses `--numstat` which outputs `added\tdeleted\tfilename` per file.
 * Returns total added + deleted lines.
 *
 * @param files  File paths relative to `cwd`.
 * @param cwd    The working directory.
 * @returns      Total number of added + deleted lines, or -1 on error.
 */
export async function countDiffLinesFast(files, cwd) {
    if (files.length === 0)
        return 0;
    // --numstat: "added\tdeleted\tfilename" — no diff body, just counts
    // --no-color: avoid ANSI escape codes
    const result = await runReadonlyCommand(`git diff --numstat --no-color HEAD -- ${files.map((f) => shellQuote(f)).join(" ")}`, cwd);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
        // May be all new (untracked) files — fall back to wc -l per file
        let total = 0;
        for (const file of files) {
            const tracked = await runReadonlyCommand(`git ls-files --error-unmatch ${shellQuote(file)} 2>/dev/null`, cwd);
            if (tracked.exitCode !== 0) {
                // Untracked file — count its lines
                const wc = await runReadonlyCommand(`wc -l < ${shellQuote(file)}`, cwd);
                if (wc.exitCode === 0 && wc.stdout.trim()) {
                    total += parseInt(wc.stdout.trim(), 10) || 0;
                }
            }
        }
        return total;
    }
    // Parse numstat lines: "added\tdeleted\tfilename"
    let total = 0;
    for (const line of result.stdout.trim().split("\n")) {
        const parts = line.split("\t");
        if (parts.length >= 2) {
            const added = parseInt(parts[0], 10);
            const deleted = parseInt(parts[1], 10);
            if (!Number.isNaN(added))
                total += added;
            if (!Number.isNaN(deleted))
                total += deleted;
        }
    }
    return total;
}
/**
 * Cap a diff string at maxLines, keeping the most recent changes.
 * Adds a truncation notice if truncated.
 */
export function capDiff(diff, maxLines) {
    const lines = diff.split("\n");
    if (lines.length <= maxLines)
        return diff;
    const kept = lines.slice(0, maxLines);
    const dropped = lines.length - maxLines;
    kept.push(``, `--- DIFF TRUNCATED: ${dropped} lines omitted (cap: ${maxLines}) ---`);
    return kept.join("\n");
}
/**
 * Read the reviewer system prompt from the prompts directory.
 */
export function readSystemPrompt(promptsDir) {
    const promptPath = path.join(promptsDir, "system.md");
    try {
        return fs.readFileSync(promptPath, "utf8");
    }
    catch {
        throw new Error(`Reviewer: cannot read system prompt at ${promptPath}`);
    }
}
/**
 * Render the task template with placeholders replaced.
 */
export function renderTaskTemplate(promptsDir, task, files, diff) {
    const templatePath = path.join(promptsDir, "task-template.md");
    let template;
    try {
        template = fs.readFileSync(templatePath, "utf8");
    }
    catch {
        throw new Error(`Reviewer: cannot read task template at ${templatePath}`);
    }
    return template
        .replace(/\{\{TASK\}\}/g, task || "(no task description available)")
        .replace(/\{\{FILES\}\}/g, files.length > 0
        ? files.map((f) => `- \`${f}\``).join("\n")
        : "(no changed files)")
        .replace(/\{\{DIFF\}\}/g, diff || "(no diff available)");
}
// ── Child Pi Spawn ───────────────────────────────────────────────────────────
/**
 * Determine the Pi invocation (handles Bun vs standalone).
 */
function getPiInvocation(args) {
    const currentScript = process.argv[1];
    const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
    if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
        return { command: process.execPath, args: [currentScript, ...args] };
    }
    return { command: "pi", args };
}
function sha256Hex(value) {
    return createHash("sha256").update(value).digest("hex");
}
function formatCommandArg(arg) {
    return /^[A-Za-z0-9_./:=,@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}
export function buildSanitizedReviewerCommand(command, nonPromptArgs, taskPrompt) {
    const rendered = [command, ...nonPromptArgs].map(formatCommandArg).join(" ");
    return `${rendered} [taskPrompt omitted chars=${taskPrompt.length} sha256=${sha256Hex(taskPrompt)}]`;
}
/**
 * Spawn a headless child Pi process for the review.
 * Uses `--mode json --no-session` with read-only tools.
 */
export async function spawnReviewer(taskPrompt, systemPrompt, config, cwd, signal) {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-reviewer-"));
    try {
        // Write system prompt to temp file for --append-system-prompt
        const promptFile = path.join(tmpDir, "reviewer-prompt.md");
        await fs.promises.writeFile(promptFile, systemPrompt, {
            encoding: "utf8",
            mode: 0o600,
        });
        // Build Pi arguments
        const piArgs = [
            "--mode",
            "json",
            "-p", // pipe mode (no interactive UI)
            "--no-session",
            "--no-extensions", // prevent extension loading in child to avoid stale ctx errors
            "--tools",
            config.tools.join(","),
            "--append-system-prompt",
            promptFile,
        ];
        if (config.model) {
            piArgs.push("--model", config.model);
        }
        // NOTE: pi CLI does not support --max-tokens; maxTokens is config-only
        // and can be used by consumers for logging or provider-specific limits.
        const invocationForCommand = getPiInvocation(piArgs);
        const commandStr = buildSanitizedReviewerCommand(invocationForCommand.command, invocationForCommand.args, taskPrompt);
        // The task is passed as the final argument (positional), but is omitted from
        // ReviewerResult.command to avoid persisting task/diff text in appendEntry.
        piArgs.push(taskPrompt);
        const invocation = getPiInvocation(piArgs);
        return await new Promise((resolve) => {
            let buffer = "";
            let output = "";
            let stderr = "";
            let usage = "";
            let timedOut = false;
            let exited = false;
            const timeoutId = setTimeout(() => {
                timedOut = true;
                proc.kill("SIGTERM");
                setTimeout(() => {
                    if (!exited)
                        proc.kill("SIGKILL");
                }, 5000);
            }, config.timeoutMs);
            const proc = spawn(invocation.command, invocation.args, {
                cwd,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env },
            });
            const processLine = (line) => {
                if (!line.trim())
                    return;
                try {
                    const event = JSON.parse(line);
                    if (event?.type === "message_end" &&
                        event?.message?.role === "assistant") {
                        for (const part of event.message.content || []) {
                            if (part.type === "text")
                                output += part.text ?? "";
                        }
                        if (event.message.usage) {
                            const u = event.message.usage;
                            usage = `↑${u.input || 0} ↓${u.output || 0} $${u.cost?.total?.toFixed(4) || 0}`;
                        }
                    }
                }
                catch {
                    // Not JSON — might be stderr or other output; collect in stderr
                }
            };
            proc.stdout.on("data", (data) => {
                buffer += data.toString();
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines)
                    processLine(line);
            });
            proc.stderr.on("data", (data) => {
                stderr += data.toString();
            });
            proc.on("close", (code) => {
                exited = true;
                clearTimeout(timeoutId);
                if (buffer.trim())
                    processLine(buffer);
                // Fallback: if no structured output but stderr has content, use it
                const rawOutput = output || stderr;
                resolve({
                    report: parseReviewReport(rawOutput),
                    rawOutput,
                    exitCode: code ?? 0,
                    timedOut,
                    usage: usage || undefined,
                    stderr,
                    command: commandStr,
                });
            });
            // Handle abort signal
            if (signal) {
                const onAbort = () => {
                    clearTimeout(timeoutId);
                    proc.kill("SIGTERM");
                    setTimeout(() => {
                        if (!exited)
                            proc.kill("SIGKILL");
                    }, 5000);
                };
                if (signal.aborted)
                    onAbort();
                else
                    signal.addEventListener("abort", onAbort, { once: true });
            }
        });
    }
    finally {
        // Clean up temp dir
        try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        }
        catch {
            // Best-effort cleanup
        }
    }
}
// ── Report Parsing ───────────────────────────────────────────────────────────
/**
 * Parse the structured `## Review Report` block from the reviewer child output.
 * Returns null if parsing fails or the report block is not found.
 */
export function parseReviewReport(output) {
    if (!output?.trim())
        return null;
    // Find the report block
    const reportMarker = "## Review Report";
    const reportIndex = output.indexOf(reportMarker);
    if (reportIndex === -1)
        return null;
    const reportText = output.slice(reportIndex);
    // Parse STATUS
    const statusMatch = reportText.match(/^STATUS:\s*(PASS|ISSUES|CANNOT_REVIEW)\s*$/m);
    if (!statusMatch)
        return null;
    const status = statusMatch[1];
    // Parse CONFIDENCE
    const confidenceMatch = reportText.match(/^CONFIDENCE:\s*(HIGH|MEDIUM|LOW)\s*$/m);
    const confidence = (confidenceMatch?.[1] ?? "LOW");
    // Parse Findings
    const findings = parseFindings(reportText);
    // Parse "What was verified"
    const verified = parseListSection(reportText, "What was verified");
    // Parse "What could not be verified"
    const notVerified = parseListSection(reportText, "What could not be verified");
    // Parse Summary — take everything between "### Summary" and the end (or next ## header)
    const summary = parseSummarySection(reportText);
    return {
        status,
        confidence,
        findings,
        verified,
        unverifiable: notVerified,
        summary,
    };
}
/**
 * Parse individual findings from the report text.
 * Each finding starts with `#### [SEVERITY] description`.
 */
function parseFindings(reportText) {
    const findings = [];
    // Match finding blocks: #### [SEVERITY] description
    const findingRegex = /^####\s*\[(CRITICAL|WARNING|NIT)\]\s*(.+)$/gm;
    const matches = [...reportText.matchAll(findingRegex)];
    for (const match of matches) {
        const severity = match[1];
        const description = match[2].trim();
        const blockStart = (match.index ?? 0) + match[0].length;
        // Find the end of this finding block (next #### or ### or end)
        const remainingAfterStart = reportText.slice(blockStart);
        const nextFindingOrSection = remainingAfterStart.search(/^#{3,4}\s/m);
        const blockText = nextFindingOrSection !== -1
            ? remainingAfterStart.slice(0, nextFindingOrSection)
            : remainingAfterStart;
        const rawFile = extractField(blockText, "File") || "";
        const { file, line } = parseFilePath(rawFile);
        findings.push({
            severity,
            title: description,
            file,
            line,
            domain: extractField(blockText, "Category") || "quality",
            rule: extractField(blockText, "Rule") || "",
            issue: extractField(blockText, "Issue") || "",
            evidence: extractField(blockText, "Evidence") || "",
            suggestion: extractField(blockText, "Suggestion") || "",
        });
    }
    // Handle "None." case
    if (findings.length === 0) {
        const noneMatch = reportText.match(/### Findings\s*\n\s*None\.\s*\n/i);
        if (noneMatch)
            return [];
    }
    return findings;
}
/**
 * Extract a bold-labeled field from a finding block.
 * E.g., `- **File:** path/to/file.ts:42` → "path/to/file.ts:42"
 */
function extractField(block, fieldName) {
    const regex = new RegExp(`\\*\\*${fieldName}:\\*\\*\\s*(.+?)(?:\\n|$)`, "i");
    const match = block.match(regex);
    return match?.[1]?.trim() ?? "";
}
/**
 * Parse a list section (bullet points under a ### heading).
 * Returns an array of the bullet point contents.
 */
/**
 * Parse the file path from a File field value, stripping any line number suffix.
 * Returns the file path and optionally the line number.
 * E.g., "src/db.ts:42" → { file: "src/db.ts", line: 42 }
 * E.g., "src/style.ts" → { file: "src/style.ts", line: null }
 */
function parseFilePath(fileField) {
    if (!fileField)
        return { file: "", line: null };
    const trimmed = fileField.trim();
    const lineMatch = trimmed.match(/:(\d+)\s*$/);
    if (lineMatch) {
        return {
            file: trimmed.slice(0, lineMatch.index),
            line: parseInt(lineMatch[1], 10),
        };
    }
    return { file: trimmed, line: null };
}
function parseListSection(reportText, heading) {
    const items = [];
    // Find the heading
    const headingRegex = new RegExp(`^###\\s+${escapeRegex(heading)}\\s*$`, "m");
    const headingMatch = headingRegex.exec(reportText);
    if (!headingMatch)
        return items;
    const afterHeading = reportText.slice(headingMatch.index + headingMatch[0].length);
    // Collect lines until the next ### heading or end
    const lines = afterHeading.split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("### "))
            break; // next section
        if (trimmed.startsWith("- ")) {
            items.push(trimmed.slice(2).trim());
        }
    }
    return items;
}
/**
 * Parse the Summary section (free text after "### Summary").
 */
function parseSummarySection(reportText) {
    const match = reportText.match(/^###\s+Summary\s*\n([\s\S]*?)$/m);
    if (!match)
        return "";
    const text = match[1].trim();
    // Trim to first ## header if present
    const nextHeader = text.search(/^##\s/m);
    return nextHeader !== -1 ? text.slice(0, nextHeader).trim() : text;
}
// ── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Shell-quote a file path for use in shell commands.
 */
function shellQuote(str) {
    return `'${str.replace(/'/g, "'\\''")}'`;
}
/**
 * Escape special regex characters.
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Run a read-only shell command and capture stdout.
 */
async function runReadonlyCommand(command, cwd) {
    return new Promise((resolve) => {
        let stdout = "";
        const proc = spawn("sh", ["-c", command], {
            cwd,
            shell: false,
            stdio: ["ignore", "pipe", "ignore"],
        });
        proc.stdout.on("data", (data) => {
            stdout += data.toString();
        });
        proc.on("close", (code) => {
            resolve({ stdout, exitCode: code ?? 0 });
        });
    });
}
/**
 * Run a read-only shell command with stdin input and capture stdout.
 * Used for `git check-ignore --stdin` to avoid argument-length limits.
 */
async function runReadonlyCommandWithInput(command, cwd, stdin) {
    return new Promise((resolve) => {
        let stdout = "";
        // Parse command into args to avoid shell NUL-byte issues
        const proc = spawn("sh", ["-c", command], {
            cwd,
            shell: false,
            stdio: ["pipe", "pipe", "ignore"],
        });
        proc.stdout.on("data", (data) => {
            stdout += data.toString();
        });
        proc.on("close", (code) => {
            resolve({ stdout, exitCode: code ?? 0 });
        });
        // Write stdin as a Buffer to preserve NUL bytes, then close
        proc.stdin.write(Buffer.from(stdin, "utf8"));
        proc.stdin.end();
    });
}
/**
 * Check whether the report contains findings at or above the threshold.
 */
export function hasFindingsAboveThreshold(report, threshold) {
    if (!report || threshold === "none")
        return false;
    const severityOrder = {
        CRITICAL: 3,
        WARNING: 2,
        NIT: 1,
    };
    const minLevel = threshold === "critical" ? 3 : 2;
    return report.findings.some((f) => severityOrder[f.severity] >= minLevel);
}
/**
 * Format a report for display to the user.
 */
export function formatReportForDisplay(report) {
    const lines = [];
    lines.push(`**Review: ${report.status}** (confidence: ${report.confidence})`);
    lines.push("");
    if (report.findings.length > 0) {
        lines.push("### Findings");
        lines.push("");
        for (const f of report.findings) {
            const loc = f.line != null ? `${f.file}:${f.line}` : (f.file ?? "");
            lines.push(`- **[${f.severity}]** ${f.title} \`${loc}\``);
            if (f.suggestion) {
                lines.push(`  - 💡 ${f.suggestion}`);
            }
        }
        lines.push("");
    }
    if (report.summary) {
        lines.push(report.summary);
    }
    return lines.join("\n");
}
