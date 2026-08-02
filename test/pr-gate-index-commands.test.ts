import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import prGateExtension from "../src/pr-gate/index.js";

interface RegisteredCommand {
	description: string;
	handler: (
		args: string | undefined,
		ctx: ExtensionContext,
	) => Promise<void> | void;
}

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<unknown>;
}

interface SentMessage {
	customType?: string;
	content?: string;
	details?: Record<string, unknown>;
	display?: boolean;
}

function createMockPi(): {
	pi: ExtensionAPI;
	commands: Map<string, RegisteredCommand>;
	tools: Map<string, RegisteredTool>;
	messages: SentMessage[];
	activeTools: string[];
	handlers: Map<string, (...args: unknown[]) => unknown>;
} {
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Map<string, RegisteredTool>();
	const messages: SentMessage[] = [];
	const activeTools = ["orchestrate"];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const on = vi.fn(
		(event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, handler);
		},
	);

	const pi = {
		registerCommand: (name: string, command: RegisteredCommand) => {
			commands.set(name, command);
		},
		registerTool: (tool: RegisteredTool) => {
			tools.set(tool.name, tool);
		},
		getActiveTools: () => activeTools,
		sendMessage: (message: SentMessage) => {
			messages.push(message);
		},
		on,
	} as unknown as ExtensionAPI;

	return { pi, commands, tools, messages, activeTools, handlers };
}

function createMockContext(
	setStatus?: ReturnType<typeof vi.fn>,
	branch: unknown[] = [],
): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: Boolean(setStatus),
		ui: { setStatus: setStatus ?? vi.fn() },
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;
}

describe("pr-gate command registration", () => {
	it("registers /pr-review-status as a real status command", async () => {
		const { pi, commands, messages } = createMockPi();
		prGateExtension(pi);

		const command = commands.get("pr-review-status");
		expect(command).toBeDefined();

		await command?.handler("", createMockContext());

		expect(messages.at(-1)?.customType).toBe("pr-review-status");
		expect(messages.at(-1)?.content).toContain("HEAD has PASS");
	});

	it("does not register the retired turn_end auto-review trigger", () => {
		const { pi } = createMockPi();
		prGateExtension(pi);

		expect(pi.on).not.toHaveBeenCalledWith("turn_end", expect.any(Function));
	});

	it("registers the agent-callable pr_review custom tool over the shared coordinator", () => {
		const { pi, tools } = createMockPi();
		prGateExtension(pi);

		const tool = tools.get("pr_review");
		expect(tool).toBeDefined();
		expect(tool?.name).toBe("pr_review");
		expect(tool?.promptSnippet).toContain("pr_review");
		expect(tool?.promptGuidelines?.length).toBeGreaterThan(0);
		expect(typeof tool?.execute).toBe("function");
	});

	it("/pr-review and pr_review share one coordinator (command kickoff then tool in-progress)", async () => {
		const { pi, commands, tools } = createMockPi();
		let resolveDispatch: (value: unknown) => void = () => {};
		const dispatch = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveDispatch = resolve;
				}),
		);
		prGateExtension(pi, {
			resolveHeadSha: () => "shared HEAD",
			createPrReviewDispatch: () => ({ dispatch }) as never,
		});

		const command = commands.get("pr-review");
		expect(command).toBeDefined();
		await command?.handler("", createMockContext());
		expect(dispatch).toHaveBeenCalledTimes(1);

		// The tool must observe the SAME in-progress guard: a tool kickoff now
		// reports in-progress rather than starting a second review.
		const tool = tools.get("pr_review");
		const execResult = (await tool?.execute(
			"t1",
			{},
			undefined,
			undefined,
			createMockContext(),
		)) as {
			details: { status: string };
		};
		expect(execResult.details.status).toBe("in-progress");
		expect(dispatch).toHaveBeenCalledTimes(1);

		resolveDispatch({
			report: null,
			stamped: true,
			escalated: false,
			blocked: false,
			message: "ok",
		});
		await new Promise((r) => setTimeout(r, 0));
	});

	it("treats /pr-review status as a status alias, not a base ref", async () => {
		const { pi, commands, messages } = createMockPi();
		prGateExtension(pi);

		const command = commands.get("pr-review");
		expect(command).toBeDefined();

		await command?.handler("status", createMockContext());

		expect(messages.at(-1)?.customType).toBe("pr-review-status");
		expect(messages.at(-1)?.content).toContain("PR gate enabled");
		expect(messages.at(-1)?.content).not.toContain("git diff");
	});

	it("starts /pr-review in the background and updates UI status", async () => {
		const { pi, commands, messages } = createMockPi();
		const setStatus = vi.fn();
		let resolveDispatch: (value: unknown) => void = () => {};
		const dispatch = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveDispatch = resolve;
				}),
		);

		prGateExtension(pi, {
			resolveHeadSha: () => "abc123 HEAD_SHA_FIXTURE",
			createPrReviewDispatch: () => ({ dispatch }) as never,
		});

		const command = commands.get("pr-review");
		expect(command).toBeDefined();

		await command?.handler("", createMockContext(setStatus));

		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(messages.at(-1)?.customType).toBe("pr-review-status");
		expect(messages.at(-1)?.content).toContain("PR review started");
		expect(setStatus).toHaveBeenCalledWith(
			"pr-review",
			expect.stringContaining("running"),
		);

		resolveDispatch({
			report: null,
			stamped: false,
			escalated: false,
			blocked: true,
			message: "done",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(messages.at(-1)?.content).toBe("done");
		expect(setStatus).toHaveBeenLastCalledWith(
			"pr-review",
			expect.stringContaining("blocked"),
		);
	});

	it("does not start a review when the linter is not clean", async () => {
		const { pi, commands, messages } = createMockPi();
		const setStatus = vi.fn();
		const dispatch = vi.fn();

		prGateExtension(pi, {
			createPrReviewDispatch: () => ({ dispatch }) as never,
		});

		const command = commands.get("pr-review");
		expect(command).toBeDefined();

		const branch = [
			{
				type: "custom_message",
				customType: "post-turn-linter-status",
				details: { status: "findings" },
			},
		];
		await command?.handler("", createMockContext(setStatus, branch));

		expect(dispatch).not.toHaveBeenCalled();
		expect(messages.at(-1)?.customType).toBe("pr-review-status");
		expect(messages.at(-1)?.content).toContain("linter is not clean");
		expect(messages.some((m) => m.content?.includes("PR review started"))).toBe(
			false,
		);
	});
});

