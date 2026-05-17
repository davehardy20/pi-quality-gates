import { describe, expect, it } from "vitest";
import { __test__ as linterTest } from "../src/linter/index.js";
import { __test__ as reviewerTest } from "../src/reviewer/index.js";

const {
  detectModifiedFilesFromToolEvent,
  detectModifiedFilesFromToolResult,
  tokenizeArgs,
} = linterTest;

const {
  severityMeetsThreshold,
  formatPhaseStatus,
} = reviewerTest;
import {
  parseSkipContent,
  shouldSkip,
  filterSkipped,
} from "../src/reviewer/reviewer-skip.js";
import {
  normalizePath,
  pathsEqual,
  normalizeAndSortPaths,
} from "../src/shared/path-utils.js";
import {
  parseJsoncConfig,
  formatMarkdownlintResults,
  groupFilesByLinter,
  getLinterForFile,
  DEFAULT_CONFIG as LinterDefaultConfig,
} from "../src/linter/core.js";
import {
} from "../src/reviewer/index.js";
// severityMeetsThreshold and formatPhaseStatus imported via reviewerTest above
import { DEFAULT_REVIEW_CONFIG } from "../src/reviewer/types.js";
import type { ReviewerState } from "../src/reviewer/types.js";
import { capDiff, extractOriginalTask, parseReviewReport } from "../src/reviewer/reviewer.js";

// ── Post-Turn Linter tests ────────────────────────────────────────────

describe("post-turn-linter: detectModifiedFilesFromToolEvent", () => {
  it("detects a write tool event", () => {
    const files = detectModifiedFilesFromToolEvent({
      toolName: "write",
      args: { path: "/tmp/test.ts" },
    });
    expect(files).toEqual(["/tmp/test.ts"]);
  });

  it("detects an edit tool event", () => {
    const files = detectModifiedFilesFromToolEvent({
      toolName: "edit",
      args: { path: "/tmp/foo.ts" },
    });
    expect(files).toEqual(["/tmp/foo.ts"]);
  });

  it("detects a hashline_edit rename", () => {
    const files = detectModifiedFilesFromToolEvent({
      toolName: "hashline_edit",
      args: { filePath: "/tmp/old.ts", rename: "/tmp/new.ts" },
    });
    expect(files).toEqual(["/tmp/new.ts"]);
  });

  it("detects ast_grep_replace with multiple paths", () => {
    const files = detectModifiedFilesFromToolEvent({
      toolName: "ast_grep_replace",
      args: { paths: ["/tmp/a.ts", "/tmp/b.ts"] },
    });
    expect(files).toEqual(["/tmp/a.ts", "/tmp/b.ts"]);
  });

  it("returns empty for unknown tools", () => {
    const files = detectModifiedFilesFromToolEvent({
      toolName: "read",
      args: { path: "/tmp/test.ts" },
    });
    expect(files).toEqual([]);
  });
});

describe("post-turn-linter: detectModifiedFilesFromToolResult", () => {
  it("extracts modifiedFiles from result details", () => {
    const files = detectModifiedFilesFromToolResult({
      toolName: "write",
      result: {
        details: { modifiedFiles: ["/tmp/a.ts", "/tmp/b.ts"] },
      },
    });
    expect(files).toEqual(["/tmp/a.ts", "/tmp/b.ts"]);
  });

  it("returns null when no modifiedFiles in details", () => {
    const files = detectModifiedFilesFromToolResult({
      toolName: "write",
      result: { details: {} },
    });
    expect(files).toBeNull();
  });
});

