import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createOrchestratorReviewerExecution as createBridge,
	type OrchestratorReviewDeadlineAdapter,
} from "../src/pr-gate/orchestrator-reviewer-execution.js";
import { createPassTokenStore } from "../src/pr-gate/pass-token-store.js";
import { PR_REVIEW_CONFIG } from "../src/pr-gate/pr-review-config.js";
import type { ReviewerAttemptInput } from "../src/pr-gate/reviewer.js";
import {
	formatTestExecutionPlan,
	recommendTestCommands,
} from "../src/pr-gate/test-execution.js";
import { createReviewDeadline } from "../src/shared/review-deadline.js";
import { parseReviewValidationPolicy } from "../src/shared/review-validation-policy.js";

// Existing transport tests use an explicit trusted adapter fixture. Production
// has no adapter by default and must never dispatch an uncontrolled reviewer.
function createOrchestratorReviewerExecution(
	pi: Parameters<typeof createBridge>[0],
	options: Parameters<typeof createBridge>[1] = {},
) {
	return createBridge(pi, {
		deadlineAdapter: {
			protocol: "review-deadline-v1",
			register: () => ({ cancel: () => {}, dispose: () => {} }),
		},
		...options,
	});
}

function makeAttemptInput(): ReviewerAttemptInput {
	return {
		task: "Review this change",
		files: ["src/a.ts"],
		cwd: "/repo",
		config: { ...PR_REVIEW_CONFIG, timeoutMs: 1000 },
		diff: "diff --git a/src/a.ts b/src/a.ts",
		testPlan: "run_typecheck",
	};
}

function passReport(): string {
	return [
		"## Review Report",
		"STATUS: PASS",
		"CONFIDENCE: HIGH",
		"",
		"### Findings",
		"None.",
		"",
		"### What was verified",
		"- Tests passed",
		"",
		"### What could not be verified",
		"None.",
		"",
		"### Test execution",
		"- **Status:** PASS",
		"- **Summary:** run_typecheck passed",
		"",
		"### Summary",
		"Looks good.",
	].join("\n");
}