describe("pr-gate session shutdown", () => {
	it("registers cleanup and suppresses late review completion delivery", async () => {
		const { pi, commands, messages, handlers } = createMockPi();
		let resolveDispatch: (value: unknown) => void = () => {};
		const dispatch = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveDispatch = resolve;
				}),
		);
		prGateExtension(pi, {
			resolveHeadSha: () => "shutdown-head",
			createPrReviewDispatch: () => ({ dispatch }) as never,
		});
		await commands.get("pr-review")?.handler("", createMockContext());
		expect(dispatch).toHaveBeenCalledTimes(1);
		const messageCountBeforeShutdown = messages.length;

		await handlers.get("session_shutdown")?.();
		resolveDispatch({
			report: null,
			stamped: false,
			escalated: false,
			blocked: true,
			message: "late completion must not be delivered",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(messages).toHaveLength(messageCountBeforeShutdown);
		expect(messages.some((m) => m.content?.includes("late completion"))).toBe(
			false,
		);
	});
});

describe("pr-gate reviewer bridge selection", () => {
	// The host bridge spawns a headless child Pi directly and returns its report;
	// it never routes through `orchestrate`, so it registers no tool_result
	// handler. The orchestrator bridge (container) is opt-in.
	function withEnv<T>(value: string | undefined, fn: () => T): T {
		const prev = process.env.PI_PR_REVIEW_BRIDGE;
		if (value === undefined) delete process.env.PI_PR_REVIEW_BRIDGE;
		else process.env.PI_PR_REVIEW_BRIDGE = value;
		try {
			return fn();
		} finally {
			if (prev === undefined) delete process.env.PI_PR_REVIEW_BRIDGE;
			else process.env.PI_PR_REVIEW_BRIDGE = prev;
		}
	}

	it("defaults to the host reviewer bridge (no tool_result handler)", () => {
		withEnv(undefined, () => {
			const { pi, handlers, tools } = createMockPi();
			prGateExtension(pi);

			expect(handlers.has("tool_result")).toBe(false);
			expect(handlers.has("session_shutdown")).toBe(true);
			expect(tools.get("pr_review")).toBeDefined();
		});
	});

	it("selects the orchestrator bridge when PI_PR_REVIEW_BRIDGE=orchestrator", () => {
		withEnv("orchestrator", () => {
			const { pi, handlers } = createMockPi();
			prGateExtension(pi);

			expect(handlers.has("tool_result")).toBe(true);
		});
	});

	it("reviewerBridgeMode dep overrides PI_PR_REVIEW_BRIDGE", () => {
		withEnv("orchestrator", () => {
			const { pi, handlers } = createMockPi();
			prGateExtension(pi, { reviewerBridgeMode: "host" });

			expect(handlers.has("tool_result")).toBe(false);
		});
	});
});
