import { describe, expect, it, vi } from "vitest";
import {
	type ClosedReviewerRuntime,
	type ClosedReviewerSessionOptions,
	createClosedReviewerSession,
} from "../src/pr-gate/reviewer-closed-session.js";

function fixture() {
	let options: ClosedReviewerSessionOptions | undefined;
	let active = ["read", "run_vitest"];
	const session = {
		getActiveToolNames: () => active,
		bindExtensions: vi.fn(async () => {}),
		prompt: vi.fn(async (_task: string) => {}),
		subscribe: vi.fn((_listener: (event: unknown) => void) => () => {}),
		abort: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
	};
	const runtime: ClosedReviewerRuntime = {
		SettingsManager: { inMemory: vi.fn(() => ({ kind: "memory-settings" })) },
		SessionManager: { inMemory: vi.fn(() => ({ kind: "memory-session" })) },
		createExtensionRuntime: vi.fn(() => ({ kind: "empty-extensions" })),
		createAgentSession: vi.fn(async (input) => {
			options = input;
			return {
				session,
				extensionsResult: input.resourceLoader.getExtensions(),
			};
		}),
	};
	const guard = vi.fn(() => {});
	const input = {
		cwd: "/fixed-workspace",
		agentDir: "/fixed-owned-reviewer-temp",
		model: { provider: "fixture", id: "fixed-model" },
		modelRuntime: { kind: "explicit-model-runtime" },
		systemPrompt: "fixed reviewer system prompt",
		tools: ["read", "run_vitest"],
		customTools: [{ name: "run_vitest", execute: async () => ({}) }],
		guard,
	};
	return {
		runtime,
		input,
		guard,
		session,
		options: () => {
			if (!options) throw new Error("Fixture session not created");
			return options;
		},
		setActive: (names: string[]) => {
			active = names;
		},
	};
}

