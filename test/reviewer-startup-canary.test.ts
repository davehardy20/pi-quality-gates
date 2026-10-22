import { describe, expect, it, vi } from "vitest";
import {
	type CanarySessionOptions,
	createReviewerStartupCanary,
	type ReviewerCanaryBinding,
	type ReviewerCanaryDeps,
} from "../src/pr-gate/reviewer-startup-canary.js";

// Fabricated objects only. No Pi imports, filesystem, processes or real model transport.
function fixture() {
	let now = 2_000;
	let accepted = true;
	const binding: ReviewerCanaryBinding = {
		version: 1,
		checkpointId: "owned-startup",
		sdkVersion: "1.3.0",
		nodeVersion: "v26.12.0",
		nodeSha256: "a".repeat(64),
		runtimeClosureSha256: "b".repeat(64),
		bootstrapSha256: "c".repeat(64),
		sourceCommit: "d".repeat(40),
		fixtureRoot: "/owned-fixture/canary",
		issuedAt: 1_000,
		expiresAt: 7_000,
	};
	const credentials = { fixture: "empty-auth" };
	const settings = { fixture: "memory-settings" };
	const sessionManager = { fixture: "memory-session" };
	const modelRuntime = { fixture: "no-refresh-runtime" };
	const extensionRuntime = { fixture: "empty-extension-runtime" };
	const forbidden = vi.fn(() => {
		throw new Error("ambient discovery was touched");
	});
	const session = {
		model: undefined as unknown,
		getActiveToolNames: vi.fn((): string[] => []),
		bindExtensions: vi.fn(async (_bindings: { mode: "json" }) => {}),
		dispose: vi.fn(() => {}),
		prompt: forbidden,
	};
	const extensionsResult = {
		extensions: [] as unknown[],
		errors: [] as unknown[],
	};
	const runtime = {
		sdkVersion: "1.3.0" as const,
		AuthStorage: { inMemory: vi.fn(() => credentials), create: forbidden },
		SettingsManager: { inMemory: vi.fn(() => settings), create: forbidden },
		SessionManager: {
			inMemory: vi.fn(() => sessionManager),
			create: forbidden,
		},
		ModelRuntime: { create: vi.fn(async () => modelRuntime) },
		DefaultResourceLoader: forbidden,
		createExtensionRuntime: vi.fn(() => extensionRuntime),
		createAgentSession: vi.fn(async (_options: CanarySessionOptions) => ({
			session,
			extensionsResult,
		})),
	};
	const deps = {
		now: vi.fn(() => now),
		claimAcceptedCanary: vi.fn((_id: string): unknown => binding),
		isAccepted: vi.fn((_plan: Readonly<ReviewerCanaryBinding>) => accepted),
		loadRuntime: vi.fn(async () => runtime),
		verifyLoadedRuntime: vi.fn(() => true),
	};
	const invoke = createReviewerStartupCanary(deps);
	return {
		run: (signal?: AbortSignal) => invoke(binding.checkpointId, signal),
		binding,
		deps,
		runtime,
		session,
		extensionsResult,
		forbidden,
		credentials,
		settings,
		sessionManager,
		modelRuntime,
		extensionRuntime,
		setNow: (value: number) => {
			now = value;
		},
		revoke: () => {
			accepted = false;
		},
	};
}

const denied = (reason: string) => ({ status: "denied", reason });

