import { describe, expect, it } from "vitest";
import {
  decidePushGate,
  type GateDecision,
} from "../src/pr-gate/gate-decision.js";
import { createPassTokenStore } from "../src/pr-gate/pass-token-store.js";
import type { ReviewReport } from "../src/shared/review-types.js";

function makeReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    status: "PASS",
    confidence: "HIGH",
    findings: [],
    verified: [],
    unverifiable: [],
    summary: "",
    ...overrides,
  };
}

describe("decidePushGate", () => {
  describe("push / pr_create with an active PASS token for HEAD", () => {
    it("ALLOWs when a PASS token exists for the exact HEAD sha", () => {
      const tokens = createPassTokenStore();
      tokens.stampPass({
        sha: "head123",
        passedAt: 1000,
        reportStatus: "PASS",
      });
      const decision = decidePushGate({
        action: "push",
        headSha: "head123",
        tokens,
        baseSha: "base000",
      });
      expect(decision.verdict).toBe("allow");
      expect(decision.reason).toBeUndefined();
    });

    it("ALLOWs pr_create the same way as push", () => {
      const tokens = createPassTokenStore();
      tokens.stampPass({
        sha: "head123",
        passedAt: 1000,
        reportStatus: "PASS",
      });
      const decision = decidePushGate({
        action: "pr_create",
        headSha: "head123",
        tokens,
        baseSha: "base000",
      });
      expect(decision.verdict).toBe("allow");
    });
  });

  describe("push / pr_create WITHOUT a PASS token", () => {
    it("BLOCKs with a steer-to-review reason when no token exists", () => {
      const tokens = createPassTokenStore();
      const decision = decidePushGate({
        action: "push",
        headSha: "head123",
        tokens,
        baseSha: "base000",
      });
      expect(decision.verdict).toBe("block");
      expect(decision.reason).toContain("head123");
      // The block reason must instruct the agent to run the review
      expect(decision.steer).toMatch(/pr-review|review/i);
    });

    it("BLOCKs when a token exists for a DIFFERENT sha (new commit)", () => {
      const tokens = createPassTokenStore();
      tokens.stampPass({
        sha: "old1234",
        passedAt: 1000,
        reportStatus: "PASS",
      });
      const decision = decidePushGate({
        action: "push",
        headSha: "new1234",
        tokens,
        baseSha: "base000",
      });
      expect(decision.verdict).toBe("block");
    });
  });

  describe("PASS stamping from a review report", () => {
    it("stamps a token when a PASS report is provided for the HEAD", () => {
      const tokens = createPassTokenStore();
      const decision = decidePushGate({
        action: "push",
        headSha: "head123",
        tokens,
        baseSha: "base000",
        reviewReport: makeReport({ status: "PASS" }),
      });
      // Review came back PASS — gate allows the push
      expect(decision.verdict).toBe("allow");
      // And the token is now stamped for future calls
      expect(tokens.hasPass("head123")).toBe(true);
    });

    it("does NOT stamp on ISSUES and BLOCKs with a fix steer", () => {
      const tokens = createPassTokenStore();
      const decision = decidePushGate({
        action: "push",
        headSha: "head123",
        tokens,
        baseSha: "base000",
        reviewReport: makeReport({ status: "ISSUES" }),
      });
      expect(decision.verdict).toBe("block");
      expect(tokens.hasPass("head123")).toBe(false);
      // Must steer toward fixing the issues
      expect(decision.steer).toMatch(/fix|issu/i);
    });

    it("does NOT stamp on CANNOT_REVIEW and BLOCKs", () => {
      const tokens = createPassTokenStore();
      const decision = decidePushGate({
        action: "push",
        headSha: "head123",
        tokens,
        baseSha: "base000",
        reviewReport: makeReport({ status: "CANNOT_REVIEW" }),
      });
      expect(decision.verdict).toBe("block");
      expect(tokens.hasPass("head123")).toBe(false);
    });
  });

  describe("CRITICAL security escalation", () => {
    it("ESCALATES (human ack required) on a CRITICAL security finding", () => {
      const tokens = createPassTokenStore();
      const decision = decidePushGate({
        action: "push",
        headSha: "head123",
        tokens,
        baseSha: "base000",
        reviewReport: makeReport({
          status: "ISSUES",
          findings: [
            {
              severity: "CRITICAL",
              domain: "security",
              title: "RCE",
              file: "src/x.ts",
              rule: "no-rce",
              issue: "eval of user input",
              evidence: "eval(req.body)",
              suggestion: "don't",
            },
          ],
        }),
      });
      expect(decision.verdict).toBe("escalate");
      expect(decision.requiresHumanAck).toBe(true);
    });

    it("ESCALATES even if other findings are non-critical", () => {
      const tokens = createPassTokenStore();
      const decision = decidePushGate({
        action: "push",
        headSha: "head123",
        tokens,
        baseSha: "base000",
        reviewReport: makeReport({
          status: "ISSUES",
          findings: [
            {
              severity: "NIT",
              domain: "quality",
              title: "naming",
              file: "src/y.ts",
              rule: "naming",
              issue: "x",
              evidence: "x",
              suggestion: "x",
            },
            {
              severity: "CRITICAL",
              domain: "security",
              title: "sql injection",
              file: "src/db.ts",
              rule: "no-sqli",
              issue: "concatenated query",
              evidence: "x",
              suggestion: "x",
            },
          ],
        }),
      });
      expect(decision.verdict).toBe("escalate");
    });

    it("does NOT escalate on a non-security CRITICAL (treats as fix loop)", () => {
      const tokens = createPassTokenStore();
      const decision = decidePushGate({
        action: "push",
        headSha: "head123",
        tokens,
        baseSha: "base000",
        reviewReport: makeReport({
          status: "ISSUES",
          findings: [
            {
              severity: "CRITICAL",
              domain: "correctness",
              title: "off-by-one",
              file: "src/loop.ts",
              rule: "bounds",
              issue: "x",
              evidence: "x",
              suggestion: "x",
            },
          ],
        }),
      });
      // Correctness CRITICAL goes to the fix loop, not human escalation
      expect(decision.verdict).toBe("block");
    });
  });

  describe("fail-safe behavior", () => {
    it("BLOCKs when headSha is empty/malformed (cannot prove a pass)", () => {
      const tokens = createPassTokenStore();
      const decision = decidePushGate({
        action: "push",
        headSha: "",
        tokens,
        baseSha: "base000",
      });
      expect(decision.verdict).toBe("block");
    });

    it("BLOCKs (never allows) when the gate action is unrecognized", () => {
      const tokens = createPassTokenStore();
      tokens.stampPass({
        sha: "head123",
        passedAt: 1000,
        reportStatus: "PASS",
      });
      // Unrecognized action — must NOT silently allow
      const decision = decidePushGate({
        action: "something_else" as "push",
        headSha: "head123",
        tokens,
        baseSha: "base000",
      });
      expect(decision.verdict).toBe("block");
    });
  });

  describe("no-op actions", () => {
    it("passes through (allow) for non-gated actions", () => {
      const tokens = createPassTokenStore();
      const decision = decidePushGate({
        action: "other",
        headSha: "head123",
        tokens,
        baseSha: "base000",
      });
      expect(decision.verdict).toBe("noop");
    });
  });

  describe("GateDecision type shape", () => {
    it("always returns a verdict and a reason when blocking/escalating", () => {
      const tokens = createPassTokenStore();
      const blocked = decidePushGate({
        action: "push",
        headSha: "head123",
        tokens,
        baseSha: "base000",
      });
      const escalation = decidePushGate({
        action: "push",
        headSha: "head123",
        tokens,
        baseSha: "base000",
        reviewReport: makeReport({
          status: "ISSUES",
          findings: [
            {
              severity: "CRITICAL",
              domain: "security",
              title: "x",
              file: "x",
              rule: "x",
              issue: "x",
              evidence: "x",
              suggestion: "x",
            },
          ],
        }),
      });
      const allow = decidePushGate({
        action: "push",
        headSha: "head123",
        tokens,
        baseSha: "base000",
        reviewReport: makeReport({ status: "PASS" }),
      });

      const checkShape = (d: GateDecision) => {
        expect(d).toHaveProperty("verdict");
        if (d.reason) {
          expect(typeof d.reason).toBe("string");
          expect(d.reason.length).toBeGreaterThan(0);
        }
      };
      checkShape(blocked);
      checkShape(escalation);
      checkShape(allow);
    });
  });
});
