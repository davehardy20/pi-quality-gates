import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { lint } from "markdownlint/promise";
import { minimatch } from "minimatch";
import { normalizeAndSortPaths, normalizePath } from "../shared/path-utils.js";
export const DEFAULT_MARKDOWNLINT_CONFIG = {
    default: true,
    MD013: { line_length: 120 },
};
export const DEFAULT_CONFIG = {
    cooldownMs: 15_000,
    timeoutMs: 60_000,
    reportMode: "auto-follow-up",
    runtimeMode: "auto",
    lsp: {
        enabled: false,
        settleMs: 500,
        timeoutMs: 15_000,
        minSeverity: "warning",
        maxFilesPerWorkspace: 100,
    },
    linters: {
        ".md": { type: "api", name: "markdownlint", runner: runMarkdownlint },
        ".ts": { type: "cli", command: "biome", args: ["check"], name: "Biome" },
        ".tsx": { type: "cli", command: "biome", args: ["check"], name: "Biome" },
        ".js": { type: "cli", command: "biome", args: ["check"], name: "Biome" },
        ".jsx": { type: "cli", command: "biome", args: ["check"], name: "Biome" },
        ".mjs": { type: "cli", command: "biome", args: ["check"], name: "Biome" },
        ".cjs": { type: "cli", command: "biome", args: ["check"], name: "Biome" },
        ".py": { type: "cli", command: "ruff", args: ["check"], name: "Ruff" },
        ".pyi": { type: "cli", command: "ruff", args: ["check"], name: "Ruff" },
        ".c": {
            type: "cli",
            command: "cppcheck",
            args: ["--enable=all", "--std=c11", "--quiet", "--template=gcc"],
            name: "cppcheck",
        },
        ".cpp": {
            type: "cli",
            command: "cppcheck",
            args: ["--enable=all", "--std=c++17", "--quiet", "--template=gcc"],
            name: "cppcheck",
        },
        ".cc": {
            type: "cli",
            command: "cppcheck",
            args: ["--enable=all", "--std=c++17", "--quiet", "--template=gcc"],
            name: "cppcheck",
        },
        ".h": {
            type: "cli",
            command: "cppcheck",
            args: ["--enable=all", "--quiet", "--template=gcc"],
            name: "cppcheck",
        },
        ".hpp": {
            type: "cli",
            command: "cppcheck",
            args: ["--enable=all", "--std=c++17", "--quiet", "--template=gcc"],
            name: "cppcheck",
        },
        ".tf": {
            type: "cli",
            command: "tflint",
            args: [],
            name: "tflint",
            mode: "project-root",
            rootMarker: ".tflint.hcl",
        },
        ".tfvars": {
            type: "cli",
            command: "tflint",
            args: [],
            name: "tflint",
            mode: "project-root",
            rootMarker: ".tflint.hcl",
        },
        ".rs": {
            type: "cli",
            command: "cargo",
            args: ["clippy", "--all-targets", "--all-features"],
            name: "cargo clippy",
            mode: "project-root",
            rootMarker: "Cargo.toml",
        },
    },
};
export const MAX_MODIFIED_FILES = 1000;
export const BATCH_SIZE = 50;
const CODE_CONTEXT_LINES = 2;
const MAX_EXCERPT_RANGES = 12;
/** Default root markers used when discovering project roots for workspace-mode linters. */
const WORKSPACE_ROOT_MARKERS = [
    "Cargo.toml",
    "package.json",
    ".tflint.hcl",
    ".tflint.hcl.json",
    ".git",
];
export const BUILT_IN_IGNORED_AGENT_ARTIFACT_GLOBS = [
    "**/agent/plans/*.md",
    "**/agent/plans/archive/*.md",
];
export function isBuiltInIgnoredAgentArtifact(filePath) {
    const normalized = normalizePath(resolve(filePath));
    return (/(?:^|\/)agent\/plans\/[^/]+\.md$/i.test(normalized) ||
        /(?:^|\/)agent\/plans\/archive\/[^/]+\.md$/i.test(normalized));
}
export function filterBuiltInIgnoredFiles(filePaths) {
    return filePaths.filter((filePath) => !isBuiltInIgnoredAgentArtifact(filePath));
}
export function parseJsoncConfig(configData) {
    let inString = false;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;
    let withoutComments = "";
    for (let i = 0; i < configData.length; i++) {
        const char = configData[i];
        const next = configData[i + 1];
        if (inLineComment) {
            if (char === "\n") {
                inLineComment = false;
                withoutComments += char;
            }
            continue;
        }
        if (inBlockComment) {
            if (char === "*" && next === "/") {
                inBlockComment = false;
                i++;
            }
            continue;
        }
        if (inString) {
            withoutComments += char;
            if (escaped)
                escaped = false;
            else if (char === "\\")
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            withoutComments += char;
            continue;
        }
        if (char === "/" && next === "/") {
            inLineComment = true;
            i++;
            continue;
        }
        if (char === "/" && next === "*") {
            inBlockComment = true;
            i++;
            continue;
        }
        withoutComments += char;
    }
    let result = "";
    inString = false;
    escaped = false;
    for (let i = 0; i < withoutComments.length; i++) {
        const char = withoutComments[i];
        if (inString) {
            result += char;
            if (escaped)
                escaped = false;
            else if (char === "\\")
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            result += char;
            continue;
        }
        if (char === ",") {
            let j = i + 1;
            while (j < withoutComments.length && /\s/.test(withoutComments[j])) {
                j++;
            }
            if (j < withoutComments.length &&
                (withoutComments[j] === "}" || withoutComments[j] === "]")) {
                continue;
            }
        }
        result += char;
    }
    return JSON.parse(result);
}
export async function loadMarkdownlintConfig(directory) {
    const configPaths = [
        join(directory, ".markdownlint.jsonc"),
        join(directory, ".markdownlint.json"),
    ];
    for (const configPath of configPaths) {
        try {
            const configData = await fs.readFile(configPath, "utf8");
            const userConfig = parseJsoncConfig(configData);
            return { ...DEFAULT_MARKDOWNLINT_CONFIG, ...userConfig };
        }
        catch (error) {
            if (error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT") {
                continue;
            }
            console.error(`[pi-post-turn-linter] Failed to load markdownlint config from ${configPath}:`, error);
            return DEFAULT_MARKDOWNLINT_CONFIG;
        }
    }
    return DEFAULT_MARKDOWNLINT_CONFIG;
}
/**
 * Walk upward from each file's directory looking for a .markdownlintignore.
 * Returns the first one found, or undefined.
 */
