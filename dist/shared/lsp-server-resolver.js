/**
 * LSP Server Resolver
 *
 * Maps file extensions to LSP server commands.
 * Supports configuration overrides from ~/.pi/lsp-config.yaml.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
// Built-in server definitions
const BUILTIN_SERVERS = [
    {
        id: "typescript",
        command: ["typescript-language-server", "--stdio"],
        extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    },
    {
        id: "python",
        command: ["pyright-langserver", "--stdio"],
        extensions: [".py", ".pyi"],
    },
    {
        id: "rust",
        command: ["rust-analyzer"],
        extensions: [".rs"],
    },
    {
        id: "go",
        command: ["gopls"],
        extensions: [".go"],
    },
    {
        id: "bash",
        command: ["bash-language-server", "start"],
        extensions: [".sh", ".bash", ".zsh"],
    },
    {
        id: "yaml",
        command: ["yaml-language-server", "--stdio"],
        extensions: [".yaml", ".yml"],
    },
    {
        id: "json",
        command: ["vscode-json-language-server", "--stdio"],
        extensions: [".json", ".jsonc"],
    },
];
let cachedConfig = null;
let cachedMergedServers = null;
function loadConfigFile() {
    const configPath = path.join(os.homedir(), ".pi", "lsp-config.yaml");
    try {
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, "utf8");
            return yamlParse(content);
        }
    }
    catch {
        // ignore config load errors
    }
    return {};
}
function getConfig() {
    if (!cachedConfig) {
        cachedConfig = loadConfigFile();
    }
    return cachedConfig;
}
export function getAutoInstallEnabled() {
    return getConfig().autoInstall !== false;
}
export function getInstallationTimeoutMs() {
    return getConfig().installationTimeoutMs ?? 60_000;
}
export function getMergedServers() {
    if (cachedMergedServers)
        return cachedMergedServers;
    const config = getConfig();
    const overrides = config.servers ?? {};
    const merged = new Map();
    for (const server of BUILTIN_SERVERS) {
        merged.set(server.id, { ...server });
    }
    for (const [id, override] of Object.entries(overrides)) {
        const existing = merged.get(id);
        if (existing) {
            merged.set(id, {
                ...existing,
                command: override.command ?? existing.command,
                extensions: override.extensions ?? existing.extensions,
                disabled: override.disabled ?? existing.disabled,
            });
        }
        else {
            merged.set(id, {
                id,
                command: override.command ?? ["unknown"],
                extensions: override.extensions ?? [],
                disabled: override.disabled,
            });
        }
    }
    cachedMergedServers = Array.from(merged.values()).filter((s) => !s.disabled);
    return cachedMergedServers;
}
export function resetCache() {
    cachedConfig = null;
    cachedMergedServers = null;
}
export function findServerForExtension(ext) {
    const servers = getMergedServers();
    return servers.find((s) => s.extensions.includes(ext));
}
export function findServerForFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return findServerForExtension(ext);
}
export function findWorkspaceRoot(filePath) {
    let dir = path.resolve(path.dirname(filePath));
    const markers = [
        ".git",
        "package.json",
        "pyproject.toml",
        "Cargo.toml",
        "go.mod",
        "pom.xml",
        "build.gradle",
    ];
    let prevDir = "";
    while (dir !== prevDir) {
        for (const marker of markers) {
            if (fs.existsSync(path.join(dir, marker))) {
                return dir;
            }
        }
        prevDir = dir;
        dir = path.dirname(dir);
    }
    return path.dirname(path.resolve(filePath));
}
