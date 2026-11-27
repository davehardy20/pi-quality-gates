import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, posix, relative } from "node:path";
import { types } from "node:util";

/** Fixed read-only reviewer tools, shared with the normal PR configuration. */
export const CLOSED_REVIEWER_TOOLS = Object.freeze([
	"read",
	"grep",
	"find",
	"ls",
	"safe_parse_file",
	"ast_grep_search",
	"lsp_goto_definition",
	"lsp_find_references",
	"lsp_diagnostics",
	"lsp_symbols",
	"lsp_prepare_rename",
	"git_inspect_safe",
	"context7_library",
	"context7_docs",
	"web_search",
	"mulch_query",
	"mulch_search",
	"seeds_show",
	"seeds_plan_show",
	"run_biome",
	"run_vitest",
	"run_typecheck",
	"run_pytest",
	"run_cargo_test",
	"run_node_test",
	"run_ruff",
	"compact_plus_query_tool_output",
]);

/** Mandatory explicitly loaded safe tools; never silently omit validation. */
export const CLOSED_REVIEWER_SAFE_TOOLS = Object.freeze([
	"git_inspect_safe",
	"run_biome",
	"run_vitest",
	"run_typecheck",
	"run_pytest",
	"run_cargo_test",
	"run_node_test",
	"run_ruff",
]);

/** SDK ports only. This module does not import Pi, discover resources, obtain
 * credentials, issue acceptance or establish runtime/source provenance. The
 * supervising launcher must supply its already-admitted runtime and inputs. */
interface ClosedResourceLoader {
	getExtensions(): {
		extensions: unknown[];
		errors: unknown[];
		runtime: unknown;
	};
	getSkills(): { skills: unknown[]; diagnostics: unknown[] };
	getPrompts(): { prompts: unknown[]; diagnostics: unknown[] };
	getThemes(): { themes: unknown[]; diagnostics: unknown[] };
	getAgentsFiles(): { agentsFiles: unknown[] };
	getSystemPrompt(): string;
	getSystemPromptSource(): undefined;
	getAppendSystemPrompt(): string[];
	getAppendSystemPromptSources(): unknown[];
	extendResources(paths: unknown): never;
	reload(): Promise<never>;
}

export interface ClosedReviewerContextPolicy {
	readonly path: string;
	readonly resolvedPath: string;
	readonly sourceInfo: unknown;
	readonly handlers: Map<string, ((...args: never[]) => unknown)[]>;
	readonly tools: Map<string, unknown>;
	readonly commands: Map<string, unknown>;
	readonly flags: Map<string, unknown>;
	readonly shortcuts: Map<string, unknown>;
	readonly messageRenderers: Map<string, unknown>;
	readonly toolRenderers?: readonly unknown[];
	readonly entryRenderers?: Map<string, unknown>;
	readonly markdownTransformer?: unknown;
}

interface ClosedReviewerTool {
	readonly name: string;
	readonly execute: (...args: never[]) => unknown;
	readonly [key: string]: unknown;
}

export interface RequiredVitestCall {
	cwd: string;
	config: string;
	paths: string[];
	timeoutMs: number;
}

const configRefusal = () =>
	new Error("Required selected-config Vitest validation is NOT_RUN.");
const object = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

/** Resolve identities without importing configs or running discovery/scripts. */
function canonicalFile(root: string, value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 512 ||
		posix.normalize(value) !== value ||
		isAbsolute(value) ||
		/^[A-Za-z]:/.test(value) ||
		/[\\*?[\]{}\p{Cc}]/u.test(value) ||
		value.split("/").some((part) => part === ".." || part.startsWith("-"))
	)
		throw configRefusal();
	const file = realpathSync(join(root, value));
	const identity = relative(root, file);
	if (
		!identity ||
		identity === ".." ||
		identity.startsWith("../") ||
		isAbsolute(identity) ||
		!statSync(file).isFile()
	)
		throw configRefusal();
	return identity;
}

