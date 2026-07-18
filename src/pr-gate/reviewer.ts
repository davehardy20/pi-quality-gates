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
  TestExecutionStatus,
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
  /** True when output capture exceeded a pre-close memory limit. */
  outputOverflowed?: boolean;
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
  /** Base ref for repository-direct review execution. */
  baseRef?: string;
  signal?: AbortSignal;
  /**
   * Optional HEAD sha this review covers. The orchestrator bridge uses it to
   * stamp the exact-HEAD PASS token directly from an observed report.
   */
  headSha?: string;
}

export interface ReviewerExecution {
  runAttempt(input: ReviewerAttemptInput): Promise<ReviewerResult>;
  /** Skip parent-side diff materialization; the reviewer inspects baseRef..HEAD. */
  inspectRepositoryDirectly?: boolean;
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
      const spawn = deps.spawnReviewer ?? spawnReviewer;
      const primaryResult = await spawn(
        taskPrompt,
        systemPrompt,
        input.config,
        input.cwd,
        input.signal,
      );
      if (primaryResult.report || !isEmptyModelFailure(primaryResult)) {
        return primaryResult;
      }
      // Pi core has no native --model fallback. When the primary model fails
      // with an empty-output model failure (quota exhaustion, empty response),
      // retry each configured fallback model until one produces a parseable
      // review report or a non-empty failure. Returns the primary failure if
      // every fallback is also an empty-output model failure.
      for (const fallbackModel of input.config.fallbackModels ?? []) {
        const fallbackResult = await spawn(
          taskPrompt,
          systemPrompt,
          { ...input.config, model: fallbackModel },
          input.cwd,
          input.signal,
        );
        if (fallbackResult.report || !isEmptyModelFailure(fallbackResult)) {
          return fallbackResult;
        }
      }
      return primaryResult;
    },
  };
}

/**
 * Detect a child result that looks like an empty-output model failure
 * (e.g. quota exhaustion or an empty model response) rather than a real
 * review failure or error. Such results are retryable via model fallback:
 * zero review output, no stderr, clean exit, and no timeout.
 */
function isEmptyModelFailure(result: ReviewerResult): boolean {
  return (
    result.report === null &&
    result.rawOutput.trim() === "" &&
    result.stderr.trim() === "" &&
    result.exitCode === 0 &&
    !result.timedOut
  );
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

export interface BoundedTextCapture {
  append(value: string): void;
  value(): string;
  overflowed(): boolean;
  totalChars(): number;
}

/** Retain only a bounded tail while tracking whether any content was dropped. */
export function createBoundedTextCapture(maxChars: number): BoundedTextCapture {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error("maxChars must be a positive safe integer");
  }
  let retained = "";
  let total = 0;
  let didOverflow = false;
  return {
    append(value): void {
      if (!value) return;
      total += value.length;
      if (value.length >= maxChars) {
        retained = value.slice(-maxChars);
        didOverflow =
          didOverflow || value.length > maxChars || total > maxChars;
        return;
      }
      const overflowBy = retained.length + value.length - maxChars;
      if (overflowBy > 0) {
        retained = retained.slice(overflowBy) + value;
        didOverflow = true;
      } else {
        retained += value;
      }
    },
    value: () => retained,
    overflowed: () => didOverflow,
    totalChars: () => total,
  };
}

export interface BoundedLineProcessor {
  append(chunk: string): void;
  flush(): void;
  overflowed(): boolean;
  bufferedChars(): number;
}

/** Parse newline-delimited output without retaining an unterminated line forever. */
export function createBoundedLineProcessor(
  maxLineChars: number,
  onLine: (line: string) => void,
): BoundedLineProcessor {
  if (!Number.isSafeInteger(maxLineChars) || maxLineChars < 1) {
    throw new Error("maxLineChars must be a positive safe integer");
  }
  let buffer = "";
  let currentLineOverflowed = false;
  let didOverflow = false;

  function finishLine(): void {
    if (!currentLineOverflowed) onLine(buffer);
    buffer = "";
    currentLineOverflowed = false;
  }

  return {
    append(chunk): void {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf("\n", start);
        const end = newline === -1 ? chunk.length : newline;
        const fragment = chunk.slice(start, end);
        if (!currentLineOverflowed) {
          const remaining = maxLineChars - buffer.length;
          if (fragment.length > remaining) {
            buffer += fragment.slice(0, Math.max(0, remaining));
            currentLineOverflowed = true;
            didOverflow = true;
          } else {
            buffer += fragment;
          }
        }
        if (newline === -1) break;
        finishLine();
        start = newline + 1;
      }
    },
    flush: finishLine,
    overflowed: () => didOverflow,
    bufferedChars: () => buffer.length,
  };
}

const MAX_REVIEWER_JSON_LINE_CHARS = 1_048_576;
const MAX_REVIEWER_OUTPUT_CHARS = 262_144;
const MAX_REVIEWER_STDERR_CHARS = 65_536;

