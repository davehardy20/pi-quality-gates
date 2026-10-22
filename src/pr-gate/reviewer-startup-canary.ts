/** Startup-only seam. No Pi imports, discovery, IO, model calls or review authority. */
export interface ReviewerCanaryBinding {
	version: 1;
	checkpointId: string;
	sdkVersion: "1.3.0";
	nodeVersion: string;
	nodeSha256: string;
	runtimeClosureSha256: string;
	bootstrapSha256: string;
	sourceCommit: string;
	fixtureRoot: string;
	issuedAt: number;
	expiresAt: number;
}

export interface CanaryResourceLoader {
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

export interface CanarySessionOptions {
	cwd: string;
	agentDir: string;
	modelRuntime: unknown;
	settingsManager: unknown;
	sessionManager: unknown;
	resourceLoader: CanaryResourceLoader;
	noTools: "all";
	tools: string[];
	customTools: unknown[];
	thinkingLevel: "off";
}

export interface CanarySession {
	readonly model: unknown;
	getActiveToolNames(): string[];
	bindExtensions(bindings: { mode: "json" }): Promise<void>;
	dispose(): void;
}

/** Structural port, not an import of the checkout's incompatible 0.74 SDK. */
export interface CanaryRuntime {
	sdkVersion: "1.3.0";
	AuthStorage: { inMemory(): unknown };
	SettingsManager: { inMemory(settings: Record<string, unknown>): unknown };
	SessionManager: { inMemory(cwd: string): unknown };
	ModelRuntime: {
		create(options: {
			credentials: unknown;
			modelsPath: null;
			refreshOnCreate: false;
			allowModelNetwork: false;
			signal?: AbortSignal;
		}): Promise<unknown>;
	};
	createExtensionRuntime(): unknown;
	createAgentSession(options: CanarySessionOptions): Promise<{
		session: CanarySession;
		extensionsResult: { extensions: unknown[]; errors: unknown[] };
	}>;
}

export interface ReviewerCanaryDeps {
	now(): number;
	/** Trusted, single-use owner registry. Never construct grants from model/JSON data. */
	claimAcceptedCanary?(checkpointId: string): unknown;
	/** Must attest canonical owned paths, source closure and process envelope BEFORE import. */
	isAccepted?(binding: Readonly<ReviewerCanaryBinding>): boolean;
	/** No default importer. Owner-approved coordinator must supply the exact audited adapter. */
	loadRuntime?(
		binding: Readonly<ReviewerCanaryBinding>,
		signal?: AbortSignal,
	): Promise<CanaryRuntime>;
	/** Metadata alone is insufficient: independently verify actual loaded origin/ABI. */
	verifyLoadedRuntime?(
		binding: Readonly<ReviewerCanaryBinding>,
		runtime: CanaryRuntime,
	): boolean;
}

export type ReviewerCanaryResult =
	| { status: "startup-completed" }
	| {
			status: "denied";
			reason:
				| "invalid"
				| "authority"
				| "expired"
				| "cancelled"
				| "runtime"
				| "startup"
				| "cleanup";
	  };

type DenialReason = Extract<
	ReviewerCanaryResult,
	{ status: "denied" }
>["reason"];

class Refusal extends Error {
	constructor(readonly reason: DenialReason) {
		super(reason);
	}
}

const BINDING_KEYS = [
	"version",
	"checkpointId",
	"sdkVersion",
	"nodeVersion",
	"nodeSha256",
	"runtimeClosureSha256",
	"bootstrapSha256",
	"sourceCommit",
	"fixtureRoot",
	"issuedAt",
	"expiresAt",
] as const;

/** Lexical validation only. The trusted registry must attest realpath/ownership. */
function snapshotBinding(input: unknown, id: string): ReviewerCanaryBinding {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new Refusal("invalid");
	}
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== null && prototype !== Object.prototype) {
		throw new Refusal("invalid");
	}
	const keys = Reflect.ownKeys(input);
	if (keys.length !== BINDING_KEYS.length) throw new Refusal("invalid");
	const record: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (
			typeof key !== "string" ||
			!BINDING_KEYS.includes(key as (typeof BINDING_KEYS)[number])
		) {
			throw new Refusal("invalid");
		}
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor || !("value" in descriptor)) throw new Refusal("invalid");
		record[key] = descriptor.value;
	}
	if (
		record.version !== 1 ||
		record.checkpointId !== id ||
		record.sdkVersion !== "1.3.0" ||
		record.nodeVersion !== "v26.12.0" ||
		typeof record.sourceCommit !== "string" ||
		!/^[a-f0-9]{40}$/.test(record.sourceCommit)
	) {
		throw new Refusal("invalid");
	}
	for (const key of ["nodeSha256", "runtimeClosureSha256", "bootstrapSha256"]) {
		if (
			typeof record[key] !== "string" ||
			!/^[a-f0-9]{64}$/.test(record[key])
		) {
			throw new Refusal("invalid");
		}
	}
	const root = record.fixtureRoot;
	if (
		typeof root !== "string" ||
		root.length > 4096 ||
		!root.startsWith("/") ||
		[...root].some(
			(char) => char.charCodeAt(0) < 32 || char === "\u007f" || char === "\\",
		) ||
		root
			.slice(1)
			.split("/")
			.some((part) =>
				["", ".", "..", ".pi", ".git"].includes(part.toLowerCase()),
			)
	) {
		throw new Refusal("invalid");
	}
	return Object.freeze(record) as unknown as ReviewerCanaryBinding;
}

