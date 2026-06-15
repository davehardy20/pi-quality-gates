import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, type Mock, vi } from "vitest";
import {
	createReviewerOrchestrator,
	type ReviewerOrchestratorDeps,
} from "../src/reviewer/orchestrator.js";
import type { ReviewConfig, ReviewReport } from "../src/reviewer/types.js";
import { DEFAULT_REVIEW_CONFIG } from "../src/reviewer/types.js";

type MockMessage = {
	customType: string;
	content: string;
	display?: boolean;
	details?: Record<string, unknown>;
};

type MockContext = {
	cwd: string;
	hasUI: boolean;
	isIdle: () => boolean;
	modelRegistry?: {
		getAvailable: () => Array<{ provider: string; id: string; name: string }>;
	};
	sessionManager: {
		getBranch: () => unknown[];
		getSessionFile: () => string;
	};
	ui: {
		notify: (msg: string, level: string) => void;
		setStatus: (id: string, text: string) => void;
	};
};

function createMockPi() {
	const messages: MockMessage[] = [];
	const userMessages: string[] = [];
	const handlers = new Map<
		string,
		(event: unknown, ctx: MockContext) => Promise<void> | void
	>();
	const commands = new Map<
		string,
		(args: string | undefined, ctx: MockContext) => Promise<void> | void
	>();

	return {
		on: (
			event: string,
			handler: (event: unknown, ctx: MockContext) => Promise<void> | void,
		) => {
			handlers.set(event, handler);
		},
		registerCommand: (
			name: string,
			command: {
				handler: (
					args: string | undefined,
					ctx: MockContext,
				) => Promise<void> | void;
			},
		) => {
			commands.set(name, command.handler);
		},
		sendMessage: (message: MockMessage) => {
			messages.push(message);
		},
		sendUserMessage: (message: string) => {
			userMessages.push(message);
		},
		appendEntry: (_type: string, _details: unknown) => undefined,
		handlers,
		commands,
		messages,
		userMessages,
	};
}

function createMockContext(
	overrides: Partial<MockContext> = {},
): ExtensionContext {
	return {
		cwd: "/repo",
		hasUI: false,
		isIdle: () => true,
		sessionManager: {
			getBranch: () => [],
			getSessionFile: () => "/tmp/session.jsonl",
		},
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
		...overrides,
	} as unknown as ExtensionContext;
}

function createFakeDeps(
	overrides: { loadConfig?: ReviewConfig; runReview?: ReviewReport } = {},
): ReviewerOrchestratorDeps {
	const config = overrides.loadConfig ?? {
		...DEFAULT_REVIEW_CONFIG,
		reviewDelayMs: 0,
	};
	return {
		loadConfig: vi.fn(async () => ({ ...config })),
		loadSkipFilter: vi.fn(() => ({
			loaded: false,
			patternCount: 0,
			ig: { ignores: () => false, filter: (p: string[]) => p },
		})),
		countDiffLines: vi.fn(async () => 10),
		runReview: vi.fn(async () => ({
			report: overrides.runReview ?? null,
			rawOutput: "",
			exitCode: 0,
			timedOut: false,
			stderr: "",
			command: "pi --mode json",
		})),
		writeSidecar: vi.fn(async () => ({
			ok: true,
			metadata: {
				id: "sidecar-1",
				toolName: "post-turn-reviewer" as const,
				sessionId: "session-1",
				path: "/tmp/sidecar-1.json",
				createdAt: "2026-06-15T00:00:00.000Z",
				originalChars: 100,
				originalBytes: 100,
				redactedChars: 90,
				redactedBytes: 90,
				originalSha256: "a",
				redactedSha256: "b",
				summaryMode: "post-turn-reviewer-summary" as const,
			},
		})),
		getSystemPrompt: vi.fn(() => "system prompt"),
		getTaskPrompt: vi.fn(() => "task prompt"),
		getPromptsDir: vi.fn(() => "/prompts"),
	} as unknown as ReviewerOrchestratorDeps;
}

function passReport(): ReviewReport {
	return {
		status: "PASS",
		confidence: "HIGH",
		findings: [],
		verified: ["Build compiles"],
		unverifiable: [],
		summary: "Looks good.",
	};
}

function issuesReport(): ReviewReport {
	return {
		status: "ISSUES",
		confidence: "MEDIUM",
		findings: [
			{
				severity: "CRITICAL",
				title: "Missing null check",
				file: "src/index.ts",
				line: 42,
				domain: "correctness",
				rule: "null-check",
				issue: "Variable may be null",
				evidence: "const x = foo()",
				suggestion: "Add a null check",
			},
		],
		verified: [],
		unverifiable: [],
		summary: "One critical issue.",
	};
}