describe("createOrchestratorReviewerExecution", () => {
	it("refuses before dispatch without a trusted execution deadline adapter", async () => {
		const sendUserMessage = vi.fn();
		const bridge = createBridge({
			getActiveTools: () => ["orchestrate"],
			sendUserMessage,
		});
		const result = await bridge.reviewerExecution.runAttempt(
			makeAttemptInput(),
		);
		expect(result.report).toBeNull();
		expect(result.stderr).toMatch(/trusted.*deadline.*adapter/);
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(bridge.pendingCount()).toBe(0);
		expect(bridge.getStatus().lastDiagnostic?.kind).toBe("error");
	});

	for (const phase of ["protocol", "register", "cancel", "dispose"]) {
		it(`refuses adapter ${phase} errors safely`, async () => {
			const sendUserMessage = vi.fn();
			const bridge = createBridge(
				{ getActiveTools: () => ["orchestrate"], sendUserMessage },
				{
					deadlineAdapter: {
						protocol:
							phase === "protocol"
								? ("unknown" as never)
								: "review-deadline-v1",
						register: () => {
							if (phase === "register") throw new Error("private-adapter-data");
							return {
								cancel: () => {
									if (phase === "cancel")
										throw new Error("private-adapter-data");
								},
								dispose: () => {
									if (phase === "dispose")
										throw new Error("private-adapter-data");
								},
							};
						},
					},
				},
			);
			const pending = bridge.reviewerExecution.runAttempt(makeAttemptInput());
			if (phase === "cancel" || phase === "dispose") {
				const requestId = bridge.getStatus().pending[0].requestId;
				bridge.handleToolResult({
					toolName: "orchestrate",
					input: {
						agentType: "verifier",
						profile: "pr-review",
						task: `Request ${requestId}`,
					},
					content: [{ type: "text", text: passReport() }],
				});
			} else {
				expect(sendUserMessage).not.toHaveBeenCalled();
			}
			const result = await pending;
			expect(result.report).toBeNull();
			expect(result.stderr).toContain("adapter");
			expect(result.stderr).not.toContain("private-adapter-data");
			expect(bridge.pendingCount()).toBe(0);
			expect(bridge.getStatus().lastDiagnostic?.kind).toBe("error");
			bridge.dispose();
		});
	}

	it("refuses before dispatch if trusted registration exhausts the deadline", async () => {
		let now = 0;
		const sendUserMessage = vi.fn();
		const cancel = vi.fn();
		const dispose = vi.fn();
		const bridge = createBridge(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage },
			{
				deadlineAdapter: {
					protocol: "review-deadline-v1",
					register: () => {
						now = 1_000;
						return { cancel, dispose };
					},
				},
			},
		);
		const result = await bridge.reviewerExecution.runAttempt({
			...makeAttemptInput(),
			deadline: createReviewDeadline(1_000, () => now),
		});
		expect(result.timedOut).toBe(true);
		expect(cancel).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(bridge.pendingCount()).toBe(0);
	});

	it("cancels the owned active child and refuses another attempt at expiry", async () => {
		vi.useFakeTimers();
		try {
			let now = 0;
			let beforeAttempt!: () => number;
			let signal!: AbortSignal;
			const killChild = vi.fn();
			const dispose = vi.fn();
			const bridge = createBridge(
				{ getActiveTools: () => ["orchestrate"], sendUserMessage: vi.fn() },
				{
					deadlineAdapter: {
						protocol: "review-deadline-v1",
						register: (request) => {
							beforeAttempt = request.beforeAttempt;
							signal = request.signal;
							return { cancel: killChild, dispose };
						},
					},
				},
			);
			const pending = bridge.reviewerExecution.runAttempt({
				...makeAttemptInput(),
				deadline: createReviewDeadline(1_000, () => now),
			});
			expect(beforeAttempt()).toBe(1_000);
			now = 1_000;
			await vi.advanceTimersByTimeAsync(1_000);
			expect((await pending).timedOut).toBe(true);
			expect(signal.aborted).toBe(true);
			expect(killChild).toHaveBeenCalledOnce();
			expect(dispose).toHaveBeenCalledOnce();
			expect(() => beforeAttempt()).toThrow(/deadline/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses the shared remaining deadline for a long plan and refuses exhausted dispatch", async () => {
		vi.useFakeTimers();
		try {
			let now = 100;
			const sendUserMessage = vi.fn();
			const bridge = createOrchestratorReviewerExecution({
				getActiveTools: () => ["orchestrate"],
				sendUserMessage,
			});
			const input = {
				...makeAttemptInput(),
				config: { ...PR_REVIEW_CONFIG, timeoutMs: 3_900_000 },
				deadline: createReviewDeadline(3_900_000, () => now, 0),
			};
			const pending = bridge.reviewerExecution.runAttempt(input);
			await vi.advanceTimersByTimeAsync(3_899_899);
			expect(bridge.pendingCount()).toBe(1);
			now = 3_900_000;
			await vi.advanceTimersByTimeAsync(1);
			expect((await pending).timedOut).toBe(true);
			expect(bridge.pendingCount()).toBe(0);
			expect(sendUserMessage).toHaveBeenCalledOnce();
			expect((await bridge.reviewerExecution.runAttempt(input)).timedOut).toBe(
				true,
			);
			expect(sendUserMessage).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("retains request command evidence when a result arrives after expiry", async () => {
		vi.useFakeTimers();
		try {
			let now = 0;
			const bridge = createOrchestratorReviewerExecution({
				getActiveTools: () => ["orchestrate"],
				sendUserMessage: vi.fn(),
			});
			const pending = bridge.reviewerExecution.runAttempt({
				...makeAttemptInput(),
				deadline: createReviewDeadline(1_000, () => now),
			});
			const requestId = bridge.getStatus().pending[0].requestId;
			now = 1_000;
			bridge.handleToolResult({
				toolName: "orchestrate",
				input: {
					agentType: "verifier",
					profile: "pr-review",
					task: `Request ${requestId}`,
				},
				content: [{ type: "text", text: passReport() }],
			});
			const result = await pending;
			expect(result.report).toBeNull();
			expect(result.timedOut).toBe(true);
			expect(result.command).toBe(
				`orchestrate agentType=verifier profile=pr-review requestId=${requestId}`,
			);
			expect(bridge.pendingCount()).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	for (const cleanupFailure of ["none", "cancel", "dispose"]) {
		it(`cleans dispatch exceptions immediately with ${cleanupFailure} cleanup failure`, async () => {
			vi.useFakeTimers();
			try {
				const controller = new AbortController();
				const removeListener = vi.spyOn(
					controller.signal,
					"removeEventListener",
				);
				const cancel = vi.fn(() => {
					if (cleanupFailure === "cancel")
						throw new Error("private-cancel-data");
				});
				const dispose = vi.fn(() => {
					if (cleanupFailure === "dispose")
						throw new Error("private-dispose-data");
				});
				let request!: Parameters<
					OrchestratorReviewDeadlineAdapter["register"]
				>[0];
				const bridge = createBridge(
					{
						getActiveTools: () => ["orchestrate"],
						sendUserMessage: () => {
							throw new Error("private-dispatch-data");
						},
					},
					{
						deadlineAdapter: {
							protocol: "review-deadline-v1",
							register: (registered) => {
								request = registered;
								return { cancel, dispose };
							},
						},
					},
				);
				const result = await bridge.reviewerExecution.runAttempt({
					...makeAttemptInput(),
					signal: controller.signal,
				});
				expect(result.report).toBeNull();
				expect(result.exitCode).toBe(1);
				expect(result.stderr).toContain("dispatch failed");
				expect(JSON.stringify(result)).not.toContain("private-");
				expect(result.command).toContain(request.requestId);
				expect(request.signal.aborted).toBe(true);
				expect(() => request.beforeAttempt()).toThrow(/cancelled/);
				expect(cancel).toHaveBeenCalledOnce();
				expect(dispose).toHaveBeenCalledOnce();
				expect(removeListener).toHaveBeenCalledWith(
					"abort",
					expect.any(Function),
				);
				expect(bridge.pendingCount()).toBe(0);
				expect(vi.getTimerCount()).toBe(0);
				expect(bridge.getStatus().lastDiagnostic?.kind).toBe("error");
				expect(
					bridge.handleToolResult({
						toolName: "orchestrate",
						input: {
							agentType: "verifier",
							profile: "pr-review",
							task: request.requestId,
						},
						content: [{ type: "text", text: passReport() }],
					}),
				).toBe(false);
				controller.abort();
				bridge.dispose();
				expect(cancel).toHaveBeenCalledOnce();
				expect(dispose).toHaveBeenCalledOnce();
			} finally {
				vi.useRealTimers();
			}
		});
	}

	it("requests a canonical verifier orchestrate run and resolves from its tool result", async () => {
		const sendUserMessage = vi.fn();
		const bridge = createOrchestratorReviewerExecution({
			getActiveTools: () => ["orchestrate"],
			sendUserMessage,
		});

		const pendingResult = bridge.reviewerExecution.runAttempt(
			makeAttemptInput(),
		);

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		const [instruction, options] = sendUserMessage.mock.calls[0];
		expect(options).toEqual({ deliverAs: "followUp" });
		expect(instruction).toContain("agentType `verifier`");
		expect(instruction).toContain("profile `pr-review`");
		expect(instruction).toContain("PR_REVIEW_REQUEST_ID:");
		expect(instruction).not.toContain("diff --git a/src/a.ts b/src/a.ts");
		expect(instruction).toContain("Parent diff omitted:");
		expect(instruction).toContain("git_inspect_safe is optional");
		expect(instruction).toContain("built-in read-only Git commands");
		expect(instruction).toContain("safe validation runners");
		// Host safety: package scripts from the reviewed checkout must never run on the host.
		expect(instruction).toMatch(/do NOT run package scripts/);
		expect(instruction).not.toContain("sandbox");
		expect(instruction).not.toContain("Apple");
		expect(instruction).toContain(
			"Treat the supplied changed-file list as the authoritative filtered review scope",
		);
		expect(instruction).toContain("Apply repository `.gitignore` rules");
		expect(instruction).toContain("`.pi/reviewer.skip`");
		expect(bridge.reviewerExecution.inspectRepositoryDirectly).toBe(true);
		expect(bridge.pendingCount()).toBe(1);

		const requestId = String(instruction).match(
			/PR_REVIEW_REQUEST_ID: (pr-review-[^\n]+)/,
		)?.[1];
		expect(requestId).toBeDefined();

		const handled = bridge.handleToolResult({
			toolName: "orchestrate",
			input: {
				agentType: "verifier",
				profile: "pr-review",
				task: `Request ${requestId}`,
			},
			content: [{ type: "text", text: passReport() }],
			isError: false,
		});

		expect(handled).toBe(true);
		const result = await pendingResult;
		expect(result.exitCode).toBe(0);
		expect(result.report?.status).toBe("PASS");
		expect(result.command).toContain("agentType=verifier");
		expect(result.command).toContain("profile=pr-review");
		expect(bridge.pendingCount()).toBe(0);
	});

	it("resolves the pending review from a canonical verifier orchestrate input", async () => {
		const bridge = createOrchestratorReviewerExecution({
			getActiveTools: () => ["orchestrate"],
			sendUserMessage: vi.fn(),
		});
		const pendingResult = bridge.reviewerExecution.runAttempt(
			makeAttemptInput(),
		);
		const requestId = bridge.getStatus().pending[0]?.requestId;

		const handled = bridge.handleToolResult({
			toolName: "orchestrate",
			input: {
				agentType: "verifier",
				profile: "pr-review",
				task: `Request ${requestId}`,
			},
			content: [{ type: "text", text: passReport() }],
			isError: false,
		});

		expect(handled).toBe(true);
		const result = await pendingResult;
		expect(result.exitCode).toBe(0);
		expect(result.report?.status).toBe("PASS");
		expect(result.command).toContain("agentType=verifier");
		expect(result.command).toContain("profile=pr-review");
		expect(bridge.pendingCount()).toBe(0);
	});

	it("ignores orchestrate results for non-review canonical pairs", () => {
		const bridge = createOrchestratorReviewerExecution({
			getActiveTools: () => ["orchestrate"],
			sendUserMessage: vi.fn(),
		});
		bridge.reviewerExecution.runAttempt(makeAttemptInput());

		const handled = bridge.handleToolResult({
			toolName: "orchestrate",
			input: { agentType: "worker", profile: "general", task: "other" },
			content: [{ type: "text", text: passReport() }],
			isError: false,
		});

		expect(handled).toBe(false);
		expect(bridge.pendingCount()).toBe(1);
		bridge.dispose("test done");
	});

	it("resolves the sole pending review from an input-light error result", async () => {
		const bridge = createOrchestratorReviewerExecution({
			getActiveTools: () => ["orchestrate"],
			sendUserMessage: vi.fn(),
		});
		const pendingResult = bridge.reviewerExecution.runAttempt(
			makeAttemptInput(),
		);

		try {
			const handled = bridge.handleToolResult({
				toolName: "orchestrate",
				input: { agentType: "verifier", profile: "pr-review" },
				content: [
					{
						type: "text",
						text: "Agent failed (exit 1): reviewer failed closed",
					},
				],
				isError: true,
			});

			expect(handled).toBe(true);
			const result = await pendingResult;
			expect(result.exitCode).toBe(1);
			expect(result.rawOutput).toContain("reviewer failed closed");
			expect(bridge.pendingCount()).toBe(0);
		} finally {
			bridge.dispose();
		}
	});

	it("resolves the sole pending review from an input-light unparseable result", async () => {
		const bridge = createOrchestratorReviewerExecution({
			getActiveTools: () => ["orchestrate"],
			sendUserMessage: vi.fn(),
		});
		const pendingResult = bridge.reviewerExecution.runAttempt(
			makeAttemptInput(),
		);

		try {
			const handled = bridge.handleToolResult({
				toolName: "orchestrate",
				input: { agentType: "verifier", profile: "pr-review" },
				content: [
					{
						type: "text",
						text: "Reviewer output was truncated before its Review Report header.",
					},
				],
				isError: false,
			});

			expect(handled).toBe(true);
			const result = await pendingResult;
			expect(result.exitCode).toBe(0);
			expect(result.report).toBeNull();
			expect(result.rawOutput).toContain("truncated");
			expect(bridge.pendingCount()).toBe(0);
		} finally {
			bridge.dispose();
		}
	});

	it("fails closed when orchestrate is unavailable", async () => {
		const bridge = createOrchestratorReviewerExecution({
			getActiveTools: () => [],
			sendUserMessage: vi.fn(),
		});

		const result = await bridge.reviewerExecution.runAttempt(
			makeAttemptInput(),
		);

		expect(result.report).toBeNull();
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("orchestrate tool is unavailable");
		expect(bridge.pendingCount()).toBe(0);
	});

	it("bounds parent relay metadata independently of full diff size", async () => {
		const sendUserMessage = vi.fn();
		const bridge = createOrchestratorReviewerExecution({
			getActiveTools: () => ["orchestrate"],
			sendUserMessage,
		});
		const input = makeAttemptInput();
		input.task = "task".repeat(10_000);
		input.diff = `FULL_DIFF_SENTINEL${"d".repeat(2_000_000)}`;
		// Executable instructions are not truncatable metadata; keep this
		// fixture's plan bounded while testing task/file/diff summaries.
		input.files = Array.from(
			{ length: 100 },
			(_, i) => `src/${i}-${"p".repeat(500)}.ts`,
		);

		const pending = bridge.reviewerExecution.runAttempt(input);
		const instruction = String(sendUserMessage.mock.calls[0]?.[0]);
		expect(instruction.length).toBeLessThan(20_000);
		expect(instruction).not.toContain("FULL_DIFF_SENTINEL");
		expect(instruction).toContain("Parent diff omitted: 2000018 chars");
		expect(instruction).toContain("68 more file(s) omitted");
		bridge.dispose();
		expect((await pending).stderr).toContain("session shut down");
	});

	it("fails closed when a generated plan exceeds the relay budget", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "qg-relay-plan-"));
		const sendUserMessage = vi.fn();
		const tokens = createPassTokenStore();
		const headSha = "deadcafe".repeat(5);
		const bridge = createOrchestratorReviewerExecution(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage },
			{ tokens, resolveHeadSha: () => headSha },
		);
		try {
			fs.writeFileSync(
				path.join(cwd, "package.json"),
				JSON.stringify({ devDependencies: { vitest: "^3.2.4" } }),
			);
			fs.mkdirSync(path.join(cwd, "test"));
			const files = Array.from(
				{ length: 30 },
				(_, i) => `test/${"required-behavior-".repeat(4)}${i}.test.ts`,
			);
			for (const file of files) {
				fs.writeFileSync(path.join(cwd, file), "export {};\n");
			}
			const testPlan = formatTestExecutionPlan(
				// Transport fixtures do not read live user-global validation policy.
				recommendTestCommands(files, cwd, parseReviewValidationPolicy({})),
			);
			// Reproduce required typecheck/lint falling beyond the old prefix.
			expect(testPlan.indexOf("run_typecheck")).toBeGreaterThan(4_000);
			expect(testPlan.indexOf("run_biome")).toBeGreaterThan(4_000);
			const input = { ...makeAttemptInput(), cwd, files, headSha, testPlan };
			const pending = bridge.reviewerExecution.runAttempt(input);
			expect(sendUserMessage).not.toHaveBeenCalled();
			expect(bridge.pendingCount()).toBe(0);
			const result = await pending;
			expect(result.report).toBeNull();
			expect(result.exitCode).toBe(1);
			expect(result.timedOut).toBe(false);
			expect(result.testPlanBudgetExceeded).toBe(true);
			expect(result.promptBudgetExceeded).not.toBe(true);
			expect(result.stderr).toContain("required test execution plan");
			expect(result.stderr).toContain("relay budget");
			expect(bridge.getStatus().lastDiagnostic?.kind).toBe("error");
			const justOverBudget = await bridge.reviewerExecution.runAttempt({
				...input,
				testPlan: "p".repeat(4_001),
			});
			expect(justOverBudget.report).toBeNull();
			expect(justOverBudget.testPlanBudgetExceeded).toBe(true);
			expect(justOverBudget.stderr).toContain("4001 > 4000");
			expect(sendUserMessage).not.toHaveBeenCalled();
			expect(bridge.pendingCount()).toBe(0);
			// Refusal must not register a request that could stamp a late PASS.
			expect(
				bridge.handleToolResult({
					toolName: "orchestrate",
					input: {
						agentType: "verifier",
						profile: "pr-review",
						task: "PR_REVIEW_REQUEST_ID: pr-review-rejected-budget",
					},
					content: [{ type: "text", text: passReport() }],
				}),
			).toBe(false);
			expect(tokens.hasPass(headSha)).toBe(false);
		} finally {
			bridge.dispose();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("relays a boundary-size test plan without truncation", async () => {
		const sendUserMessage = vi.fn();
		const bridge = createOrchestratorReviewerExecution({
			getActiveTools: () => ["orchestrate"],
			sendUserMessage,
		});
		try {
			const input = makeAttemptInput();
			const tail = "\nREQUIRED_FINAL_CHECK";
			input.testPlan = "p".repeat(4_000 - tail.length) + tail;
			const pending = bridge.reviewerExecution.runAttempt(input);
			const instruction = String(sendUserMessage.mock.calls[0]?.[0]);
			expect(instruction).toContain(input.testPlan);
			expect(instruction).not.toContain("[truncated");
			const requestId = bridge.getStatus().pending[0]?.requestId;
			expect(requestId).toBeDefined();
			bridge.handleToolResult({
				toolName: "orchestrate",
				input: {
					agentType: "verifier",
					profile: "pr-review",
					task: `Request ${requestId}`,
				},
				content: [{ type: "text", text: passReport() }],
			});
			expect((await pending).report?.status).toBe("PASS");
		} finally {
			bridge.dispose();
		}
	});

	it("fails closed and retains bounded tail evidence for oversized tool output", async () => {
		const sendUserMessage = vi.fn();
		const tokens = createPassTokenStore();
		const headSha = "abc123";
		const bridge = createOrchestratorReviewerExecution(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage },
			{ tokens },
		);
		const input = makeAttemptInput();
		input.headSha = headSha;
		const pending = bridge.reviewerExecution.runAttempt(input);
		const instruction = String(sendUserMessage.mock.calls[0]?.[0]);
		const requestId = instruction.match(
			/PR_REVIEW_REQUEST_ID: (pr-review-[^\n]+)/,
		)?.[1];

		bridge.handleToolResult({
			toolName: "orchestrate",
			input: {
				agentType: "verifier",
				profile: "pr-review",
				task: `Request ${requestId}`,
			},
			content: [
				{ type: "text", text: "x".repeat(300_000) },
				{ type: "text", text: passReport() },
			],
		});
		const result = await pending;
		expect(result.report).toBeNull();
		expect(result.rawOutput.length).toBeLessThan(263_000);
		expect(result.rawOutput).toContain("exceeded 262144");
		expect(tokens.hasPass(headSha)).toBe(false);
	});

	it("disposes pending timers and rejects new attempts after shutdown", async () => {
		vi.useFakeTimers();
		try {
			const bridge = createOrchestratorReviewerExecution({
				getActiveTools: () => ["orchestrate"],
				sendUserMessage: vi.fn(),
			});
			const pending = bridge.reviewerExecution.runAttempt(makeAttemptInput());
			expect(bridge.pendingCount()).toBe(1);
			bridge.dispose("reload cancellation");
			expect(bridge.pendingCount()).toBe(0);
			expect((await pending).stderr).toContain("reload cancellation");
			expect(bridge.getStatus().lastDiagnostic?.kind).toBe("cancelled");
			const afterDispose = await bridge.reviewerExecution.runAttempt(
				makeAttemptInput(),
			);
			expect(afterDispose.stderr).toContain("disposed");
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("orchestrator exact-HEAD correlation", () => {
	function makeAttemptInput(headSha?: string): ReviewerAttemptInput {
		return {
			task: "Review this change",
			files: ["src/a.ts"],
			cwd: "/repo",
			config: { ...PR_REVIEW_CONFIG, timeoutMs: 1000 },
			diff: "diff --git a/src/a.ts b/src/a.ts",
			testPlan: "run_typecheck",
			headSha,
		};
	}

	/** A PASS report with preamble before ## Review Report (the regression scenario). */
	function passReportWithPreamble(): string {
		return [
			"I finished the review. Here is the report.",
			"",
			"## Review Report",
			"STATUS: PASS",
			"CONFIDENCE: HIGH",
			"",
			"### Findings",
			"None.",
			"",
			"### What was verified",
			"- Tests passed",
			"",
			"### What could not be verified",
			"None.",
			"",
			"### Test execution",
			"- **Status:** PASS",
			"- **Summary:** run_typecheck passed",
			"",
			"### Summary",
			"Looks good.",
		].join("\n");
	}

	it("returns exact-HEAD PASS from a correlated error without granting authority", async () => {
		const tokens = createPassTokenStore();
		const headSha = "0b1b2c3d".repeat(5);
		const sendUserMessage = vi.fn();
		const bridge = createOrchestratorReviewerExecution(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage },
			{ tokens, resolveHeadSha: () => headSha },
		);
		const pending = bridge.reviewerExecution.runAttempt(
			makeAttemptInput(headSha),
		);
		const requestId = String(sendUserMessage.mock.calls[0][0]).match(
			/PR_REVIEW_REQUEST_ID: (pr-review-[^\n]+)/,
		)?.[1];
		expect(requestId).toBeDefined();

		const handled = bridge.handleToolResult({
			toolName: "orchestrate",
			input: {
				agentType: "verifier",
				profile: "pr-review",
				task: `Request ${requestId}`,
			},
			content: [{ type: "text", text: passReportWithPreamble() }],
			isError: true,
		});

		expect(handled).toBe(true);
		const result = await pending;
		expect(result.report?.status).toBe("PASS");
		expect(result.exitCode).toBe(1);
		expect(tokens.hasPass(headSha)).toBe(false);
		expect(bridge.getStatus().lastDiagnostic?.kind).toBe("parsed-pass");
	});

	it("does not stamp an uncorrelated PASS carried by an error result", async () => {
		const tokens = createPassTokenStore();
		const headSha = "5e6f7a8b".repeat(5);
		const sendUserMessage = vi.fn();
		const bridge = createOrchestratorReviewerExecution(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage },
			{ tokens, resolveHeadSha: () => headSha },
		);
		const pending = bridge.reviewerExecution.runAttempt(
			makeAttemptInput(headSha),
		);

		const handled = bridge.handleToolResult({
			toolName: "orchestrate",
			input: { agentType: "verifier", profile: "pr-review" },
			content: [{ type: "text", text: passReportWithPreamble() }],
			isError: true,
		});

		expect(handled).toBe(true);
		const result = await pending;
		expect(result.report).toBeNull();
		expect(result.exitCode).toBe(1);
		expect(tokens.hasPass(headSha)).toBe(false);
		expect(bridge.getStatus().lastDiagnostic?.kind).toBe("error");
	});

	it("fails closed when an error result contains a malformed review report", async () => {
		const tokens = createPassTokenStore();
		const headSha = "9a8b7c6d".repeat(5);
		const sendUserMessage = vi.fn();
		const bridge = createOrchestratorReviewerExecution(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage },
			{ tokens, resolveHeadSha: () => headSha },
		);
		const pending = bridge.reviewerExecution.runAttempt(
			makeAttemptInput(headSha),
		);
		const requestId = String(sendUserMessage.mock.calls[0][0]).match(
			/PR_REVIEW_REQUEST_ID: (pr-review-[^\n]+)/,
		)?.[1];

		const handled = bridge.handleToolResult({
			toolName: "orchestrate",
			input: {
				agentType: "verifier",
				profile: "pr-review",
				task: `Request ${requestId}`,
			},
			content: [
				{
					type: "text",
					text: "## Review Report\nSTATUS: MAYBE\n### Findings\nNone.",
				},
			],
			isError: true,
		});

		expect(handled).toBe(true);
		const result = await pending;
		expect(result.report).toBeNull();
		expect(tokens.hasPass(headSha)).toBe(false);
		expect(bridge.getStatus().lastDiagnostic?.kind).toBe("error");
	});

	function criticalSecurityPassReport(): string {
		return [
			"## Review Report",
			"STATUS: PASS",
			"CONFIDENCE: HIGH",
			"",
			"### Findings",
			"#### [CRITICAL] Unsafe publication",
			"- **File:** src/a.ts:1",
			"- **Category:** security",
			"- **Rule:** fail-closed-pr-gate",
			"- **Issue:** Critical security risk",
			"- **Evidence:** unsafe",
			"- **Suggestion:** block publication",
			"",
			"### What was verified",
			"- Tests passed",
			"",
			"### What could not be verified",
			"None.",
			"",
			"### Test execution",
			"- **Status:** PASS",
			"- **Summary:** run_typecheck passed",
			"",
			"### Summary",
			"Critical issue remains.",
		].join("\n");
	}

	it("refuses an uncorrelated PASS even when exactly one review is pending", async () => {
		const tokens = createPassTokenStore();
		const headSha = "afc61f83e4b7b450284cdaee1d50c2e055f38b58";
		const sendUserMessage = vi.fn();
		const bridge = createOrchestratorReviewerExecution(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage },
			{ tokens, resolveHeadSha: () => headSha },
		);

		const pendingResult = bridge.reviewerExecution.runAttempt(
			makeAttemptInput(headSha),
		);
		const requestId = String(sendUserMessage.mock.calls[0][0]).match(
			/PR_REVIEW_REQUEST_ID: (pr-review-[^\n]+)/,
		)?.[1];
		expect(requestId).toBeDefined();

		const uncorrelated = bridge.handleToolResult({
			toolName: "orchestrate",
			input: { agentType: "verifier", profile: "pr-review" },
			content: [{ type: "text", text: passReportWithPreamble() }],
			isError: false,
		});
		expect(uncorrelated).toBe(false);
		expect(tokens.hasPass(headSha)).toBe(false);
		expect(bridge.pendingCount()).toBe(1);

		const correlated = bridge.handleToolResult({
			toolName: "orchestrate",
			input: {
				agentType: "verifier",
				profile: "pr-review",
				task: `Request ${requestId}`,
			},
			content: [{ type: "text", text: passReportWithPreamble() }],
			isError: false,
		});
		expect(correlated).toBe(true);
		await pendingResult;
		expect(tokens.hasPass(headSha)).toBe(false);
		expect(bridge.pendingCount()).toBe(0);
	});

	it("correlates via PR_REVIEW_REQUEST_ID echoed in content text", async () => {
		const tokens = createPassTokenStore();
		const headSha = "deadbeef".repeat(5);
		const sendUserMessage = vi.fn();
		const bridge = createOrchestratorReviewerExecution(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage },
			{ tokens, resolveHeadSha: () => headSha },
		);

		const pendingResult = bridge.reviewerExecution.runAttempt(
			makeAttemptInput(headSha),
		);
		const requestId = String(sendUserMessage.mock.calls[0][0]).match(
			/PR_REVIEW_REQUEST_ID: (pr-review-[^\n]+)/,
		)?.[1];
		expect(requestId).toBeDefined();

		// Content echoes the request id back (child preamble), input has nothing.
		const handled = bridge.handleToolResult({
			toolName: "orchestrate",
			input: { agentType: "verifier", profile: "pr-review" },
			content: [
				{
					type: "text",
					text: `PR_REVIEW_REQUEST_ID: ${requestId}\n${passReportWithPreamble()}`,
				},
			],
			isError: false,
		});
		expect(handled).toBe(true);
		await pendingResult;
		expect(tokens.hasPass(headSha)).toBe(false);
	});

	it("does not stamp a correlated PASS with a CRITICAL security finding", async () => {
		const tokens = createPassTokenStore();
		const headSha = "c001d00d".repeat(5);
		const sendUserMessage = vi.fn();
		const bridge = createOrchestratorReviewerExecution(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage },
			{ tokens, resolveHeadSha: () => headSha },
		);
		const pending = bridge.reviewerExecution.runAttempt(
			makeAttemptInput(headSha),
		);
		const requestId = String(sendUserMessage.mock.calls[0][0]).match(
			/PR_REVIEW_REQUEST_ID: (pr-review-[^\n]+)/,
		)?.[1];

		bridge.handleToolResult({
			toolName: "orchestrate",
			input: {
				agentType: "verifier",
				profile: "pr-review",
				task: `Request ${requestId}`,
			},
			content: [{ type: "text", text: criticalSecurityPassReport() }],
			isError: false,
		});
		await pending;

		expect(tokens.hasPass(headSha)).toBe(false);
		expect(bridge.getStatus().lastDiagnostic?.detail).toContain(
			"CRITICAL security",
		);
	});

	it("does not stamp an uncorrelated PASS when no review request is known", () => {
		const tokens = createPassTokenStore();
		const headSha = "cafef00d".repeat(5);
		const bridge = createOrchestratorReviewerExecution(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage: vi.fn() },
			{ tokens, resolveHeadSha: () => headSha },
		);

		const handled = bridge.handleToolResult({
			toolName: "orchestrate",
			input: { agentType: "verifier", profile: "pr-review" },
			content: [{ type: "text", text: passReportWithPreamble() }],
			isError: false,
		});

		expect(handled).toBe(false);
		expect(tokens.hasPass(headSha)).toBe(false);
		expect(bridge.getStatus().lastDiagnostic?.detail).toContain(
			"token NOT stamped",
		);
	});

	it("rejects late PASS for a known timed-out request without trusting current HEAD", async () => {
		vi.useFakeTimers();
		try {
			const tokens = createPassTokenStore();
			const headSha = "faceb00c".repeat(5);
			const sendUserMessage = vi.fn();
			const bridge = createOrchestratorReviewerExecution(
				{ getActiveTools: () => ["orchestrate"], sendUserMessage },
				{ tokens, resolveHeadSha: () => "different-current-head" },
			);
			const input = makeAttemptInput(headSha);
			input.config = { ...input.config, timeoutMs: 10 };
			const pending = bridge.reviewerExecution.runAttempt(input);
			const requestId = String(sendUserMessage.mock.calls[0][0]).match(
				/PR_REVIEW_REQUEST_ID: (pr-review-[^\n]+)/,
			)?.[1];
			expect(requestId).toBeDefined();

			await vi.advanceTimersByTimeAsync(10);
			expect((await pending).timedOut).toBe(true);
			expect(bridge.pendingCount()).toBe(0);

			const handled = bridge.handleToolResult({
				toolName: "orchestrate",
				input: {
					agentType: "verifier",
					profile: "pr-review",
					task: `Request ${requestId}`,
				},
				content: [{ type: "text", text: passReportWithPreamble() }],
				isError: false,
			});
			expect(handled).toBe(false);
			expect(tokens.hasPass(headSha)).toBe(false);
			expect(tokens.hasPass("different-current-head")).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not stamp a late correlated PASS with a CRITICAL security finding", async () => {
		vi.useFakeTimers();
		try {
			const tokens = createPassTokenStore();
			const headSha = "bad5ec00".repeat(5);
			const sendUserMessage = vi.fn();
			const bridge = createOrchestratorReviewerExecution(
				{ getActiveTools: () => ["orchestrate"], sendUserMessage },
				{ tokens, resolveHeadSha: () => headSha },
			);
			const input = makeAttemptInput(headSha);
			input.config = { ...input.config, timeoutMs: 10 };
			const pending = bridge.reviewerExecution.runAttempt(input);
			const requestId = String(sendUserMessage.mock.calls[0][0]).match(
				/PR_REVIEW_REQUEST_ID: (pr-review-[^\n]+)/,
			)?.[1];
			await vi.advanceTimersByTimeAsync(10);
			await pending;

			bridge.handleToolResult({
				toolName: "orchestrate",
				input: {
					agentType: "verifier",
					profile: "pr-review",
					task: `Request ${requestId}`,
				},
				content: [{ type: "text", text: criticalSecurityPassReport() }],
				isError: false,
			});
			expect(tokens.hasPass(headSha)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does NOT stamp a token for an ISSUES report", () => {
		const tokens = createPassTokenStore();
		const headSha = "1234abcd".repeat(5);
		const bridge = createOrchestratorReviewerExecution(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage: vi.fn() },
			{ tokens, resolveHeadSha: () => headSha },
		);
		const issuesReport = [
			"## Review Report",
			"STATUS: ISSUES",
			"CONFIDENCE: HIGH",
			"",
			"### Findings",
			"#### [WARNING] something",
			"- **File:** src/a.ts:1",
			"- **Category:** quality",
			"",
			"### Summary",
			"Found issues.",
		].join("\n");

		bridge.handleToolResult({
			toolName: "orchestrate",
			input: { agentType: "verifier", profile: "pr-review" },
			content: [{ type: "text", text: issuesReport }],
			isError: false,
		});

		expect(tokens.hasPass(headSha)).toBe(false);
		expect(tokens.size).toBe(0);
		expect(bridge.getStatus().lastDiagnostic?.kind).toBe("parsed-nonpass");
	});

	it("does NOT stamp a PASS that omits the required Test execution section", () => {
		const tokens = createPassTokenStore();
		const headSha = "f00d1234".repeat(5);
		const bridge = createOrchestratorReviewerExecution(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage: vi.fn() },
			{ tokens, resolveHeadSha: () => headSha },
		);
		const passWithoutTests = [
			"## Review Report",
			"STATUS: PASS",
			"CONFIDENCE: HIGH",
			"",
			"### Findings",
			"None.",
			"",
			"### Summary",
			"Looks good.",
		].join("\n");

		bridge.handleToolResult({
			toolName: "orchestrate",
			input: { agentType: "verifier", profile: "pr-review" },
			content: [{ type: "text", text: passWithoutTests }],
			isError: false,
		});

		// Invariant: PASS requires test execution. No token, actionable diag.
		expect(tokens.hasPass(headSha)).toBe(false);
		const diag = bridge.getStatus().lastDiagnostic;
		expect(diag?.kind).toBe("parsed-pass");
		expect(diag?.detail).toContain("token NOT stamped");
		expect(diag?.detail).toContain("Test execution");
	});

	it("records an actionable diagnostic when output is malformed (no report block)", () => {
		const tokens = createPassTokenStore();
		const headSha = "beefcafe".repeat(5);
		const bridge = createOrchestratorReviewerExecution(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage: vi.fn() },
			{ tokens, resolveHeadSha: () => headSha },
		);

		bridge.handleToolResult({
			toolName: "orchestrate",
			input: { agentType: "verifier", profile: "pr-review" },
			content: [{ type: "text", text: "sure thing, here are my thoughts..." }],
			isError: false,
		});

		expect(tokens.size).toBe(0);
		const diag = bridge.getStatus().lastDiagnostic;
		expect(diag?.kind).toBe("parse-failed");
		expect(diag?.headSha).toBe(headSha);
		expect(diag?.detail).toContain("## Review Report");
		expect(diag?.detail).toContain("Preview:");
	});

	it("records an error diagnostic on isError results", () => {
		const tokens = createPassTokenStore();
		const bridge = createOrchestratorReviewerExecution(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage: vi.fn() },
			{ tokens, resolveHeadSha: () => "abc" },
		);
		bridge.handleToolResult({
			toolName: "orchestrate",
			input: { agentType: "verifier", profile: "pr-review" },
			content: [{ type: "text", text: "container bridge unavailable" }],
			isError: true,
		});
		expect(bridge.getStatus().lastDiagnostic?.kind).toBe("error");
		expect(tokens.size).toBe(0);
	});

	it("getStatus exposes pending request id + head before resolution", async () => {
		const tokens = createPassTokenStore();
		const headSha = "feedface".repeat(5);
		const sendUserMessage = vi.fn();
		const bridge = createOrchestratorReviewerExecution(
			{ getActiveTools: () => ["orchestrate"], sendUserMessage },
			{ tokens, resolveHeadSha: () => headSha },
		);
		const pending = bridge.reviewerExecution.runAttempt(
			makeAttemptInput(headSha),
		);
		const status = bridge.getStatus();
		expect(status.pending).toHaveLength(1);
		expect(status.pending[0]?.headSha).toBe(headSha);
		expect(status.pending[0]?.requestId).toMatch(/^pr-review-/);

		// Resolve so the timer doesn't keep the test alive.
		bridge.handleToolResult({
			toolName: "orchestrate",
			input: {
				agentType: "verifier",
				profile: "pr-review",
				task: `Request ${status.pending[0]?.requestId}`,
			},
			content: [{ type: "text", text: passReportWithPreamble() }],
			isError: false,
		});
		await pending;
		expect(bridge.getStatus().pending).toHaveLength(0);
	});
});
