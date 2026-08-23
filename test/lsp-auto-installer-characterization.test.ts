// Characterization tests for installLanguageServer CRAP improvement (pi-quality-gates-a893).
// These tests lock observable install fallback behaviour before refactoring.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installLanguageServer } from "../src/shared/lsp-auto-installer.js";

let tmpDir: string;
let binDir: string;
let projectDir: string;
let originalPath: string | undefined;

function makeExecutable(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	fs.chmodSync(filePath, 0o755);
}

function useControlledPath(): void {
	process.env.PATH = [binDir, "/usr/bin", "/bin"].join(path.delimiter);
}

beforeEach(() => {
	originalPath = process.env.PATH;
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-auto-installer-"));
	binDir = path.join(tmpDir, "bin");
	projectDir = path.join(tmpDir, "project");
	fs.mkdirSync(binDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	useControlledPath();
});

afterEach(() => {
	process.env.PATH = originalPath;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("lsp-auto-installer: installLanguageServer characterization", () => {
	it("returns an existing binary name without installing", async () => {
		makeExecutable(
			path.join(binDir, "typescript-language-server"),
			"#!/bin/sh\n",
		);

		await expect(
			installLanguageServer(
				"typescript",
				"typescript-language-server",
				projectDir,
			),
		).resolves.toBe("typescript-language-server");
	});

	it("uses rustup for rust-analyzer and returns the installed binary", async () => {
		makeExecutable(
			path.join(binDir, "rustup"),
			`#!/bin/sh
if [ "$1 $2 $3" != "component add rust-analyzer" ]; then
	exit 9
fi
cat > "${path.join(binDir, "rust-analyzer")}" <<'SH'
#!/bin/sh
SH
chmod +x "${path.join(binDir, "rust-analyzer")}"
`,
		);

		await expect(
			installLanguageServer("rust", "rust-analyzer", projectDir),
		).resolves.toBe("rust-analyzer");
	});

	it("uses go install for gopls and returns the installed binary", async () => {
		makeExecutable(
			path.join(binDir, "go"),
			`#!/bin/sh
if [ "$1 $2" != "install golang.org/x/tools/gopls@latest" ]; then
	exit 9
fi
cat > "${path.join(binDir, "gopls")}" <<'SH'
#!/bin/sh
SH
chmod +x "${path.join(binDir, "gopls")}"
`,
		);

		await expect(
			installLanguageServer("go", "gopls", projectDir),
		).resolves.toBe("gopls");
	});

	it("tries npm global install for npm-based language servers", async () => {
		makeExecutable(
			path.join(binDir, "npm"),
			`#!/bin/sh
if [ "$1" = "prefix" ] && [ "$2" = "-g" ]; then
	printf '%s\n' "${tmpDir}"
	exit 0
fi
if [ "$1 $2 $3" = "install -g pyright" ]; then
	cat > "${path.join(binDir, "pyright-langserver")}" <<'SH'
#!/bin/sh
SH
	chmod +x "${path.join(binDir, "pyright-langserver")}"
	exit 0
fi
exit 9
`,
		);

		await expect(
			installLanguageServer("python", "pyright-langserver", projectDir),
		).resolves.toBe("pyright-langserver");
	});

	it("falls back to local project install when global npm install fails", async () => {
		fs.writeFileSync(path.join(projectDir, "package-lock.json"), "{}\n");
		makeExecutable(
			path.join(binDir, "npm"),
			`#!/bin/sh
if [ "$1" = "prefix" ] && [ "$2" = "-g" ]; then
	printf '%s\n' "${tmpDir}"
	exit 0
fi
if [ "$1 $2 $3" = "install -g pyright" ]; then
	exit 1
fi
if [ "$1 $2 $3" = "install -D pyright" ]; then
	mkdir -p node_modules/.bin
	cat > node_modules/.bin/pyright-langserver <<'SH'
#!/bin/sh
SH
	chmod +x node_modules/.bin/pyright-langserver
	exit 0
fi
exit 9
`,
		);

		await expect(
			installLanguageServer("python", "pyright-langserver", projectDir),
		).resolves.toBe(
			path.join(projectDir, "node_modules", ".bin", "pyright-langserver"),
		);
	});

	async function expectLocalInstallCommand(
		lockFile: string,
		packageManager: string,
		expectedArgs: string,
	): Promise<void> {
		fs.writeFileSync(path.join(projectDir, lockFile), "\n");
		makeExecutable(
			path.join(binDir, "npm"),
			`#!/bin/sh
if [ "$1" = "prefix" ] && [ "$2" = "-g" ]; then
	printf '%s\n' "${tmpDir}"
	exit 0
fi
if [ "$1 $2 $3" = "install -g pyright" ]; then
	exit 1
fi
exit 9
`,
		);
		makeExecutable(
			path.join(binDir, packageManager),
			`#!/bin/sh
if [ "$*" != "${expectedArgs}" ]; then
	exit 9
fi
mkdir -p node_modules/.bin
cat > node_modules/.bin/pyright-langserver <<'SH'
#!/bin/sh
SH
chmod +x node_modules/.bin/pyright-langserver
`,
		);

		await expect(
			installLanguageServer("python", "pyright-langserver", projectDir),
		).resolves.toBe(
			path.join(projectDir, "node_modules", ".bin", "pyright-langserver"),
		);
	}

	it.each([
		["bun.lock", "bun", "add -d pyright"],
		["pnpm-lock.yaml", "pnpm", "add -D pyright"],
		["yarn.lock", "yarn", "add -D pyright"],
	])("uses %s to choose the local install command", expectLocalInstallCommand);

	it("returns undefined when local install does not place the expected binary", async () => {
		fs.writeFileSync(path.join(projectDir, "package-lock.json"), "{}\n");
		makeExecutable(
			path.join(binDir, "npm"),
			`#!/bin/sh
if [ "$1" = "prefix" ] && [ "$2" = "-g" ]; then
	printf '%s\n' "${tmpDir}"
	exit 0
fi
if [ "$1 $2 $3" = "install -g pyright" ]; then
	exit 1
fi
if [ "$1 $2 $3" = "install -D pyright" ]; then
	exit 0
fi
exit 9
`,
		);

		await expect(
			installLanguageServer("python", "pyright-langserver", projectDir),
		).resolves.toBeUndefined();
	});

	it("returns undefined for unsupported missing binaries", async () => {
		await expect(
			installLanguageServer("unknown", "missing-language-server", projectDir),
		).resolves.toBeUndefined();
	});
});
