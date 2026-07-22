import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/linter/core.js";
import { createLinterOrchestrator } from "../src/linter/orchestrator.js";

describe("post-turn-linter: file coverage reporting", () => {
	it("reports checked and skipped files without claiming both were checked", async () => {
		const checkedFile = "/repo/main.go";
		const skippedFile = "/repo/notes.txt";
		const messages: Array<{
			customType?: string;
			content?: string;
			details?: Record<string, unknown>;
		}> = [];
		const orchestrator = createLinterOrchestrator(
			{
				sendMessage: (message: (typeof messages)[number]) => {
					messages.push(message);
				},
				sendUserMessage: () => undefined,
			} as never,
			{
				existsSync: () => true,
				loadLinterConfig: async () => ({
					...DEFAULT_CONFIG,
					cooldownMs: 0,
				}),
				createPipeline: () =>
					({
						runChecks: async () => ({
							kind: "clean",
							report: "",
							affectedFiles: [],
							signature: "clean",
							reportMode: "report-only",
							checkedFiles: [checkedFile],
							skippedFiles: [skippedFile],
						}),
						summarize: () => ({ message: "", details: {} }) as never,
						persist: async () => ({ ok: false, error: "unused" }),
					}) as never,
				setTimeout: () => undefined,
				statSync: () => ({ mtimeMs: 1, size: 1 }),
				writeLinterReportSidecar: async () =>
					({ ok: false, error: "unused" }) as never,
				recoverLinterReportSidecar: async () => {
					throw new Error("unused");
				},
				isQualityGatesSubAgentRuntime: () => false,
			} satisfies Parameters<typeof createLinterOrchestrator>[1],
		);
		const ctx = {
			hasUI: false,
			isIdle: () => true,
			sessionManager: {
				getBranch: () => [],
				getSessionFile: () => "/tmp/session.jsonl",
			},
		};

		await orchestrator.initialize(ctx as never);
		await orchestrator.onToolExecutionEnd(
			{
				toolCallId: "tool-1",
				toolName: "write",
				result: {
					details: { modifiedFiles: [checkedFile, skippedFile] },
				},
			},
			ctx as never,
		);
		await orchestrator.onTurnEnd(ctx as never);

		const status = messages.find(
			(message) => message.customType === "post-turn-linter-status",
		);
		expect(status?.content).toBe(
			"post-turn-linter: clean (1 file(s) checked, 1 skipped)",
		);
		expect(status?.details).toMatchObject({
			status: "clean",
			files: [checkedFile],
			skippedFiles: [skippedFile],
		});
	});
});