describe("ReviewerOrchestrator", () => {
	it("initializes with default config and loads skip filter", async () => {
		const pi = createMockPi();
		const deps = createFakeDeps();
		const orchestrator = createReviewerOrchestrator(pi as never, deps);
		const ctx = createMockContext();

		await orchestrator.initialize(ctx);

		const snapshot = orchestrator.getStateSnapshot();
		expect(snapshot.phase).toBe("IDLE");
		expect(snapshot.config.enabled).toBe(true);
		expect(deps.loadConfig).toHaveBeenCalledWith("/repo");
		expect(deps.loadSkipFilter).toHaveBeenCalledWith(
			"/repo",
			".pi/reviewer.skip",
		);
	});

	it("triggers a review when linter goes clean and files are pending", async () => {
		const pi = createMockPi();
		const deps = createFakeDeps({ runReview: passReport() });
		const orchestrator = createReviewerOrchestrator(pi as never, deps);
		const ctx = createMockContext({
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: { role: "user", content: "Do the thing" },
					},
				],
				getSessionFile: () => "/tmp/session.jsonl",
			},
		});

		await orchestrator.initialize(ctx);
		orchestrator.onLinterClean(["src/a.ts"]);
		await orchestrator.onTurnEnd(ctx);

		expect(deps.runReview).toHaveBeenCalledWith(
			expect.any(String),
			["src/a.ts"],
			"/repo",
			expect.objectContaining({ enabled: true }),
			expect.any(Object),
		);
		expect(orchestrator.getStateSnapshot().phase).toBe("IDLE");
	});

	it("skips review when disabled", async () => {
		const pi = createMockPi();
		const deps = createFakeDeps({
			loadConfig: { ...DEFAULT_REVIEW_CONFIG, enabled: false },
		});
		const orchestrator = createReviewerOrchestrator(pi as never, deps);
		const ctx = createMockContext();

		await orchestrator.initialize(ctx);
		orchestrator.onLinterClean(["src/a.ts"]);
		await orchestrator.onTurnEnd(ctx);

		expect(deps.runReview).not.toHaveBeenCalled();
	});

	it("requests a review manually with provided files", async () => {
		const pi = createMockPi();
		const deps = createFakeDeps({ runReview: passReport() });
		const orchestrator = createReviewerOrchestrator(pi as never, deps);
		const ctx = createMockContext({
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: { role: "user", content: "Do the thing" },
					},
				],
				getSessionFile: () => "/tmp/session.jsonl",
			},
		});

		await orchestrator.initialize(ctx);
		await orchestrator.requestReview(ctx, { files: ["src/b.ts"] });

		expect(deps.runReview).toHaveBeenCalledWith(
			expect.any(String),
			["src/b.ts"],
			"/repo",
			expect.any(Object),
			expect.any(Object),
		);
	});

	it("sends findings message and requests fix turn for actionable report", async () => {
		const pi = createMockPi();
		const deps = createFakeDeps({ runReview: issuesReport() });
		const orchestrator = createReviewerOrchestrator(pi as never, deps);
		const ctx = createMockContext({
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: { role: "user", content: "Do the thing" },
					},
				],
				getSessionFile: () => "/tmp/session.jsonl",
			},
		});

		await orchestrator.initialize(ctx);
		orchestrator.onLinterClean(["src/index.ts"]);
		await orchestrator.onTurnEnd(ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(
			pi.messages.some((m) => m.customType === "post-turn-reviewer-findings"),
		).toBe(true);
		expect(pi.userMessages.length).toBeGreaterThan(0);
		expect(pi.userMessages[0]).toContain("src/index.ts");
		expect(orchestrator.getStateSnapshot().phase).toBe("FIX_REQUESTED");
	});

	it("status command reports current phase", async () => {
		const pi = createMockPi();
		const deps = createFakeDeps();
		const orchestrator = createReviewerOrchestrator(pi as never, deps);
		const ctx = createMockContext({ hasUI: true });

		await orchestrator.initialize(ctx);
		orchestrator.registerCommands(pi as never);
		await pi.commands.get("reviewer-status")?.(
			"",
			ctx as unknown as MockContext,
		);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Phase: IDLE"),
			"info",
		);
	});

	it("toggle command disables and resets to IDLE", async () => {
		const pi = createMockPi();
		const deps = createFakeDeps();
		const orchestrator = createReviewerOrchestrator(pi as never, deps);
		const ctx = createMockContext({ hasUI: true });

		await orchestrator.initialize(ctx);
		orchestrator.registerCommands(pi as never);
		await pi.commands.get("reviewer-toggle")?.(
			"off",
			ctx as unknown as MockContext,
		);

		expect(orchestrator.getStateSnapshot().config.enabled).toBe(false);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("disabled"),
			"info",
		);
	});

	it("model command updates config through the orchestrator", async () => {
		const pi = createMockPi();
		const deps = createFakeDeps();
		const orchestrator = createReviewerOrchestrator(pi as never, deps);
		const ctx = createMockContext();

		await orchestrator.initialize(ctx);
		orchestrator.updateConfig((config) => ({
			...config,
			model: "openai/gpt-4o",
		}));

		expect(orchestrator.getStateSnapshot().config.model).toBe("openai/gpt-4o");
	});

	it("resets state on shutdown", async () => {
		const pi = createMockPi();
		const deps = createFakeDeps();
		const orchestrator = createReviewerOrchestrator(pi as never, deps);
		const ctx = createMockContext();

		await orchestrator.initialize(ctx);
		orchestrator.onLinterClean(["src/a.ts"]);
		await orchestrator.shutdown(ctx);

		expect(orchestrator.getStateSnapshot().linterClean).toBe(false);
		expect(orchestrator.getStateSnapshot().pendingFiles).toEqual([]);
	});

	it("does not run concurrent reviews when already reviewing", async () => {
		const pi = createMockPi();
		const deps = createFakeDeps({ runReview: passReport() });
		const orchestrator = createReviewerOrchestrator(pi as never, deps);
		const ctx = createMockContext({
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: { role: "user", content: "Do the thing" },
					},
				],
				getSessionFile: () => "/tmp/session.jsonl",
			},
		});

		await orchestrator.initialize(ctx);
		orchestrator.onLinterClean(["src/a.ts"]);
		const first = orchestrator.onTurnEnd(ctx);
		orchestrator.onLinterClean(["src/b.ts"]);
		const second = orchestrator.onTurnEnd(ctx);
		await Promise.all([first, second]);

		expect(deps.runReview).toHaveBeenCalledTimes(1);
	});

	it("cancels a pending delayed review when disabled", async () => {
		vi.useFakeTimers();
		const pi = createMockPi();
		const deps = createFakeDeps({
			loadConfig: { ...DEFAULT_REVIEW_CONFIG, reviewDelayMs: 100 },
			runReview: passReport(),
		});
		const orchestrator = createReviewerOrchestrator(pi as never, deps);
		const ctx = createMockContext({
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: { role: "user", content: "Do the thing" },
					},
				],
				getSessionFile: () => "/tmp/session.jsonl",
			},
		});

		await orchestrator.initialize(ctx);
		orchestrator.onLinterClean(["src/a.ts"]);
		const turnEndPromise = orchestrator.onTurnEnd(ctx);
		await vi.advanceTimersByTimeAsync(50);
		expect(deps.runReview).not.toHaveBeenCalled();

		orchestrator.registerCommands(pi as never);
		await pi.commands.get("reviewer-toggle")?.(
			"off",
			ctx as unknown as MockContext,
		);
		await vi.advanceTimersByTimeAsync(200);
		await turnEndPromise;

		expect(deps.runReview).not.toHaveBeenCalled();
		expect(orchestrator.getStateSnapshot().phase).toBe("IDLE");
		vi.useRealTimers();
	});

	it("refreshes pending files during the review debounce window", async () => {
		vi.useFakeTimers();
		try {
			const pi = createMockPi();
			const deps = createFakeDeps({
				loadConfig: { ...DEFAULT_REVIEW_CONFIG, reviewDelayMs: 100 },
				runReview: passReport(),
			});
			const orchestrator = createReviewerOrchestrator(pi as never, deps);
			const branch: unknown[] = [
				{
					type: "message",
					message: { role: "user", content: "First task" },
				},
				{
					type: "custom_message",
					customType: "post-turn-linter-status",
					details: { status: "clean", files: ["src/a.ts"], timestamp: 1 },
				},
			];
			const ctx = createMockContext({
				sessionManager: {
					getBranch: () => branch,
					getSessionFile: () => "/tmp/session.jsonl",
				},
			});

			await orchestrator.initialize(ctx);
			await orchestrator.onTurnEnd(ctx);
			await vi.advanceTimersByTimeAsync(50);

			branch.push(
				{
					type: "message",
					message: { role: "user", content: "Second task" },
				},
				{
					type: "custom_message",
					customType: "post-turn-linter-status",
					details: { status: "clean", files: ["src/b.ts"], timestamp: 2 },
				},
			);
			await orchestrator.onTurnEnd(ctx);
			await vi.advanceTimersByTimeAsync(100);

			expect(deps.runReview).toHaveBeenCalledTimes(1);
			expect(deps.runReview).toHaveBeenCalledWith(
				"Second task",
				["src/b.ts"],
				"/repo",
				expect.any(Object),
				expect.any(Object),
			);
			expect(orchestrator.getStateSnapshot().phase).toBe("IDLE");
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not run a manual review when no files are available", async () => {
		const pi = createMockPi();
		const deps = createFakeDeps({ runReview: passReport() });
		const orchestrator = createReviewerOrchestrator(pi as never, deps);
		const ctx = createMockContext({ hasUI: true });

		await orchestrator.initialize(ctx);
		orchestrator.registerCommands(pi as never);
		await pi.commands.get("reviewer-run")?.("", ctx as unknown as MockContext);

		expect(deps.runReview).not.toHaveBeenCalled();
		expect(orchestrator.getStateSnapshot().phase).toBe("IDLE");
		expect(
			(ctx.ui.notify as Mock).mock.calls.some((call) =>
				(call[0] as string).includes("No files to review"),
			),
		).toBe(true);
	});

	it("stays in RE_REVIEWING while a re-review is pending", async () => {
		const pi = createMockPi();
		const deps = createFakeDeps({ runReview: issuesReport() });
		const orchestrator = createReviewerOrchestrator(pi as never, deps);
		const ctx = createMockContext({
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: { role: "user", content: "Do the thing" },
					},
				],
				getSessionFile: () => "/tmp/session.jsonl",
			},
		});

		await orchestrator.initialize(ctx);
		orchestrator.onLinterClean(["src/a.ts"]);
		await orchestrator.onTurnEnd(ctx);
		expect(orchestrator.getStateSnapshot().phase).toBe("FIX_REQUESTED");

		let resolveRun: (
			value: Awaited<ReturnType<typeof deps.runReview>>,
		) => void = () => undefined;
		(deps.runReview as Mock).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveRun = resolve;
				}) as ReturnType<typeof deps.runReview>,
		);

		orchestrator.onLinterClean(["src/a.ts"]);
		const reReview = orchestrator.onTurnEnd(ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(orchestrator.getStateSnapshot().phase).toBe("RE_REVIEWING");

		resolveRun({
			report: passReport(),
			rawOutput: "",
			exitCode: 0,
			timedOut: false,
			stderr: "",
			command: "pi --mode json",
		});
		await reReview;

		expect(orchestrator.getStateSnapshot().phase).toBe("IDLE");
	});

	it("guards concurrent direct requestReview calls", async () => {
		const pi = createMockPi();
		const deps = createFakeDeps({ runReview: passReport() });
		const orchestrator = createReviewerOrchestrator(pi as never, deps);
		const ctx = createMockContext({
			hasUI: true,
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: { role: "user", content: "Do the thing" },
					},
				],
				getSessionFile: () => "/tmp/session.jsonl",
			},
		});

		await orchestrator.initialize(ctx);

		let resolveRun: (
			value: Awaited<ReturnType<typeof deps.runReview>>,
		) => void = () => undefined;
		(deps.runReview as Mock).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveRun = resolve;
				}) as ReturnType<typeof deps.runReview>,
		);

		const first = orchestrator.requestReview(ctx, { files: ["src/a.ts"] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = orchestrator.requestReview(ctx, { files: ["src/b.ts"] });
		expect(
			(ctx.ui.notify as Mock).mock.calls.some((call) =>
				(call[0] as string).includes("Reviewer busy"),
			),
		).toBe(true);

		resolveRun({
			report: passReport(),
			rawOutput: "",
			exitCode: 0,
			timedOut: false,
			stderr: "",
			command: "pi --mode json",
		});
		await first;
		await second;

		expect(deps.runReview).toHaveBeenCalledTimes(1);
		expect(deps.runReview).toHaveBeenCalledWith(
			expect.any(String),
			["src/a.ts"],
			"/repo",
			expect.any(Object),
			expect.any(Object),
		);
	});
});
