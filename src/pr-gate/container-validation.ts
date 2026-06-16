import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectProjectEcosystem } from "./test-execution.js";

export const DEFAULT_REVIEW_CONTAINER_IMAGE =
	"pi-apple-sandbox-node-ts-fuller:prototype";

const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_PREVIEW_CHARS = 2400;
const WORKSPACE_EXCLUDES = new Set([
	".git",
	".mulch",
	"agent",
	"coverage",
	"dist",
	"node_modules",
]);

export type ContainerValidationStatus = "passed" | "failed" | "skipped";

export interface ContainerCommandResult {
	name: string;
	command: string;
	exitCode: number;
	timedOut: boolean;
	stdout: string;
	stderr: string;
}

export interface ContainerValidationResult {
	image: string;
	status: ContainerValidationStatus;
	results: ContainerCommandResult[];
	evidence: string;
	workspaceMode: "writable-copy" | "skipped";
}

export interface ContainerValidationOptions {
	image?: string;
	timeoutMs?: number;
	containerCommand?: string;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function capOutput(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= OUTPUT_PREVIEW_CHARS) return trimmed;
	return `${trimmed.slice(0, OUTPUT_PREVIEW_CHARS)}… [truncated ${trimmed.length - OUTPUT_PREVIEW_CHARS} chars]`;
}

function isTestFile(file: string): boolean {
	return (
		file.includes(".test.") ||
		file.includes(".spec.") ||
		file.includes("_test.go") ||
		file.includes("/tests/")
	);
}

function deriveStatus(
	results: ContainerCommandResult[],
	fallback: ContainerValidationStatus = "passed",
): ContainerValidationStatus {
	if (results.length === 0) return fallback;
	return results.some((result) => result.exitCode !== 0 || result.timedOut)
		? "failed"
		: "passed";
}

async function prepareWritableWorkspace(cwd: string): Promise<{
	root: string;
	workspace: string;
}> {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-pr-review-"));
	const workspace = path.join(root, "workspace");
	await cp(cwd, workspace, {
		recursive: true,
		filter: (source) => {
			const relative = path.relative(cwd, source);
			if (!relative) return true;
			const parts = relative.split(path.sep);
			return !parts.some((part) => WORKSPACE_EXCLUDES.has(part));
		},
	});
	return { root, workspace };
}

async function runProcess(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
): Promise<{
	exitCode: number;
	timedOut: boolean;
	stdout: string;
	stderr: string;
}> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let exited = false;

		const proc = spawn(command, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		});

		const timeout = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!exited) proc.kill("SIGKILL");
			}, 5000);
		}, timeoutMs);

		proc.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		proc.on("error", (error) => {
			exited = true;
			clearTimeout(timeout);
			resolve({
				exitCode: 127,
				timedOut,
				stdout,
				stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
			});
		});
		proc.on("close", (code) => {
			exited = true;
			clearTimeout(timeout);
			resolve({ exitCode: code ?? 0, timedOut, stdout, stderr });
		});
	});
}

async function runContainerCommand(
	workspace: string,
	name: string,
	command: string,
	options: Required<ContainerValidationOptions>,
): Promise<ContainerCommandResult> {
	const args = [
		"run",
		"--rm",
		"--mount",
		`type=bind,source=${workspace},target=/workspace`,
		"-w",
		"/workspace",
		"-e",
		"HOME=/tmp",
		options.image,
		"sh",
		"-lc",
		command,
	];

	const result = await runProcess(
		options.containerCommand,
		args,
		workspace,
		options.timeoutMs,
	);

	return { name, command, ...result };
}

function buildTypeScriptCommands(files: string[]): Array<[string, string]> {
	const testFiles = files.filter(isTestFile);
	const commands: Array<[string, string]> = [
		[
			"tool versions",
			"node --version && npm --version && tsc --version && vitest --version && (biome --version || echo 'biome: not installed')",
		],
		[
			"hydrate dependencies",
			"if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache; elif [ -f package.json ]; then npm install --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache; else echo 'no package manifest'; fi",
		],
		["typecheck", "tsc --noEmit -p tsconfig.json"],
	];

	if (testFiles.length > 0) {
		commands.push([
			"targeted vitest",
			`vitest run ${testFiles.map(shellQuote).join(" ")}`,
		]);
	}

	commands.push([
		"biome",
		"if command -v biome >/dev/null 2>&1; then biome check src test; else echo 'biome: not installed in container image; skipping'; fi",
	]);
	return commands;
}

export function formatContainerValidationEvidence(args: {
	image: string;
	results: ContainerCommandResult[];
	status?: ContainerValidationStatus;
	workspaceMode?: ContainerValidationResult["workspaceMode"];
}): string {
	const status = args.status ?? deriveStatus(args.results);
	const lines = [
		`**Apple container image:** ${args.image}`,
		`**Workspace mode:** ${args.workspaceMode ?? "writable-copy"}`,
		`**Overall status:** ${status.toUpperCase()}`,
		"",
	];

	for (const result of args.results) {
		lines.push(
			`### ${result.name}: ${result.exitCode === 0 && !result.timedOut ? "PASS" : "FAIL"}`,
			`- command: \`${result.command}\``,
			`- exitCode: ${result.exitCode}`,
			`- timedOut: ${result.timedOut}`,
		);
		if (result.stdout.trim()) {
			lines.push("", "stdout:", "```text", capOutput(result.stdout), "```");
		}
		if (result.stderr.trim()) {
			lines.push("", "stderr:", "```text", capOutput(result.stderr), "```");
		}
		lines.push("");
	}

	return lines.join("\n").trim();
}

export async function runContainerValidationEvidence(
	files: string[],
	cwd: string,
	options: ContainerValidationOptions = {},
): Promise<ContainerValidationResult> {
	const resolvedOptions: Required<ContainerValidationOptions> = {
		image: options.image ?? DEFAULT_REVIEW_CONTAINER_IMAGE,
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		containerCommand: options.containerCommand ?? "container",
	};

	const ecosystem = detectProjectEcosystem(cwd);
	if (ecosystem !== "typescript") {
		const evidence = `Apple container validation skipped: unsupported ecosystem ${ecosystem}.`;
		return {
			image: resolvedOptions.image,
			status: "skipped",
			results: [],
			evidence,
			workspaceMode: "skipped",
		};
	}

	const { root, workspace } = await prepareWritableWorkspace(cwd);
	try {
		const results: ContainerCommandResult[] = [];
		for (const [name, command] of buildTypeScriptCommands(files)) {
			const result = await runContainerCommand(
				workspace,
				name,
				command,
				resolvedOptions,
			);
			results.push(result);
			if (result.exitCode !== 0 || result.timedOut) break;
		}

		const status = deriveStatus(results);
		return {
			image: resolvedOptions.image,
			status,
			results,
			evidence: formatContainerValidationEvidence({
				image: resolvedOptions.image,
				results,
				status,
				workspaceMode: "writable-copy",
			}),
			workspaceMode: "writable-copy",
		};
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