describe("closed host reviewer SDK session", () => {
	it("supplies every discovery/storage boundary explicitly without CLI startup", async () => {
		const f = fixture();
		const reviewer = await createClosedReviewerSession(f.runtime, f.input);
		const options = f.options();
		expect(options).toMatchObject({
			cwd: f.input.cwd,
			agentDir: f.input.agentDir,
			model: f.input.model,
			modelRuntime: f.input.modelRuntime,
			settingsManager: { kind: "memory-settings" },
			sessionManager: { kind: "memory-session" },
			noTools: "all",
			tools: ["read", "run_vitest"],
			thinkingLevel: "medium",
		});
		expect(f.runtime.SessionManager.inMemory).toHaveBeenCalledWith(f.input.cwd);
		expect(f.runtime.SettingsManager.inMemory).toHaveBeenCalledWith({
			compaction: { enabled: false },
			retry: { enabled: false },
			images: { blockImages: true },
			cacheWarming: "off",
		});
		expect(f.session.bindExtensions).toHaveBeenCalledWith({ mode: "json" });
		expect(f.session.prompt).not.toHaveBeenCalled();
		await reviewer.dispose();
	});

	it("has no discovered global or project resources and refuses resource expansion", async () => {
		const f = fixture();
		const reviewer = await createClosedReviewerSession(f.runtime, f.input);
		const loader = f.options().resourceLoader;
		expect(loader.getExtensions()).toEqual({
			extensions: [],
			errors: [],
			runtime: { kind: "empty-extensions" },
		});
		expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
		expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
		expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] });
		expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
		expect(loader.getSystemPrompt()).toBe(f.input.systemPrompt);
		expect(loader.getAppendSystemPrompt()).toEqual([]);
		expect(() => loader.extendResources({ extensions: ["/global"] })).toThrow();
		await expect(loader.reload()).rejects.toThrow();
		await expect(reviewer.prompt("fixed task")).rejects.toThrow();
		expect(f.session.prompt).not.toHaveBeenCalled();
		await reviewer.dispose();
	});

	it("retains a fixed context redactor but rejects lifecycle or command registration", async () => {
		const context = vi.fn(() => undefined);
		const policy = {
			path: "/fixed-redaction-policy",
			resolvedPath: "/fixed-redaction-policy",
			sourceInfo: {},
			handlers: new Map([["context", [context]]]),
			tools: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
			messageRenderers: new Map(),
		};
		const f = fixture();
		const reviewer = await createClosedReviewerSession(f.runtime, {
			...f.input,
			contextPolicies: [policy],
		});
		const captured = f.options().resourceLoader.getExtensions().extensions;
		expect(captured).toHaveLength(1);
		expect(context).not.toHaveBeenCalled();
		await reviewer.dispose();
		for (const event of [
			"session_start",
			"session_shutdown",
			"before_agent_start",
		]) {
			const g = fixture();
			await expect(
				createClosedReviewerSession(g.runtime, {
					...g.input,
					contextPolicies: [
						{ ...policy, handlers: new Map([[event, [context]]]) },
					],
				}),
			).rejects.toThrow();
			expect(g.runtime.createAgentSession).not.toHaveBeenCalled();
		}
		const g = fixture();
		await expect(
			createClosedReviewerSession(g.runtime, {
				...g.input,
				contextPolicies: [{ ...policy, commands: new Map([["unsafe", {}]]) }],
			}),
		).rejects.toThrow();
		expect(g.runtime.createAgentSession).not.toHaveBeenCalled();
	});

	it("copies tool definitions and keeps widening a permanent failure", async () => {
		const f = fixture();
		const original = f.input.customTools[0].execute;
		const reviewer = await createClosedReviewerSession(f.runtime, f.input);
		f.input.customTools[0].execute = async () => ({ changed: true });
		f.input.tools.push("write");
		expect(f.options().customTools[0].execute).toBe(original);
		expect(f.options().tools).toEqual(["read", "run_vitest"]);
		f.setActive(["read", "run_vitest", "bash"]);
		expect(() => reviewer.subscribe(() => {})).toThrow();
		f.setActive(["read", "run_vitest"]);
		await expect(reviewer.prompt("fixed task")).rejects.toThrow();
		await reviewer.dispose();
	});

	it("snapshots the tool allowlist and refuses mutations, wildcards and hidden custom tools", async () => {
		for (const name of ["bash", "edit", "write", "git_safe", "*", "+read"]) {
			const f = fixture();
			await expect(
				createClosedReviewerSession(f.runtime, {
					...f.input,
					tools: [...f.input.tools, name],
				}),
			).rejects.toThrow("Closed reviewer startup refused.");
			expect(f.runtime.createAgentSession).not.toHaveBeenCalled();
		}
		const f = fixture();
		await expect(
			createClosedReviewerSession(f.runtime, {
				...f.input,
				customTools: [{ name: "git_safe", execute: async () => ({}) }],
			}),
		).rejects.toThrow("Closed reviewer startup refused.");
		expect(f.runtime.createAgentSession).not.toHaveBeenCalled();
	});

	it("refuses SDK extension injection and awaits disposal before reporting failure", async () => {
		const f = fixture();
		f.runtime.createAgentSession = vi.fn(async () => ({
			session: f.session,
			extensionsResult: { extensions: [{ path: "/global" }], errors: [] },
		}));
		await expect(
			createClosedReviewerSession(f.runtime, f.input),
		).rejects.toThrow("Closed reviewer startup refused.");
		expect(f.session.bindExtensions).not.toHaveBeenCalled();
		expect(f.session.dispose).toHaveBeenCalledOnce();
	});

	it("refuses tool widening or missing required tools before and after binding", async () => {
		for (const active of [["read", "run_vitest", "write"], ["read"]]) {
			const f = fixture();
			f.setActive(active);
			await expect(
				createClosedReviewerSession(f.runtime, f.input),
			).rejects.toThrow();
			expect(f.session.dispose).toHaveBeenCalledOnce();
		}
		const f = fixture();
		f.session.bindExtensions = vi.fn(async () => {
			f.setActive(["read", "run_vitest", "bash"]);
		});
		await expect(
			createClosedReviewerSession(f.runtime, f.input),
		).rejects.toThrow();
		expect(f.session.dispose).toHaveBeenCalledOnce();
	});

	it("checks the guard before SDK effects and never turns approval callbacks into authority", async () => {
		const f = fixture();
		f.guard.mockImplementation(() => {
			throw new Error("fixed private diagnostic");
		});
		await expect(
			createClosedReviewerSession(f.runtime, f.input),
		).rejects.toThrow(/^Closed reviewer startup refused\.$/);
		expect(f.runtime.SettingsManager.inMemory).not.toHaveBeenCalled();
		expect(f.runtime.createAgentSession).not.toHaveBeenCalled();
	});

	it("does not start an already cancelled request and aborts an active session", async () => {
		const cancelled = new AbortController();
		cancelled.abort();
		const f = fixture();
		await expect(
			createClosedReviewerSession(f.runtime, {
				...f.input,
				signal: cancelled.signal,
			}),
		).rejects.toThrow();
		expect(f.runtime.createAgentSession).not.toHaveBeenCalled();
		const active = new AbortController();
		const g = fixture();
		const reviewer = await createClosedReviewerSession(g.runtime, {
			...g.input,
			signal: active.signal,
		});
		active.abort();
		expect(g.session.abort).toHaveBeenCalledOnce();
		await expect(reviewer.prompt("fixed task")).rejects.toThrow();
		await reviewer.dispose();
	});

	it("keeps SDK controls private and disposes exactly once", async () => {
		const f = fixture();
		const reviewer = await createClosedReviewerSession(f.runtime, f.input);
		expect(Object.keys(reviewer).sort()).toEqual([
			"dispose",
			"prompt",
			"subscribe",
		]);
		await reviewer.prompt("fixed task");
		expect(f.session.prompt).toHaveBeenCalledWith("fixed task");
		await Promise.all([reviewer.dispose(), reviewer.dispose()]);
		expect(f.session.dispose).toHaveBeenCalledOnce();
		await expect(reviewer.prompt("fixed task")).rejects.toThrow();
	});
});