function findMarkdownlintIgnore(filePaths) {
    const dirs = new Set(filePaths.map((f) => {
        const parts = resolve(f).split("/");
        parts.pop();
        return parts.join("/");
    }));
    for (const dir of dirs) {
        let current = dir;
        for (let i = 0; i < 10; i++) {
            const candidate = join(current, ".markdownlintignore");
            if (existsSync(candidate))
                return candidate;
            const parent = resolve(current, "..");
            if (parent === current)
                break;
            current = parent;
        }
    }
    return undefined;
}
/**
 * Read a .markdownlintignore file and return its glob patterns.
 * Skips blank lines and comments.
 */
async function loadMarkdownlintIgnorePatterns(ignorePath) {
    const content = await fs.readFile(ignorePath, "utf8");
    const baseDir = resolve(ignorePath, "..");
    return content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((pattern) => (isAbsolute(pattern) ? pattern : join(baseDir, pattern)));
}
/**
 * Filter out files that match any .markdownlintignore pattern.
 * The markdownlint programmatic API does not honour ignorePath,
 * so we pre-filter the file list ourselves.
 */
function filterIgnoredFiles(filePaths, ignorePatterns) {
    return filePaths.filter((filePath) => {
        const absPath = resolve(filePath);
        return !ignorePatterns.some((pattern) => minimatch(absPath, pattern));
    });
}
export async function runMarkdownlint(filePaths, config) {
    let existingFiles = await filterExistingFiles(filePaths);
    if (existingFiles.length === 0) {
        return { kind: "clean", output: "", fileCount: 0, affectedFiles: [] };
    }
    // markdownlint's programmatic API ignores the ignorePath option,
    // so we must filter matching files ourselves before linting.
    const ignoreFile = findMarkdownlintIgnore(existingFiles);
    if (ignoreFile) {
        const ignorePatterns = await loadMarkdownlintIgnorePatterns(ignoreFile);
        existingFiles = filterIgnoredFiles(existingFiles, ignorePatterns);
    }
    if (existingFiles.length === 0) {
        return { kind: "clean", output: "", fileCount: 0, affectedFiles: [] };
    }
    try {
        const lintOptions = {
            files: existingFiles,
            config: config ??
                DEFAULT_MARKDOWNLINT_CONFIG,
        };
        const results = (await lint(lintOptions));
        const output = formatMarkdownlintResults(results);
        const affectedFiles = normalizeAndSortPaths(Object.entries(results)
            .filter(([, violations]) => violations.length > 0)
            .map(([filePath]) => resolve(filePath)));
        return {
            kind: output ? "findings" : "clean",
            output,
            fileCount: existingFiles.length,
            affectedFiles,
        };
    }
    catch (error) {
        return {
            kind: "tool-error",
            output: `Error running markdownlint: ${error instanceof Error ? error.message : String(error)}`,
            fileCount: existingFiles.length,
            affectedFiles: [],
        };
    }
}
function formatMarkdownlintFixInfo(fixInfo) {
    if (!fixInfo)
        return "";
    const parts = [];
    if (typeof fixInfo.lineNumber === "number") {
        parts.push(`line ${fixInfo.lineNumber}`);
    }
    if (typeof fixInfo.editColumn === "number") {
        parts.push(`col ${fixInfo.editColumn}`);
    }
    if (typeof fixInfo.deleteCount === "number") {
        parts.push(`delete ${fixInfo.deleteCount}`);
    }
    if (typeof fixInfo.insertText === "string") {
        parts.push(`insert ${JSON.stringify(fixInfo.insertText)}`);
    }
    return parts.length > 0 ? ` — fix: ${parts.join(", ")}` : "";
}
export function formatMarkdownlintResults(results) {
    const lines = [];
    for (const [filePath, violations] of Object.entries(results)) {
        if (violations.length === 0)
            continue;
        for (const violation of violations) {
            const ruleId = violation.ruleNames.join("/");
            const ruleDocLink = `https://github.com/DavidAnson/markdownlint/blob/main/doc/${violation.ruleNames[0]}.md`;
            const detail = violation.errorDetail ? ` — ${violation.errorDetail}` : "";
            const context = violation.errorContext
                ? ` — context: ${JSON.stringify(violation.errorContext)}`
                : "";
            const fix = formatMarkdownlintFixInfo(violation.fixInfo);
            lines.push(`${filePath}:${violation.lineNumber} ${ruleId} ${violation.ruleDescription}${detail}${context}${fix} [${ruleDocLink}]`);
        }
    }
    return lines.join("\n");
}
export function attachMarkdownlintConfig(linters, markdownlintConfig) {
    const markdownLinter = linters[".md"];
    if (markdownLinter &&
        markdownLinter.type === "api" &&
        markdownLinter.name === "markdownlint") {
        return {
            ...linters,
            ".md": {
                ...markdownLinter,
                runner: (filePaths) => runMarkdownlint(filePaths, markdownlintConfig),
            },
        };
    }
    return linters;
}
export async function loadLinterConfig(directory) {
    const markdownlintConfig = await loadMarkdownlintConfig(directory);
    const configPaths = [
        join(directory, ".pi", "linter.config.json"),
        join(directory, ".opencode", "linter.config.json"),
    ];
    for (const configPath of configPaths) {
        try {
            const configData = await fs.readFile(configPath, "utf8");
            const userConfig = JSON.parse(configData);
            return {
                cooldownMs: userConfig.cooldownMs ?? DEFAULT_CONFIG.cooldownMs,
                timeoutMs: userConfig.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
                reportMode: userConfig.reportMode ?? DEFAULT_CONFIG.reportMode,
                runtimeMode: userConfig.runtimeMode ?? DEFAULT_CONFIG.runtimeMode,
                lsp: {
                    ...(DEFAULT_CONFIG.lsp ?? {}),
                    ...(userConfig.lsp ?? {}),
                },
                linters: attachMarkdownlintConfig({
                    ...DEFAULT_CONFIG.linters,
                    ...(userConfig.linters || {}),
                }, markdownlintConfig),
            };
        }
        catch (error) {
            if (error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT") {
                continue;
            }
            console.error(`[pi-post-turn-linter] Failed to load config from ${configPath}:`, error);
            break;
        }
    }
    return {
        ...DEFAULT_CONFIG,
        linters: attachMarkdownlintConfig(DEFAULT_CONFIG.linters, markdownlintConfig),
    };
}
export function getLinterForFile(filePath, config) {
    return config.linters[extname(filePath).toLowerCase()] || null;
}
function findProjectRoot(startDir, marker) {
    let dir = resolve(startDir);
    const markers = Array.isArray(marker) ? marker : marker ? [marker] : [".git"];
    let prevDir = "";
    while (dir !== prevDir) {
        for (const m of markers) {
            if (existsSync(join(dir, m))) {
                return dir;
            }
        }
        prevDir = dir;
        dir = resolve(dir, "..");
    }
    return resolve(startDir);
}
export function groupFilesByLinter(files, config) {
    const groups = new Map();
    for (const filePath of files) {
        const linter = getLinterForFile(filePath, config);
        if (!linter)
            continue;
        let key;
        if (linter.type === "cli" &&
            (linter.mode === "project-root" || linter.mode === "workspace")) {
            const root = linter.mode === "workspace" && !linter.rootMarker
                ? findProjectRoot(resolve(filePath, ".."), WORKSPACE_ROOT_MARKERS)
                : findProjectRoot(resolve(filePath, ".."), linter.rootMarker || ".git");
            key = `${linter.command}:${linter.args.join(" ")}:root=${root}`;
        }
        else {
            key =
                linter.type === "cli"
                    ? `${linter.command}:${linter.args.join(" ")}`
                    : `api:${linter.name}`;
        }
        const group = groups.get(key) ?? [];
        group.push(filePath);
        groups.set(key, group);
    }
    return groups;
}
export async function runLinter(filePaths, linter, timeoutMs = 60_000, directory) {
    const existingFiles = await filterExistingFiles(filePaths);
    if (existingFiles.length === 0)
        return null;
    if (linter.type === "api") {
        try {
            const result = await linter.runner(existingFiles);
            return {
                kind: result.kind,
                name: linter.name,
                output: result.output,
                fileCount: result.fileCount,
                affectedFiles: result.affectedFiles,
            };
        }
        catch (error) {
            return {
                kind: "tool-error",
                name: linter.name,
                output: `Error running ${linter.name}: ${error instanceof Error ? error.message : String(error)}`,
                fileCount: existingFiles.length,
                affectedFiles: [],
            };
        }
    }
    const outputs = [];
    const isWorkspace = linter.mode === "workspace";
    const isProjectRoot = linter.mode === "project-root";
    const batches = isWorkspace || isProjectRoot
        ? [[]]
        : Array.from({ length: Math.ceil(existingFiles.length / BATCH_SIZE) }, (_, i) => existingFiles.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE));
    const spawnDirectory = isProjectRoot && directory ? directory : directory;
    for (const batch of batches) {
        const cmdParts = isWorkspace || isProjectRoot
            ? [...linter.args]
            : [...linter.args, ...batch];
        const result = await spawnCommand(linter.command, cmdParts, timeoutMs, spawnDirectory);
        if (result.output.startsWith(`Error running ${linter.command}`)) {
            return {
                kind: "tool-error",
                name: linter.name,
                output: result.output,
                fileCount: existingFiles.length,
                affectedFiles: [],
            };
        }
        const normalizedOutput = normalizeCliOutput(linter.command, result.output, result.exitCode);
        if (normalizedOutput)
            outputs.push(normalizedOutput);
    }
    const output = outputs.join("\n").trim();
    return {
        kind: output ? "findings" : "clean",
        name: linter.name,
        output,
        fileCount: existingFiles.length,
        affectedFiles: spawnDirectory
            ? extractAffectedFiles(output, spawnDirectory)
            : [],
    };
}
export function buildCombinedSignature(results) {
    return JSON.stringify(results
        .map((result) => ({
        kind: result.kind,
        signature: result.signature,
    }))
        .sort((a, b) => {
        if (a.kind !== b.kind)
            return a.kind.localeCompare(b.kind);
        return a.signature.localeCompare(b.signature);
    }));
}
export function mergeValidationOutcomes(args) {
    const findings = args.results.filter((result) => result.kind === "findings" && result.report.trim().length > 0);
    const toolErrors = args.results.filter((result) => result.kind === "tool-error" && result.report.trim().length > 0);
    const cleanResults = args.results.filter((result) => result.kind === "clean");
    const signature = buildCombinedSignature(args.results);
    if (findings.length > 0) {
        return {
            kind: "findings",
            report: [...findings, ...toolErrors]
                .map((result) => result.report)
                .join("\n\n"),
            affectedFiles: normalizeAndSortPaths(findings.flatMap((result) => result.affectedFiles)),
            reportMode: args.reportMode,
            signature,
        };
    }
    if (toolErrors.length > 0) {
        return {
            kind: "tool-error",
            report: toolErrors.map((result) => result.report).join("\n\n"),
            affectedFiles: [],
            reportMode: args.reportMode,
            signature,
        };
    }
    if (cleanResults.length > 0 || args.results.length === 0) {
        return {
            kind: "clean",
            report: "",
            affectedFiles: [],
            reportMode: args.reportMode,
            signature,
        };
    }
    return {
        kind: "clean",
        report: "",
        affectedFiles: [],
        reportMode: args.reportMode,
        signature,
    };
}
export async function runQueuedLintChecks(filePaths, directory, providedConfig) {
    const config = providedConfig ?? (await loadLinterConfig(directory));
    const filesByLinter = groupFilesByLinter(new Set(filterBuiltInIgnoredFiles(filePaths)), config);
    const entries = Array.from(filesByLinter.entries());
    const results = [];
    for (const [, groupedFiles] of entries) {
        const linter = getLinterForFile(groupedFiles[0], config);
        if (!linter)
            continue;
        let runDirectory;
        if (linter.type === "cli" && linter.mode === "project-root") {
            runDirectory = findProjectRoot(resolve(groupedFiles[0], ".."), linter.rootMarker);
        }
        else if (linter.type === "cli" && linter.mode === "workspace") {
            runDirectory = linter.rootMarker
                ? findProjectRoot(resolve(groupedFiles[0], ".."), linter.rootMarker)
                : findProjectRoot(resolve(groupedFiles[0], ".."), WORKSPACE_ROOT_MARKERS);
        }
        else {
            runDirectory = directory;
        }
        const result = await runLinter(groupedFiles, linter, config.timeoutMs, runDirectory);
        if (result) {
            results.push(result);
        }
    }
    const validationResults = results.map((result) => {
        const report = `--- ${result.name} (${result.fileCount} file${result.fileCount === 1 ? "" : "s"}) ---\n${result.output}`;
        return {
            kind: result.kind,
            report,
            affectedFiles: result.kind === "findings" ? result.affectedFiles : [],
            signature: report,
        };
    });
    const outcome = mergeValidationOutcomes({
        reportMode: config.reportMode ?? "auto-follow-up",
        results: validationResults,
    });
    if (outcome.kind !== "findings") {
        return outcome;
    }
    const excerpts = await buildCodeExcerptSection(outcome.report, directory);
    return {
        ...outcome,
        report: excerpts ? `${outcome.report}\n\n${excerpts}` : outcome.report,
    };
}
function normalizeCliOutput(command, output, exitCode) {
    const trimmed = output.trim();
    if (!trimmed)
        return "";
    if (command === "biome" &&
        exitCode === 0 &&
        trimmed.startsWith("Checked ") &&
        trimmed.includes("No fixes applied.") &&
        !trimmed.includes("Found ")) {
        return "";
    }
    return trimmed;
}
function extractAffectedFiles(output, directory) {
    const locations = extractIssueLocations(output, directory);
    return normalizeAndSortPaths(locations.map((loc) => loc.filePath));
}
function extractIssueLocations(report, directory) {
    const locations = new Map();
    const linePattern = /^(.+?):(\d+)(?::\d+)?\b/;
    for (const line of report.split(/\r?\n/)) {
        const match = line.match(linePattern);
        if (!match)
            continue;
        const rawPath = match[1].trim();
        const lineNumber = Number.parseInt(match[2] ?? "", 10);
        if (!rawPath || !Number.isFinite(lineNumber) || lineNumber < 1)
            continue;
        if (rawPath.startsWith("http://") || rawPath.startsWith("https://"))
            continue;
        const filePath = normalizePath(isAbsolute(rawPath) ? rawPath : resolve(directory, rawPath));
        const existing = locations.get(filePath) ?? new Set();
        existing.add(lineNumber);
        locations.set(filePath, existing);
    }
    return Array.from(locations.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([filePath, lineNumbers]) => Array.from(lineNumbers)
        .sort((a, b) => a - b)
        .map((lineNumber) => ({ filePath, lineNumber })));
}
function formatExcerptBlock(filePath, lines, startLine, endLine, highlightedLines) {
    const content = lines
        .slice(startLine - 1, endLine)
        .map((line, index) => {
        const lineNumber = startLine + index;
        const marker = highlightedLines.has(lineNumber) ? ">" : " ";
        return `${marker} ${String(lineNumber).padStart(4, " ")} | ${line}`;
    })
        .join("\n");
    return `${filePath}:${startLine}-${endLine}\n\`\`\`text\n${content}\n\`\`\``;
}
async function buildCodeExcerptSection(report, directory) {
    if (!report.trim())
        return "";
    const issueLocations = extractIssueLocations(report, directory).slice(0, MAX_EXCERPT_RANGES);
    if (issueLocations.length === 0)
        return "";
    const byFile = new Map();
    for (const issue of issueLocations) {
        const lines = byFile.get(issue.filePath) ?? [];
        lines.push(issue.lineNumber);
        byFile.set(issue.filePath, lines);
    }
    const sections = [];
    for (const [filePath, rawLineNumbers] of byFile.entries()) {
        try {
            const fileContent = await fs.readFile(filePath, "utf8");
            const fileLines = fileContent.split(/\r?\n/);
            const lineNumbers = Array.from(new Set(rawLineNumbers)).sort((a, b) => a - b);
            const highlightedLines = new Set(lineNumbers);
            const ranges = [];
            for (const lineNumber of lineNumbers) {
                const start = Math.max(1, lineNumber - CODE_CONTEXT_LINES);
                const end = Math.min(fileLines.length, lineNumber + CODE_CONTEXT_LINES);
                const previous = ranges.at(-1);
                if (previous && start <= previous.end + 1) {
                    previous.end = Math.max(previous.end, end);
                }
                else {
                    ranges.push({ start, end });
                }
            }
            sections.push(...ranges.map((range) => formatExcerptBlock(filePath, fileLines, range.start, range.end, highlightedLines)));
        }
        catch {
            // ignore unreadable files
        }
    }
    if (sections.length === 0)
        return "";
    return `--- Code excerpts ---\n${sections.join("\n\n")}`;
}
async function filterExistingFiles(filePaths) {
    const existingFiles = [];
    for (const filePath of filePaths) {
        if (isBuiltInIgnoredAgentArtifact(filePath))
            continue;
        try {
            await fs.access(filePath);
            existingFiles.push(filePath);
        }
        catch {
            // ignore missing files
        }
    }
    return existingFiles;
}
async function spawnCommand(command, args, timeoutMs, cwd) {
    return new Promise((resolve) => {
        const proc = spawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
            ...(cwd ? { cwd } : {}),
        });
        let stdout = "";
        let stderr = "";
        let finished = false;
        const timer = setTimeout(() => {
            if (finished)
                return;
            finished = true;
            proc.kill("SIGKILL");
            resolve({
                output: `Error running ${command}: timed out after ${timeoutMs}ms`,
                exitCode: null,
            });
        }, timeoutMs);
        proc.stdout.on("data", (chunk) => {
            stdout += String(chunk);
        });
        proc.stderr.on("data", (chunk) => {
            stderr += String(chunk);
        });
        proc.on("error", (error) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            resolve({
                output: `Error running ${command}: ${error instanceof Error ? error.message : String(error)}`,
                exitCode: null,
            });
        });
        proc.on("close", (code) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            resolve({
                output: [stdout, stderr].filter(Boolean).join("\n"),
                exitCode: code,
            });
        });
    });
}
export const __test__ = {
    parseJsoncConfig,
    loadMarkdownlintConfig,
    loadLinterConfig,
    groupFilesByLinter,
    getLinterForFile,
    extractIssueLocations,
    extractAffectedFiles,
    buildCodeExcerptSection,
    formatMarkdownlintResults,
    findProjectRoot,
    mergeValidationOutcomes,
    isBuiltInIgnoredAgentArtifact,
    filterBuiltInIgnoredFiles,
    buildCombinedSignature,
};
