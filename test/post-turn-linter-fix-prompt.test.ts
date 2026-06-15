import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/linter/core.js";
import { createLinterOrchestrator } from "../src/linter/orchestrator.js";

describe("post-turn-linter: fix prompt", () => {
	it("continues the active task after fixing linter findings", async () => {
		type MockContext = {
			hasUI: false;
			isIdle: () => boolean;
			sessionManager: {
				getBranch: () => unknown[];
				getSessionFile: () => string;
			};
		};
		const userMessages: string[] = [];
		const sidecarMetadata = {
			id: "sidecar-1",
			toolName: "post-turn-linter" as const,
			sessionId: "session-1",
			path: "/tmp/sidecar-1.json",
			createdAt: "2026-06-13T00:00:00.000Z",
			originalChars: 0,
			originalBytes: 0,
			redactedChars: 0,
			redactedBytes: 0,
			originalSha256: "original",
			redactedSha256: "redacted",
			summaryMode: "post-turn-linter-summary" as const,
		};

		const orchestrator = createLinterOrchestrator(
			{
				sendMessage: () => undefined,
				sendUserMessage: (message: string) => {
					userMessages.push(message);
				},
			} as never,
			{
				existsSync: () => true,
				loadLinterConfig: async () => ({
					...DEFAULT_CONFIG,
					reportMode: "auto-follow-up",
				}),
				createPipeline: () =>
					({
						runChecks: async () => ({
							kind: "findings",
							report: "/repo/src/example.ts:1:1 RULE0 detail",
							affectedFiles: ["/repo/src/example.ts"],
							signature: "signature",
							reportMode: "auto-follow-up",
						}),
						summarize: () => ({ message: "", details: {} }) as never,
						persist: async () => ({ ok: true, metadata: sidecarMetadata }),
					}) as never,
				setTimeout: (callback) => {
					callback();
					return undefined;
				},
				statSync: () => ({ mtimeMs: 1, size: 1 }),
				writeLinterReportSidecar: async () => ({
					ok: true,
					metadata: sidecarMetadata,
				}),
				recoverLinterReportSidecar: async () => ({
					mode: "preview",
					content: "",
					metadata: sidecarMetadata,
				}),
				isQualityGatesSubAgentRuntime: () => false,
			} satisfies Parameters<typeof createLinterOrchestrator>[1],
		);

		const ctx: MockContext = {
			hasUI: false,
			isIdle: () => true,
			sessionManager: {
				getBranch: () => [],
				getSessionFile: () => "/tmp/session-1.jsonl",
			},
		};

		await orchestrator.initialize(ctx as never);
		await orchestrator.onToolExecutionEnd(
			{
				toolCallId: "tool-1",
				toolName: "write",
				result: { details: { modifiedFiles: ["/repo/src/example.ts"] } },
			},
			ctx as never,
		);
		await orchestrator.onTurnEnd(ctx as never);

		expect(userMessages[0]).toContain(
			"After fixing the linter findings, continue the active user task.",
		);
		expect(userMessages[0]).not.toContain("After fixing the files, stop.");
	});
});
