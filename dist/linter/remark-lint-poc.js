/**
 * Proof-of-concept: remark-lint runner for post-turn-linter.
 *
 * This file demonstrates how remark-lint (via the unified ecosystem)
 * could replace or supplement markdownlint in the post-turn-linter.
 *
 * To use: swap the ".md" linter in DEFAULT_CONFIG from runMarkdownlint
 * to runRemarkLint (see bottom of file).
 */
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { remark } from "remark";
import remarkLint from "remark-lint";
import remarkLintMaximumLineLength from "remark-lint-maximum-line-length";
import remarkLintNoLiteralUrls from "remark-lint-no-literal-urls";
import remarkLintNoMissingBlankLines from "remark-lint-no-missing-blank-lines";
import remarkPresetLintConsistent from "remark-preset-lint-consistent";
import remarkPresetLintRecommended from "remark-preset-lint-recommended";
// ---------------------------------------------------------------------------
// Ignore handling — remark-lint uses .remarkignore (gitignore format)
// or we can pre-filter like we do for markdownlint
// ---------------------------------------------------------------------------
async function filterExistingFiles(filePaths) {
    const existing = [];
    for (const p of filePaths) {
        try {
            await fs.access(p);
            existing.push(p);
        }
        catch {
            // skip missing
        }
    }
    return existing;
}
// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------
export const runRemarkLint = async (filePaths) => {
    const existingFiles = await filterExistingFiles(filePaths);
    if (existingFiles.length === 0) {
        return {
            kind: "clean",
            output: "",
            fileCount: 0,
            affectedFiles: [],
            name: "remark-lint",
        };
    }
    // Build the remark processor with plugins
    const processor = remark()
        .use(remarkLint)
        .use(remarkPresetLintRecommended)
        .use(remarkPresetLintConsistent)
        .use(remarkLintMaximumLineLength, 120) // MD013
        .use(remarkLintNoMissingBlankLines) // MD022 / MD032
        .use(remarkLintNoLiteralUrls); // MD038 (loose)
    const lines = [];
    const affectedFiles = [];
    for (const filePath of existingFiles) {
        try {
            const content = await fs.readFile(filePath, "utf8");
            const result = await processor.process({
                path: filePath,
                value: content,
            });
            const messages = result.messages;
            if (messages.length > 0) {
                affectedFiles.push(resolve(filePath));
                lines.push(`--- ${filePath} ---`);
                for (const msg of messages) {
                    const line = msg.line ?? 0;
                    const col = msg.column ?? 0;
                    const rule = msg.ruleId || "remark-lint";
                    const reason = msg.message;
                    lines.push(`${line}:${col}  ${rule}  ${reason}`);
                }
                lines.push("");
            }
        }
        catch (error) {
            lines.push(`--- ${filePath} ---`);
            lines.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
            lines.push("");
            affectedFiles.push(resolve(filePath));
        }
    }
    const output = lines.join("\n");
    return {
        kind: output ? "findings" : "clean",
        output,
        fileCount: existingFiles.length,
        affectedFiles: affectedFiles.sort(),
        name: "remark-lint",
    };
    // ---------------------------------------------------------------------------
    // Quick self-test (run with: npx tsx remark-lint-poc.ts)
};
// ---------------------------------------------------------------------------
async function selfTest() {
    const testFile = new URL("../../README.md", import.meta.url).pathname;
    const result = await runRemarkLint([testFile]);
    console.log("Kind:", result.kind);
    console.log("Files:", result.fileCount);
    console.log("Affected:", result.affectedFiles);
    console.log("---");
    console.log(result.output || "(clean)");
}
if (import.meta.url.startsWith("file:")) {
    const mainPath = new URL(import.meta.url).pathname;
    if (process.argv[1] === mainPath) {
        selfTest().catch(console.error);
    }
}
