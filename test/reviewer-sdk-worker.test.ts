import { fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PR_REVIEW_CONFIG } from "../src/pr-gate/pr-review-config.js";
import { createSdkReviewerLauncher } from "../src/pr-gate/reviewer-sdk-spawn.js";

// Fabricated SDK/credentials only. No installed SDK or provider requests.
const roots: string[] = [];
const worker = fileURLToPath(
	new URL("../src/pr-gate/reviewer-sdk-worker.mjs", import.meta.url),
);
const hash = (file: string) =>
	createHash("sha256").update(readFileSync(file)).digest("hex");
const nodeSha256 = hash(realpathSync(process.execPath));
const noFallbackKey = ["$", "{PI_REVIEWER_NO_FALLBACK_AUTH}"].join("");
const report =
	"## Review Report\nSTATUS: PASS\nCONFIDENCE: HIGH\n### Findings\nNone.\n### Test execution\n- **Status:** PASS\n- **Summary:** fixed fixture\n### Summary\nfixed fixture";

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function importEnvironment(log: string): {
	agentDir: string;
	temporaryRoot: string;
} {
	const prefix = "import-environment:";
	const line = readFileSync(log, "utf8")
		.split("\n")
		.find((item) => item.startsWith(prefix));
	expect(line).toBeDefined();
	return JSON.parse(line?.slice(prefix.length) ?? "null");
}

