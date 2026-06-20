import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createPassTokenStore } from "../src/pr-gate/pass-token-store.js";
import { registerPushGateHook } from "../src/pr-gate/push-gate-hook.js";

// The hook is registered against this exact toolName. If a tool_call event
// arrives for any other tool, the hook returns undefined (allow).
const GATED_TOOL = "git_safe";

interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: { action: string; [k: string]: unknown };
}

interface MockPi {
  handlers: Map<
    string,
    (event: ToolCallEvent, ctx: ExtensionContext) => unknown
  >;
}

function createMockPi(): MockPi {
  const handlers = new Map<
    string,
    (event: ToolCallEvent, ctx: ExtensionContext) => unknown
  >();
  return {
    handlers,
    on: (
      event: string,
      handler: (event: ToolCallEvent, ctx: ExtensionContext) => unknown,
    ) => {
      handlers.set(event, handler);
    },
  } as unknown as MockPi;
}

function createMockContext(): ExtensionContext {
  return { cwd: "/repo" } as unknown as ExtensionContext;
}

async function fireHook(
  pi: MockPi,
  event: ToolCallEvent,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  const handler = pi.handlers.get("tool_call");
  if (!handler) throw new Error("tool_call handler not registered");
  const result = await handler(event, createMockContext());
  return result as { block?: boolean; reason?: string } | undefined;
}