describe("startup-only canary seam (fabricated SDK, not startup acceptance)", () => {
	it("supplies every startup boundary explicitly and disposes without prompting", async () => {
		const f = fixture();
		const run = createReviewerStartupCanary(f.deps);
		expect(await run(f.binding.checkpointId)).toEqual({
			status: "startup-completed",
		});
		expect(f.deps.claimAcceptedCanary).toHaveBeenCalledWith(
			f.binding.checkpointId,
		);
		expect(f.deps.verifyLoadedRuntime).toHaveBeenCalledWith(
			f.binding,
			f.runtime,
		);
		expect(f.runtime.AuthStorage.inMemory).toHaveBeenCalledWith();
		expect(f.runtime.ModelRuntime.create).toHaveBeenCalledWith({
			credentials: f.credentials,
			modelsPath: null,
			refreshOnCreate: false,
			allowModelNetwork: false,
			signal: undefined,
		});
		expect(f.runtime.SettingsManager.inMemory).toHaveBeenCalledWith({
			defaultTools: [],
			compaction: { enabled: false },
			retry: { enabled: false, provider: { maxRetries: 0 } },
			cacheWarming: "off",
			enableAnalytics: false,
			enableInstallTelemetry: false,
		});
		expect(f.runtime.SessionManager.inMemory).toHaveBeenCalledWith(
			f.binding.fixtureRoot,
		);
		const options = f.runtime.createAgentSession.mock.calls[0][0];
		expect(options).toEqual({
			cwd: f.binding.fixtureRoot,
			agentDir: `${f.binding.fixtureRoot}/state`,
			modelRuntime: f.modelRuntime,
			settingsManager: f.settings,
			sessionManager: f.sessionManager,
			resourceLoader: expect.any(Object),
			noTools: "all",
			tools: [],
			customTools: [],
			thinkingLevel: "off",
		});
		expect(f.session.bindExtensions).toHaveBeenCalledWith({ mode: "json" });
		expect(f.session.dispose).toHaveBeenCalledOnce();
		expect(f.forbidden).not.toHaveBeenCalled();
	});

	it("keeps resources closed; attempted reload or extension discovery fails", async () => {
		const f = fixture();
		await f.run();
		const loader = f.runtime.createAgentSession.mock.calls[0][0].resourceLoader;
		expect(loader.getExtensions()).toEqual({
			extensions: [],
			errors: [],
			runtime: f.extensionRuntime,
		});
		expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
		expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
		expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] });
		expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
		expect(loader.getAppendSystemPrompt()).toEqual([]);
		expect(loader.getAppendSystemPromptSources()).toEqual([]);
		expect(loader.getSystemPromptSource()).toBeUndefined();
		expect(loader.getSystemPrompt()).toBeTypeOf("string");
		expect(() =>
			loader.extendResources({ skillPaths: ["/protected"] }),
		).toThrow();
		await expect(loader.reload()).rejects.toThrow();
		expect(() => loader.getExtensions().extensions.push("poison")).toThrow();
		expect(f.forbidden).not.toHaveBeenCalled();
	});

	it.each([
		undefined,
		null,
		{},
		[],
		"",
		"../canary",
		"/tmp/canary",
		"a\n",
		"x".repeat(65),
	])("rejects request %j before authority", async (id) => {
		const f = fixture();
		expect(await createReviewerStartupCanary(f.deps)(id)).toEqual(
			denied("invalid"),
		);
		expect(f.deps.claimAcceptedCanary).not.toHaveBeenCalled();
		expect(f.deps.loadRuntime).not.toHaveBeenCalled();
	});

	it.each([
		"claimAcceptedCanary",
		"isAccepted",
		"loadRuntime",
		"verifyLoadedRuntime",
	] as const)("requires trusted %s", async (key) => {
		const f = fixture();
		const deps: ReviewerCanaryDeps = { ...f.deps, [key]: undefined };
		expect(
			await createReviewerStartupCanary(deps)(f.binding.checkpointId),
		).toEqual(denied("authority"));
		expect(f.deps.loadRuntime).not.toHaveBeenCalled();
	});

	it.each([
		{ sdkVersion: "0.74.1" },
		{ sdkVersion: "0.87.1" },
		{ sdkVersion: "1.3.1" },
		{ version: 2 },
		{ checkpointId: "foreign" },
		{ env: {} },
		{ accepted: true },
		{ nodeSha256: "x".repeat(64) },
		{ runtimeClosureSha256: "" },
		{ bootstrapSha256: null },
		{ sourceCommit: "HEAD" },
		{ nodeVersion: "26" },
		{ fixtureRoot: "/Users/dave/.pi/canary" },
		{ fixtureRoot: "/owned/.PI/canary" },
		{ fixtureRoot: "/owned/.git/canary" },
		{ fixtureRoot: "/owned/../canary" },
		{ fixtureRoot: "/owned//canary" },
		{ fixtureRoot: "relative" },
		{ fixtureRoot: "/" },
		{ fixtureRoot: "/owned/" },
		{ fixtureRoot: "/owned\\canary" },
		{ fixtureRoot: "/owned\ncanary" },
	])("denies invalid registry binding %j before import", async (change) => {
		const f = fixture();
		f.deps.claimAcceptedCanary.mockReturnValue({ ...f.binding, ...change });
		expect(await f.run()).toEqual(denied("invalid"));
		expect(f.deps.loadRuntime).not.toHaveBeenCalled();
	});

	it("never reads binding accessors or inherited grants", async () => {
		const f = fixture();
		const getter = vi.fn(() => f.binding.fixtureRoot);
		const candidate = { ...f.binding };
		Object.defineProperty(candidate, "fixtureRoot", { get: getter });
		f.deps.claimAcceptedCanary.mockReturnValue(candidate);
		expect(await f.run()).toEqual(denied("invalid"));
		expect(getter).not.toHaveBeenCalled();
		f.deps.claimAcceptedCanary.mockReturnValue(Object.create(f.binding));
		expect(await f.run()).toEqual(denied("invalid"));
		expect(f.deps.loadRuntime).not.toHaveBeenCalled();
	});

	it.each([
		{ issuedAt: 3_000 },
		{ expiresAt: 2_000 },
		{ expiresAt: 100_000 },
		{ issuedAt: -1 },
	])("denies unusable window %j before import", async (change) => {
		const f = fixture();
		f.deps.claimAcceptedCanary.mockReturnValue({ ...f.binding, ...change });
		expect(await f.run()).toEqual(denied("expired"));
		expect(f.deps.loadRuntime).not.toHaveBeenCalled();
	});

	it("requires current independent acceptance before importing", async () => {
		const f = fixture();
		f.revoke();
		expect(await f.run()).toEqual(denied("authority"));
		expect(f.deps.loadRuntime).not.toHaveBeenCalled();
	});

	it("snapshots and freezes the registry binding instead of trusting mutable aliases", async () => {
		const f = fixture();
		f.deps.isAccepted.mockImplementation((binding) => {
			expect(binding).not.toBe(f.binding);
			expect(Object.isFrozen(binding)).toBe(true);
			return true;
		});
		expect(await f.run()).toEqual({ status: "startup-completed" });
	});

	it("denies a loaded-origin mismatch before constructing state", async () => {
		const f = fixture();
		f.deps.verifyLoadedRuntime.mockReturnValue(false);
		expect(await f.run()).toEqual(denied("runtime"));
		expect(f.runtime.AuthStorage.inMemory).not.toHaveBeenCalled();
	});

	const conditions = ["expired", "authority", "cancelled", "rollback"] as const;
	it.each(conditions)("rechecks %s", async (condition) => {
		const f = fixture();
		const controller = new AbortController();
		f.deps.loadRuntime.mockImplementation(async () => {
			if (condition === "expired") f.setNow(f.binding.expiresAt);
			if (condition === "authority") f.revoke();
			if (condition === "cancelled") controller.abort();
			if (condition === "rollback") f.setNow(1_999);
			return f.runtime;
		});
		expect(await f.run(controller.signal)).toEqual(
			denied(condition === "rollback" ? "expired" : condition),
		);
		expect(f.runtime.AuthStorage.inMemory).not.toHaveBeenCalled();
	});

	it("does not claim a grant when already aborted", async () => {
		const f = fixture();
		const controller = new AbortController();
		controller.abort();
		expect(await f.run(controller.signal)).toEqual(denied("cancelled"));
		expect(f.deps.claimAcceptedCanary).not.toHaveBeenCalled();
	});

	const missingHandles = [
		"credentials",
		"settings",
		"session manager",
		"model runtime",
		"extension runtime",
	].flatMap((handle, index) =>
		[null, undefined].map((value) => ({ handle, index, value })),
	);
	it.each(missingHandles)("rejects $handle/$value", async (entry) => {
		const f = fixture();
		const factories = [
			f.runtime.AuthStorage.inMemory,
			f.runtime.SettingsManager.inMemory,
			f.runtime.SessionManager.inMemory,
			f.runtime.ModelRuntime.create,
			f.runtime.createExtensionRuntime,
		] as const;
		if (entry.index === 3) {
			factories[3].mockResolvedValue(entry.value as never);
		} else {
			factories[entry.index].mockReturnValue(entry.value as never);
		}
		expect(await f.run()).toEqual(denied("startup"));
		for (const next of factories.slice(entry.index + 1)) {
			expect(next).not.toHaveBeenCalled();
		}
		expect(f.runtime.createAgentSession).not.toHaveBeenCalled();
		expect(f.session.bindExtensions).not.toHaveBeenCalled();
		expect(f.session.dispose).not.toHaveBeenCalled();
		expect(f.forbidden).not.toHaveBeenCalled();
	});

	it("stops between synchronous constructors if acceptance is revoked", async () => {
		const f = fixture();
		f.runtime.AuthStorage.inMemory.mockImplementation(() => {
			f.revoke();
			return f.credentials;
		});
		expect(await f.run()).toEqual(denied("authority"));
		expect(f.runtime.SettingsManager.inMemory).not.toHaveBeenCalled();
	});

	it("disposes a session returned after cancellation, without binding extensions", async () => {
		const f = fixture();
		const controller = new AbortController();
		f.runtime.createAgentSession.mockImplementation(async () => {
			controller.abort();
			return { session: f.session, extensionsResult: f.extensionsResult };
		});
		expect(await f.run(controller.signal)).toEqual(denied("cancelled"));
		expect(f.session.bindExtensions).not.toHaveBeenCalled();
		expect(f.session.dispose).toHaveBeenCalledOnce();
	});

	const unexpectedStates = ["model", "tools", "extensions", "errors"] as const;
	it.each(unexpectedStates)("rejects unexpected %s", async (kind) => {
		const f = fixture();
		if (kind === "model") f.session.model = { provider: "ambient" };
		if (kind === "tools")
			f.session.getActiveToolNames.mockReturnValue(["bash"]);
		if (kind === "extensions")
			f.extensionsResult.extensions.push({ path: "ambient" });
		if (kind === "errors")
			f.extensionsResult.errors.push({ error: "discovery" });
		expect(await f.run()).toEqual(denied("startup"));
		expect(f.session.bindExtensions).not.toHaveBeenCalled();
		expect(f.session.dispose).toHaveBeenCalledOnce();
	});

	const expiryStages = ["model", "session", "bind", "dispose"] as const;
	it.each(expiryStages)("checks expiry after %s", async (stage) => {
		const f = fixture();
		const expire = () => f.setNow(f.binding.expiresAt);
		if (stage === "model") {
			f.runtime.ModelRuntime.create.mockImplementation(async () => {
				expire();
				return f.modelRuntime;
			});
		}
		if (stage === "session") {
			f.runtime.createAgentSession.mockImplementation(async () => {
				expire();
				return { session: f.session, extensionsResult: f.extensionsResult };
			});
		}
		if (stage === "bind") {
			f.session.bindExtensions.mockImplementation(async () => expire());
		}
		if (stage === "dispose") f.session.dispose.mockImplementation(expire);
		expect(await f.run()).toEqual(denied("expired"));
		if (stage === "model") {
			expect(f.runtime.createAgentSession).not.toHaveBeenCalled();
		} else {
			expect(f.session.dispose).toHaveBeenCalledOnce();
		}
	});

	const startupResults = ["complete", "denied"] as const;
	it.each(startupResults)("awaits delayed cleanup after %s", async (state) => {
		const f = fixture();
		if (state === "denied") f.session.model = "ambient";
		let finishCleanup = () => {};
		let markCleanupStarted = () => {};
		const cleanup = new Promise<void>((resolve) => {
			finishCleanup = resolve;
		});
		const started = new Promise<void>((resolve) => {
			markCleanupStarted = resolve;
		});
		f.session.dispose.mockImplementation(() => {
			markCleanupStarted();
			return cleanup;
		});
		const settled = vi.fn();
		const result = f.run();
		void result.then(settled);
		try {
			await started;
			await Promise.resolve();
			expect(settled).not.toHaveBeenCalled();
		} finally {
			finishCleanup();
		}
		expect(await result).toEqual(
			state === "complete"
				? { status: "startup-completed" }
				: denied("startup"),
		);
		expect(f.session.dispose).toHaveBeenCalledOnce();
	});

	it("redacts asynchronous cleanup rejection", async () => {
		const f = fixture();
		f.session.dispose.mockImplementation(async () => {
			await Promise.resolve();
			throw new Error("fixture-private-cleanup");
		});
		const result = await f.run();
		expect(result).toEqual(denied("cleanup"));
		expect(JSON.stringify(result)).not.toContain("fixture-private-cleanup");
		expect(f.session.dispose).toHaveBeenCalledOnce();
	});

	const cleanupChanges = ["expired", "cancelled", "revoked"] as const;
	it.each(cleanupChanges)("checks %s after async cleanup", async (change) => {
		const f = fixture();
		const controller = new AbortController();
		f.session.dispose.mockImplementation(async () => {
			await Promise.resolve();
			if (change === "expired") f.setNow(f.binding.expiresAt);
			if (change === "cancelled") controller.abort();
			if (change === "revoked") f.revoke();
		});
		expect(await f.run(controller.signal)).toEqual(
			denied(change === "revoked" ? "authority" : change),
		);
		expect(f.session.dispose).toHaveBeenCalledOnce();
	});

	it("rejects a throwing clock before import with a redacted denial", async () => {
		const f = fixture();
		f.deps.now.mockImplementation(() => {
			throw new Error("fixture-private-clock");
		});
		expect(await f.run()).toEqual(denied("expired"));
		expect(f.deps.loadRuntime).not.toHaveBeenCalled();
	});

	it("checks authority callback expiry before import", async () => {
		const f = fixture();
		f.deps.isAccepted.mockImplementation(() => {
			f.setNow(f.binding.expiresAt);
			return true;
		});
		expect(await f.run()).toEqual(denied("expired"));
		expect(f.deps.loadRuntime).not.toHaveBeenCalled();
	});

	it("requires literal true from independent acceptance", async () => {
		const f = fixture();
		f.deps.isAccepted.mockReturnValue("true" as never);
		expect(await f.run()).toEqual(denied("authority"));
		expect(f.deps.loadRuntime).not.toHaveBeenCalled();
	});

	it("rechecks tool and model state after lifecycle binding", async () => {
		const f = fixture();
		f.session.bindExtensions.mockImplementation(async () => {
			f.session.model = "ambient";
		});
		expect(await f.run()).toEqual(denied("startup"));
		expect(f.session.dispose).toHaveBeenCalledOnce();
	});

	const failureStages = [
		"claim",
		"import",
		"model",
		"session",
		"bind",
		"dispose",
	] as const;
	it.each(failureStages)("redacts %s without fallback", async (stage) => {
		const f = fixture();
		const secretError = () => {
			throw new Error("fixture-secret-must-not-escape");
		};
		if (stage === "claim")
			f.deps.claimAcceptedCanary.mockImplementation(secretError);
		if (stage === "import") f.deps.loadRuntime.mockImplementation(secretError);
		if (stage === "model")
			f.runtime.ModelRuntime.create.mockImplementation(secretError);
		if (stage === "session")
			f.runtime.createAgentSession.mockImplementation(secretError);
		if (stage === "bind")
			f.session.bindExtensions.mockImplementation(secretError);
		if (stage === "dispose") f.session.dispose.mockImplementation(secretError);
		const result = await f.run();
		const reason =
			stage === "claim"
				? "authority"
				: stage === "import"
					? "runtime"
					: stage === "dispose"
						? "cleanup"
						: "startup";
		expect(result).toEqual(denied(reason));
		expect(JSON.stringify(result)).not.toContain("fixture-secret");
		if (stage === "bind" || stage === "dispose")
			expect(f.session.dispose).toHaveBeenCalledOnce();
		expect(f.forbidden).not.toHaveBeenCalled();
	});
});
