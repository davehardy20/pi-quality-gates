import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { __test__ as cliAdapterTest } from "../src/linter/adapters/cli.js";
import {
  DEFAULT_CONFIG,
  getLinterForFile,
} from "../src/linter/config-loader.js";
import type { CliLinterDefinition } from "../src/linter/types.js";

const biomeLinter: CliLinterDefinition = {
  type: "cli",
  command: "biome",
  args: ["check"],
  name: "Biome",
};

const ruffLinter: CliLinterDefinition = {
  type: "cli",
  command: "ruff",
  args: ["check", "--output-format=concise"],
  name: "Ruff",
};

describe("linter cli adapter", () => {
  it("runs per-file Biome checks from the file project root", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pi-quality-gates-biome-root-"));
    const externalRepo = join(tempDir, "external-repo");
    const srcDir = join(externalRepo, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(externalRepo, "biome.json"), "{}\n");

    const filePath = join(srcDir, "index.ts");
    writeFileSync(filePath, "export const value = 1;\n");

    expect(
      cliAdapterTest.resolvePerFileExecutionCwd(
        filePath,
        "/Users/dave/.pi",
        biomeLinter,
      ),
    ).toBe(externalRepo);
  });

  it("keeps non-Biome per-file linters on the caller cwd", () => {
    expect(
      cliAdapterTest.resolvePerFileExecutionCwd(
        "/tmp/project/app.py",
        "/caller/repo",
        ruffLinter,
      ),
    ).toBe("/caller/repo");
  });

  it("normalizes gofmt file output into actionable findings", () => {
    expect(
      cliAdapterTest.normalizeCliOutput("gofmt", "/tmp/project/main.go\n", 0),
    ).toBe(
      "/tmp/project/main.go:1:1 [warning] GOFMT file is not gofmt-formatted",
    );
  });

  it("normalizes go vet path prefixes", () => {
    expect(
      cliAdapterTest.normalizeCliOutput(
        "go",
        "vet: ./broken.go:2:28: undefined: missing\n",
        1,
      ),
    ).toBe("./broken.go:2:28: undefined: missing");
  });

  it("passes Ruff concise output through normalizeCliOutput unchanged", () => {
    // Ruff's default `text` format renders ASCII-art boxes where the path lands
    // on a ` --> path:line:col` line that the pipeline cannot parse. The default
    // config must force `--output-format=concise` so findings look like
    // `path:line:col: code message`, matching cppcheck/gofmt/biome conventions.
    const concise =
      "/repo/app.py:1:8: F401 [*] `os` imported but unused\nFound 1 error.\n[*] 1 fixable with the `--fix` option.";
    expect(cliAdapterTest.normalizeCliOutput("ruff", concise, 1)).toBe(concise);
  });

  it("extracts affected files from Ruff concise output", () => {
    const concise =
      "/repo/app.py:1:8: F401 [*] `os` imported but unused\nFound 1 error.";
    expect(cliAdapterTest.extractAffectedFiles(concise, "/repo")).toEqual([
      "/repo/app.py",
    ]);
  });

  it("normalizes Biome formatter diagnostics into affected files", () => {
    const biomeReport = [
      "Checked 1 file in 4ms. No fixes applied.",
      "Found 1 error.",
      "",
      "test/example.ts format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      "  × Formatter would have printed the following content:",
      "  ",
      "    10 10 │   const value = 1;",
      "    11    │ - ······DEFAULT_AGENT_PROFILES.profiles[",
      "    12    │ - ········profileName·as·AgentProfileName",
      "    13    │ - ······],",
      "       11 │ + ······DEFAULT_AGENT_PROFILES.profiles[profileName·as·AgentProfileName],",
      "    14 12 │   export { value };",
    ].join("\n");

    const normalized = cliAdapterTest.normalizeCliOutput(
      "biome",
      biomeReport,
      1,
    );

    expect(normalized).toContain(
      "test/example.ts:11:1 format Formatter would have printed different content — fix: replace with: DEFAULT_AGENT_PROFILES.profiles[profileName as AgentProfileName],",
    );
    expect(cliAdapterTest.extractAffectedFiles(normalized, "/repo")).toEqual([
      "/repo/test/example.ts",
    ]);
  });

  it("uses a generic Biome formatter fix hint for multiline replacements", () => {
    const biomeReport = [
      "Checked 1 file in 4ms. No fixes applied.",
      "Found 1 error.",
      "",
      "test/example.ts format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      "  × Formatter would have printed the following content:",
      "  ",
      "    10    │ - ······const·value·=·DEFAULT_AGENT_PROFILES.profiles[profileName·as·AgentProfileName];",
      "       10 │ + ······const·value·=",
      "       11 │ + ········DEFAULT_AGENT_PROFILES.profiles[profileName·as·AgentProfileName];",
    ].join("\n");

    expect(
      cliAdapterTest.normalizeCliOutput("biome", biomeReport, 1),
    ).toContain(
      "test/example.ts:10:1 format Formatter would have printed different content — fix: run biome format",
    );
  });

  it("uses a generic Biome formatter fix hint for removal-only diffs", () => {
    const biomeReport = [
      "Checked 1 file in 4ms. No fixes applied.",
      "Found 1 error.",
      "",
      "test/example.ts format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      "  × Formatter would have printed the following content:",
      "  ",
      "    10 10 │   const value = 1;",
      "    11    │ - ",
      "    12 11 │   export { value };",
    ].join("\n");

    expect(
      cliAdapterTest.normalizeCliOutput("biome", biomeReport, 1),
    ).toContain(
      "test/example.ts:11:1 format Formatter would have printed different content — fix: run biome format",
    );
  });

  it("normalizes Biome diagnostic headers with their message", () => {
    const biomeReport = [
      "Checked 1 file in 3ms. No fixes applied.",
      "Found 2 errors.",
      "",
      "agent/extensions/shared/orchestrator-agent-spec.ts:116:1 parse ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      "  × Expected a statement but instead found '}'.",
      "  ",
      "    114 │   return spec;",
      "    115 │ }",
      "  > 116 │ }",
      "        │ ^",
      "  ",
      "    139 141 │         \"agent/extensions/shared/orchestrator-agent-spec.ts:116:1 parse Expected a statement but instead found '}'.\",",
      "",
      "agent/extensions/shared/orchestrator-agent-spec.ts format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      "  × Code formatting aborted due to parsing errors. To format code with errors, enable the 'formatter.formatWithErrors' option.",
    ].join("\n");

    const normalized = cliAdapterTest.normalizeCliOutput(
      "biome",
      biomeReport,
      1,
    );

    expect(normalized).toContain(
      "agent/extensions/shared/orchestrator-agent-spec.ts:116:1 parse Expected a statement but instead found '}'.",
    );
    expect(normalized).not.toContain(
      "format Formatter would have printed different content",
    );
    expect(cliAdapterTest.extractAffectedFiles(normalized, "/repo")).toEqual([
      "/repo/agent/extensions/shared/orchestrator-agent-spec.ts",
    ]);
  });

  it("does not misparse Ruff default-format output as a clean path", () => {
    // Guards the regression: the default `text` format emits ` --> path:line`,
    // which the location regex captures as ` --> path` (corrupted).
    const defaultFormat =
      "F401 [*] `os` imported but unused\n --> /repo/app.py:1:8";
    const files = cliAdapterTest.extractAffectedFiles(defaultFormat, "/repo");
    expect(files).not.toContain("/repo/app.py");
  });

  it("default config routes .py and .pyi to Ruff with concise output", () => {
    expect(getLinterForFile("/repo/app.py", DEFAULT_CONFIG)).toEqual({
      type: "cli",
      command: "ruff",
      args: ["check", "--output-format=concise"],
      name: "Ruff",
    });
    expect(getLinterForFile("/repo/types.pyi", DEFAULT_CONFIG)).toEqual({
      type: "cli",
      command: "ruff",
      args: ["check", "--output-format=concise"],
      name: "Ruff",
    });
  });

  it("default config suppresses cppcheck environmental noise on C-family files", () => {
    // cppcheck runs without system include paths in the lint sandbox, so every
    // `#include <...>` line reports missingIncludeSystem, and --enable=all emits
    // an informational checkersReport banner the findings parser counts as a
    // finding. Both are environmental false positives that latch the PR-review
    // lint gate on C-file edit turns (see .pi-d197 in davehardy20/pi-config).
    const noiseSuppressions = [
      "--suppress=missingIncludeSystem",
      "--suppress=checkersReport",
    ];
    const expectedArgs: Record<string, string[]> = {
      ".c": ["--enable=all", "--std=c11", "--quiet", "--template=gcc"],
      ".cpp": ["--enable=all", "--std=c++17", "--quiet", "--template=gcc"],
      ".cc": ["--enable=all", "--std=c++17", "--quiet", "--template=gcc"],
      ".h": ["--enable=all", "--quiet", "--template=gcc"],
      ".hpp": ["--enable=all", "--std=c++17", "--quiet", "--template=gcc"],
    };
    for (const [ext, baseArgs] of Object.entries(expectedArgs)) {
      expect(
        getLinterForFile(`/repo/native/source${ext}`, DEFAULT_CONFIG),
        ext,
      ).toEqual({
        type: "cli",
        command: "cppcheck",
        args: [...baseArgs, ...noiseSuppressions],
        name: "cppcheck",
      });
    }
  });
});
