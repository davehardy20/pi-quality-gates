/**
 * Simplified LSP Client for Pi
 *
 * Manages JSON-RPC communication with a single language server process.
 * Inspired by pi-lens and OMO LSP implementations.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, } from "vscode-jsonrpc/node.js";
import { normalizePath, uriToNormalizedPath } from "./path-utils.js";
// ── Helpers ───────────────────────────────────────────────────────────
/**
 * Normalize a documentSymbol response item.
 *
 * The LSP spec allows two response types for textDocument/documentSymbol:
 * - DocumentSymbol: has `range` at the top level
 * - SymbolInformation: has `range` nested inside `location`
 *
 * Some servers (notably pyright, bash-language-server) return SymbolInformation
 * for flat files. This normalizes both to DocumentSymbol shape.
 */
function normalizeDocumentSymbol(raw) {
    // Already DocumentSymbol shape (has top-level range)
    if (raw.range && typeof raw.range === "object") {
        return {
            name: String(raw.name ?? ""),
            kind: Number(raw.kind ?? 0),
            range: raw.range,
            selectionRange: raw.selectionRange,
            children: Array.isArray(raw.children)
                ? raw.children.map((c) => normalizeDocumentSymbol(c))
                : undefined,
        };
    }
    // SymbolInformation shape (range nested inside location)
    const loc = raw.location;
    if (loc && typeof loc.range === "object") {
        return {
            name: String(raw.name ?? ""),
            kind: Number(raw.kind ?? 0),
            range: loc.range,
            children: undefined,
        };
    }
    // Fallback: return a zero-range symbol so callers don't crash
    return {
        name: String(raw.name ?? "<unknown>"),
        kind: Number(raw.kind ?? 0),
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };
}
function canWriteToProcess(process) {
    return Boolean(process.stdin &&
        !process.stdin.destroyed &&
        process.stdin.writable &&
        process.exitCode === null &&
        !process.killed);
}
function isIgnorableShutdownError(error) {
    if (!(error instanceof Error))
        return false;
    const code = error.code;
    return (code === "ERR_STREAM_DESTROYED" ||
        code === "EPIPE" ||
        error.message.includes("Connection is closed") ||
        error.message.includes("write after a stream was destroyed") ||
        error.message.includes("write EPIPE") ||
        error.message.includes("broken pipe"));
}
async function sendNotificationSafely(connection, method, params) {
    await Promise.resolve(connection.sendNotification(method, params));
}
async function sendRequestSafely(connection, method, params) {
    return await Promise.resolve(connection.sendRequest(method, params));
}
export class LSPClient {
    state = null;
    stoppingPromise = null;
    root;
    command;
    timeoutMs;
    constructor(root, command, timeoutMs = 15_000) {
        this.root = root;
        this.command = command;
        this.timeoutMs = timeoutMs;
    }
    async start() {
        if (this.state)
            return;
        let stderrBuffer = "";
        const proc = spawn(this.command[0], this.command.slice(1), {
            cwd: this.root,
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
        });
        if (!proc.stdin || !proc.stdout || !proc.stderr) {
            throw new Error(`Failed to spawn LSP server: ${this.command.join(" ")}`);
        }
        proc.stderr.on("data", (chunk) => {
            stderrBuffer += chunk.toString("utf-8");
        });
        // Check immediate exit
        if (proc.exitCode !== null) {
            throw new Error(`LSP server exited immediately (code: ${proc.exitCode}). Stderr: ${stderrBuffer.trim() || "(none)"}`);
        }
        const connection = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
        const diagnostics = new Map();
        const documentVersions = new Map();
        const openDocuments = new Set();
        connection.onNotification("textDocument/publishDiagnostics", (params) => {
            diagnostics.set(uriToNormalizedPath(params.uri), params.diagnostics ?? []);
        });
        connection.onRequest("workspace/configuration", async () => [{}]);
        connection.onRequest("client/registerCapability", async () => { });
        connection.onRequest("window/workDoneProgress/create", async () => { });
        connection.onError((error) => {
            if (this.state?.shuttingDown && isIgnorableShutdownError(error)) {
                return;
            }
            console.error("[LSP] connection error:", error);
        });
        connection.onClose(() => {
            if (this.state)
                this.state.alive = false;
        });
        connection.listen();
        // Initialize
        try {
            await this.withTimeout(connection.sendRequest("initialize", {
                processId: process.pid,
                rootUri: pathToFileURL(this.root).href,
                workspaceFolders: [
                    { name: "workspace", uri: pathToFileURL(this.root).href },
                ],
                capabilities: {
                    textDocument: {
                        definition: {},
                        references: {},
                        documentSymbol: {},
                        rename: {},
                        hover: {},
                        publishDiagnostics: {},
                    },
                    workspace: {
                        workspaceFolders: true,
                        applyEdit: true,
                    },
                },
            }), this.timeoutMs);
        }
        catch (err) {
            proc.kill("SIGTERM");
            throw new Error(`LSP initialize failed for ${this.command.join(" ")}. ${err instanceof Error ? err.message : String(err)} Stderr: ${stderrBuffer.trim() || "(none)"}`);
        }
        try {
            await sendNotificationSafely(connection, "initialized", {});
        }
        catch (error) {
            proc.kill("SIGTERM");
            throw new Error(`LSP initialized notification failed for ${this.command.join(" ")}. ${error instanceof Error ? error.message : String(error)} Stderr: ${stderrBuffer.trim() || "(none)"}`);
        }
        this.state = {
            connection,
            process: proc,
            diagnostics,
            documentVersions,
            openDocuments,
            alive: true,
            shuttingDown: false,
        };
        // Wait a moment for server to be ready
        await new Promise((r) => setTimeout(r, 300));
    }
    async stop() {
        if (!this.state)
            return;
        if (this.stoppingPromise)
            return this.stoppingPromise;
        const state = this.state;
        const { connection, process } = state;
        state.alive = false;
        state.shuttingDown = true;
        this.stoppingPromise = (async () => {
            // Close all open documents before shutting down
            for (const filePath of state.openDocuments) {
                if (canWriteToProcess(process)) {
                    try {
                        await sendNotificationSafely(connection, "textDocument/didClose", {
                            textDocument: { uri: pathToFileURL(filePath).href },
                        });
                    }
                    catch (error) {
                        if (!isIgnorableShutdownError(error))
                            throw error;
                    }
                }
            }
            state.openDocuments.clear();
            if (canWriteToProcess(process)) {
                try {
                    await sendRequestSafely(connection, "shutdown", {});
                }
                catch (error) {
                    if (!isIgnorableShutdownError(error))
                        throw error;
                }
                if (canWriteToProcess(process)) {
                    try {
                        await sendNotificationSafely(connection, "exit", {});
                    }
                    catch (error) {
                        if (!isIgnorableShutdownError(error))
                            throw error;
                    }
                }
            }
            connection.dispose();
            if (!process.killed && process.exitCode === null) {
                process.kill("SIGTERM");
            }
            // Force kill after timeout
            setTimeout(() => {
                if (!process.killed && process.exitCode === null) {
                    process.kill("SIGKILL");
                }
            }, 5000);
        })().finally(() => {
            if (this.state === state) {
                this.state = null;
            }
            this.stoppingPromise = null;
        });
        return this.stoppingPromise;
    }
    isAlive() {
        return this.state?.alive ?? false;
    }
    // ── Document sync ──────────────────────────────────────────────────
    async syncFile(filePath) {
        const content = fs.readFileSync(filePath, "utf-8");
        await this.syncDocumentText(filePath, content);
    }
    async syncFiles(filePaths) {
        for (const filePath of filePaths) {
            await this.syncFile(filePath);
        }
    }
    async closeDocument(filePath) {
        if (!this.state)
            return;
        const state = this.state;
        const normalized = normalizePath(filePath);
        if (!state.openDocuments.has(normalized))
            return;
        const uri = pathToFileURL(filePath).href;
        if (!state.shuttingDown && canWriteToProcess(state.process)) {
            try {
                await sendNotificationSafely(state.connection, "textDocument/didClose", {
                    textDocument: { uri },
                });
            }
            catch (error) {
                // Only suppress stream/connection errors during active shutdown.
                if (!(state.shuttingDown && isIgnorableShutdownError(error))) {
                    throw error;
                }
            }
        }
        state.openDocuments.delete(normalized);
        state.diagnostics.delete(normalized);
        state.documentVersions.delete(normalized);
    }
    async waitForDiagnostics(ms = 500) {
        await new Promise((r) => setTimeout(r, ms));
    }
    getCachedDiagnostics(filePath) {
        if (!this.state)
            return [];
        return this.state.diagnostics.get(normalizePath(filePath)) ?? [];
    }
    async syncDocumentText(filePath, content) {
        if (!this.state)
            throw new Error("LSP client not started");
        const state = this.state;
        if (state.shuttingDown || !canWriteToProcess(state.process))
            return;
        const uri = pathToFileURL(filePath).href;
        const normalized = normalizePath(filePath);
        if (state.openDocuments.has(normalized)) {
            // Update instead
            const version = (state.documentVersions.get(normalized) ?? 0) + 1;
            state.documentVersions.set(normalized, version);
            try {
                await sendNotificationSafely(state.connection, "textDocument/didChange", {
                    textDocument: { uri, version },
                    contentChanges: [{ text: content }],
                });
            }
            catch (error) {
                // Only suppress stream/connection errors during active shutdown.
                if (!(state.shuttingDown && isIgnorableShutdownError(error))) {
                    throw error;
                }
            }
            return;
        }
        state.documentVersions.set(normalized, 1);
        try {
            await sendNotificationSafely(state.connection, "textDocument/didOpen", {
                textDocument: {
                    uri,
                    languageId: this.inferLanguageId(filePath),
                    version: 1,
                    text: content,
                },
            });
            state.openDocuments.add(normalized);
        }
        catch (error) {
            state.documentVersions.delete(normalized);
            // Only suppress stream/connection errors during active shutdown.
            if (!(state.shuttingDown && isIgnorableShutdownError(error))) {
                throw error;
            }
        }
    }
    // ── Navigation ─────────────────────────────────────────────────────
    async definition(filePath, line, character) {
        return this.navRequest(filePath, "textDocument/definition", {
            position: { line: line - 1, character },
        });
    }
    async references(filePath, line, character) {
        return this.navRequest(filePath, "textDocument/references", {
            position: { line: line - 1, character },
            context: { includeDeclaration: true },
        });
    }
    async documentSymbol(filePath) {
        const raw = await this.navRequest(filePath, "textDocument/documentSymbol", {});
        if (!Array.isArray(raw))
            return [];
        return raw.map((s) => normalizeDocumentSymbol(s));
    }
    async rename(filePath, line, character, newName) {
        const result = await this.rawNavRequest(filePath, "textDocument/rename", { position: { line: line - 1, character }, newName });
        return result ?? null;
    }
    async prepareRename(filePath, line, character) {
        return this.rawNavRequest(filePath, "textDocument/prepareRename", {
            position: { line: line - 1, character },
        });
    }
    // ── Diagnostics ────────────────────────────────────────────────────
    async diagnostics(filePath, settleMs = 500) {
        if (!this.state)
            return [];
        await this.syncFile(filePath);
        await this.waitForDiagnostics(settleMs);
        return this.getCachedDiagnostics(filePath);
    }
    // ── Helpers ────────────────────────────────────────────────────────
    async navRequest(filePath, method, params) {
        const result = await this.rawNavRequest(filePath, method, params);
        if (!result)
            return [];
        if (Array.isArray(result))
            return result;
        return [result];
    }
    async rawNavRequest(filePath, method, params) {
        if (!this.state)
            throw new Error("LSP client not started");
        if (this.state.shuttingDown || !canWriteToProcess(this.state.process)) {
            return undefined;
        }
        const uri = pathToFileURL(filePath).href;
        await this.syncFile(filePath);
        if (!this.state ||
            this.state.shuttingDown ||
            !canWriteToProcess(this.state.process)) {
            return undefined;
        }
        await this.waitForDiagnostics(300);
        if (!this.state ||
            this.state.shuttingDown ||
            !canWriteToProcess(this.state.process)) {
            return undefined;
        }
        try {
            return await this.withTimeout(sendRequestSafely(this.state.connection, method, {
                textDocument: { uri },
                ...params,
            }), this.timeoutMs);
        }
        catch (error) {
            // Only suppress stream/connection errors during active shutdown.
            // During normal operation these indicate a real server failure.
            if (this.state?.shuttingDown && isIgnorableShutdownError(error)) {
                return undefined;
            }
            throw error;
        }
    }
    async withTimeout(promise, timeoutMs) {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`LSP request timeout after ${timeoutMs}ms`)), timeoutMs)),
        ]);
    }
    inferLanguageId(filePath) {
        const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
        const map = {
            ts: "typescript",
            tsx: "typescriptreact",
            js: "javascript",
            jsx: "javascriptreact",
            py: "python",
            rs: "rust",
            go: "go",
            sh: "shellscript",
            bash: "shellscript",
            yaml: "yaml",
            yml: "yaml",
            json: "json",
            jsonc: "jsonc",
        };
        return map[ext] ?? ext;
    }
}
