import { describe, expect, it, vi } from "vitest";
import { createOrchestratorReviewerExecution } from "../src/pr-gate/orchestrator-reviewer-execution.js";
import { createPassTokenStore } from "../src/pr-gate/pass-token-store.js";
import { PR_REVIEW_CONFIG } from "../src/pr-gate/pr-review-config.js";
import type { ReviewerAttemptInput } from "../src/pr-gate/reviewer.js";

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
	it("requests a sandboxed pr-reviewer orchestrate run and resolves from its tool result", async () => {
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
		expect(instruction).toContain("category `pr-reviewer`");
		expect(instruction).toContain("PR_REVIEW_REQUEST_ID:");
		expect(instruction).not.toContain("diff --git a/src/a.ts b/src/a.ts");
		expect(instruction).toContain("Parent diff omitted:");
		expect(instruction).toContain("git_inspect_safe is optional");
		expect(instruction).toContain("built-in sandbox-local read-only Git");
		expect(instruction).toContain(
			"trusted package scripts inside the disposable sandbox",
		);
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
			input: { category: "pr-reviewer", task: `Request ${requestId}` },
			content: [{ type: "text", text: passReport() }],
			isError: false,
		});

		expect(handled).toBe(true);
		const result = await pendingResult;
		expect(result.exitCode).toBe(0);
		expect(result.report?.status).toBe("PASS");
		expect(result.command).toContain("orchestrate category=pr-reviewer");
		expect(bridge.pendingCount()).toBe(0);
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
				input: { category: "pr-reviewer" },
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
				input: { category: "pr-reviewer" },
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
		input.testPlan = "test".repeat(10_000);
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
			input: { category: "pr-reviewer", task: `Request ${requestId}` },
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

describe("createOrchestratorReviewerExecution exact-HEAD PASS stamping", () => {
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

	it("stamps an exact-HEAD PASS parsed from a correlated error result", async () => {
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
			input: { category: "pr-reviewer", task: `Request ${requestId}` },
			content: [{ type: "text", text: passReportWithPreamble() }],
			isError: true,
		});

		expect(handled).toBe(true);
		const result = await pending;
		expect(result.report?.status).toBe("PASS");
		expect(result.exitCode).toBe(1);
		expect(tokens.hasPass(headSha)).toBe(true);
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
			input: { category: "pr-reviewer" },
			content: [{ type: "text", text: passReportWithPreamble() }],
			isError: true,
		});

		expect(handled).toBe(true);
		const result = await pending;
		expect(result.report?.status).toBe("PASS");
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
			input: { category: "pr-reviewer", task: `Request ${requestId}` },
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
			input: { category: "pr-reviewer" },
			content: [{ type: "text", text: passReportWithPreamble() }],
			isError: false,
		});
		expect(uncorrelated).toBe(false);
		expect(tokens.hasPass(headSha)).toBe(false);
		expect(bridge.pendingCount()).toBe(1);

		const correlated = bridge.handleToolResult({
			toolName: "orchestrate",
			input: { category: "pr-reviewer", task: `Request ${requestId}` },
			content: [{ type: "text", text: passReportWithPreamble() }],
			isError: false,
		});
		expect(correlated).toBe(true);
		await pendingResult;
		expect(tokens.hasPass(headSha)).toBe(true);
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
			input: { category: "pr-reviewer" },
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
		expect(tokens.hasPass(headSha)).toBe(true);
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
			input: { category: "pr-reviewer", task: `Request ${requestId}` },
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
			input: { category: "pr-reviewer" },
			content: [{ type: "text", text: passReportWithPreamble() }],
			isError: false,
		});

		expect(handled).toBe(false);
		expect(tokens.hasPass(headSha)).toBe(false);
		expect(bridge.getStatus().lastDiagnostic?.detail).toContain(
			"token NOT stamped",
		);
	});

	it("stamps a late PASS only when it echoes a known timed-out request id", async () => {
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
				input: { category: "pr-reviewer", task: `Request ${requestId}` },
				content: [{ type: "text", text: passReportWithPreamble() }],
				isError: false,
			});
			expect(handled).toBe(false);
			expect(tokens.hasPass(headSha)).toBe(true);
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
				input: { category: "pr-reviewer", task: `Request ${requestId}` },
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
			input: { category: "pr-reviewer" },
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
			input: { category: "pr-reviewer" },
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
			input: { category: "pr-reviewer" },
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
			input: { category: "pr-reviewer" },
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
				category: "pr-reviewer",
				task: `Request ${status.pending[0]?.requestId}`,
			},
			content: [{ type: "text", text: passReportWithPreamble() }],
			isError: false,
		});
		await pending;
		expect(bridge.getStatus().pending).toHaveLength(0);
	});
});
