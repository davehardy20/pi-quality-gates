import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { detectProjectEcosystem } from "./test-execution.js";

export const DEFAULT_REVIEW_CONTAINER_IMAGE =
	"pi-apple-sandbox-node-ts-fuller:prototype";

const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_PREVIEW_CHARS = 2400;

export interface ContainerCommandResult {
	name: string;
	command: string;
	exitCode: number;
	timedOut: boolean;
	stdout: string;
	stderr: string;
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
	cwd: string,
	name: string,
	command: string,
	options: Required<ContainerValidationOptions>,
): Promise<ContainerCommandResult> {
	const tmpfsTarget = path.join(cwd, "node_modules", ".vite-temp");
	const args = [
		"run",
		"--rm",
		"--mount",
		`type=bind,source=${cwd},target=/workspace,readonly`,
		"-w",
		"/workspace",
		"-e",
		"HOME=/tmp",
	];

	if (fs.existsSync(tmpfsTarget)) {
		args.push("--tmpfs", "/workspace/node_modules/.vite-temp");
	}

	args.push(options.image, "sh", "-lc", command);

	const result = await runProcess(
		options.containerCommand,
		args,
		cwd,
		options.timeoutMs,
	);

	return { name, command, ...result };
}

function buildTypeScriptCommands(files: string[]): Array<[string, string]> {
	const testFiles = files.filter(isTestFile);
	const commands: Array<[string, string]> = [
		[
			"tool versions",
			"node --version && npm --version && tsc --version && vitest --version && (biome --version || echo 'biome: not found')",
		],
		["typecheck", "tsc --noEmit -p tsconfig.json"],
	];

	if (testFiles.length > 0) {
		commands.push([
			"targeted vitest",
			`vitest run ${testFiles.map(shellQuote).join(" ")}`,
		]);
	}

	commands.push(["biome", "biome check src test"]);
	return commands;
}

export function formatContainerValidationEvidence(args: {
	image: string;
	results: ContainerCommandResult[];
}): string {
	const hasFailure = args.results.some(
		(result) => result.exitCode !== 0 || result.timedOut,
	);
	const lines = [
		`**Apple container image:** ${args.image}`,
		`**Overall status:** ${hasFailure ? "FAILED" : "PASSED"}`,
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
): Promise<string> {
	const resolvedOptions: Required<ContainerValidationOptions> = {
		image: options.image ?? DEFAULT_REVIEW_CONTAINER_IMAGE,
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		containerCommand: options.containerCommand ?? "container",
	};

	const ecosystem = detectProjectEcosystem(cwd);
	if (ecosystem !== "typescript") {
		return `Apple container validation skipped: unsupported ecosystem ${ecosystem}.`;
	}

	const results: ContainerCommandResult[] = [];
	for (const [name, command] of buildTypeScriptCommands(files)) {
		results.push(
			await runContainerCommand(cwd, name, command, resolvedOptions),
		);
	}

	return formatContainerValidationEvidence({
		image: resolvedOptions.image,
		results,
	});
}
