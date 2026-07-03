import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { __test__ as cliAdapterTest } from "../src/linter/adapters/cli.js";
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
  args: ["check"],
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
});
