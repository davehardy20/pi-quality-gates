import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	sep,
} from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { types } from "node:util";
import {
	CLOSED_REVIEWER_SAFE_TOOLS,
	createClosedReviewerSession,
} from "./reviewer-closed-session.ts";

// No CLI import, DefaultResourceLoader, global settings/auth store, or ambient
// extension discovery. IPC comes only from the supervising host, never a tool.
const entries = Object.freeze({
	auth: "dist/core/auth-storage.js",
	models: "dist/core/model-runtime.js",
	settings: "dist/core/settings-manager.js",
	sessions: "dist/core/session-manager.js",
	extensions: "dist/core/extensions/loader.js",
	sdk: "dist/core/sdk.js",
});
const allowed = new Set(CLOSED_REVIEWER_SAFE_TOOLS);
let consumed = false;
let reviewer;
let stopped = false;
let secrets = [];
let expires = 0;
let stage = "validate-request";
let assistantStarted = false;
let assistantStopReason;
let assistantError;

function fail(cause) {
	throw new Error("Reviewer SDK startup refused.", { cause });
}

// Keep diagnostics on stderr, never in the assistant/report stream. Redact
// before truncating so a credential crossing the boundary cannot leak a prefix.
function diagnosticText(value) {
	if (typeof value !== "string") return undefined;
	if (value.length > 65_536) return "Error details omitted (too large).";
	let text = value;
	const variants = secrets
		.flatMap((secret) => [secret, secret.replace(/^(?:Bearer|Basic)\s+/i, "")])
		.flatMap((secret) => [
			secret,
			JSON.stringify(secret).slice(1, -1),
			encodeURIComponent(secret),
		]);
	const sorted = [...new Set(variants)].sort((a, b) => b.length - a.length);
	for (const secret of sorted) {
		if (secret) text = text.split(secret).join("[redacted]");
	}
	text = text
		.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted URL]")
		.replace(
			/(["']?\b(?:api[_-]?key|token|secret|password|authorization)\b["']?\s*[:=]\s*)["']?[^\s"',}]{8,}["']?/gi,
			"$1[redacted]",
		)
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/\b(?:AWS|AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]")
		.replace(
			/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
			"[redacted]",
		)
		.replace(/\p{Cc}/gu, " ");
	return text.slice(0, 512);
}

function writeFailure(error) {
	const diagnostic = { type: "reviewer_failure", stage, assistantStarted };
	try {
		diagnostic.stopReason = diagnosticText(assistantStopReason);
		diagnostic.assistantError = diagnosticText(assistantError);
		diagnostic.errors = [];
		for (let count = 0; error !== undefined && count < 3; count++) {
			if (!types.isNativeError(error)) {
				diagnostic.errors.push({
					message: diagnosticText(
						typeof error === "string"
							? error
							: "Non-Error exception; details omitted.",
					),
				});
				break;
			}
			diagnostic.errors.push({
				name: diagnosticText(error.name),
				code: diagnosticText(error.code),
				message: diagnosticText(error.message),
			});
			error = error.cause;
		}
	} catch {
		// Malformed error properties or encodings must not escape unsanitized.
		diagnostic.errors = [{ message: "Error details omitted (unreadable)." }];
		delete diagnostic.assistantError;
		delete diagnostic.stopReason;
	}
	let text = JSON.stringify(diagnostic);
	if (Buffer.byteLength(text) > 7_000) {
		diagnostic.errors = [{ message: "Error details omitted (too large)." }];
		delete diagnostic.assistantError;
		text = JSON.stringify(diagnostic);
	}
	process.stderr.write(
		`Reviewer SDK startup or execution refused.\n${text}\n`,
		() => void stop(),
	);
}
function guard() {
	if (stopped || performance.now() >= expires) fail();
}
function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonicalDirectory(value) {
	if (
		typeof value !== "string" ||
		value.length > 4096 ||
		!isAbsolute(value) ||
		normalize(value) !== value ||
		realpathSync(value) !== value ||
		!lstatSync(value).isDirectory()
	)
		fail();
	return value;
}
function digest(file) {
	const stat = lstatSync(file);
	if (!stat.isFile() || stat.size > 268_435_456 || realpathSync(file) !== file)
		fail();
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}
function emit(event) {
	let text = JSON.stringify(event);
	for (const secret of secrets) {
		text = text.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
	}
	if (Buffer.byteLength(text) > 1_048_576) fail();
	process.stdout.write(`${text}\n`);
}
function plainHeaders(value) {
	if (!record(value) || Object.keys(value).length > 32) fail();
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => {
			if (
				!/^[A-Za-z0-9-]{1,128}$/.test(key) ||
				typeof item !== "string" ||
				item.length > 8192 ||
				/[\r\n\0]/.test(item) ||
				/^(host|proxy-authorization)$/i.test(key)
			)
				fail();
			if (item) secrets.push(item);
			return [key, item];
		}),
	);
}