export function buildReviewerPiArgs(
  config: ReviewConfig,
  promptFile: string,
): string[] {
  const piArgs = [
    "--mode",
    "json",
    "-p", // pipe mode (no interactive UI)
    "--no-session",
    "--tools",
    config.tools.join(","),
    "--append-system-prompt",
    promptFile,
  ];

  if (config.model) {
    piArgs.push("--model", config.model);
  }

  return piArgs;
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

    // Keep extensions enabled: safe validation runners are extension-provided
    // in normal Pi sessions, and /pr-review must expose them to the child.
    const piArgs = buildReviewerPiArgs(config, promptFile);

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
      const output = createBoundedTextCapture(MAX_REVIEWER_OUTPUT_CHARS);
      const stderr = createBoundedTextCapture(MAX_REVIEWER_STDERR_CHARS);
      const overflowSources = new Set<string>();
      let usage = "";
      let timedOut = false;
      let exited = false;
      let terminationRequested = false;
      let timeoutId: ReturnType<typeof setTimeout>;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;

      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env } as Record<string, string>,
      });

      const cleanupControlState = () => {
        clearTimeout(timeoutId);
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = undefined;
        }
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
          onAbort = undefined;
        }
      };

      const requestTermination = (source: "timeout" | "abort") => {
        if (source === "timeout") timedOut = true;
        clearTimeout(timeoutId);
        if (terminationRequested || exited) return;
        terminationRequested = true;
        proc.kill("SIGTERM");
        killTimer = setTimeout(() => {
          killTimer = undefined;
          if (!exited) proc.kill("SIGKILL");
        }, 5000);
      };

      timeoutId = setTimeout(
        () => requestTermination("timeout"),
        config.timeoutMs,
      );

      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (
            event?.type === "message_end" &&
            event?.message?.role === "assistant"
          ) {
            for (const part of event.message.content || []) {
              if (part.type === "text") output.append(part.text ?? "");
            }
            if (output.overflowed()) overflowSources.add("assistant output");
            if (event.message.usage) {
              const u = event.message.usage;
              usage = `↑${u.input || 0} ↓${u.output || 0} $${u.cost?.total?.toFixed(4) || 0}`;
            }
          }
        } catch {
          // Ignore non-JSON stdout. Structured reviewer output is required.
        }
      };

      const stdoutLines = createBoundedLineProcessor(
        MAX_REVIEWER_JSON_LINE_CHARS,
        processLine,
      );

      proc.stdout.on("data", (data: Buffer) => {
        stdoutLines.append(data.toString());
        if (stdoutLines.overflowed()) overflowSources.add("stdout JSON line");
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr.append(data.toString());
        if (stderr.overflowed()) overflowSources.add("stderr");
      });

      proc.on("close", async (code) => {
        exited = true;
        cleanupControlState();
        clearTimeout(timeoutId);
        stdoutLines.flush();

        const outputValue = output.value();
        const stderrValue = stderr.value();
        const outputOverflowed = overflowSources.size > 0;
        const overflowNote = outputOverflowed
          ? `[reviewer output exceeded memory limits: ${[...overflowSources].join(", ")}].`
          : "";
        // Fallback: if no structured output but stderr has content, use it.
        const capturedOutput = outputValue || stderrValue;
        const rawOutput = overflowNote
          ? `${overflowNote}\n${capturedOutput}`
          : capturedOutput;
        // Any overflow fails closed: a partial report cannot stamp a PASS token.
        const report = outputOverflowed ? null : parseReviewReport(rawOutput);
        let sidecarPath: string | undefined;
        if (!report) {
          try {
            sidecarPath = await writeParseFailureSidecar(tmpDir, {
              rawOutput,
              stderr: stderrValue,
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
          stderr: stderrValue,
          command: commandStr,
          sidecarPath,
          outputOverflowed,
        });
      });

      // Handle abort signal
      if (signal) {
        onAbort = () => requestTermination("abort");
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

  const testExecution = parseTestExecutionSection(reportText);

  // Parse Summary — take everything between "### Summary" and the end (or next ## header)
  const summary = parseSummarySection(reportText);

  return {
    status,
    confidence,
    findings,
    verified,
    unverifiable: notVerified,
    ...(testExecution ? { testExecution } : {}),
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
  const section = parseSectionBody(reportText, heading);
  if (!section) return [];

  const items: string[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      items.push(trimmed.slice(2).trim());
    }
  }

  return items;
}

function parseSectionBody(reportText: string, heading: string): string {
  const headingRegex = new RegExp(`^###\\s+${escapeRegex(heading)}\\s*$`, "im");
  const headingMatch = headingRegex.exec(reportText);
  if (!headingMatch) return "";

  const afterHeading = reportText.slice(
    headingMatch.index + headingMatch[0].length,
  );
  const nextHeading = afterHeading.search(/^###\s+/m);
  return (
    nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)
  ).trim();
}

function parseTestExecutionSection(
  reportText: string,
): ReviewReport["testExecution"] | undefined {
  const section = parseSectionBody(reportText, "Test execution");
  if (!section) return undefined;

  const statusValue = parseMarkdownField(section, "Status").toUpperCase();
  const status = isTestExecutionStatus(statusValue) ? statusValue : "NOT_RUN";
  const summary = parseMarkdownField(section, "Summary") || section.trim();
  const sidecarRef = parseMarkdownField(section, "Sidecar");

  return {
    status,
    summary,
    ...(sidecarRef ? { sidecarRef } : {}),
  };
}

function parseMarkdownField(block: string, fieldName: string): string {
  const fieldPrefix = `${fieldName}:`.toUpperCase();
  for (const line of block.split("\n")) {
    const normalized = line.replaceAll("**", "").trim().replace(/^-\s*/, "");
    if (normalized.toUpperCase().startsWith(fieldPrefix)) {
      return normalized.slice(fieldPrefix.length).trim();
    }
  }
  return "";
}

function isTestExecutionStatus(value: string): value is TestExecutionStatus {
  return value === "PASS" || value === "FAIL" || value === "NOT_RUN";
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

  if (report.testExecution) {
    lines.push("### Test execution");
    lines.push("");
    lines.push(`- **Status:** ${report.testExecution.status}`);
    lines.push(`- **Summary:** ${report.testExecution.summary}`);
    if (report.testExecution.sidecarRef) {
      lines.push(`- **Sidecar:** ${report.testExecution.sidecarRef}`);
    }
    lines.push("");
  }

  if (report.summary) {
    lines.push(report.summary);
  }

  return lines.join("\n");
}