function collectedRequiredFile(
	value: unknown,
	call: RequiredVitestCall & { root: string; identity: string },
): boolean {
	try {
		const receipt = object(value);
		const request = object(receipt?.request);
		if (
			receipt?.version !== 1 ||
			receipt.source !== "vitest-json-reporter" ||
			receipt.status !== "complete" ||
			request?.cwd !== call.root ||
			request.config !== call.config ||
			JSON.stringify(request.paths) !== JSON.stringify(call.paths) ||
			request.testNamePattern !== null ||
			!Number.isSafeInteger(receipt.reportBytes) ||
			(receipt.reportBytes as number) <= 0 ||
			(receipt.reportBytes as number) > 4 * 1024 * 1024 ||
			typeof receipt.reportSha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(receipt.reportSha256) ||
			!Array.isArray(receipt.files) ||
			!receipt.files.length ||
			receipt.files.length > 2048 ||
			canonicalFile(call.root, call.paths[0]) !== call.identity
		)
			return false;
		const identities = new Set<string>();
		let total = 0;
		let found = false;
		for (const value of receipt.files) {
			const file = object(value);
			if (!file) return false;
			const identity = canonicalFile(call.root, file.path);
			if (identity !== file.path || identities.has(identity)) return false;
			identities.add(identity);
			let count = 0;
			for (const key of ["passed", "failed", "skipped", "todo"]) {
				const counter = file[key];
				if (
					!Number.isSafeInteger(counter) ||
					(counter as number) < 0 ||
					(counter as number) > 100_000
				)
					return false;
				count += counter as number;
			}
			total += count;
			if (file.failed !== 0 || total > 100_000) return false;
			if (identity === call.identity && count > 0) found = true;
		}
		return found;
	} catch {
		return false;
	}
}

/** Only awaited trusted tool results count, never model text or stdout names.
 * Version-1 collection binds the exact request to canonical same-run files.
 * Skipped/todo collection is valid but does not prove test-body execution. */
export function createVitestConfigGuard<T extends Readonly<ClosedReviewerTool>>(
	tools: readonly T[],
	required: readonly RequiredVitestCall[],
) {
	if (!Array.isArray(required)) throw configRefusal();
	if (!required.length) return { tools, assertComplete() {} };
	if (required.length > 2048) throw configRefusal();
	const runners = tools.filter((tool) => tool.name === "run_vitest");
	const schema = object(runners[0]?.parameters);
	const properties = object(schema?.properties);
	if (runners.length !== 1 || object(properties?.config)?.type !== "string")
		throw configRefusal();
	const complete = required.map(() => false);
	const attempts = required.map(() => 0);
	const selected = required.map((call: RequiredVitestCall) => {
		if (
			!call ||
			typeof call.cwd !== "string" ||
			!isAbsolute(call.cwd) ||
			normalize(call.cwd) !== call.cwd ||
			typeof call.config !== "string" ||
			!call.config ||
			isAbsolute(call.config) ||
			call.config.includes("\\") ||
			call.config.split("/").some((part) => part === ".." || !part) ||
			!Array.isArray(call.paths) ||
			call.paths.length !== 1 ||
			typeof call.paths[0] !== "string" ||
			!call.paths[0] ||
			!Number.isSafeInteger(call.timeoutMs) ||
			call.timeoutMs < 1000
		)
			throw configRefusal();
		try {
			const root = realpathSync(call.cwd);
			canonicalFile(root, call.config);
			return {
				...call,
				paths: [...call.paths],
				root,
				identity: canonicalFile(root, call.paths[0]),
			};
		} catch {
			throw configRefusal();
		}
	});
	return {
		tools: tools.map((tool) =>
			tool.name !== "run_vitest"
				? tool
				: {
						...tool,
						async execute(...args: never[]) {
							const params = object(args[1]);
							if (!params || params.env !== undefined) throw configRefusal();
							const index = selected.findIndex(
								(call) =>
									(params.cwd ?? call.cwd) === call.cwd &&
									params.config === call.config &&
									params.timeoutMs === call.timeoutMs &&
									JSON.stringify(params.paths) === JSON.stringify(call.paths) &&
									Object.keys(params).every((key) =>
										["cwd", "config", "paths", "timeoutMs"].includes(key),
									),
							);
							const attempt = index >= 0 ? ++attempts[index] : 0;
							if (index >= 0) complete[index] = false;
							const result = await tool.execute(...args);
							if (index >= 0 && attempts[index] === attempt) {
								const detail = object(object(result)?.details);
								const call = selected[index];
								complete[index] = Boolean(
									detail &&
										detail.toolName === "run_vitest" &&
										detail.cwd === call.cwd &&
										collectedRequiredFile(detail.vitestCollection, call) &&
										detail.exitCode === 0 &&
										detail.success === true &&
										detail.timedOut === false &&
										detail.aborted === false &&
										detail.spawnError === false &&
										object(detail.validation)?.passed === true &&
										detail.requestedTimeoutMs === call.timeoutMs &&
										typeof detail.effectiveTimeoutMs === "number" &&
										Number.isSafeInteger(detail.effectiveTimeoutMs) &&
										detail.effectiveTimeoutMs >= 1000 &&
										detail.effectiveTimeoutMs <= call.timeoutMs &&
										typeof detail.elapsedMs === "number" &&
										Number.isFinite(detail.elapsedMs) &&
										detail.elapsedMs >= 0,
								);
							}
							return result;
						},
					},
		),
		assertComplete() {
			if (complete.some((passed) => !passed)) throw configRefusal();
		},
	};
}