/** Guard builtin path arguments without pretending to be an OS sandbox or a
 * hostile-writer lease. Symlinks are refused before inspecting their target. */
function scopedReadTools(raw, cwd, roots) {
	const names = new Set(["read", "grep", "find", "ls"]);
	if (
		!Array.isArray(raw) ||
		raw.length !== names.size ||
		new Set(raw.map((tool) => tool.name)).size !== names.size ||
		raw.some((tool) => !names.has(tool.name))
	)
		fail();
	const check = (value) => {
		guard();
		if (
			typeof value !== "string" ||
			value.length > 4096 ||
			value.includes("\0") ||
			value.split(/[\\/]/).includes("..")
		)
			fail();
		const target = resolve(cwd, value);
		const root = roots.find((candidate) => {
			const suffix = relative(candidate, target);
			return (
				!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`)
			);
		});
		if (!root || lstatSync(root).isSymbolicLink()) fail();
		let path = root;
		for (const part of relative(root, target).split(sep).filter(Boolean)) {
			path = join(path, part);
			if (lstatSync(path).isSymbolicLink()) fail();
		}
		if (realpathSync(target) !== target) fail();
		return target;
	};
	return raw.map((tool) => ({
		...tool,
		execute: async (...args) => {
			const params = args[1];
			if (!record(params) || types.isProxy(params)) fail();
			const descriptors = Object.getOwnPropertyDescriptors(params);
			if (Object.values(descriptors).some((item) => !("value" in item))) fail();
			const target = check(descriptors.path?.value ?? ".");
			const call = [...args];
			call[1] = { ...params, path: target };
			// Retain the complete final result, not unvalidated partial updates.
			call[3] = undefined;
			const result = await tool.execute(...call);
			check(target);
			return result;
		},
	}));
}

async function run(request) {
	if (
		!record(request) ||
		request.version !== 1 ||
		(request.mode !== undefined &&
			request.mode !== "review" &&
			request.mode !== "startup-only") ||
		typeof request.correlationId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			request.correlationId,
		) ||
		Buffer.byteLength(JSON.stringify(request)) > 2_097_152 ||
		!Number.isSafeInteger(request.remainingMs) ||
		request.remainingMs < 1 ||
		request.remainingMs > 86_400_000
	)
		fail();
	// Remember only explicit request credentials, including headers which later
	// fail validation. Never dump the packet, prompts, environment or stack.
	if (record(request.auth)) {
		secrets = [
			request.auth.apiKey,
			...Object.values(
				record(request.auth.headers) ? request.auth.headers : {},
			),
		].filter((value) => typeof value === "string" && value.length > 0);
	}
	const mode = request.mode ?? "review";
	const startupOnly = mode === "startup-only";
	expires = performance.now() + request.remainingMs;
	guard();
	stage = "validate-paths";
	const cwd = canonicalDirectory(request.cwd);
	const agentDir = canonicalDirectory(request.agentDir);
	const temporary = realpathSync(tmpdir());
	const suffix = relative(temporary, agentDir);
	const owned = lstatSync(agentDir);
	if (
		!suffix ||
		isAbsolute(suffix) ||
		suffix === ".." ||
		suffix.startsWith(`..${sep}`) ||
		owned.uid !== process.getuid?.() ||
		(owned.mode & 0o7777) !== 0o700 ||
		cwd === agentDir
	)
		fail();
	stage = "validate-sdk";
	const sdkRoot = canonicalDirectory(request.sdkRoot);
	const metadata = JSON.parse(
		readFileSync(join(sdkRoot, "package.json"), "utf8"),
	);
	if (
		metadata.name !== "@earendil-works/pi-coding-agent" ||
		metadata.version !== "1.3.0" ||
		(metadata.piConfig?.name || "pi") !== "pi" ||
		!record(request.hashes) ||
		Object.keys(request.hashes).sort().join(",") !==
			Object.keys(entries).sort().join(",") ||
		digest(realpathSync(process.execPath)) !== request.nodeSha256
	)
		fail();
	const paths = Object.fromEntries(
		Object.entries(entries).map(([name, file]) => [name, join(sdkRoot, file)]),
	);
	for (const [name, file] of Object.entries(paths)) {
		if (digest(file) !== request.hashes[name]) fail();
	}
	if (
		typeof request.task !== "string" ||
		request.task.length > 100_000 ||
		typeof request.systemPrompt !== "string" ||
		request.systemPrompt.length > 1_048_576 ||
		!record(request.model) ||
		typeof request.model.provider !== "string" ||
		typeof request.model.id !== "string"
	)
		fail();
	stage = "validate-auth";
	if (startupOnly) {
		if (request.auth !== undefined) fail();
	} else if (
		!record(request.auth) ||
		typeof request.auth.apiKey !== "string" ||
		!request.auth.apiKey ||
		request.auth.apiKey.length > 65_536 ||
		/[\r\n\0]/.test(request.auth.apiKey)
	)
		fail();
	const headers = startupOnly ? {} : plainHeaders(request.auth.headers ?? {});
	const baseUrl = new URL(
		startupOnly
			? request.model.baseUrl
			: (request.auth.baseUrl ?? request.model.baseUrl),
	);
	if (
		baseUrl.protocol !== "https:" ||
		baseUrl.username ||
		baseUrl.password ||
		baseUrl.search ||
		baseUrl.hash
	)
		fail();
	stage = "validate-tools";
	const toolPath = request.toolSource;
	if (
		typeof toolPath !== "string" ||
		toolPath.length > 4096 ||
		!isAbsolute(toolPath) ||
		digest(toolPath) !== request.toolSha256
	)
		fail();
	const toolRoot = canonicalDirectory(join(dirname(toolPath), "../.."));
	const toolMetadata = JSON.parse(
		readFileSync(join(toolRoot, "package.json"), "utf8"),
	);
	if (toolMetadata.name !== "@davehardy20/pi-safe-tools") fail();
	const guardPath = join(toolRoot, "src/extensions/secret-guard.ts");
	if (digest(guardPath) !== request.guardSha256) fail();
	guard();
	// SDK tools-manager captures getAgentDir()/bin at module initialization.
	// Use the same explicit owned directory as the session; never another HOME
	// or CWD. PI_OFFLINE disables management downloads/catalog updates, not the
	// selected provider's streamSimple requests. Missing search tools refuse.
	// Jiti's ESM fallback can write temporary modules even with FS cache off.
	// Resolve that temporary directory inside the same owned root before import.
	// These SDK controls are not a filesystem/network sandbox or import fence.
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	process.env.TMPDIR = agentDir;
	const modules = {};
	for (const [name, file] of Object.entries(paths)) {
		stage = `import-sdk:${name}`;
		guard();
		modules[name] = await import(pathToFileURL(file).href);
		guard();
		if (digest(file) !== request.hashes[name]) fail();
	}
	stage = "model-runtime";
	const credentials = modules.auth.AuthStorage.inMemory();
	const runtimeOptions = {
		credentials,
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	};
	let modelRuntime = await modules.models.ModelRuntime.create(runtimeOptions);
	guard();
	// Do not register providers: that API launches a full availability refresh,
	// including unrelated ambient credential probes. Use the existing builtin
	// provider, explicit parent-selected model, and selected-provider key only.
	const provider = modelRuntime.getProvider(request.model.provider);
	if (!provider) fail();
	if (!startupOnly) {
		stage = "model-authentication";
		if (provider.auth.oauth && !provider.auth.apiKey) {
			// The parent has already resolved/refreshed OAuth. Borrow its access
			// token as an opaque request credential, never a fabricated OAuth
			// record or a copied refresh token. The SDK's config overlay adds a
			// bearer handler while retaining its normal auth check/resolution.
			// This reference is deliberately unset: without the runtime key there
			// is no dummy credential or ambient fallback. No secret goes to disk.
			delete process.env.PI_REVIEWER_NO_FALLBACK_AUTH;
			const modelsPath = join(agentDir, "reviewer-models.json");
			writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						[request.model.provider]: {
							apiKey: ["$", "{PI_REVIEWER_NO_FALLBACK_AUTH}"].join(""),
						},
					},
				}),
				{ flag: "wx", mode: 0o400 },
			);
			guard();
			modelRuntime = await modules.models.ModelRuntime.create({
				...runtimeOptions,
				modelsPath,
			});
			guard();
		}

		await modelRuntime.setRuntimeApiKey(
			request.model.provider,
			request.auth.apiKey,
		);
	}
	guard();
	const model = { ...request.model, baseUrl: baseUrl.href, headers };
	// Discard the tool source's lifecycle handlers and commands. Retain only
	// selected tool definitions and the fixed startup-free context redactor.
	stage = "load-extensions";
	const loaded = await modules.extensions.loadExtensions(
		[toolPath, guardPath],
		cwd,
	);
	guard();
	if (loaded.errors.length || loaded.extensions.length !== 2) {
		const detail = loaded.errors[0]?.error;
		fail(typeof detail === "string" ? new Error(detail) : undefined);
	}
	if (
		digest(toolPath) !== request.toolSha256 ||
		digest(guardPath) !== request.guardSha256
	)
		fail();
	const toolExtension = loaded.extensions.find(
		(item) => item.resolvedPath === toolPath,
	);
	const contextPolicy = loaded.extensions.find(
		(item) => item.resolvedPath === guardPath,
	);
	if (!toolExtension || !contextPolicy) fail();
	stage = "select-tools";
	const safeTools = [...toolExtension.tools.values()]
		.map((tool) => tool.definition)
		.filter((tool) => allowed.has(tool.name));
	if (
		CLOSED_REVIEWER_SAFE_TOOLS.some(
			(name) => safeTools.filter((tool) => tool.name === name).length !== 1,
		)
	)
		fail();
	const customTools = [
		...scopedReadTools(modules.sdk.createReadOnlyTools(cwd), cwd, [
			cwd,
			sdkRoot,
			toolRoot,
		]),
		...safeTools,
	];
	const tools = customTools.map((tool) => tool.name);
	stage = "create-session";
	reviewer = await createClosedReviewerSession(
		{
			SettingsManager: modules.settings.SettingsManager,
			SessionManager: modules.sessions.SessionManager,
			createExtensionRuntime: modules.extensions.createExtensionRuntime,
			createAgentSession: modules.sdk.createAgentSession,
		},
		{
			cwd,
			agentDir,
			model,
			modelRuntime,
			systemPrompt: request.systemPrompt,
			tools,
			customTools,
			contextPolicies: [contextPolicy],
			guard,
		},
	);
	guard();
	// Observed file identity, not OS/native loaded-byte attestation or a grant.
	emit({
		type: "reviewer_startup_identity",
		version: 1,
		correlationId: request.correlationId,
		mode,
		sdkRoot,
		hashes: request.hashes,
		nodeSha256: request.nodeSha256,
		toolSource: toolPath,
		toolSha256: request.toolSha256,
		guardSha256: request.guardSha256,
		resourcePolicy: "closed-sdk-v1",
		tools,
	});
	if (startupOnly) {
		stage = "dispose";
		await reviewer.dispose();
		return;
	}
	let assistantFailed = false;
	let terminalAnswer;
	const unsubscribe = reviewer.subscribe((event) => {
		if (event?.type === "message_start" && event.message?.role === "assistant")
			assistantStarted = true;
		// A later turn/start invalidates an earlier report, including failures
		// swallowed by Agent.runWithLifecycle before prompt() resolves normally.
		if (
			event?.type === "agent_start" ||
			event?.type === "turn_start" ||
			(event?.type === "message_start" && event.message?.role === "assistant")
		) {
			terminalAnswer = undefined;
			return;
		}
		if (event?.type !== "message_end" || event.message?.role !== "assistant")
			return;
		assistantStarted = true;
		const reason = event.message.stopReason;
		if (!assistantFailed) {
			assistantStopReason = reason;
			assistantError = event.message.errorMessage;
		}
		if (reason !== "stop" && reason !== "toolUse") assistantFailed = true;
		terminalAnswer = reason === "stop" ? event : undefined;
	});
	stage = "prompt";
	try {
		await reviewer.prompt(request.task);
		guard();
	} finally {
		const previousStage = stage;
		stage = "dispose";
		unsubscribe();
		await reviewer.dispose();
		stage = previousStage;
	}
	stage = "terminal-answer";
	if (
		assistantFailed ||
		terminalAnswer?.message.stopReason !== "stop" ||
		!Array.isArray(terminalAnswer.message.content) ||
		!terminalAnswer.message.content.some(
			(part) =>
				part?.type === "text" &&
				typeof part.text === "string" &&
				part.text.trim(),
		)
	)
		fail();
	// Emit no intermediate/failed report, and only after prompt and disposal.
	guard();
	emit(terminalAnswer);
	secrets = [];
}

async function stop() {
	stopped = true;
	try {
		await reviewer?.dispose();
	} finally {
		process.exit(1);
	}
}
const onDisconnect = () => void stop();
process.once("SIGTERM", () => void stop());
process.once("disconnect", onDisconnect);
process.on("message", (request) => {
	if (consumed) return void stop();
	consumed = true;
	void run(request)
		.then(() => {
			process.removeListener("disconnect", onDisconnect);
			if (process.connected) process.disconnect();
			// Flush the completed report before confirming successful termination.
			process.stdout.end(() => process.exit(0));
		})
		.catch(writeFailure);
});
