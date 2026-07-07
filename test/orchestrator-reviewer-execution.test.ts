import { describe, expect, it, vi } from "vitest";
import { createOrchestratorReviewerExecution } from "../src/pr-gate/orchestrator-reviewer-execution.js";
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
		expect(instruction).toContain("category: `pr-reviewer`");
		expect(instruction).toContain("PR_REVIEW_REQUEST_ID:");
		expect(instruction).toContain("diff --git a/src/a.ts b/src/a.ts");
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
});