export interface ClosedReviewerSessionOptions {
	cwd: string;
	agentDir: string;
	model: unknown;
	modelRuntime: unknown;
	settingsManager: unknown;
	sessionManager: unknown;
	resourceLoader: ClosedResourceLoader;
	noTools: "all";
	tools: string[];
	customTools: Readonly<ClosedReviewerTool>[];
	thinkingLevel: "medium";
}

interface SdkSession {
	getActiveToolNames(): string[];
	bindExtensions(input: { mode: "json" }): Promise<void>;
	prompt(task: string): Promise<void>;
	subscribe(listener: (event: unknown) => void): () => void;
	abort(): void | Promise<void>;
	dispose(): void | Promise<void>;
}

export interface ClosedReviewerRuntime {
	SettingsManager: { inMemory(settings: Record<string, unknown>): unknown };
	SessionManager: { inMemory(cwd: string): unknown };
	createExtensionRuntime(): unknown;
	createAgentSession(options: ClosedReviewerSessionOptions): Promise<{
		session: SdkSession;
		extensionsResult: { extensions: unknown[]; errors: unknown[] };
	}>;
}

export interface ClosedReviewerSessionInput {
	/** Original canonical workspace; never a substitute HOME or CWD. */
	cwd: string;
	/** Supervisor-owned private temporary root, not a discovered config root. */
	agentDir: string;
	model: unknown;
	/** Explicit bounded provider runtime; this factory never constructs defaults. */
	modelRuntime: unknown;
	systemPrompt: string;
	tools: readonly string[];
	/** Trusted tool definitions supplied by the supervisor, not repository data. */
	customTools: readonly Readonly<ClosedReviewerTool>[];
	requiredVitestCalls?: readonly RequiredVitestCall[];
	/** Fixed redaction policy only; no lifecycle or registered tools/commands. */
	contextPolicies?: readonly ClosedReviewerContextPolicy[];
	signal?: AbortSignal;
	/** Recheck an existing lease/deadline. This callback does not grant admission. */
	guard(): void;
}

const allowedTools = new Set(CLOSED_REVIEWER_TOOLS);
const allowedReviewerContextPolicyEvents = new Set([
	"input",
	"context",
	"tool_call",
	"tool_result",
]);
// Keep the public refusal fixed; only the worker formats/redacts its cause.
const refused = (cause?: unknown) =>
	new Error("Closed reviewer startup refused.", { cause });

/** Explicit SDK session construction, with no CLI main, global/project
 * extensions, discovery, file-backed settings/session, warming or retry loop.
 * Import containment and hard termination belong to the supervising process. */
