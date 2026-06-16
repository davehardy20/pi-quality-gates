/**
 * PassTokenStore — per-HEAD review pass tokens for the PR gate.
 *
 * The gate blocks `gh_safe pr_create` / `git_safe push` unless a PASS token
 * exists for the current HEAD sha. A new commit invalidates coverage because
 * the sha changes; tokens are sha-scoped, not branch-scoped.
 *
 * PURE in-memory store. No persistence — a session reload clears all tokens,
 * which is the fail-safe default (re-review required after reload). A future
 * revision may add an opt-in session-scoped sidecar for reload survival.
 *
 * Safety invariants enforced here:
 *  - Only `reportStatus: "PASS"` stamps a token. ISSUES / CANNOT_REVIEW never do.
 *  - Empty/whitespace shas are rejected (defensive against malformed git output).
 *  - All mutators are synchronous and side-effect-free aside from the Map.
 */

export interface PassToken {
  /** The HEAD sha this pass covers. */
  sha: string;
  /** Epoch ms when the pass was stamped. */
  passedAt: number;
  /** Always "PASS" — kept in the type for forward-compat with escalated acks. */
  reportStatus: "PASS";
  /** Optional human-readable summary from the review report. */
  summary?: string;
}

export interface PassTokenStore {
  /** True iff a PASS token exists for this exact sha. */
  hasPass(sha: string): boolean;
  /** The stamped token for this sha, or null. */
  get(sha: string): PassToken | null;
  /**
   * Stamp a PASS token for a sha. NO-OP if reportStatus !== "PASS" or sha is
   * empty/whitespace. Re-stamping the same sha replaces the prior entry.
   */
  stampPass(token: PassToken): void;
  /** Remove the token for a single sha (no-op if absent). */
  invalidate(sha: string): void;
  /** Remove all tokens. */
  clear(): void;
  /** Current number of stamped tokens. */
  get size(): number;
}

function isValidSha(sha: string): boolean {
  return typeof sha === "string" && sha.trim().length > 0;
}

export function createPassTokenStore(): PassTokenStore {
  const tokens = new Map<string, PassToken>();

  return {
    hasPass(sha: string): boolean {
      return tokens.has(sha);
    },

    get(sha: string): PassToken | null {
      return tokens.get(sha) ?? null;
    },

    stampPass(token: PassToken): void {
      // Defensive: only a genuine PASS stamps. This guards against callers
      // that might pass the raw review report status through unchanged.
      if (token.reportStatus !== "PASS") return;
      if (!isValidSha(token.sha)) return;
      tokens.set(token.sha, { ...token });
    },

    invalidate(sha: string): void {
      tokens.delete(sha);
    },

    clear(): void {
      tokens.clear();
    },

    get size(): number {
      return tokens.size;
    },
  };
}
