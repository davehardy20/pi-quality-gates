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
import type { ReviewConfig } from "../shared/review-config.js";
import { type DiffFilterOptions, gatherDiff } from "../shared/review-scope.js";
import { hasFindingsAboveThreshold } from "../shared/review-severity.js";
import type {
  Finding,
  ReviewConfidence,
  ReviewDomain,
  ReviewReport,
  ReviewStatus,
  Severity,
} from "../shared/review-types.js";

// Re-export shared primitives for backwards compatibility
export type { ReviewConfig } from "../shared/review-config.js";
export {
  capDiff,
  countDiffLinesFast,
  type DiffFilterOptions,
  extractOriginalTask,
  filterGitignoredFiles,
  gatherDiff,
} from "../shared/review-scope.js";
export type {
  Finding,
  ReviewConfidence,
  ReviewDomain,
  ReviewReport,
  ReviewStatus,
  Severity,
} from "../shared/review-types.js";

export interface ReviewerResult {
  report: ReviewReport | null;
  rawOutput: string;
  exitCode: number;
  timedOut: boolean;
  usage?: string;
  stderr: string;
  command: string;
  /** Path to a retained sidecar directory when parsing fails. */
  sidecarPath?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

export interface ReviewerAttemptInput {
  task: string;
  files: string[];
  cwd: string;
  config: ReviewConfig;
  filterOptions?: DiffFilterOptions;
  /** Optional pre-computed diff. If omitted, the execution gathers it. */
  diff?: string;
  /** Optional test-execution plan rendered into the task template. */
  testPlan?: string;
  signal?: AbortSignal;
}

export interface ReviewerExecution {
  runAttempt(input: ReviewerAttemptInput): Promise<ReviewerResult>;
}

export interface ReviewerExecutionDependencies {
  gatherDiff?: typeof gatherDiff;
  readSystemPrompt?: typeof readSystemPrompt;
  renderTaskTemplate?: typeof renderTaskTemplate;
  spawnReviewer?: typeof spawnReviewer;
  getPromptsDir: () => string;
}

// ── Context Gathering ────────────────────────────────────────────────────────

/**
 * Read the reviewer system prompt from the prompts directory.
 */
export function readSystemPrompt(promptsDir: string): string {
  const promptPath = path.join(promptsDir, "system.md");
  try {
    return fs.readFileSync(promptPath, "utf8");
  } catch {
    throw new Error(`Reviewer: cannot read system prompt at ${promptPath}`);
  }
}

/**
 * Render the task template with placeholders replaced.
 */
export function renderTaskTemplate(
  promptsDir: string,
  task: string,
  files: string[],
  diff: string,
  testPlan?: string,
): string {
  const templatePath = path.join(promptsDir, "task-template.md");
  let template: string;
  try {
    template = fs.readFileSync(templatePath, "utf8");
  } catch {
    throw new Error(`Reviewer: cannot read task template at ${templatePath}`);
  }

  return template
    .replace(/\{\{TASK\}\}/g, task || "(no task description available)")
    .replace(
      /\{\{FILES\}\}/g,
      files.length > 0
        ? files.map((f) => `- \`${f}\``).join("\n")
        : "(no changed files)",
    )
    .replace(/\{\{DIFF\}\}/g, diff || "(no diff available)")
    .replace(
      /\{\{TEST_PLAN\}\}/g,
      testPlan ?? "(no test execution plan available)",
    );
}

export function createReviewerExecution(
  deps: ReviewerExecutionDependencies,
): ReviewerExecution {
  return {
    async runAttempt(input: ReviewerAttemptInput): Promise<ReviewerResult> {
      const promptsDir = deps.getPromptsDir();
      const systemPrompt = (deps.readSystemPrompt ?? readSystemPrompt)(
        promptsDir,
      );
      const diff =
        input.diff ??
        (await (deps.gatherDiff ?? gatherDiff)(
          input.files,
          input.cwd,
          input.config.maxDiffLines,
          undefined, // baseRef — post-turn reviewer diffs working tree vs HEAD
          input.filterOptions,
        ));
      const taskPrompt = (deps.renderTaskTemplate ?? renderTaskTemplate)(
        promptsDir,
        input.task,
        input.files,
        diff,
        input.testPlan,
      );
      return (deps.spawnReviewer ?? spawnReviewer)(
        taskPrompt,
        systemPrompt,
        input.config,
        input.cwd,
        input.signal,
      );
    },
  };
}

// ── Child Pi Spawn ───────────────────────────────────────────────────────────

/**
 * Determine the Pi invocation (handles Bun vs standalone).
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  return { command: "pi", args };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatCommandArg(arg: string): string {
  return /^[A-Za-z0-9_./:=,@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

export function buildSanitizedReviewerCommand(
  command: string,
  nonPromptArgs: string[],
  taskPrompt: string,
): string {
  const rendered = [command, ...nonPromptArgs].map(formatCommandArg).join(" ");
  return `${rendered} [taskPrompt omitted chars=${taskPrompt.length} sha256=${sha256Hex(taskPrompt)}]`;
}

/**
 * Spawn a headless child Pi process for the review.
 * Uses `--mode json --no-session` with read-only tools.
 */
export async function spawnReviewer(
  taskPrompt: string,
  systemPrompt: string,
  config: ReviewConfig,
  cwd: string,
  signal?: AbortSignal,
): Promise<ReviewerResult> {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-reviewer-"),
  );

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
    const commandStr = buildSanitizedReviewerCommand(
      invocationForCommand.command,
      invocationForCommand.args,
      taskPrompt,
    );