export async function createClosedReviewerSession(
	runtime: ClosedReviewerRuntime,
	input: ClosedReviewerSessionInput,
): Promise<{
	prompt(task: string): Promise<void>;
	subscribe(listener: (event: unknown) => void): () => void;
	dispose(): Promise<void>;
}> {
	let session: SdkSession | undefined;
	let failed = false;
	let closed = false;
	let disposal: Promise<void> | undefined;
	let onAbort: (() => void) | undefined;
	const guard = () => {
		if (failed || closed || input.signal?.aborted) throw refused();
		input.guard();
	};
	const dispose = (): Promise<void> => {
		if (disposal) return disposal;
		closed = true;
		if (onAbort) input.signal?.removeEventListener("abort", onAbort);
		disposal = Promise.resolve().then(async () => {
			try {
				await session?.dispose();
			} catch (error) {
				throw refused(error);
			}
		});
		return disposal;
	};
	try {
		guard();
		for (const root of [input.cwd, input.agentDir]) {
			if (
				typeof root !== "string" ||
				!isAbsolute(root) ||
				normalize(root) !== root
			)
				throw refused();
		}
		if (
			!input.model ||
			!input.modelRuntime ||
			typeof input.systemPrompt !== "string" ||
			input.systemPrompt.length > 1_048_576 ||
			!Array.isArray(input.tools) ||
			input.tools.length === 0 ||
			input.tools.length > 32 ||
			!Array.isArray(input.customTools) ||
			input.customTools.length > 32
		)
			throw refused();
		const tools = [...input.tools];
		const selected = new Set(tools);
		if (
			selected.size !== tools.length ||
			tools.some((name) => !allowedTools.has(name))
		)
			throw refused();
		const customTools = input.customTools.map((tool) => {
			if (!tool || types.isProxy(tool)) throw refused();
			const prototype = Object.getPrototypeOf(tool);
			if (prototype !== null && prototype !== Object.prototype) throw refused();
			const descriptors = Object.getOwnPropertyDescriptors(tool);
			if (Object.values(descriptors).some((value) => !("value" in value)))
				throw refused();
			if (typeof descriptors.execute?.value !== "function") throw refused();
			return Object.freeze(
				Object.defineProperties({}, descriptors),
			) as Readonly<ClosedReviewerTool>;
		});
		const configValidation = createVitestConfigGuard(
			customTools,
			input.requiredVitestCalls ?? [],
		);
		const customNames = customTools.map((tool) => tool.name);
		if (
			new Set(customNames).size !== customNames.length ||
			customNames.some((name) => !selected.has(name))
		)
			throw refused();
		const policies = input.contextPolicies ?? [];
		if (!Array.isArray(policies) || policies.length > 1) throw refused();
		const contextPolicies = policies.map((policy) => {
			if (!policy || types.isProxy(policy)) throw refused();
			const prototype = Object.getPrototypeOf(policy);
			if (prototype !== null && prototype !== Object.prototype) throw refused();
			const descriptors = Object.getOwnPropertyDescriptors(policy);
			if (Object.values(descriptors).some((value) => !("value" in value)))
				throw refused();
			const hooks = Map.prototype.entries.call(policy.handlers) as Iterable<
				[string, ((...args: never[]) => unknown)[]]
			>;
			const handlers = new Map<string, ((...args: never[]) => unknown)[]>();
			for (const [event, callbacks] of hooks) {
				if (!allowedReviewerContextPolicyEvents.has(event)) {
					throw refused();
				}
				if (
					!Array.isArray(callbacks) ||
					callbacks.length > 8 ||
					callbacks.some((callback) => typeof callback !== "function")
				)
					throw refused();
				handlers.set(event, [...callbacks]);
			}
			for (const map of [
				policy.tools,
				policy.commands,
				policy.flags,
				policy.shortcuts,
				policy.messageRenderers,
			]) {
				if (!Map.prototype.entries.call(map).next().done) throw refused();
			}
			if (
				policy.entryRenderers !== undefined &&
				!Map.prototype.entries.call(policy.entryRenderers).next().done
			)
				throw refused();
			if (
				policy.toolRenderers?.length ||
				policy.markdownTransformer !== undefined
			)
				throw refused();
			return Object.freeze({
				...policy,
				handlers,
				tools: new Map<string, unknown>(),
				commands: new Map<string, unknown>(),
				flags: new Map<string, unknown>(),
				shortcuts: new Map<string, unknown>(),
				messageRenderers: new Map<string, unknown>(),
				toolRenderers: [],
				entryRenderers: new Map<string, unknown>(),
			});
		});
		const systemPrompt = input.systemPrompt;
		const extensionRuntime = runtime.createExtensionRuntime();
		const refuseExpansion = (): never => {
			failed = true;
			throw refused();
		};
		const resourceLoader: ClosedResourceLoader = {
			getExtensions: () => ({
				extensions: [...contextPolicies],
				errors: [],
				runtime: extensionRuntime,
			}),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => systemPrompt,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: refuseExpansion,
			reload: async () => refuseExpansion(),
		};
		guard();
		const result = await runtime.createAgentSession({
			cwd: input.cwd,
			agentDir: input.agentDir,
			model: input.model,
			modelRuntime: input.modelRuntime,
			settingsManager: runtime.SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
				images: { blockImages: true },
				cacheWarming: "off",
			}),
			sessionManager: runtime.SessionManager.inMemory(input.cwd),
			resourceLoader,
			noTools: "all",
			tools,
			customTools: [...configValidation.tools],
			// Match the SDK's documented default, not a startup-canary shortcut.
			thinkingLevel: "medium",
		});
		session = result.session;
		guard();
		if (
			result.extensionsResult.errors.length ||
			result.extensionsResult.extensions.length !== contextPolicies.length ||
			result.extensionsResult.extensions.some(
				(extension, index) => extension !== contextPolicies[index],
			)
		)
			throw refused();
		const verifyTools = () => {
			guard();
			const active = session?.getActiveToolNames() ?? [];
			if (
				active.length !== selected.size ||
				new Set(active).size !== selected.size ||
				active.some((name) => !selected.has(name))
			) {
				failed = true;
				throw refused();
			}
		};
		verifyTools();
		onAbort = () => {
			failed = true;
			try {
				void Promise.resolve(session?.abort()).catch(() => {});
			} catch {
				// Disposal is still awaited by the supervisor.
			}
		};
		input.signal?.addEventListener("abort", onAbort, { once: true });
		guard();
		await session.bindExtensions({ mode: "json" });
		verifyTools();
		const boundSession = session;
		return Object.freeze({
			async prompt(task: string) {
				try {
					verifyTools();
					if (typeof task !== "string" || task.length > 100_000)
						throw refused();
					await boundSession.prompt(task);
					verifyTools();
					configValidation.assertComplete();
				} catch (error) {
					failed = true;
					throw refused(error);
				}
			},
			subscribe(listener: (event: unknown) => void) {
				verifyTools();
				return boundSession.subscribe(listener);
			},
			dispose,
		});
	} catch (error) {
		failed = true;
		await dispose();
		throw refused(error);
	}
}