function fixture(
	options: {
		injectedExtension?: boolean;
		echoKey?: boolean;
		oauthOnly?: boolean;
		missingRunner?: boolean;
		readPath?: string;
		assistantMessages?: {
			stopReason?: string;
			text?: string;
			errorMessage?: string;
		}[];
		extensionError?: string;
		failure?: {
			stage:
				| "import-sdk"
				| "model-runtime"
				| "create-session"
				| "prompt"
				| "dispose";
			message: string;
		};
		trailingStart?: "message_start" | "turn_start" | "agent_start";
	} = {},
) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "qg-sdk-worker-")));
	roots.push(root);
	const sdkRoot = join(root, "sdk");
	const workspace = join(root, "workspace");
	const agentDir = join(root, "owned");
	for (const path of [sdkRoot, workspace, agentDir])
		mkdirSync(path, { mode: 0o700 });
	writeFileSync(join(workspace, "fixed.ts"), "owned fixture data");
	const log = join(root, "effects.log");
	const record = `import { appendFileSync } from "node:fs"; const log = ${JSON.stringify(log)}; const note = s => appendFileSync(log, s + "\\n");`;
	function file(path: string, value: string) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, value);
		return path;
	}
	file(
		join(sdkRoot, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			version: "1.3.0",
			type: "module",
		}),
	);
	const throwAt = (stage: NonNullable<typeof options.failure>["stage"]) =>
		options.failure?.stage === stage
			? `throw Object.assign(new TypeError(${JSON.stringify(options.failure.message)}), { code: "ERR_FIXTURE" });`
			: "";
	const entries = {
		auth: file(
			join(sdkRoot, "dist/core/auth-storage.js"),
			`${record} import { tmpdir } from "node:os"; note("auth-import");
			note("import-environment:" + JSON.stringify({ agentDir: process.env.PI_CODING_AGENT_DIR ?? null, temporaryRoot: tmpdir(), offline: process.env.PI_OFFLINE ?? null, cwd: process.cwd(), home: process.env.HOME ?? null }));
			export const AuthStorage = { inMemory() { note("auth-memory"); return { memory: true }; } };`,
		),
		models: file(
			join(sdkRoot, "dist/core/model-runtime.js"),
			`${record}
			import { readFileSync } from "node:fs";
			import { join } from "node:path";
			note("models-import");
			export const ModelRuntime = { async create(input) {
				if (!input.credentials.memory || input.refreshOnCreate !== false || input.allowModelNetwork !== false) throw Error("unsafe defaults");
				let resolvedBearer = false;
				if (input.modelsPath !== null) {
					if (input.modelsPath !== join(process.env.PI_CODING_AGENT_DIR, "reviewer-models.json")) throw Error("ambient model config forbidden");
					const config = JSON.parse(readFileSync(input.modelsPath, "utf8"));
					if (JSON.stringify(config) !== JSON.stringify({ providers: { fixture: { apiKey: ${JSON.stringify(noFallbackKey)} } } })) throw Error("unexpected model config");
					if (process.env.PI_REVIEWER_NO_FALLBACK_AUTH !== undefined) throw Error("fallback auth forbidden");
					resolvedBearer = true;
					note("resolved-bearer-config");
				}
				note("model-memory");
				${throwAt("model-runtime")}
				const acceptsKey = !${Boolean(options.oauthOnly)} || resolvedBearer;
				return {
					registerProvider() { throw Error("ambient provider refresh forbidden"); },
					async setRuntimeApiKey(provider, key) { note("key-bound"); this.key = key; },
					getProvider(provider) { return provider === "fixture" ? { auth: ${options.oauthOnly ? "{ oauth: {} }" : "{ apiKey: {} }"} } : undefined; },
					hasConfiguredAuth() { return acceptsKey && !!this.key; },
					async checkAuth() { return this.hasConfiguredAuth() ? { type: "api_key" } : undefined; },
					async getAuth() { return this.hasConfiguredAuth() ? { auth: Object.fromEntries([["apiKey", this.key]]) } : undefined; },
					getModel() { throw Error("implicit model lookup forbidden"); }
				};
			} };`,
		),
		settings: file(
			join(sdkRoot, "dist/core/settings-manager.js"),
			`${record} export const SettingsManager = { inMemory(settings) { note("settings-memory"); return settings; } };`,
		),
		sessions: file(
			join(sdkRoot, "dist/core/session-manager.js"),
			`${record} export const SessionManager = { inMemory(cwd) { note("session-memory"); return { cwd }; } };`,
		),
		extensions: file(
			join(sdkRoot, "dist/core/extensions/loader.js"),
			`${record}
			export const createExtensionRuntime = () => ({});
			export async function loadExtensions(paths) {
				note("explicit-tools");
				return { errors: ${JSON.stringify(options.extensionError ? [{ error: options.extensionError }] : [])}, extensions: [
					{ resolvedPath: paths[0], tools: new Map(["git_inspect_safe", "run_biome", "run_vitest", "run_typecheck", "run_pytest", "run_cargo_test", "run_node_test"].filter(name => !${Boolean(options.missingRunner)} || name !== "run_node_test").map(name => [name, { definition: { name, execute: async () => ({}) } }])) },
					{ path: paths[1], resolvedPath: paths[1], sourceInfo: {}, handlers: new Map([["context", [async event => ({ messages: event.messages })]]]), tools: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(), messageRenderers: new Map() }
				] };
			}`,
		),
		sdk: file(
			join(sdkRoot, "dist/core/sdk.js"),
			`${record}
			${throwAt("import-sdk")}
			export function createReadOnlyTools() {
				return ["read", "grep", "find", "ls"].map(name => ({
					name,
					execute: async (_id, params) => { note("read:" + params.path); return { content: [] }; }
				}));
			}
			export async function createAgentSession(options) {
				if (!options.resourceLoader || !options.sessionManager || !options.settingsManager || !options.modelRuntime) throw Error("discovery poison");
				if (options.model.type !== "chat") throw Error("model type missing");
				if (options.resourceLoader.getExtensions().extensions.some(item => item.handlers.has("session_start"))) throw Error("global extensions poison");
				if (options.settingsManager.cacheWarming !== "off" || options.settingsManager.images.blockImages !== true) throw Error("unsafe settings");
				note("closed-session");
				${throwAt("create-session")}
				let listener;
				return {
					extensionsResult: { extensions: ${options.injectedExtension ? '[{ path: "/global" }]' : "options.resourceLoader.getExtensions().extensions"}, errors: [] },
					session: {
						getActiveToolNames: () => options.tools,
						bindExtensions: async () => note("bind-empty"),
						subscribe: fn => { listener = fn; return () => {}; },
						prompt: async () => {
							note("prompt");
							// Mirror the SDK's OAuth-only provider preflight.
							if (!options.modelRuntime.hasConfiguredAuth(options.model.provider) && !(await options.modelRuntime.checkAuth(options.model.provider))) throw Error("No API key found for " + options.model.provider);
							const auth = await options.modelRuntime.getAuth(options.model);
							if (auth?.auth.apiKey !== options.modelRuntime.key) throw Error("request authentication missing");
							${throwAt("prompt")}
							${options.readPath === undefined ? "" : `await (options.customTools.find(tool => tool.name === "read") ?? createReadOnlyTools()[0]).execute("fixture-call", { path: ${JSON.stringify(options.readPath)} });`}
							for (const message of ${JSON.stringify(options.assistantMessages ?? [{ stopReason: "stop", text: report }])}) {
								listener({ type: "message_start", message: { role: "assistant" } });
								listener({ type: "message_end", message: { role: "assistant", stopReason: message.stopReason, errorMessage: message.errorMessage, content: [{ type: "text", text: ${options.echoKey ? "options.modelRuntime.key" : 'message.text ?? ""'} }] } });
							}
							${options.trailingStart ? `listener({ type: ${JSON.stringify(options.trailingStart)}, message: { role: "assistant" } });` : ""}
						},
						abort: async () => note("abort"),
						dispose: async () => { note("dispose"); ${throwAt("dispose")} }
					}
				};
			}`,
		),
	};
	const toolRoot = join(root, "safe-tools");
	file(
		join(toolRoot, "package.json"),
		JSON.stringify({ name: "@davehardy20/pi-safe-tools" }),
	);
	const toolSource = file(
		join(toolRoot, "src/extensions/safe-command-tools.ts"),
		"export default function fixedFixtureOnly() {}",
	);
	const guardSource = file(
		join(toolRoot, "src/extensions/secret-guard.ts"),
		"export default function fixedGuardFixtureOnly() {}",
	);
	const request = {
		version: 1,
		correlationId: "00000000-0000-4000-8000-000000000000",
		remainingMs: 10_000,
		cwd: workspace,
		agentDir,
		sdkRoot,
		nodeSha256,
		hashes: Object.fromEntries(
			Object.entries(entries).map(([key, path]) => [key, hash(path)]),
		),
		toolSource,
		toolSha256: hash(toolSource),
		guardSha256: hash(guardSource),
		model: {
			type: "chat",
			provider: "fixture",
			id: "fixed-model",
			api: "fixture-api",
			baseUrl: "https://fixture.invalid",
		},
		auth: {
			apiKey: ["owned", "fixture", "not", "a", "credential"].join("-"),
			headers: {},
		},
		systemPrompt: "fixed system prompt",
		task: "fixed task",
	};
	return { root, log, request };
}

