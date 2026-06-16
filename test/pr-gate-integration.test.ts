/**
 * Integration test: the full push-gate allow/block cycle.
 *
 * Exercises the real token store + decision core + tool_call hook against a
 * faithful mock of the Pi tool_call event shape, simulating the agent's
 * journey: blocked push -> review PASS -> token stamped -> allowed push.
 *
 * This does NOT spawn a real reviewer child; that is covered separately in
 * the reviewer-orchestrator integration test. Here we assert the GATE
 * mechanics around an externally-supplied review result.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { decidePushGate } from "../src/pr-gate/gate-decision.js";
import { createPassTokenStore } from "../src/pr-gate/pass-token-store.js";
import {
  registerPushGateHook,
  type ToolCallEventLike,
} from "../src/pr-gate/push-gate-hook.js";

const HEAD_SHA = "abc123def456";
const GATED_TOOL = "git_safe";

interface MockPi {
  handlers: Map<
    string,
    (event: ToolCallEventLike, ctx: ExtensionContext) => Promise<unknown>
  >;
}

function createMockPi(): MockPi {
  const handlers = new Map<
    string,
    (event: ToolCallEventLike, ctx: ExtensionContext) => Promise<unknown>
  >();
  return {
    handlers,
    on: (
      event: string,
      handler: (
        event: ToolCallEventLike,
        ctx: ExtensionContext,
      ) => Promise<unknown>,
    ) => {
      handlers.set(event, handler);
    },
  } as unknown as MockPi;
}

function createMockContext(): ExtensionContext {
  return { cwd: "/repo" } as unknown as ExtensionContext;
}

async function callHook(
  pi: MockPi,
  action: string,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  const handler = pi.handlers.get("tool_call");
  if (!handler) throw new Error("tool_call handler not registered");
  const result = await handler(
    { toolName: GATED_TOOL, toolCallId: "tc1", input: { action } },
    createMockContext(),
  );
  return result as { block?: boolean; reason?: string } | undefined;
}

describe("push-gate full cycle integration", () => {
  it("blocks the first push, allows after a review PASS stamps the token, blocks again after a new commit", async () => {
    const tokens = createPassTokenStore();
    const pi = createMockPi();
    let head = HEAD_SHA;
    registerPushGateHook(pi as never, {
      tokens,
      getHeadSha: () => head,
    });

    // 1. Agent tries to push with no prior review -> BLOCKED.
    const firstPush = await callHook(pi, "push");
    expect(firstPush?.block).toBe(true);
    expect(firstPush?.reason).toContain(HEAD_SHA);
    expect(tokens.hasPass(HEAD_SHA)).toBe(false);

    // 2. Review returns PASS for this HEAD. Stamp via the decision core
    //    (this is what the tool_result observation path will do).
    const stampDecision = decidePushGate({
      action: "push",
      headSha: HEAD_SHA,
      baseSha: "base",
      tokens,
      reviewReport: {
        status: "PASS",
        confidence: "HIGH",
        findings: [],
        verified: [],
        unverifiable: [],
        summary: "clean",
      },
    });
    expect(stampDecision.verdict).toBe("allow");
    expect(tokens.hasPass(HEAD_SHA)).toBe(true);

    // 3. Agent retries the push -> ALLOWED (token covers this exact sha).
    const retryPush = await callHook(pi, "push");
    expect(retryPush).toBeUndefined();

    // 4. A new commit lands on HEAD. The sha changes; the old token no
    //    longer covers it. The next push is BLOCKED again.
    head = "newcommit789";
    const postCommitPush = await callHook(pi, "push");
    expect(postCommitPush?.block).toBe(true);
    expect(postCommitPush?.reason).toContain("newcommit789");
  });

  it("keeps blocking through the fix loop until a review PASS arrives", async () => {
    const tokens = createPassTokenStore();
    const pi = createMockPi();
    registerPushGateHook(pi as never, {
      tokens,
      getHeadSha: () => HEAD_SHA,
    });

    // First review returns ISSUES -> no stamp -> still blocked.
    const issuesDecision = decidePushGate({
      action: "push",
      headSha: HEAD_SHA,
      baseSha: "base",
      tokens,
      reviewReport: {
        status: "ISSUES",
        confidence: "MEDIUM",
        findings: [
          {
            severity: "WARNING",
            domain: "correctness",
            title: "missing null check",
            file: "src/x.ts",
            rule: "null-check",
            issue: "x may be null",
            evidence: "x.foo()",
            suggestion: "guard x",
          },
        ],
        verified: [],
        unverifiable: [],
        summary: "issues",
      },
    });
    expect(issuesDecision.verdict).toBe("block");
    expect(tokens.hasPass(HEAD_SHA)).toBe(false);

    const pushAfterIssues = await callHook(pi, "push");
    expect(pushAfterIssues?.block).toBe(true);

    // After the agent fixes + lint-clean + re-review, PASS arrives -> stamp.
    decidePushGate({
      action: "push",
      headSha: HEAD_SHA,
      baseSha: "base",
      tokens,
      reviewReport: {
        status: "PASS",
        confidence: "HIGH",
        findings: [],
        verified: [],
        unverifiable: [],
        summary: "fixed and clean",
      },
    });
    const pushAfterPass = await callHook(pi, "push");
    expect(pushAfterPass).toBeUndefined();
  });

  it("escalates on CRITICAL security and stays blocked even across retries until human ack", async () => {
    const tokens = createPassTokenStore();
    const pi = createMockPi();
    registerPushGateHook(pi as never, {
      tokens,
      getHeadSha: () => HEAD_SHA,
    });

    const escalateDecision = decidePushGate({
      action: "push",
      headSha: HEAD_SHA,
      baseSha: "base",
      tokens,
      reviewReport: {
        status: "ISSUES",
        confidence: "HIGH",
        findings: [
          {
            severity: "CRITICAL",
            domain: "security",
            title: "RCE via eval",
            file: "src/eval.ts",
            rule: "no-eval",
            issue: "user input evaluated",
            evidence: "eval(req.body)",
            suggestion: "remove eval",
          },
        ],
        verified: [],
        unverifiable: [],
        summary: "critical security",
      },
    });
    expect(escalateDecision.verdict).toBe("escalate");
    expect(escalateDecision.requiresHumanAck).toBe(true);

    // The hook blocks any push after an escalation because no PASS token was
    // stamped. The escalation/human-ack wording is surfaced by the review
    // result path (tool_result observation), not by the tool_call veto hook.
    const pushAfterEscalation = await callHook(pi, "push");
    expect(pushAfterEscalation?.block).toBe(true);
    // No token stamped for an escalation.
    expect(tokens.hasPass(HEAD_SHA)).toBe(false);
  });

  it("read-only git_safe actions (diff, status) never hit the gate", async () => {
    const tokens = createPassTokenStore();
    const pi = createMockPi();
    registerPushGateHook(pi as never, {
      tokens,
      getHeadSha: () => HEAD_SHA,
    });
    expect(await callHook(pi, "diff")).toBeUndefined();
    expect(await callHook(pi, "status")).toBeUndefined();
    expect(await callHook(pi, "fetch")).toBeUndefined();
    expect(await callHook(pi, "log")).toBeUndefined();
  });

  it("non-git_safe tools never hit the gate", async () => {
    const tokens = createPassTokenStore();
    const pi = createMockPi();
    registerPushGateHook(pi as never, {
      tokens,
      getHeadSha: () => HEAD_SHA,
    });
    const handler = pi.handlers.get("tool_call");
    if (!handler) throw new Error("tool_call handler not registered");
    const readResult = await handler(
      { toolName: "read", toolCallId: "tc1", input: { path: "/x" } },
      createMockContext(),
    );
    const editResult = await handler(
      { toolName: "edit", toolCallId: "tc2", input: { path: "/x" } },
      createMockContext(),
    );
    expect(readResult).toBeUndefined();
    expect(editResult).toBeUndefined();
  });
});
