import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
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

function createMockContext(): ExtensionContext {
	return { cwd: process.cwd() } as ExtensionContext;
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
});