describe("push-gate-hook (tool_call interceptor for git_safe)", () => {
  describe("hook registration", () => {
    it("registers a tool_call handler", () => {
      const pi = createMockPi();
      registerPushGateHook(pi as never, {
        tokens: createPassTokenStore(),
        getHeadSha: () => "head123",
      });
      expect(pi.handlers.has("tool_call")).toBe(true);
    });
  });

  describe("non-gated tools pass through", () => {
    it("returns undefined (allow) for read", async () => {
      const pi = createMockPi();
      registerPushGateHook(pi as never, {
        tokens: createPassTokenStore(),
        getHeadSha: () => "head123",
      });
      const result = await fireHook(pi, {
        toolName: "read",
        toolCallId: "tc1",
        input: { action: "read", path: "/x" },
      });
      expect(result).toBeUndefined();
    });

    it("returns undefined (allow) for git_safe action='diff' (read-only)", async () => {
      const pi = createMockPi();
      registerPushGateHook(pi as never, {
        tokens: createPassTokenStore(),
        getHeadSha: () => "head123",
      });
      const result = await fireHook(pi, {
        toolName: GATED_TOOL,
        toolCallId: "tc1",
        input: { action: "diff" },
      });
      expect(result).toBeUndefined();
    });

    it("returns undefined for git_safe action='status' (read-only)", async () => {
      const pi = createMockPi();
      registerPushGateHook(pi as never, {
        tokens: createPassTokenStore(),
        getHeadSha: () => "head123",
      });
      const result = await fireHook(pi, {
        toolName: GATED_TOOL,
        toolCallId: "tc1",
        input: { action: "status" },
      });
      expect(result).toBeUndefined();
    });
  });

  describe("git_safe push / pr_create gating", () => {
    it("ALLOWS push when a PASS token exists for HEAD", async () => {
      const tokens = createPassTokenStore();
      tokens.stampPass({ sha: "head123", passedAt: 1, reportStatus: "PASS" });
      const pi = createMockPi();
      registerPushGateHook(pi as never, {
        tokens,
        getHeadSha: () => "head123",
      });
      const result = await fireHook(pi, {
        toolName: GATED_TOOL,
        toolCallId: "tc1",
        input: { action: "push" },
      });
      expect(result).toBeUndefined();
    });

    it("ALLOWS pr_create when a PASS token exists for HEAD", async () => {
      const tokens = createPassTokenStore();
      tokens.stampPass({ sha: "head123", passedAt: 1, reportStatus: "PASS" });
      const pi = createMockPi();
      registerPushGateHook(pi as never, {
        tokens,
        getHeadSha: () => "head123",
      });
      const result = await fireHook(pi, {
        toolName: GATED_TOOL,
        toolCallId: "tc1",
        input: { action: "pr_create" },
      });
      expect(result).toBeUndefined();
    });

    it("BLOCKS push when no PASS token exists, with a reason naming HEAD + steer to /pr-review", async () => {
      const tokens = createPassTokenStore();
      const pi = createMockPi();
      registerPushGateHook(pi as never, {
        tokens,
        getHeadSha: () => "head123",
      });
      const result = await fireHook(pi, {
        toolName: GATED_TOOL,
        toolCallId: "tc1",
        input: { action: "push" },
      });
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain("head123");
      expect(result?.reason).toMatch(/pr-review/i);
    });

    it("BLOCKS pr_create when no PASS token exists", async () => {
      const tokens = createPassTokenStore();
      const pi = createMockPi();
      registerPushGateHook(pi as never, {
        tokens,
        getHeadSha: () => "head123",
      });
      const result = await fireHook(pi, {
        toolName: GATED_TOOL,
        toolCallId: "tc1",
        input: { action: "pr_create" },
      });
      expect(result?.block).toBe(true);
    });

    it("BLOCKS when token exists for a stale sha (new commit on HEAD)", async () => {
      const tokens = createPassTokenStore();
      tokens.stampPass({ sha: "old1234", passedAt: 1, reportStatus: "PASS" });
      const pi = createMockPi();
      registerPushGateHook(pi as never, {
        tokens,
        getHeadSha: () => "new1234",
      });
      const result = await fireHook(pi, {
        toolName: GATED_TOOL,
        toolCallId: "tc1",
        input: { action: "push" },
      });
      expect(result?.block).toBe(true);
    });
  });

  describe("fail-safe behavior", () => {
    it("BLOCKS when getHeadSha throws (cannot prove a pass)", async () => {
      const tokens = createPassTokenStore();
      const pi = createMockPi();
      registerPushGateHook(pi as never, {
        tokens,
        getHeadSha: () => {
          throw new Error("git rev-parse failed");
        },
      });
      const result = await fireHook(pi, {
        toolName: GATED_TOOL,
        toolCallId: "tc1",
        input: { action: "push" },
      });
      // Fail-safe: errors block the mutating action, never allow it
      expect(result?.block).toBe(true);
    });

    it("BLOCKS when getHeadSha returns empty (detached/unknown HEAD)", async () => {
      const tokens = createPassTokenStore();
      const pi = createMockPi();
      registerPushGateHook(pi as never, {
        tokens,
        getHeadSha: () => "",
      });
      const result = await fireHook(pi, {
        toolName: GATED_TOOL,
        toolCallId: "tc1",
        input: { action: "push" },
      });
      expect(result?.block).toBe(true);
    });
  });

  describe("configuration", () => {
    it("can disable the gate entirely (allow-all, even without a token)", async () => {
      const tokens = createPassTokenStore();
      const pi = createMockPi();
      registerPushGateHook(pi as never, {
        tokens,
        getHeadSha: () => "head123",
        enabled: () => false,
      });
      const result = await fireHook(pi, {
        toolName: GATED_TOOL,
        toolCallId: "tc1",
        input: { action: "push" },
      });
      expect(result).toBeUndefined();
    });

    it("respects an allowlist of actions to gate (default: push + pr_create)", async () => {
      const tokens = createPassTokenStore();
      const pi = createMockPi();
      // Only gate push, leave pr_create un-gated
      registerPushGateHook(pi as never, {
        tokens,
        getHeadSha: () => "head123",
        gatedActions: () => new Set(["push"]),
      });
      const prCreateResult = await fireHook(pi, {
        toolName: GATED_TOOL,
        toolCallId: "tc1",
        input: { action: "pr_create" },
      });
      expect(prCreateResult).toBeUndefined();
      const pushResult = await fireHook(pi, {
        toolName: GATED_TOOL,
        toolCallId: "tc2",
        input: { action: "push" },
      });
      expect(pushResult?.block).toBe(true);
    });
  });

  describe("observation hook for PASS stamping", () => {
    it("does not stamp tokens from inside tool_call (that is the tool_result hook's job)", async () => {
      const tokens = createPassTokenStore();
      const pi = createMockPi();
      registerPushGateHook(pi as never, {
        tokens,
        getHeadSha: () => "head123",
      });
      await fireHook(pi, {
        toolName: GATED_TOOL,
        toolCallId: "tc1",
        input: { action: "push" },
      });
      // tool_call only vetoes; it never stamps. Stamping happens on the
      // review-result observation path, not here.
      expect(tokens.hasPass("head123")).toBe(false);
    });
  });

  describe("unused param safety", () => {
    it("does not throw when input has no action field", async () => {
      const tokens = createPassTokenStore();
      const pi = createMockPi();
      registerPushGateHook(pi as never, {
        tokens,
        getHeadSha: () => "head123",
      });
      const result = await fireHook(pi, {
        toolName: GATED_TOOL,
        toolCallId: "tc1",
        input: {} as ToolCallEvent["input"],
      });
      // No action => not a gated call => allow
      expect(result).toBeUndefined();
    });
  });
});
