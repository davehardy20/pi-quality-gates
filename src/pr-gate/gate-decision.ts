/**
 * decidePushGate — the PURE decision core of the PR review gate.
 *
 * Given a gate event (push / pr_create / other), the current HEAD sha, an
 * optional just-arrived review report, and the PASS token store, return a
 * GateDecision. This function has NO side effects on the filesystem and does
 * NOT call Pi APIs — the tool_call hook wrapper is responsible for translating
 * a GateDecision into a { block: true, reason } return or an allow.
 *
 * SAFETY INVARIANTS (enforced here, tested in gate-decision.test.ts):
 *  - The ONLY way to verdict=allow is a PASS token for the exact HEAD sha, OR
 *    a review report with status==="PASS" just supplied (which also stamps the
 *    token so future calls allow without re-review).
 *  - CRITICAL security findings escalate (verdict=escalate) regardless of
 *    anything else and require human acknowledgement.
 *  - Empty/malformed HEAD sha always blocks — cannot prove a pass.
 *  - Unrecognized gated actions block (fail-closed). Non-gated actions noop.
 *  - ISSUES / CANNOT_REVIEW never stamp and always block the gated action.
 */

import { hasCriticalSecurityFinding } from "../shared/review-severity.js";
import type { ReviewReport } from "../shared/review-types.js";
import type { PassToken, PassTokenStore } from "./pass-token-store.js";

/** The mutating actions the gate intercepts. */
export type GatedAction = "push" | "pr_create";

/** A non-gated action passes through unchanged. */
export type GateAction = GatedAction | "other";

export interface PushGateInput {
  /** The action being intercepted (push, pr_create, or other). */
  action: GateAction;
  /** Current HEAD sha. Empty/malformed => block. */
  headSha: string;
  /** Base sha for the PR (informational; future use for diff scoping). */
  baseSha: string;
  /** The PASS token store. */
  tokens: PassTokenStore;
  /** An optional review report that just arrived for this HEAD. */
  reviewReport?: ReviewReport;
}

export interface GateDecision {
  /**
   * allow  — gated action may proceed (PASS proven).
   * block  — gated action MUST NOT proceed; steer is set.
   * escalate — human acknowledgement required before release.
   * noop   — action is not gated; pass through unchanged.
   */
  verdict: "allow" | "block" | "escalate" | "noop";
  /** Human/agent-readable reason. Required for block and escalate. */
  reason?: string;
  /** Instruction the agent should act on (run review / fix / wait for ack). */
  steer?: string;
  /** True iff verdict=escalate and a human must ack before release. */
  requiresHumanAck?: boolean;
}



/**
 * Core decision. Pure. Side effects limited to optionally stamping a PASS
 * token into the supplied store when a PASS report arrives — which is the
 * intended mutation and is idempotent.
 */
export function decidePushGate(input: PushGateInput): GateDecision {
  const { action, headSha, tokens, reviewReport } = input;

  // Explicitly non-gated actions pass through. Anything else that is not a
  // recognized gated action is treated as unrecognized and fails closed.
  if (action === "other") {
    return { verdict: "noop" };
  }
  if (action !== "push" && action !== "pr_create") {
    return {
      verdict: "block",
      reason: `PR review gate: unrecognized gated action "${action}". Only push and pr_create are gated.`,
      steer: `Run /pr-review for HEAD ${headSha} to obtain a review PASS, then retry with a recognized action.`,
    };
  }

  // If a review report just arrived, evaluate it FIRST — it may stamp a token
  // (PASS), escalate (CRITICAL security), or send us to the fix loop (ISSUES).
  if (reviewReport) {
    if (hasCriticalSecurityFinding(reviewReport)) {
      return {
        verdict: "escalate",
        requiresHumanAck: true,
        reason: `CRITICAL security finding(s) in review for HEAD ${headSha}. Human acknowledgement required before push.`,
        steer:
          "Resolve the CRITICAL security findings or obtain explicit human acknowledgement before retrying the push.",
      };
    }
    if (reviewReport.status === "PASS") {
      // Stamp the token so the retry push (same sha) allows without re-review.
      const token: PassToken = {
        sha: headSha,
        passedAt: Date.now(),
        reportStatus: "PASS",
        summary: reviewReport.summary,
      };
      tokens.stampPass(token);
      return { verdict: "allow" };
    }
    // ISSUES or CANNOT_REVIEW — block and steer to fix loop.
    return {
      verdict: "block",
      reason: `Review for HEAD ${headSha} returned ${reviewReport.status}. PASS required before push.`,
      steer:
        reviewReport.status === "ISSUES"
          ? "Fix the review findings on the affected files, wait for lint-clean, then re-run /pr-review."
          : "Review could not complete (CANNOT_REVIEW). Investigate the reviewer output and re-run /pr-review.",
    };
  }

  // No new report. Allow iff a PASS token already covers this exact HEAD sha.
  if (tokens.hasPass(headSha)) {
    return { verdict: "allow" };
  }

  // Fail-closed: no token, no fresh PASS. Block + steer to review.
  // Includes the empty/malformed headSha case (hasPass("") is always false).
  return {
    verdict: "block",
    reason: `No review PASS for HEAD ${headSha || "(unknown)"}. Run /pr-review before push.`,
    steer: `Run /pr-review for HEAD ${headSha} to obtain a review PASS, then retry the push.`,
  };
}
