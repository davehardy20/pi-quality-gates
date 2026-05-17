/**
 * Shared LSP service for Pi
 *
 * Owns the LSP client cache and provides helpers used by both
 * lsp-tools.ts and post-turn-linter.
 */
import { LSPClient, type LSPDiagnostic } from "./lsp-client.js";
/** Minimal context subset required by the LSP service. */
export interface LspServiceContext {
    ui: {
        notify: (message: string, type?: "info" | "warning" | "error") => void;
        setStatus: (key: string, text: string | undefined) => void;
    };
    hasUI: boolean;
}
export declare function getAliveLspClientKeys(): string[];
export declare function updateLspStatus(ctx: LspServiceContext): void;
export declare function getLspClient(filePath: string, ctx: LspServiceContext): Promise<LSPClient | null>;
export declare function getCachedDiagnostics(filePath: string, ctx: LspServiceContext): Promise<LSPDiagnostic[]>;
export declare function stopAllLspClients(ctx: LspServiceContext): Promise<void>;
