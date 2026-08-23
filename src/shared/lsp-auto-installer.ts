/**
 * LSP Auto-Installer
 *
 * Attempts to install missing language servers using the detected package manager.
 * Fallback chain: global npm install → local project install → npx.
 */

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

const INSTALL_COMMANDS: Record<string, string[]> = {
	"typescript-language-server": [
		"npm",
		"install",
		"-g",
		"typescript-language-server",
		"typescript",
	],
	"pyright-langserver": ["npm", "install", "-g", "pyright"],
	"rust-analyzer": [], // handled by rustup
	gopls: [], // handled by go install
	"bash-language-server": ["npm", "install", "-g", "bash-language-server"],
	"yaml-language-server": ["npm", "install", "-g", "yaml-language-server"],
	"vscode-json-language-server": [
		"npm",
		"install",
		"-g",
		"vscode-langservers-extracted",
	],
};

function detectPackageManager(cwd: string): PackageManager {
	if (
		fs.existsSync(path.join(cwd, "bun.lockb")) ||
		fs.existsSync(path.join(cwd, "bun.lock"))
	) {
		return "bun";
	}
	if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
		return "pnpm";
	}
	if (fs.existsSync(path.join(cwd, "yarn.lock"))) {
		return "yarn";
	}
	if (fs.existsSync(path.join(cwd, "package-lock.json"))) {
		return "npm";
	}
	// Check for global availability
	try {
		execSync("bun --version", { stdio: "ignore" });
		return "bun";
	} catch {
		/* ignore */
	}
	try {
		execSync("pnpm --version", { stdio: "ignore" });
		return "pnpm";
	} catch {
		/* ignore */
	}
	try {
		execSync("npm --version", { stdio: "ignore" });
		return "npm";
	} catch {
		/* ignore */
	}
	return "unknown";
}

function isOnPath(command: string): boolean {
	const isWindows = process.platform === "win32";
	try {
		const result = spawnSync(isWindows ? "where" : "which", [command], {
			stdio: "ignore",
			shell: false,
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

function isWindows(): boolean {
	return process.platform === "win32";
}

function findBinary(command: string): string | undefined {
	if (isOnPath(command)) return command;
	// Check npm global
	try {
		const prefix = execSync("npm prefix -g", { encoding: "utf-8" }).trim();
		const binDir = isWindows() ? prefix : path.join(prefix, "bin");
		const candidates = isWindows()
			? [
					path.join(binDir, `${command}.cmd`),
					path.join(binDir, `${command}.exe`),
					path.join(binDir, command),
				]
			: [path.join(binDir, command)];
		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) return candidate;
		}
	} catch {
		/* ignore */
	}
	return undefined;
}

function tryRustAnalyzerInstall(): string | undefined {
	if (!isOnPath("rustup")) return undefined;

	try {
		execSync("rustup component add rust-analyzer", { stdio: "ignore" });
		return findBinary("rust-analyzer");
	} catch {
		return undefined;
	}
}

function tryGoPlsInstall(): string | undefined {
	if (!isOnPath("go")) return undefined;

	try {
		execSync("go install golang.org/x/tools/gopls@latest", {
			stdio: "ignore",
		});
		return findBinary("gopls");
	} catch {
		return undefined;
	}
}

function tryGlobalInstall(
	binaryName: string,
	installCommand: string[],
): string | undefined {
	try {
		execSync(installCommand.join(" "), { stdio: "ignore", timeout: 60_000 });
		return findBinary(binaryName);
	} catch {
		return undefined;
	}
}

function getPackageName(installCommand: string[]): string | undefined {
	return installCommand.at(-1);
}

function buildLocalInstallCommand(
	packageManager: PackageManager,
	packageName: string,
): string[] | undefined {
	switch (packageManager) {
		case "bun":
			return ["bun", "add", "-d", packageName];
		case "pnpm":
			return ["pnpm", "add", "-D", packageName];
		case "yarn":
			return ["yarn", "add", "-D", packageName];
		case "npm":
			return ["npm", "install", "-D", packageName];
		case "unknown":
			return undefined;
	}
}

function findLocalBinary(cwd: string, binaryName: string): string | undefined {
	const localBin = path.join(cwd, "node_modules", ".bin", binaryName);
	if (fs.existsSync(localBin)) return localBin;
	if (!isWindows()) return undefined;

	const localBinCmd = `${localBin}.cmd`;
	return fs.existsSync(localBinCmd) ? localBinCmd : undefined;
}

function tryLocalInstall(
	binaryName: string,
	installCommand: string[],
	cwd: string,
): string | undefined {
	const packageName = getPackageName(installCommand);
	if (!packageName) return undefined;

	const localCommand = buildLocalInstallCommand(
		detectPackageManager(cwd),
		packageName,
	);
	if (!localCommand) return undefined;

	try {
		execSync(localCommand.join(" "), {
			cwd,
			stdio: "ignore",
			timeout: 60_000,
		});
		return findLocalBinary(cwd, binaryName);
	} catch {
		return undefined;
	}
}

function trySpecialInstall(binaryName: string): string | undefined {
	switch (binaryName) {
		case "rust-analyzer":
			return tryRustAnalyzerInstall();
		case "gopls":
			return tryGoPlsInstall();
		default:
			return undefined;
	}
}

/**
 * Install a language server. Returns the command path if successful.
 */
export async function installLanguageServer(
	_serverId: string,
	binaryName: string,
	cwd: string,
): Promise<string | undefined> {
	const existing = findBinary(binaryName);
	if (existing) return existing;

	const specialInstall = trySpecialInstall(binaryName);
	if (
		specialInstall ||
		binaryName === "rust-analyzer" ||
		binaryName === "gopls"
	) {
		return specialInstall;
	}

	const installCommand = INSTALL_COMMANDS[binaryName];
	if (!installCommand) return undefined;

	return (
		tryGlobalInstall(binaryName, installCommand) ??
		tryLocalInstall(binaryName, installCommand, cwd)
	);
}

/**
 * Get installation instructions for a server.
 */
export function getInstallInstructions(binaryName: string): string {
	const commands: Record<string, string> = {
		"typescript-language-server":
			"npm install -g typescript-language-server typescript",
		"pyright-langserver": "npm install -g pyright",
		"rust-analyzer": "rustup component add rust-analyzer",
		gopls: "go install golang.org/x/tools/gopls@latest",
		"bash-language-server": "npm install -g bash-language-server",
		"yaml-language-server": "npm install -g yaml-language-server",
		"vscode-json-language-server":
			"npm install -g vscode-langservers-extracted",
	};
	return (
		commands[binaryName] ??
		`Install '${binaryName}' and ensure it's in your PATH`
	);
}
