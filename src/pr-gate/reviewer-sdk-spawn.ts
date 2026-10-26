import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createReviewDeadline,
	type ReviewDeadline,
} from "../shared/review-deadline.js";
import {
	createBoundedLineProcessor,
	type ReviewerAttemptInput,
	type SdkObservedStartupIdentity,
	spawnReviewer,
} from "./reviewer.js";
import { CLOSED_REVIEWER_SAFE_TOOLS } from "./reviewer-closed-session.js";

const entries = {
	auth: "dist/core/auth-storage.js",
	models: "dist/core/model-runtime.js",
	settings: "dist/core/settings-manager.js",
	sessions: "dist/core/session-manager.js",
	extensions: "dist/core/extensions/loader.js",
	sdk: "dist/core/sdk.js",
};
const customNames = CLOSED_REVIEWER_SAFE_TOOLS;
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
function fail(): never {
	throw new Error("Closed SDK reviewer refused.");
}

/** Bounded, no-follow descriptor snapshot of a public runtime/source file.
 * File observations are not actual loaded-image/native-origin attestation. */
function snapshot(file: string, retain = false) {
	const canonical = realpathSync(file);
	const expected = lstatSync(canonical);
	const fd = openSync(
		canonical,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const before = fstatSync(fd);
		if (
			!before.isFile() ||
			before.ino !== expected.ino ||
			before.dev !== expected.dev ||
			before.size > (retain ? 1_048_576 : 268_435_456)
		)
			fail();
		const hash = createHash("sha256");
		const buffer = Buffer.alloc(65_536);
		const chunks: Buffer[] = [];
		let total = 0;
		for (;;) {
			const count = readSync(fd, buffer, 0, buffer.length, null);
			if (!count) break;
			total += count;
			if (total > before.size) fail();
			hash.update(buffer.subarray(0, count));
			if (retain) chunks.push(Buffer.from(buffer.subarray(0, count)));
		}
		const after = fstatSync(fd);
		if (
			total !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			realpathSync(file) !== canonical
		)
			fail();
		return {
			path: canonical,
			sha256: hash.digest("hex"),
			bytes: Buffer.concat(chunks),
		};
	} finally {
		closeSync(fd);
	}
}
function metadata(root: string) {
	return JSON.parse(
		snapshot(join(root, "package.json"), true).bytes.toString("utf8"),
	);
}
function sdkRootFromParent(): string {
	const script = process.argv[1] ? realpathSync(process.argv[1]) : fail();
	for (const tail of ["dist/bundle/cli.js", "dist/cli.js"]) {
		if (script.endsWith(`/${tail}`)) return script.slice(0, -tail.length - 1);
	}
	return fail();
}
function contains(root: string, target: string): boolean {
	const suffix = relative(root, target);
	return (
		!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`)
	);
}

export type { SdkObservedStartupIdentity } from "./reviewer.js";

export interface SdkReviewerLauncherDependencies {
	/** Fixture seams, not admission/origin providers or tool arguments. */
	resolveSdkRoot?: () => string;
	spawnProcess?: typeof spawn;
	bootstrapRoot?: string;
}

/** Capture this registered implementation before a later review changes its
 * checkout. No SDK import, credential access, process or model starts here. */
export function createSdkReviewerLauncher(
	getToolInfos: () => readonly unknown[],
	deps: SdkReviewerLauncherDependencies = {},
) {
	const packageRoot =
		deps.bootstrapRoot ?? fileURLToPath(new URL("../../", import.meta.url));
	let bootstrap:
		| {
				worker: ReturnType<typeof snapshot>;
				session: ReturnType<typeof snapshot>;
		  }
		| undefined;
	try {
		bootstrap = {
			worker: snapshot(
				join(packageRoot, "src/pr-gate/reviewer-sdk-worker.mjs"),
				true,
			),
			session: snapshot(
				join(packageRoot, "src/pr-gate/reviewer-closed-session.ts"),
				true,
			),
		};
	} catch {
		/* Registration remains fail-closed; the tool can explain refusal. */
	}

	return (
		ctx: ExtensionContext,
		attempt: ReviewerAttemptInput,
	): typeof spawnReviewer =>
		async (
			task,
			systemPrompt,
			config,
			cwd,
			signal,
			suppliedDeadline,
			_spawn,
			failureDirectory,
		) => {
			const deadline =
				suppliedDeadline ?? createReviewDeadline(config.timeoutMs);
			let phase = "runtime-identity";
			let root: string | undefined;
			let child: ChildProcess | undefined;
			let confirmedClose = false;
			let exitCode: number | null = null;
			let exitSignal: string | null = null;
			let fault = false;
			let identity: SdkObservedStartupIdentity | undefined;
			let completed = false;
			const guard = () => {
				if (fault || signal?.aborted || deadline.remainingMs() <= 0) fail();
			};
			try {
				guard();
				if (!bootstrap || realpathSync(cwd) !== cwd || cwd !== attempt.cwd)
					fail();
				const sdkRoot = realpathSync(
					(deps.resolveSdkRoot ?? sdkRootFromParent)(),
				);
				const sdkMetadata = metadata(sdkRoot);
				if (
					sdkMetadata.name !== "@earendil-works/pi-coding-agent" ||
					sdkMetadata.version !== "1.3.0"
				)
					fail();
				const node = snapshot(realpathSync(process.execPath));
				const hashes = Object.fromEntries(
					Object.entries(entries).map(([key, file]) => [
						key,
						snapshot(join(sdkRoot, file)).sha256,
					]),
				);
				phase = "registered-tool-source";
				const infos = getToolInfos().filter(record);
				const sources = customNames.map((name) => {
					const info = infos.find((item) => item.name === name);
					if (
						!record(info?.sourceInfo) ||
						info.sourceInfo.scope !== "user" ||
						typeof info.sourceInfo.path !== "string"
					)
						fail();
					return realpathSync(info.sourceInfo.path);
				});
				if (new Set(sources).size !== 1) fail();
				const tool = snapshot(sources[0]);
				const toolRoot = dirname(dirname(dirname(tool.path)));
				if (
					metadata(toolRoot).name !== "@davehardy20/pi-safe-tools" ||
					contains(cwd, toolRoot) ||
					contains(cwd, sdkRoot)
				)
					fail();
				const contextGuard = snapshot(
					join(toolRoot, "src/extensions/secret-guard.ts"),
				);
				phase = "selected-model";
				const selector =
					config.model ??
					(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
				const slash = selector.indexOf("/");
				if (slash < 1 || selector.length > 512) fail();
				const registry = ctx.modelRegistry as unknown as {
					find(provider: string, id: string): unknown;
					getApiKeyAndHeaders(model: unknown): Promise<unknown>;
					getRegisteredNativeProvider?(provider: string): unknown;
					getRegisteredProviderConfig?(provider: string): unknown;
				};
				if (
					typeof registry?.find !== "function" ||
					typeof registry.getApiKeyAndHeaders !== "function"
				)
					fail();
				const provider = selector.slice(0, slash);
				const providerConfig = registry.getRegisteredProviderConfig?.(provider);
				if (
					registry.getRegisteredNativeProvider?.(provider) !== undefined ||
					(record(providerConfig) &&
						typeof providerConfig.streamSimple === "function")
				)
					fail();
				const selected = registry.find(provider, selector.slice(slash + 1));
				if (!record(selected) || typeof selected.baseUrl !== "string") fail();
				const recipient = new URL(selected.baseUrl);
				if (
					recipient.protocol !== "https:" ||
					recipient.username ||
					recipient.password ||
					recipient.search ||
					recipient.hash
				)
					fail();
				const model = Object.fromEntries(
					[
						"type",
						"provider",
						"id",
						"name",
						"api",
						"reasoning",
						"input",
						"cost",
						"contextWindow",
						"maxTokens",
						"compat",
						"thinkingLevelMap",
						"promptCache",
						"samplingParams",
						"samplingParamsByThinkingLevel",
						"baseUrl",
					]
						.filter((key) => selected[key] !== undefined)
						.map((key) => [key, selected[key]]),
				);
				phase = "model-authentication";
				guard();
				// The borrowed host auth API may maintain its own credential cache.
				// Waiting is bounded; this does not claim to forcibly cancel that API.
				const auth = await bounded(
					registry.getApiKeyAndHeaders(selected),
					deadline,
					signal,
				);
				guard();
				if (
					!record(auth) ||
					auth.ok !== true ||
					typeof auth.apiKey !== "string" ||
					!auth.apiKey
				)
					fail();
				const resolvedRecipient = new URL(
					typeof auth.baseUrl === "string" ? auth.baseUrl : recipient.href,
				);
				if (
					resolvedRecipient.href.replace(/\/$/, "") !==
					recipient.href.replace(/\/$/, "")
				)
					fail();
				const headers = {
					...(record(selected.headers) ? selected.headers : {}),
					...(record(auth.headers) ? auth.headers : {}),
				};
				phase = "owned-bootstrap";
				root = realpathSync(await mkdtemp(join(tmpdir(), "pi-reviewer-sdk-")));
				const boot = join(root, "bootstrap");
				await mkdir(boot, { mode: 0o700 });
				await writeFile(join(boot, "package.json"), '{"type":"module"}', {
					flag: "wx",
					mode: 0o400,
				});
				await writeFile(
					join(boot, "reviewer-sdk-worker.mjs"),
					bootstrap.worker.bytes,
					{ flag: "wx", mode: 0o400 },
				);
				await writeFile(
					join(boot, "reviewer-closed-session.ts"),
					bootstrap.session.bytes,
					{ flag: "wx", mode: 0o400 },
				);
				const packet = {
					version: 1,
					mode: "review",
					correlationId: randomUUID(),
					remainingMs: deadline.remainingMs(),
					cwd,
					agentDir: root,
					sdkRoot,
					hashes,
					nodeSha256: node.sha256,
					toolSource: tool.path,
					toolSha256: tool.sha256,
					guardSha256: contextGuard.sha256,
					model,
					auth: {
						apiKey: auth.apiKey,
						headers,
						baseUrl: resolvedRecipient.href,
					},
					task,
					systemPrompt,
				};
				if (Buffer.byteLength(JSON.stringify(packet)) > 2_097_152) fail();
				const environment: Record<string, string> = {
					NODE_DISABLE_COMPILE_CACHE: "1",
					JITI_FS_CACHE: "false",
					TMPDIR: realpathSync(tmpdir()),
				};
				for (const name of [
					"HOME",
					"PATH",
					"LANG",
					"LC_ALL",
					"USER",
					"LOGNAME",
				]) {
					const value = process.env[name];
					if (value !== undefined) environment[name] = value;
				}
				const observer = createBoundedLineProcessor(1_048_576, (line) => {
					try {
						const event: unknown = JSON.parse(line);
						if (!record(event) || event.type !== "reviewer_startup_identity")
							return;
						if (
							identity ||
							event.version !== 1 ||
							event.mode !== packet.mode ||
							event.correlationId !== packet.correlationId ||
							event.resourcePolicy !== "closed-sdk-v1" ||
							event.sdkRoot !== sdkRoot ||
							event.nodeSha256 !== node.sha256 ||
							event.toolSource !== tool.path ||
							event.toolSha256 !== tool.sha256 ||
							event.guardSha256 !== contextGuard.sha256 ||
							JSON.stringify(event.hashes) !== JSON.stringify(hashes) ||
							!Array.isArray(event.tools) ||
							JSON.stringify([...event.tools].sort()) !==
								JSON.stringify(
									["read", "grep", "find", "ls", ...customNames].sort(),
								)
						) {
							fault = true;
							return;
						}
						identity = event as unknown as SdkObservedStartupIdentity;
					} catch {
						/* Non-event stdout is never a startup identity. */
					}
				});
				const spawnSdk: typeof spawn = ((
					command: string,
					args: string[],
					options: object,
				) => {
					child = (deps.spawnProcess ?? spawn)(command, args, {
						...options,
						stdio: ["ignore", "pipe", "pipe", "ipc"],
					});
					const process = child;
					process.on("error", () => {
						fault = true;
					});
					process.once("close", (code, closedSignal) => {
						confirmedClose = true;
						exitCode = code;
						exitSignal = closedSignal;
						observer.flush();
					});
					process.stdout?.on("data", (chunk: Buffer) =>
						observer.append(chunk.toString()),
					);
					process.once("spawn", () => {
						try {
							guard();
							if (!process.send) fail();
							process.send(packet, (error) => {
								if (error) {
									fault = true;
									process.kill("SIGTERM");
								}
							});
						} catch {
							fault = true;
							process.kill("SIGTERM");
						}
					});
					return process;
				}) as typeof spawn;
				phase = "sdk-process";
				guard();
				const result = await spawnReviewer(
					task,
					systemPrompt,
					config,
					cwd,
					signal,
					deadline,
					spawnSdk,
					failureDirectory ?? root,
					{
						command: node.path,
						args: [
							"--experimental-strip-types",
							join(boot, "reviewer-sdk-worker.mjs"),
						],
						environment,
						assistantOutputOnly: true,
					},
				);
				if (
					!confirmedClose ||
					exitCode !== 0 ||
					exitSignal ||
					fault ||
					observer.overflowed() ||
					!identity ||
					signal?.aborted ||
					deadline.remainingMs() <= 0
				)
					return {
						...result,
						report: null,
						stderr:
							result.stderr ||
							"Closed SDK startup identity or lifecycle refused.",
						sidecarPath: result.sidecarPath ?? root,
						startupIdentity: identity,
					};
				completed = result.report !== null;
				return { ...result, startupIdentity: identity };
			} catch {
				fault = true;
				if (child && !confirmedClose) {
					try {
						child.kill("SIGKILL");
					} catch {
						// Root remains held; a signal is not evidence of closure.
					}
				}
				return {
					report: null,
					rawOutput: "",
					exitCode: 1,
					timedOut: deadline.remainingMs() <= 0,
					stderr: `Closed SDK reviewer refused (${phase}).`,
					command: "[closed SDK reviewer; payload omitted]",
					sidecarPath: root,
					...(child
						? { terminationConfirmed: confirmedClose, pid: child.pid }
						: {}),
				};
			} finally {
				if (root && completed && confirmedClose) {
					await rm(root, { recursive: true, force: true }).catch(() => {});
				}
			}
		};
}

async function bounded<T>(
	operation: Promise<T>,
	deadline: ReviewDeadline,
	signal?: AbortSignal,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(new Error("Reviewer authentication cancelled."));
				if (signal?.aborted || deadline.remainingMs() <= 0) return onAbort();
				signal?.addEventListener("abort", onAbort, { once: true });
				timer = setTimeout(onAbort, deadline.remainingMs());
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}
