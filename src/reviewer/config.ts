import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReviewConfig } from "./types.js";

// Re-export for consumers that import from config.js
export type { ReviewConfig };

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: ReviewConfig = {
  model: null,
  minChangedLines: 5,
  enabled: true,
  maxReReviewPasses: 1,
  autoFixThreshold: "critical",
  maxTokens: 8192,
  timeoutMs: 120_000,
  tools: ["read", "grep", "find", "ls", "bash"],
  allowedBashPatterns: [
    "cat",
    "head",
    "tail",
    "wc",
    "diff",
    "git diff*",
    "git log*",
    "git show*",
    "git blame",
    "git status",
    "jq",
    "rg",
    "grep",
    "find",
    "ls",
    "file",
    "stat",
    "cargo test --no-run",
    "npm test --dry-run",
    "pytest --collect-only",
    "go test -list .*",
  ],
  respectGitignore: true,
  skipFile: ".pi/reviewer.skip",
  allowTestDiscovery: false,
  testDiscoveryCommands: {
    python: ["pytest --collect-only -q"],
    rust: ["cargo test --no-run"],
    go: ["go test -list ."],
    typescript: ["npx jest --listTests"],
    javascript: ["npx jest --listTests"],
  },
  maxDiffLines: 500,
  maxChangedLines: 500,
  reviewDelayMs: 10_000,
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load reviewer config from the following locations in order:
 *
 * 1. `<directory>/.pi/reviewer.config.json` (project-local)
 * 2. `<directory>/reviewer.config.json` (repo root)
 * 3. `~/.pi/reviewer.config.json` (global fallback)
 *
 * - If all files are missing, returns defaults silently.
 * - If a file has invalid JSON, logs a warning and returns defaults.
 * - Partial configs are merged — any missing field falls back to its default.
 */
export function loadReviewConfig(
  directory: string,
  opts?: { log?: (msg: string) => void },
): ReviewConfig {
  const log = opts?.log ?? console.error;
  const configPath = join(directory, ".pi", "reviewer.config.json");
  const fallbackPath = join(directory, "reviewer.config.json");
  const globalPath = join(homedir(), ".pi", "reviewer.config.json");

  let raw: string;
  let usedPath: string;
  try {
    raw = readFileSync(configPath, "utf8");
    usedPath = configPath;
  } catch (error: unknown) {
    // Try repo-root fallback if .pi/ version is missing
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      try {
        raw = readFileSync(fallbackPath, "utf8");
        usedPath = fallbackPath;
      } catch (fbError: unknown) {
        if (
          fbError instanceof Error &&
          "code" in fbError &&
          (fbError as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          // Try global fallback in ~/.pi/
          try {
            raw = readFileSync(globalPath, "utf8");
            usedPath = globalPath;
          } catch (globalError: unknown) {
            if (
              globalError instanceof Error &&
              "code" in globalError &&
              (globalError as NodeJS.ErrnoException).code === "ENOENT"
            ) {
              return { ...DEFAULT_CONFIG };
            }
            log(
              `[pi-post-turn-reviewer] Failed to read config from ${globalPath}: ${globalError}`,
            );
            return { ...DEFAULT_CONFIG };
          }
        } else {
          log(
            `[pi-post-turn-reviewer] Failed to read config from ${fallbackPath}: ${fbError}`,
          );
          return { ...DEFAULT_CONFIG };
        }
      }
    } else {
      log(
        `[pi-post-turn-reviewer] Failed to read config from ${configPath}: ${error}`,
      );
      return { ...DEFAULT_CONFIG };
    }
  }

  let userConfig: Partial<ReviewConfig>;
  try {
    userConfig = JSON.parse(raw) as Partial<ReviewConfig>;
  } catch (parseError) {
    log(
      `[pi-post-turn-reviewer] Invalid JSON in ${usedPath}, using defaults: ${parseError}`,
    );
    return { ...DEFAULT_CONFIG };
  }

  return {
    model: userConfig.model ?? DEFAULT_CONFIG.model,
    minChangedLines:
      userConfig.minChangedLines ?? DEFAULT_CONFIG.minChangedLines,
    enabled: userConfig.enabled ?? DEFAULT_CONFIG.enabled,
    maxReReviewPasses:
      userConfig.maxReReviewPasses ?? DEFAULT_CONFIG.maxReReviewPasses,
    autoFixThreshold:
      userConfig.autoFixThreshold ?? DEFAULT_CONFIG.autoFixThreshold,
    maxTokens: userConfig.maxTokens ?? DEFAULT_CONFIG.maxTokens,
    timeoutMs: userConfig.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    tools: userConfig.tools ?? DEFAULT_CONFIG.tools,
    allowedBashPatterns:
      userConfig.allowedBashPatterns ?? DEFAULT_CONFIG.allowedBashPatterns,
    respectGitignore:
      userConfig.respectGitignore ?? DEFAULT_CONFIG.respectGitignore,
    skipFile:
      userConfig.skipFile !== undefined
        ? userConfig.skipFile
        : DEFAULT_CONFIG.skipFile,
    allowTestDiscovery:
      userConfig.allowTestDiscovery ?? DEFAULT_CONFIG.allowTestDiscovery,
    testDiscoveryCommands: {
      ...DEFAULT_CONFIG.testDiscoveryCommands,
      ...(userConfig.testDiscoveryCommands ?? {}),
    },
    maxDiffLines: userConfig.maxDiffLines ?? DEFAULT_CONFIG.maxDiffLines,
    maxChangedLines:
      userConfig.maxChangedLines ?? DEFAULT_CONFIG.maxChangedLines,
    reviewDelayMs: userConfig.reviewDelayMs ?? DEFAULT_CONFIG.reviewDelayMs,
  };
}