describe("post-turn-linter: tokenizeArgs", () => {
  it("tokenizes simple arguments", () => {
    expect(tokenizeArgs("foo bar baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("handles quoted arguments", () => {
    expect(tokenizeArgs('"hello world" foo')).toEqual(["hello world", "foo"]);
  });

  it("handles single quotes", () => {
    expect(tokenizeArgs("'hello world' foo")).toEqual(["hello world", "foo"]);
  });

  it("handles --no-fix flag", () => {
    expect(tokenizeArgs("/tmp/a.ts --no-fix /tmp/b.ts")).toEqual([
      "/tmp/a.ts",
      "--no-fix",
      "/tmp/b.ts",
    ]);
  });
});

// DEFAULT_CONFIG already imported as LinterDefaultConfig above
describe("post-turn-linter: core helpers", () => {
  it("parseJsoncConfig strips comments and trailing commas", () => {
    const result = parseJsoncConfig('{ "default": true, // comment\n "MD013": { "line_length": 120 }, }');
    expect(result).toEqual({ default: true, MD013: { line_length: 120 } });
  });

  it("formatMarkdownlintResults formats violations", () => {
    const results = {
      "/tmp/test.md": [
        {
          lineNumber: 10,
          ruleNames: ["MD013", "line-length"],
          ruleDescription: "Line length",
          errorDetail: "Expected: 120",
        },
      ],
    };
    const output = formatMarkdownlintResults(results);
    expect(output).toContain("/tmp/test.md:10");
    expect(output).toContain("MD013");
  });

  it("getLinterForFile returns correct linter", () => {
    const linter = getLinterForFile("test.py", LinterDefaultConfig);
    expect(linter).not.toBeNull();
    expect(linter!.name).toBe("Ruff");
  });

  it("groupFilesByLinter groups by extension", () => {
    const groups = groupFilesByLinter(
      new Set(["/tmp/a.ts", "/tmp/b.md", "/tmp/c.ts"]),
      LinterDefaultConfig,
    );
    // .ts files share a linter, .md has its own
    expect(groups.size).toBeGreaterThanOrEqual(2);
  });
});

// ── Shared path-utils tests ───────────────────────────────────────────

describe("shared: path-utils", () => {
  it("normalizePath handles backslashes and trailing slashes", () => {
    expect(normalizePath("foo/bar/")).toBe("foo/bar");
    expect(normalizePath("foo\\bar")).toBe("foo/bar");
  });

  it("pathsEqual compares case-insensitively on macOS", () => {
    expect(pathsEqual("Foo/Bar", "foo/bar")).toBe(true);
  });

  it("normalizeAndSortPaths deduplicates and sorts", () => {
    const result = normalizeAndSortPaths(["/b", "/a", "/b"]);
    expect(result).toEqual(["/a", "/b"]);
  });
});

// ── Post-Turn Reviewer tests ──────────────────────────────────────────

describe("post-turn-reviewer: skip filter", () => {
  it("parseSkipContent handles basic patterns", () => {
    const filter = parseSkipContent("*.log\ndist/\n!important.log");
    expect(filter.loaded).toBe(true);
    expect(filter.patternCount).toBe(3);
    expect(shouldSkip(filter, "error.log")).toBe(true);
    expect(shouldSkip(filter, "important.log")).toBe(false);
    expect(shouldSkip(filter, "dist/bundle.js")).toBe(true);
  });

  it("parseSkipContent ignores comments and blank lines", () => {
    const filter = parseSkipContent("# comment\n\n*.tmp\n");
    expect(filter.patternCount).toBe(1);
  });

  it("filterSkipped removes matching paths", () => {
    const filter = parseSkipContent("*.log");
    const result = filterSkipped(filter, ["a.ts", "debug.log", "b.ts"]);
    expect(result).toEqual(["a.ts", "b.ts"]);
  });
});

describe("post-turn-reviewer: reviewer helpers", () => {
  it("capDiff truncates at maxLines", () => {
    const diff = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const capped = capDiff(diff, 5);
    expect(capped).toContain("DIFF TRUNCATED");
    expect(capped.split("\n").length).toBeLessThanOrEqual(7); // 5 lines + blank + truncation notice
  });

  it("capDiff returns original when within limit", () => {
    const diff = "line 1\nline 2\nline 3";
    expect(capDiff(diff, 10)).toBe(diff);
  });

  it("extractOriginalTask finds the last user message", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "First task" } },
      { type: "message", message: { role: "assistant", content: "Done" } },
      { type: "message", message: { role: "user", content: "Second task" } },
    ];
    expect(extractOriginalTask(entries)).toBe("Second task");
  });

  it("extractOriginalTask handles content arrays", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Array content" }],
        },
      },
    ];
    expect(extractOriginalTask(entries)).toBe("Array content");
  });

  it("extractOriginalTask returns empty string for no entries", () => {
    expect(extractOriginalTask([])).toBe("");
  });
});

