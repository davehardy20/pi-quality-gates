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

interface SentMessage {
	customType?: string;
	content?: string;
	details?: Record<string, unknown>;
	display?: boolean;
}

function createMockPi(): {
	pi: ExtensionAPI;
	commands: Map<string, RegisteredCommand>;
	messages: SentMessage[];
} {
	const commands = new Map<string, RegisteredCommand>();
	const messages: SentMessage[] = [];

	const pi = {
		registerCommand: (name: string, command: RegisteredCommand) => {
			commands.set(name, command);
		},
		sendMessage: (message: SentMessage) => {
			messages.push(message);
		},
		on: () => {},
	} as unknown as ExtensionAPI;

	return { pi, commands, messages };
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