type FixtureWorkerRequest = Omit<
	ReturnType<typeof fixture>["request"],
	"auth"
> & {
	auth?: ReturnType<typeof fixture>["request"]["auth"];
	mode?: "review" | "startup-only";
};

async function launch(request: FixtureWorkerRequest) {
	return await new Promise<{
		code: number | null;
		stdout: string;
		stderr: string;
	}>((resolve, reject) => {
		const child = fork(worker, [], {
			execArgv: ["--experimental-strip-types"],
			cwd: request.cwd,
			silent: true,
			env: {
				NODE_DISABLE_COMPILE_CACHE: "1",
				TMPDIR: realpathSync(tmpdir()),
			},
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
		child.stdout?.on("data", (data) => {
			stdout += data;
		});
		child.stderr?.on("data", (data) => {
			stderr += data;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
		child.send(request);
	});
}

function supervisedFixture(
	customProvider = false,
	options: Parameters<typeof fixture>[0] = {},
) {
	const f = fixture(options);
	const resolveAuth = vi.fn(async () => ({ ok: true, ...f.request.auth }));
	const ctx = {
		cwd: f.request.cwd,
		modelRegistry: {
			find: vi.fn(() => f.request.model),
			getRegisteredNativeProvider: () => (customProvider ? {} : undefined),
			getApiKeyAndHeaders: resolveAuth,
		},
	} as unknown as ExtensionContext;
	const config = { ...PR_REVIEW_CONFIG, model: "fixture/fixed-model" };
	const attempt = {
		task: f.request.task,
		files: ["fixed.ts"],
		cwd: f.request.cwd,
		config,
	};
	const spawnProcess = vi.fn(spawn);
	const launcher = createSdkReviewerLauncher(
		() =>
			[
				"git_inspect_safe",
				"run_biome",
				"run_vitest",
				"run_typecheck",
				"run_pytest",
				"run_cargo_test",
				"run_node_test",
			].map((name) => ({
				name,
				sourceInfo: { scope: "user", path: f.request.toolSource },
			})),
		{
			resolveSdkRoot: () => f.request.sdkRoot,
			spawnProcess: spawnProcess as unknown as typeof spawn,
		},
	);
	const run = () =>
		launcher(ctx, attempt)(
			f.request.task,
			f.request.systemPrompt,
			config,
			f.request.cwd,
		);
	return { ...f, resolveAuth, spawnProcess, run };
}

describe("supervised SDK route using only owned fabricated SDK modules", () => {
	for (const stopReason of ["error", "aborted", "length"]) {
		it(`never promotes observed startup and an earlier PASS after ${stopReason}`, async () => {
			const f = supervisedFixture(false, {
				assistantMessages: [
					{ stopReason: "stop", text: report },
					{ stopReason, text: "" },
				],
			});
			const result = await f.run();
			if (result.sidecarPath) roots.push(result.sidecarPath);
			expect(result.startupIdentity?.mode).toBe("review");
			expect(result.report).toBeNull();
			expect(result.exitCode).toBe(1);
			expect(result.terminationConfirmed).toBe(true);
		});
	}

	it("preserves redacted worker failure details in the saved sidecar", async () => {
		const key = ["owned", "fixture", "not", "a", "credential"].join("-");
		const f = supervisedFixture(false, {
			failure: { stage: "create-session", message: `fixed SDK failure ${key}` },
		});
		const result = await f.run();
		if (!result.sidecarPath) throw new Error("Missing fixture failure sidecar");
		roots.push(result.sidecarPath);
		expect(result.exitCode).toBe(1);
		expect(result.report).toBeNull();
		expect(result.terminationConfirmed).toBe(true);
		const saved = readFileSync(
			join(result.sidecarPath, "sidecar.json"),
			"utf8",
		);
		expect(saved).not.toContain(key);
		expect(diagnostic(JSON.parse(saved).stderr)).toMatchObject({
			stage: "create-session",
			assistantStarted: false,
			errors: expect.arrayContaining([
				expect.objectContaining({ message: "fixed SDK failure [redacted]" }),
			]),
		});
	});

	it("connects model/auth selection, private IPC, identity and genuine Node close", async () => {
		const f = supervisedFixture();
		const result = await f.run();
		if (result.sidecarPath) roots.push(result.sidecarPath);
		expect(result.stderr).not.toContain("refused");
		expect(result.report?.status).toBe("PASS");
		expect(result.terminationConfirmed).toBe(true);
		expect(result.startupIdentity?.tools).toHaveLength(11);
		expect(f.resolveAuth).toHaveBeenCalledOnce();
		const call = f.spawnProcess.mock.calls[0];
		expect(call?.[0]).toBe(realpathSync(process.execPath));
		expect(JSON.stringify(call)).not.toContain(f.request.auth.apiKey);
		expect(result.command).not.toContain(f.request.task);
		expect(result.rawOutput).not.toContain(f.request.auth.apiKey);
		const observed = importEnvironment(f.log);
		expect(observed.temporaryRoot).toBe(observed.agentDir);
		expect(observed.agentDir).not.toBe(f.request.agentDir);
		expect(existsSync(observed.agentDir)).toBe(false);
	});

	it("refuses custom native provider behavior rather than silently replacing it", async () => {
		const f = supervisedFixture(true);
		const result = await f.run();
		if (result.sidecarPath) roots.push(result.sidecarPath);
		expect(result.report).toBeNull();
		expect(f.resolveAuth).not.toHaveBeenCalled();
		expect(f.spawnProcess).not.toHaveBeenCalled();
	});

	it("rejects an unsupported public SDK version before requesting credentials", async () => {
		const f = supervisedFixture();
		writeFileSync(
			join(f.request.sdkRoot, "package.json"),
			JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				version: "0.0.0",
				type: "module",
			}),
		);
		const result = await f.run();
		expect(result.report).toBeNull();
		expect(f.resolveAuth).not.toHaveBeenCalled();
		expect(f.spawnProcess).not.toHaveBeenCalled();
	});
});

function diagnostic(stderr: string) {
	const line = stderr.split("\n").find((value) => value.startsWith("{"));
	expect(line).toBeDefined();
	return JSON.parse(line ?? "null");
}

describe("SDK worker failure diagnostics", () => {
	for (const stage of [
		"import-sdk",
		"model-runtime",
		"create-session",
		"prompt",
		"dispose",
	] as const) {
		it(`preserves a safely redacted cause for ${stage}`, async () => {
			const f = fixture({ failure: { stage, message: "fixed SDK failure" } });
			const result = await launch(f.request);
			expect(result.code).toBe(1);
			expect(result.stdout).not.toContain('"type":"message_end"');
			expect(result.stderr).toContain(
				"Reviewer SDK startup or execution refused.",
			);
			expect(diagnostic(result.stderr)).toMatchObject({
				type: "reviewer_failure",
				stage: stage === "import-sdk" ? "import-sdk:sdk" : stage,
				assistantStarted: stage === "dispose",
				errors: expect.arrayContaining([
					expect.objectContaining({
						name: "TypeError",
						code: "ERR_FIXTURE",
						message: "fixed SDK failure",
					}),
				]),
			});
		});
	}

	it("retains extension-loader errors without emitting a report", async () => {
		const f = fixture({ extensionError: "fixed extension load failure" });
		const result = await launch(f.request);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(diagnostic(result.stderr)).toMatchObject({
			stage: "load-extensions",
			assistantStarted: false,
			errors: expect.arrayContaining([
				expect.objectContaining({ message: "fixed extension load failure" }),
			]),
		});
	});

	it("captures the first failed assistant outcome even after a later stop", async () => {
		const f = fixture({
			assistantMessages: [
				{ stopReason: "error", errorMessage: "fixed provider error" },
				{ stopReason: "stop", text: report },
			],
		});
		const result = await launch(f.request);
		expect(result.code).toBe(1);
		expect(result.stdout).not.toContain('"type":"message_end"');
		expect(diagnostic(result.stderr)).toMatchObject({
			stage: "terminal-answer",
			assistantStarted: true,
			stopReason: "error",
			assistantError: "fixed provider error",
		});
	});

	it("distinguishes a missing assistant from an assistant error", async () => {
		const f = fixture({ assistantMessages: [] });
		const result = await launch(f.request);
		expect(result.code).toBe(1);
		expect(diagnostic(result.stderr)).toMatchObject({
			stage: "terminal-answer",
			assistantStarted: false,
		});
	});

	for (const source of ["exception", "assistant"] as const) {
		it(`redacts credentials, header values and URLs in ${source} diagnostics`, async () => {
			const key = 'owned-fixture-key/with+"quote';
			const header = "owned-fixture-header/value";
			const message = [
				key,
				JSON.stringify(key).slice(1, -1),
				encodeURIComponent(key),
				header,
				encodeURIComponent(header),
				"https://user:private@fixture.invalid?token=hidden-value",
				["password", "hidden-password-value"].join("="),
				["Bearer", "hidden-bearer-value"].join(" "),
				"fixed safe detail",
			].join(" ");
			const f = fixture(
				source === "exception"
					? { failure: { stage: "model-runtime", message } }
					: {
							assistantMessages: [
								{ stopReason: "error", errorMessage: message },
							],
						},
			);
			f.request.auth.apiKey = key;
			f.request.auth.headers = { Authorization: `Bearer ${header}` };
			const result = await launch(f.request);
			expect(result.code).toBe(1);
			const text = result.stdout + result.stderr;
			for (const secret of [
				key,
				JSON.stringify(key).slice(1, -1),
				encodeURIComponent(key),
				header,
				encodeURIComponent(header),
				"hidden-value",
				"hidden-password-value",
				"hidden-bearer-value",
			]) {
				expect(text).not.toContain(secret);
			}
			expect(text).toContain("[redacted]");
			expect(text).toContain("fixed safe detail");
		});
	}

	it("redacts a credential crossing the diagnostic truncation boundary", async () => {
		const key = "owned-fixture-boundary-credential";
		const f = fixture({
			failure: { stage: "model-runtime", message: "x".repeat(506) + key },
		});
		f.request.auth.apiKey = key;
		const result = await launch(f.request);
		expect(result.code).toBe(1);
		expect(result.stderr).not.toContain(key.slice(0, 6));
		expect(diagnostic(result.stderr).errors[0].message).toHaveLength(512);
	});

	it("redacts credentials in a path error before SDK imports", async () => {
		const f = fixture();
		f.request.agentDir = join(f.root, f.request.auth.apiKey, "missing");
		const result = await launch(f.request);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain(f.request.auth.apiKey);
		expect(diagnostic(result.stderr)).toMatchObject({
			stage: "validate-paths",
			assistantStarted: false,
			errors: [expect.objectContaining({ code: "ENOENT" })],
		});
	});

	it("normalizes control characters without splitting the diagnostic JSON line", async () => {
		const f = fixture({
			failure: {
				stage: "model-runtime",
				message: `fixed${String.fromCharCode(10, 27)}[31mred`,
			},
		});
		const result = await launch(f.request);
		expect(result.code).toBe(1);
		expect(result.stderr.split("\n")).toHaveLength(3);
		expect(diagnostic(result.stderr).errors[0].message).toBe("fixed  [31mred");
	});

	it("omits oversized error text within a bounded diagnostic", async () => {
		const f = fixture({
			failure: { stage: "model-runtime", message: "x".repeat(70_000) },
		});
		const result = await launch(f.request);
		expect(result.code).toBe(1);
		expect(Buffer.byteLength(result.stderr)).toBeLessThan(8192);
		expect(diagnostic(result.stderr).errors[0].message).toContain("omitted");
	});

	it("does not emit diagnostics on success", async () => {
		const result = await launch(fixture().request);
		expect(result.code).toBe(0);
		expect(result.stderr).not.toContain("reviewer_failure");
	});
});

describe("fixed SDK worker with owned fabricated modules", () => {
	for (const stopReason of [
		"error",
		"aborted",
		"length",
		"pending",
		"deferred",
		"unknown",
		"toolUse",
		undefined,
	]) {
		it(`refuses a parseable PASS with incomplete outcome ${stopReason}`, async () => {
			const f = fixture({ assistantMessages: [{ stopReason, text: report }] });
			const result = await launch(f.request);
			expect(result.code).toBe(1);
			expect(result.stdout).not.toContain('"type":"message_end"');
			expect(readFileSync(f.log, "utf8")).toContain("dispose");
		});
	}

	for (const stopReason of ["error", "aborted", "length"]) {
		it(`vetoes an earlier PASS followed by an empty ${stopReason}`, async () => {
			const f = fixture({
				assistantMessages: [
					{ stopReason: "stop", text: report },
					{ stopReason, text: "" },
				],
			});
			const result = await launch(f.request);
			expect(result.code).toBe(1);
			expect(result.stdout).not.toContain('"type":"message_end"');
		});

		it(`does not recover ${stopReason} into a later PASS`, async () => {
			const f = fixture({
				assistantMessages: [
					{ stopReason, text: "" },
					{ stopReason: "stop", text: report },
				],
			});
			const result = await launch(f.request);
			expect(result.code).toBe(1);
			expect(result.stdout).not.toContain('"type":"message_end"');
		});
	}

	for (const messages of [[], [{ stopReason: "stop", text: "" }]]) {
		it(`requires a nonempty terminal answer (${messages.length} messages)`, async () => {
			const f = fixture({ assistantMessages: messages });
			const result = await launch(f.request);
			expect(result.code).toBe(1);
		});
	}

	for (const trailingStart of [
		"message_start",
		"turn_start",
		"agent_start",
	] as const) {
		it(`refuses an earlier PASS after unfinished ${trailingStart}`, async () => {
			const f = fixture({ trailingStart });
			const result = await launch(f.request);
			expect(result.code).toBe(1);
			expect(result.stdout).not.toContain('"type":"message_end"');
		});
	}

	it("emits only the final completed answer after successful tool continuation", async () => {
		const f = fixture({
			assistantMessages: [
				{ stopReason: "toolUse", text: "intermediate fixture" },
				{ stopReason: "stop", text: report },
			],
		});
		const result = await launch(f.request);
		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("intermediate fixture");
		expect(result.stdout).toContain('"stopReason":"stop"');
	});

	for (const oauthOnly of [true, false]) {
		it(`hands off resolved auth to an ${oauthOnly ? "OAuth-only" : "API-key"} provider without copying OAuth records`, async () => {
			const f = fixture({ oauthOnly });
			const result = await launch(f.request);
			expect(result.stderr, result.stderr).not.toContain("refused");
			expect(result.code).toBe(0);
			expect(result.stdout).toContain('"stopReason":"stop"');
			const effects = readFileSync(f.log, "utf8");
			expect(effects.includes("resolved-bearer-config")).toBe(oauthOnly);
			expect(effects).toContain("key-bound");
			const config = join(f.request.agentDir, "reviewer-models.json");
			expect(existsSync(config)).toBe(oauthOnly);
			if (oauthOnly) {
				const saved = readFileSync(config, "utf8");
				expect(JSON.parse(saved)).toEqual({
					providers: {
						fixture: Object.fromEntries([["apiKey", noFallbackKey]]),
					},
				});
				expect(saved).not.toContain(f.request.auth.apiKey);
				expect(saved).not.toMatch(/refresh|access|expires|headers|baseUrl/);
			}
		});
	}

	it("refuses an existing bearer-config symlink without writing to its target", async () => {
		const f = fixture({ oauthOnly: true });
		const target = join(f.request.cwd, "do-not-overwrite.json");
		writeFileSync(target, "untouched fixture");
		symlinkSync(target, join(f.request.agentDir, "reviewer-models.json"));
		const result = await launch(f.request);
		expect(result.code).toBe(1);
		expect(diagnostic(result.stderr)).toMatchObject({
			stage: "model-authentication",
			assistantStarted: false,
		});
		expect(readFileSync(target, "utf8")).toBe("untouched fixture");
		expect(readFileSync(f.log, "utf8")).not.toContain("key-bound");
		expect(result.stdout).toBe("");
	});

	it("refuses unknown providers before creating a bearer config", async () => {
		const f = fixture({ oauthOnly: true });
		f.request.model.provider = "unknown";
		const result = await launch(f.request);
		expect(result.code).toBe(1);
		expect(existsSync(join(f.request.agentDir, "reviewer-models.json"))).toBe(
			false,
		);
		expect(readFileSync(f.log, "utf8")).not.toContain("key-bound");
		expect(result.stdout).toBe("");
	});

	it("binds SDK management paths before first import without disabling model prompting", async () => {
		const f = fixture();
		const result = await launch(f.request);
		expect(result.code).toBe(0);
		const effects = readFileSync(f.log, "utf8").split("\n");
		expect(importEnvironment(f.log)).toEqual({
			agentDir: f.request.agentDir,
			temporaryRoot: f.request.agentDir,
			offline: "1",
			cwd: f.request.cwd,
			home: null,
		});
		expect(effects).toContain("key-bound");
		expect(effects).toContain("prompt");
	});

	it("refuses an SDK app-name change before importing config-dependent modules", async () => {
		const f = fixture();
		writeFileSync(
			join(f.request.sdkRoot, "package.json"),
			JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				version: "1.3.0",
				type: "module",
				piConfig: { name: "different-app" },
			}),
		);
		const result = await launch(f.request);
		expect(result.code).toBe(1);
		expect(existsSync(f.log)).toBe(false);
	});

	it("completes closed startup, emits observed identity and flushes the report before exit", async () => {
		const f = fixture();
		const result = await launch(f.request);
		expect(result.stderr).not.toContain("refused");
		expect(result.code).toBe(0);
		const events = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(events[0]).toMatchObject({
			type: "reviewer_startup_identity",
			resourcePolicy: "closed-sdk-v1",
			hashes: f.request.hashes,
		});
		expect(events[1].message.content[0].text).toBe(report);
		expect(readFileSync(f.log, "utf8")).toContain(
			"bind-empty\nprompt\ndispose",
		);
	});

	it("observes OAuth-only startup without credentials, model requests or a review report", async () => {
		const f = fixture({ oauthOnly: true });
		const { auth: _omitted, ...startup } = f.request;
		const result = await launch({ ...startup, mode: "startup-only" });
		expect(result.code).toBe(0);
		const events = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "reviewer_startup_identity",
			mode: "startup-only",
		});
		const effects = readFileSync(f.log, "utf8");
		expect(effects).not.toContain("key-bound");
		expect(effects).not.toContain("prompt");
		expect(effects).not.toContain("resolved-bearer-config");
		expect(existsSync(join(f.request.agentDir, "reviewer-models.json"))).toBe(
			false,
		);
		expect(effects).toContain("dispose");
	});

	it("rejects credential material on the startup-only path", async () => {
		const f = fixture();
		const result = await launch({ ...f.request, mode: "startup-only" });
		expect(result.code).toBe(1);
		expect(existsSync(f.log)).toBe(false);
	});

	it("refuses changed SDK entries before importing any SDK module", async () => {
		const f = fixture();
		f.request.hashes.sdk = "0".repeat(64);
		const result = await launch(f.request);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(existsSync(f.log)).toBe(false);
	});

	it("refuses SDK extension injection before prompt or identity", async () => {
		const f = fixture({ injectedExtension: true });
		const result = await launch(f.request);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(readFileSync(f.log, "utf8")).not.toContain("prompt");
		expect(readFileSync(f.log, "utf8")).toContain("dispose");
	});

	it("preserves ordinary workspace reads through the scoped SDK override", async () => {
		const f = fixture({ readPath: "fixed.ts" });
		const result = await launch(f.request);
		expect(result.code).toBe(0);
		expect(readFileSync(f.log, "utf8")).toContain(
			`read:${join(f.request.cwd, "fixed.ts")}`,
		);
	});

	it("refuses traversal before delegating a builtin read", async () => {
		const f = fixture({ readPath: "../owned/private.txt" });
		const result = await launch(f.request);
		expect(result.code).toBe(1);
		expect(readFileSync(f.log, "utf8")).not.toContain("read:");
	});

	it("refuses workspace symlinks before inspecting their target", async () => {
		const f = fixture({ readPath: "linked.ts" });
		const privateFile = join(f.request.agentDir, "private.txt");
		writeFileSync(privateFile, "owned private fixture; not a real secret");
		symlinkSync(privateFile, join(f.request.cwd, "linked.ts"));
		const result = await launch(f.request);
		expect(result.code).toBe(1);
		expect(readFileSync(f.log, "utf8")).not.toContain("read:");
	});

	it("refuses missing mandatory validation tools before prompting", async () => {
		const f = fixture({ missingRunner: true });
		const result = await launch(f.request);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(readFileSync(f.log, "utf8")).not.toContain("prompt");
	});

	it("redacts the supplied credential even from a fabricated assistant event", async () => {
		const f = fixture({ echoKey: true });
		const result = await launch(f.request);
		expect(result.stdout).not.toContain(f.request.auth.apiKey);
		expect(result.stderr).not.toContain(f.request.auth.apiKey);
		expect(result.stdout).toContain("[redacted]");
	});
});