    // The task is passed as the final argument (positional), but is omitted from
    // ReviewerResult.command to avoid persisting task/diff text in appendEntry.
    piArgs.push(taskPrompt);

    const invocation = getPiInvocation(piArgs);

    return await new Promise<ReviewerResult>((resolve) => {
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
          if (!exited) proc.kill("SIGKILL");
        }, 5000);
      }, config.timeoutMs);

      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env } as Record<string, string>,
      });

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (
            event?.type === "message_end" &&
            event?.message?.role === "assistant"
          ) {
            for (const part of event.message.content || []) {
              if (part.type === "text") output += part.text ?? "";
            }
            if (event.message.usage) {
              const u = event.message.usage;
              usage = `↑${u.input || 0} ↓${u.output || 0} $${u.cost?.total?.toFixed(4) || 0}`;
            }
          }
        } catch {
          // Not JSON — might be stderr or other output; collect in stderr
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", async (code) => {
        exited = true;
        clearTimeout(timeoutId);
        if (buffer.trim()) processLine(buffer);

        // Fallback: if no structured output but stderr has content, use it
        const rawOutput = output || stderr;
        const report = parseReviewReport(rawOutput);
        let sidecarPath: string | undefined;
        if (!report) {
          try {
            sidecarPath = await writeParseFailureSidecar(tmpDir, {
              rawOutput,
              stderr,
              exitCode: code ?? 0,
              timedOut,
              usage: usage || undefined,
              command: commandStr,
            });
          } catch {
            // Sidecar persistence is best-effort.
          }
        }

        resolve({
          report,
          rawOutput,
          exitCode: code ?? 0,
          timedOut,
          usage: usage || undefined,
          stderr,
          command: commandStr,
          sidecarPath,
        });
      });

      // Handle abort signal
      if (signal) {
        const onAbort = () => {
          clearTimeout(timeoutId);
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!exited) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  } finally {
    // Clean up temp dir
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

interface ParseFailureSidecar {
  rawOutput: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  usage?: string;
  command: string;
  timestamp: string;
}

function reviewerFailuresDir(): string {
  return path.join(os.homedir(), ".pi", "reviewer-failures");
}

async function ensureReviewerFailuresDir(): Promise<void> {
  await fs.promises.mkdir(reviewerFailuresDir(), { recursive: true });
}

function sidecarTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeParseFailureSidecar(
  tmpDir: string,
  payload: Omit<ParseFailureSidecar, "timestamp">,
): Promise<string> {
  await ensureReviewerFailuresDir();
  const sidecarDir = path.join(
    reviewerFailuresDir(),
    `parse-failure-${sidecarTimestamp()}-${randomId()}`,
  );
  await fs.promises.mkdir(sidecarDir, { recursive: true });

  const sidecar: ParseFailureSidecar = {
    ...payload,
    timestamp: new Date().toISOString(),
  };
  await fs.promises.writeFile(
    path.join(sidecarDir, "sidecar.json"),
    JSON.stringify(sidecar, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );

  // Best-effort copy of the prompt used for this review.
  try {
    await fs.promises.copyFile(
      path.join(tmpDir, "reviewer-prompt.md"),
      path.join(sidecarDir, "reviewer-prompt.md"),
    );
  } catch {
    // Ignore prompt copy failures.
  }

  return sidecarDir;
}

function randomId(): string {
  return createHash("sha256")
    .update(`${Date.now()}-${process.pid}`)
    .digest("hex")
    .slice(0, 8);
}

// ── Report Parsing ───────────────────────────────────────────────────────────

/**
 * Parse the structured `## Review Report` block from the reviewer child output.
 * Returns null if parsing fails or the report block is not found.
 */
export function parseReviewReport(output: string): ReviewReport | null {
  if (!output?.trim()) return null;

  // Find the report block (case-insensitive, allowing leading whitespace)
  const reportMarker = /^\s*##\s+Review\s+Report\s*$/im;
  const reportMatch = output.match(reportMarker);
  if (!reportMatch) return null;

  const reportText = output.slice(reportMatch.index);

  const statusValue = parseReviewField(reportText, "STATUS");
  if (!isReviewStatus(statusValue)) return null;
  const status = statusValue;

  const confidenceValue = parseReviewField(reportText, "CONFIDENCE");
  const confidence = isReviewConfidence(confidenceValue)
    ? confidenceValue
    : "LOW";

  // Parse Findings
  const findings = parseFindings(reportText);

  // Parse "What was verified"
  const verified = parseListSection(reportText, "What was verified");

  // Parse "What could not be verified"
  const notVerified = parseListSection(
    reportText,
    "What could not be verified",
  );

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

function parseReviewField(reportText: string, fieldName: string): string {
  const fieldPrefix = `${fieldName}:`;
  for (const line of reportText.split("\n")) {
    const normalized = line.replaceAll("**", "").trim().toUpperCase();
    if (normalized.startsWith(fieldPrefix)) {
      return normalized.slice(fieldPrefix.length).trim();
    }
  }
  return "";
}

function isReviewStatus(value: string): value is ReviewStatus {
  return value === "PASS" || value === "ISSUES" || value === "CANNOT_REVIEW";
}

function isReviewConfidence(value: string): value is ReviewConfidence {
  return value === "HIGH" || value === "MEDIUM" || value === "LOW";
}

/**
 * Parse individual findings from the report text.
 * Each finding starts with `#### [SEVERITY] description`.
 */
function parseFindings(reportText: string): Finding[] {
  const findings: Finding[] = [];

  // Match finding blocks: #### [SEVERITY] description
  const findingRegex = /^####\s*\[(CRITICAL|WARNING|NIT)\]\s*(.+)$/gm;
  const matches = [...reportText.matchAll(findingRegex)];

  for (const match of matches) {
    const severity = match[1] as Severity;
    const description = match[2].trim();
    const blockStart = (match.index ?? 0) + match[0].length;

    // Find the end of this finding block (next #### or ### or end)
    const remainingAfterStart = reportText.slice(blockStart);
    const nextFindingOrSection = remainingAfterStart.search(/^#{3,4}\s/m);
    const blockText =
      nextFindingOrSection !== -1
        ? remainingAfterStart.slice(0, nextFindingOrSection)
        : remainingAfterStart;

    const rawFile = extractField(blockText, "File") || "";
    const { file, line } = parseFilePath(rawFile);
    findings.push({
      severity,
      title: description,
      file,
      line,
      domain:
        (extractField(blockText, "Category") as ReviewDomain) || "quality",
      rule: extractField(blockText, "Rule") || "",
      issue: extractField(blockText, "Issue") || "",
      evidence: extractField(blockText, "Evidence") || "",
      suggestion: extractField(blockText, "Suggestion") || "",
    });
  }

  // Handle "None." case
  if (findings.length === 0) {
    const noneMatch = reportText.match(/### Findings\s*\n\s*None\.\s*\n/i);
    if (noneMatch) return [];
  }

  return findings;
}

/**
 * Extract a bold-labeled field from a finding block.
 * E.g., `- **File:** path/to/file.ts:42` → "path/to/file.ts:42"
 */
function extractField(block: string, fieldName: string): string {
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
function parseFilePath(fileField: string): {
  file: string;
  line: number | null;
} {
  if (!fileField) return { file: "", line: null };
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
function parseListSection(reportText: string, heading: string): string[] {
  const items: string[] = [];

  // Find the heading
  const headingRegex = new RegExp(`^###\\s+${escapeRegex(heading)}\\s*$`, "m");
  const headingMatch = headingRegex.exec(reportText);
  if (!headingMatch) return items;

  const afterHeading = reportText.slice(
    headingMatch.index + headingMatch[0].length,
  );

  // Collect lines until the next ### heading or end
  const lines = afterHeading.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("### ")) break; // next section
    if (trimmed.startsWith("- ")) {
      items.push(trimmed.slice(2).trim());
    }
  }

  return items;
}

/**
 * Parse the Summary section (free text after "### Summary").
 */
function parseSummarySection(reportText: string): string {
  const match = reportText.match(/^###\s+Summary\s*\n([\s\S]*?)$/m);
  if (!match) return "";

  const text = match[1].trim();
  // Trim to first ## header if present
  const nextHeader = text.search(/^##\s/m);
  return nextHeader !== -1 ? text.slice(0, nextHeader).trim() : text;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Escape special regex characters.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check whether the report contains findings at or above the threshold.
 * @deprecated Re-exported from ../shared/review-severity.js for backwards
 * compatibility. New callers should import from there directly.
 */
export { hasFindingsAboveThreshold };

/**
 * Format a report for display to the user.
 */
export function formatReportForDisplay(report: ReviewReport): string {
  const lines: string[] = [];

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
