/**
 * Simplified LSP Client for Pi
 *
 * Manages JSON-RPC communication with a single language server process.
 * Inspired by pi-lens and OMO LSP implementations.
 */
export interface LSPDiagnostic {
    severity?: 1 | 2 | 3 | 4;
    message: string;
    range: {
        start: {
            line: number;
            character: number;
        };
        end: {
            line: number;
            character: number;
        };
    };
    code?: string | number;
    source?: string;
}
export interface LSPLocation {
    uri: string;
    range: {
        start: {
            line: number;
            character: number;
        };
        end: {
            line: number;
            character: number;
        };
    };
}
export interface LSPDocumentSymbol {
    name: string;
    kind: number;
    range: LSPLocation["range"];
    selectionRange?: LSPLocation["range"];
    children?: LSPDocumentSymbol[];
}
export interface LSPWorkspaceEdit {
    changes?: Record<string, {
        range: LSPLocation["range"];
        newText: string;
    }[]>;
    documentChanges?: unknown[];
}
export declare class LSPClient {
    private state;
    private stoppingPromise;
    private readonly root;
    private readonly command;
    private readonly timeoutMs;
    constructor(root: string, command: string[], timeoutMs?: number);
    start(): Promise<void>;
    stop(): Promise<void>;
    isAlive(): boolean;
    syncFile(filePath: string): Promise<void>;
    syncFiles(filePaths: string[]): Promise<void>;
    closeDocument(filePath: string): Promise<void>;
    waitForDiagnostics(ms?: number): Promise<void>;
    getCachedDiagnostics(filePath: string): LSPDiagnostic[];
    private syncDocumentText;
    definition(filePath: string, line: number, character: number): Promise<LSPLocation[]>;
    references(filePath: string, line: number, character: number): Promise<LSPLocation[]>;
    documentSymbol(filePath: string): Promise<LSPDocumentSymbol[]>;
    rename(filePath: string, line: number, character: number, newName: string): Promise<LSPWorkspaceEdit | null>;
    prepareRename(filePath: string, line: number, character: number): Promise<unknown>;
    diagnostics(filePath: string, settleMs?: number): Promise<LSPDiagnostic[]>;
    private navRequest;
    private rawNavRequest;
    private withTimeout;
    private inferLanguageId;
}