describe("post-turn-reviewer: parseReviewReport", () => {
  const validReport = `## Review Report

STATUS: ISSUES
CONFIDENCE: HIGH

### Findings

#### [CRITICAL] Missing null check
- **File:** src/index.ts:42
- **Category:** correctness
- **Rule:** null-check
- **Issue:** Variable may be null
- **Evidence:** \`const x = foo()\`
- **Suggestion:** Add a null check

### What was verified
- Build compiles: src/index.ts:1 — no errors

### What could not be verified
- Runtime behavior: cannot execute code

### Summary
One critical issue found.`;

  it("parses a valid report", () => {
    const report = parseReviewReport(validReport);
    expect(report).not.toBeNull();
    expect(report!.status).toBe("ISSUES");
    expect(report!.confidence).toBe("HIGH");
    expect(report!.findings).toHaveLength(1);
    expect(report!.findings[0].severity).toBe("CRITICAL");
    expect(report!.findings[0].file).toBe("src/index.ts");
    expect(report!.findings[0].line).toBe(42);
    expect(report!.verified).toHaveLength(1);
    expect(report!.unverifiable).toHaveLength(1);
    expect(report!.summary).toBeTruthy();
  });

  it("returns null for missing report marker", () => {
    expect(parseReviewReport("No report here")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseReviewReport("")).toBeNull();
  });

  it("parses a PASS report with no findings", () => {
    const passReport = `## Review Report

STATUS: PASS
CONFIDENCE: MEDIUM

### Findings

None.

### What was verified
- Code compiles: verified

### What could not be verified

### Summary
Everything looks good.`;

    const report = parseReviewReport(passReport);
    expect(report).not.toBeNull();
    expect(report!.status).toBe("PASS");
    expect(report!.findings).toHaveLength(0);
  });
});

describe("post-turn-reviewer: severity helpers", () => {
  it("severityMeetsThreshold works correctly", () => {
    expect(severityMeetsThreshold("CRITICAL", "critical")).toBe(true);
    expect(severityMeetsThreshold("WARNING", "critical")).toBe(false);
    expect(severityMeetsThreshold("WARNING", "warning")).toBe(true);
    expect(severityMeetsThreshold("NIT", "warning")).toBe(false);
    expect(severityMeetsThreshold("CRITICAL", "none")).toBe(false);
  });
});

describe("post-turn-reviewer: state machine helpers", () => {
  it("formatPhaseStatus shows current state", () => {
    const state: ReviewerState = {
      phase: "IDLE",
      loopCount: 0,
      lastReport: null,
      pendingFiles: [],
      linterClean: false,
      linterCleanAt: null,
      config: DEFAULT_REVIEW_CONFIG,
      reviewTimerId: null,
      lastUserPrompt: "",
      lastScannedIdx: 0,
    };
    const status = formatPhaseStatus(state, DEFAULT_REVIEW_CONFIG);
    expect(status).toContain("Phase: IDLE");
    expect(status).toContain("Enabled: true");
  });
});

// ── Package manifest and registration tests ───────────────────────────

import * as fs from "node:fs";
import qualityGatesExtension from "../src/index.js";

describe("pi-quality-gates package", () => {
  it("declares the pi-package keyword and extension manifest", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      keywords?: string[];
      pi?: { extensions?: string[] };
    };

    expect(packageJson.keywords).toContain("pi-package");
    expect(packageJson.pi?.extensions).toEqual(["./src/index.ts"]);
  });

  it("registers commands via the bundle entrypoint", () => {
    const registered = {
      commands: [] as string[],
      tools: [] as string[],
    };

    const mockPi = {
      registerCommand: (name: string) => registered.commands.push(name),
      registerTool: (def: { name: string }) => registered.tools.push(def.name),
      sendMessage: () => undefined,
      on: () => undefined,
    };

    qualityGatesExtension(mockPi as never);

    expect(registered.commands).toContain("quality-gates-status");
    expect(registered.commands).toContain("post-turn-linter-run");
    expect(registered.commands).toContain("post-turn-linter-status");
    expect(registered.commands).toContain("reviewer-status");
    expect(registered.commands).toContain("reviewer-run");
    expect(registered.commands).toContain("reviewer-toggle");
  });
});
