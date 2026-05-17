/**
 * LSP Server Resolver
 *
 * Maps file extensions to LSP server commands.
 * Supports configuration overrides from ~/.pi/lsp-config.yaml.
 */
export interface LSPServerConfig {
    id: string;
    command: string[];
    extensions: string[];
    disabled?: boolean;
}
export declare function getAutoInstallEnabled(): boolean;
export declare function getInstallationTimeoutMs(): number;
export declare function getMergedServers(): LSPServerConfig[];
export declare function resetCache(): void;
export declare function findServerForExtension(ext: string): LSPServerConfig | undefined;
export declare function findServerForFile(filePath: string): LSPServerConfig | undefined;
export declare function findWorkspaceRoot(filePath: string): string;