function closedResources(runtime: unknown): CanaryResourceLoader {
	const empty = <T>(): T[] => Object.freeze([]) as unknown as T[];
	return Object.freeze({
		getExtensions: () => ({ extensions: empty(), errors: empty(), runtime }),
		getSkills: () => ({ skills: empty(), diagnostics: empty() }),
		getPrompts: () => ({ prompts: empty(), diagnostics: empty() }),
		getThemes: () => ({ themes: empty(), diagnostics: empty() }),
		getAgentsFiles: () => ({ agentsFiles: empty() }),
		getSystemPrompt: () =>
			"Startup-only canary. Do not prompt or execute tools.",
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => empty<string>(),
		getAppendSystemPromptSources: () => empty(),
		extendResources: () => {
			throw new Refusal("startup");
		},
		reload: async () => {
			throw new Refusal("startup");
		},
	});
}

/**
 * Not registered as a tool, bridge, importer, execution lease or PASS-token source.
 * Requires a separately admitted process envelope: cooperative checks cannot stop
 * a hung import or factory. The trusted coordinator must own the hard timeout.
 * Fixture completion is NOT loaded-source acceptance or reviewer admission.
 */
export function createReviewerStartupCanary(deps: ReviewerCanaryDeps) {
	return async (
		checkpointId: unknown,
		signal?: AbortSignal,
	): Promise<ReviewerCanaryResult> => {
		if (
			typeof checkpointId !== "string" ||
			!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(checkpointId)
		) {
			return { status: "denied", reason: "invalid" };
		}
		if (signal?.aborted) return { status: "denied", reason: "cancelled" };
		const {
			claimAcceptedCanary,
			isAccepted,
			loadRuntime,
			verifyLoadedRuntime,
		} = deps;
		if (
			typeof claimAcceptedCanary !== "function" ||
			typeof isAccepted !== "function" ||
			typeof loadRuntime !== "function" ||
			typeof verifyLoadedRuntime !== "function"
		) {
			return { status: "denied", reason: "authority" };
		}
		let stage: DenialReason = "authority";
		let session: CanarySession | undefined;
		let finalGuard: (() => void) | undefined;
		let result: ReviewerCanaryResult;
		try {
			const candidate = claimAcceptedCanary(checkpointId);
			stage = "invalid";
			const binding = snapshotBinding(candidate, checkpointId);
			let previousNow = -1;
			const checkTime = () => {
				if (signal?.aborted) throw new Refusal("cancelled");
				let now: number;
				try {
					now = deps.now();
				} catch {
					throw new Refusal("expired");
				}
				if (
					!Number.isSafeInteger(now) ||
					!Number.isSafeInteger(binding.issuedAt) ||
					!Number.isSafeInteger(binding.expiresAt) ||
					binding.issuedAt < 0 ||
					binding.issuedAt > now ||
					now < previousNow ||
					now >= binding.expiresAt ||
					binding.expiresAt - binding.issuedAt > 60_000
				) {
					throw new Refusal("expired");
				}
				previousNow = now;
			};
			const guard = () => {
				checkTime();
				try {
					if (isAccepted(binding) !== true) throw new Refusal("authority");
				} catch {
					throw new Refusal("authority");
				}
				checkTime();
			};
			finalGuard = guard;
			guard();
			stage = "runtime";
			const runtime = await loadRuntime(binding, signal);
			guard();
			if (
				runtime.sdkVersion !== "1.3.0" ||
				verifyLoadedRuntime(binding, runtime) !== true
			) {
				throw new Refusal("runtime");
			}
			guard();
			stage = "startup";
			const credentials = runtime.AuthStorage.inMemory();
			guard();
			const settingsManager = runtime.SettingsManager.inMemory({
				defaultTools: [],
				compaction: { enabled: false },
				retry: { enabled: false, provider: { maxRetries: 0 } },
				cacheWarming: "off",
				enableAnalytics: false,
				enableInstallTelemetry: false,
			});
			guard();
			const sessionManager = runtime.SessionManager.inMemory(
				binding.fixtureRoot,
			);
			guard();
			const modelRuntime = await runtime.ModelRuntime.create({
				credentials,
				modelsPath: null,
				refreshOnCreate: false,
				allowModelNetwork: false,
				signal,
			});
			guard();
			const resourceLoader = closedResources(runtime.createExtensionRuntime());
			guard();
			const created = await runtime.createAgentSession({
				cwd: binding.fixtureRoot,
				agentDir: `${binding.fixtureRoot}/state`,
				modelRuntime,
				settingsManager,
				sessionManager,
				resourceLoader,
				noTools: "all",
				tools: [],
				customTools: [],
				thinkingLevel: "off",
			});
			session = created.session;
			guard();
			const checkEmpty = () => {
				if (
					!session ||
					session.model !== undefined ||
					session.getActiveToolNames().length !== 0 ||
					created.extensionsResult.extensions.length !== 0 ||
					created.extensionsResult.errors.length !== 0
				) {
					throw new Refusal("startup");
				}
			};
			checkEmpty();
			await session.bindExtensions({ mode: "json" });
			guard();
			checkEmpty();
			result = { status: "startup-completed" };
		} catch (error) {
			result = {
				status: "denied",
				reason: error instanceof Refusal ? error.reason : stage,
			};
		} finally {
			if (session) {
				try {
					session.dispose();
				} catch {
					result = { status: "denied", reason: "cleanup" };
				}
			}
		}
		if (result.status === "startup-completed") {
			try {
				finalGuard?.();
			} catch (error) {
				return {
					status: "denied",
					reason: error instanceof Refusal ? error.reason : "authority",
				};
			}
		}
		return result;
	};
}
