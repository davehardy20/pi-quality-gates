/**
 * LSP Auto-Installer
 *
 * Attempts to install missing language servers using the detected package manager.
 * Fallback chain: global npm install → local project install → npx.
 */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";
/**
 * Install a language server. Returns the command path if successful.
 */
export declare function installLanguageServer(_serverId: string, binaryName: string, cwd: string): Promise<string | undefined>;
/**
 * Get installation instructions for a server.
 */
export declare function getInstallInstructions(binaryName: string): string;
