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
import { parseReviewReport } from "../shared/review-report.js";
import { type DiffFilterOptions, gatherDiff } from "../shared/review-scope.js";
import { hasFindingsAboveThreshold } from "../shared/review-severity.js";
import type { DiffCoverage, ReviewReport } from "../shared/review-types.js";

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
  DiffCoverage,
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
  /**
   * Diff coverage (truncation signal) for a pre-computed `diff`. When the
   * execution gathers its own diff it derives this itself. Attached to the
   * parsed report so the PR-gate verdict can emit a PARTIAL verdict on
   * truncation.
   */
  diffCoverage?: DiffCoverage;
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
  renderSystemPrompt?: typeof renderSystemPrompt;
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

// ── C4 review toggles: optional reviewer domains (PR-Agent require_* mirrors) ──

const REVIEW_OPTIONAL_DOMAIN_TODO_SCAN = `### Optional Domain: TODO / FIXME / Placeholder Scan

- Scan changed code for leftover \`TODO\`, \`FIXME\`, \`HACK\`, \`XXX\`, or
  placeholder/stub implementations that were not resolved before the change.
- Report each as a WARNING (task-completion domain) with the marker text as
  evidence and a concrete resolution as the suggestion.`;

const REVIEW_OPTIONAL_DOMAIN_CAN_SPLIT = `### Optional Domain: Change Cohesion (Can-Be-Split)

- Assess whether the change is too large or mixes unrelated concerns to
  review (and merge) safely as one unit.
- If it does, suggest concrete split points (commit or PR boundaries). Report
  as a WARNING (quality domain) only when a split is clearly warranted;
  otherwise note the change is cohesive.`;

const REVIEW_OPTIONAL_DOMAIN_EFFORT = `### Optional Domain: Effort Estimate

- For each finding, estimate the whole minutes to address it and emit the
  estimate in the \`Effort:\` output field. Omit it or write \`N/A\` when a
  reliable estimate is not possible.`;

/**
 * Render the reviewer system prompt with the optional review-feature toggles
 * (PR-Agent `require_*` mirrors) applied. Deterministic: each toggle adds (or
 * omits) a fixed prompt section, so the prompt is reproducible per config.
 * With every toggle off (the default) the base prompt is emitted unchanged
 * aside from the empty placeholder substitutions.
 */
export function renderSystemPrompt(
  rawSystemPrompt: string,
  config: ReviewConfig,
): string {
  const opts = config.reviewOptions ?? {};
  const optionalDomains: string[] = [];
  if (opts.todoScan === true)
    optionalDomains.push(REVIEW_OPTIONAL_DOMAIN_TODO_SCAN);
  if (opts.canSplit === true)
    optionalDomains.push(REVIEW_OPTIONAL_DOMAIN_CAN_SPLIT);
  if (opts.effortEstimate === true)
    optionalDomains.push(REVIEW_OPTIONAL_DOMAIN_EFFORT);

  const effortField =
    opts.effortEstimate === true
      ? "- **Effort:** <optional estimated whole minutes to address this finding, e.g. 5; omit or write N/A when not estimable>"
      : "";

  return rawSystemPrompt
    .replace("{{REVIEW_OPTIONAL_DOMAINS}}", optionalDomains.join("\n\n"))
    .replace("{{EFFORT_FIELD}}", effortField);
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
  extraInstructions?: string,
): string {
  const templatePath = path.join(promptsDir, "task-template.md");
  let template: string;
  try {
    template = fs.readFileSync(templatePath, "utf8");
  } catch {
    throw new Error(`Reviewer: cannot read task template at ${templatePath}`);
  }

  const trimmedExtraInstructions = extraInstructions?.trim();

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
    )
    .replace(
      /\{\{EXTRA_INSTRUCTIONS\}\}/g,
      trimmedExtraInstructions
        ? `\n## Extra Instructions\n\n${trimmedExtraInstructions}\n`
        : "",
    );
}

export function createReviewerExecution(
  deps: ReviewerExecutionDependencies,
): ReviewerExecution {
  return {
    async runAttempt(input: ReviewerAttemptInput): Promise<ReviewerResult> {
      const promptsDir = deps.getPromptsDir();
      const rawSystemPrompt = (deps.readSystemPrompt ?? readSystemPrompt)(
        promptsDir,
      );
      const systemPrompt = (deps.renderSystemPrompt ?? renderSystemPrompt)(
        rawSystemPrompt,
        input.config,
      );
      // Resolve the diff and its coverage signal. When a diff is supplied
      // (dispatcher path) honour its coverage too; otherwise gather the diff
      // and derive coverage here (reviewer-direct path). The coverage is
      // stamped onto the parsed report so the PR-gate verdict can tell a
      // truncated (PARTIAL) review from a fully-reviewed one.
      let diff: string;
      let coverage: DiffCoverage | undefined;
      if (input.diff !== undefined) {
        diff = input.diff;
        coverage = input.diffCoverage;
      } else {
        const gathered = await (deps.gatherDiff ?? gatherDiff)(
          input.files,
          input.cwd,
          input.config.maxDiffLines,
          undefined, // baseRef — post-turn reviewer diffs working tree vs HEAD
          input.filterOptions,
          input.config.useStructuredHunks === true,
        );
        diff = gathered.text;
        coverage = {
          truncated: gathered.truncated,
          omittedLines: gathered.omittedLines,
          maxLines: input.config.maxDiffLines,
        };
      }
      const taskPrompt = (deps.renderTaskTemplate ?? renderTaskTemplate)(
        promptsDir,
        input.task,
        input.files,
        diff,
        input.testPlan,
        input.config.extraInstructions,
      );
      const spawn = deps.spawnReviewer ?? spawnReviewer;
      // Stamp the diff-coverage signal onto the parsed report (metadata; not
      // authored by the reviewer child).
      const stampCoverage = (result: ReviewerResult): ReviewerResult =>
        result.report && coverage
          ? { ...result, report: { ...result.report, diffCoverage: coverage } }
          : result;
      const primaryResult = stampCoverage(
        await spawn(
          taskPrompt,
          systemPrompt,
          input.config,
          input.cwd,
          input.signal,
        ),
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
        const fallbackResult = stampCoverage(
          await spawn(
            taskPrompt,
            systemPrompt,
            { ...input.config, model: fallbackModel },
            input.cwd,
            input.signal,
          ),
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

/**
 * Check whether the report contains findings at or above the threshold.
 * @deprecated Re-exported from ../shared/review-severity.js for backwards
 * compatibility. New callers should import from there directly.
 */
export { hasFindingsAboveThreshold };
