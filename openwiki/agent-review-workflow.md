<!-- markdownlint-disable MD013 MD032 -->

# Agent-Driven Review Workflow

How an autonomous agent requests the gate-compatible PR review itself, how the
shared coordinator drives the review to completion, and which safety boundaries
are **retained** (not relaxed) when the agent — rather than a human — starts the
review.

This is the operational companion to [PR Gate](pr-gate.md). The gate mechanics
(PASS token flow, decision truth table, push hook) live there; this page covers
the **agent's perspective**: when to call `pr_review`, what each kickoff state
means, the end-to-end loop, and the consolidated safety contract.

> Source: `src/pr-gate/pr-review-tool.ts`, `src/pr-gate/review-coordinator.ts`,
> `src/pr-gate/index.ts`, `src/pr-gate/pr-review-dispatch.ts`,
> `src/pr-gate/orchestrator-reviewer-execution.ts`.

## Why an agent-callable review exists

Before `pr_review`, the PR gate could only be satisfied by a human running
`/pr-review`. That interrupted autonomous runs: an agent that had finished its
work was stuck at the gate until a person intervened. The `pr_review` custom tool
(plan pl-1461, seed `pi-quality-gates-ff15`) lets the agent request the **same**
reviewer-bridge review, over the **same** shared coordinator, so autonomy
no longer depends on a slash command — **without** granting the agent any
publication authority.

## The one-rule mental model

> `pr_review` only **requests a review and stamps gate state**. It never
> publishes. The agent remains the sole publisher, and the push gate stays
> fail-closed until the exact HEAD has a PASS token.

Everything else on this page follows from that rule.

## End-to-end workflow

```text
   1. Agent finishes scoped work
          │
          ▼
   2. Agent ensures linter is clean
      (post-turn linter auto-runs; fix any findings)
          │  linter clean
          ▼
   3. Agent calls  pr_review   ◄── single shared coordinator
          │  returns compact kickoff state (sync)
          ▼
   4. Coordinator runs eligibility checks
      gate disabled? │ linter dirty? │ HEAD unknown? │ already in progress? │ already PASS?
          │  eligible
          ▼
   5. Background dispatch starts (NOT awaited by execute)
          │
          ▼
   6. Configured reviewer bridge runs (read-only; no host mutation):
      host (default): headless child Pi runs validation against the checkout
      orchestrator (PI_PR_REVIEW_BRIDGE=orchestrator): host-side orchestrate verifier
          │
          ▼
   7. Bridge completion resumes dispatch → exact-HEAD PASS stamp (or block / escalate)
      host: child returns the report directly
      orchestrator: matching tool_result handler parses the child's report
          │
          ▼
   8. Completion message emitted
      pr-review-pass  │  pr-review-escalation  │  pr-review-status(blocked)
          │
          ▼
   9. Agent waits for the pass message, then re-checks, THEN publishes
      via git_safe push / gh_safe pr_create (still gated on exact-HEAD PASS)
```

**Critical ordering invariant:** the agent must NOT call `git_safe push` /
`gh_safe pr_create` in the same parallel batch as `pr_review`. `pr_review`
returns immediately with kickoff state; the PASS token is stamped only when the
background review completes and emits its message. Publishing in the same batch
is blocked because no PASS token exists yet.

## Kickoff states

`pr_review` resolves synchronously with compact structured state
(`ReviewKickoffResult` / `PrReviewToolDetails`). It carries **only** status,
identifying state (head sha, base ref), and a concise message — never the review
report, diff, or findings (those stay behind the dispatch result + sidecar/report
hygiene).

| `status` | Meaning | Agent action |
|---|---|---|
| `started` | Eligible; background dispatch kicked off | **Wait** for the `pr-review-pass` message before publishing. Do not publish in the same batch. |
| `already-passed` | Exact HEAD already has a PASS token | Publishing will be allowed; re-check then publish. |
| `in-progress` | A review is already running (shared in-progress guard) | Wait for the current review's completion message; do not start another. |
| `blocked` | Linter dirty, HEAD unknown, or other eligibility failure | Address the stated reason (fix linter findings / commit something) and retry. |
| `disabled` | PR gate is off | Reviews are not required; publication is not gated. |

The optional `baseRef` parameter requests an **intentional re-review**: it
bypasses the `already-passed` early return even when the HEAD already has a
token. This is identical behavior to passing a base ref to `/pr-review` —
command/tool parity.

## How the review actually completes

`pr_review.execute` is **asynchronous by design**:

1. It runs the synchronous eligibility checks via the shared coordinator and
   kicks off the background dispatch.
2. It returns compact kickoff state immediately.
3. It never blocks on completion — awaiting the follow-up would deadlock (a tool
   result cannot run until the current tool batch completes).
4. Completion depends on the configured reviewer bridge:
   - host (default): the headless child Pi returns the report directly.
   - orchestrator (`PI_PR_REVIEW_BRIDGE=orchestrator`): the matching `tool_result`
     handler in `orchestrator-reviewer-execution.ts` parses the child's report.
   Either way the dispatch stamps a PASS token **only for the exact reviewed HEAD**.
   The parent follow-up contains bounded metadata only; the full diff is not relayed through session context. The verifier child inspects the stated base ref and HEAD directly.
5. On completion the coordinator emits one of:
   - `pr-review-pass` — PASS report, exact-HEAD token stamped.
   - `pr-review-escalation` — CRITICAL security finding; requires human ack.
   - `pr-review-status` — blocked (ISSUES / CANNOT_REVIEW / parse failure / error),
     with the reason in the message.

A PASS report that omits the `### Test execution` section or reports `FAIL`/
`NOT_RUN` is overridden to `CANNOT_REVIEW` and blocked — the agent cannot stamp a
token by claiming PASS without verified tests.

On `session_shutdown`, the bridge cancels pending attempts, clears timers and request correlation, and the coordinator suppresses late UI/session messages. Reload therefore requires a fresh review.

## Retained safety boundaries

These are the boundaries the package enforces **regardless of whether the review
was started by `/pr-review` or `pr_review`**. None of them are relaxed for the
agent path.

### Actor separation (firm)

`pr_review` and the shared coordinator **never** call `git_safe`, `gh_safe`,
push, `pr_create`, update, or merge. They only request a review and stamp gate
state. The main agent remains the sole publisher through the gated safe tools.
An agent that calls `pr_review` and a publishing tool in the same parallel batch
**cannot** bypass the gate — publication stays blocked until a completed PASS is
visible on the exact HEAD.

### Single review path

`/pr-review` and `pr_review` share **one** coordinator, **one** in-progress
guard, **one** dispatch instance, **one** set of eligibility checks, and **one**
exact-HEAD token store (`createReviewCoordinator()` in
`src/pr-gate/review-coordinator.ts`). There is no second review or stamping path
that could drift and re-open pi-quality-gates-3225.

### Gate stays fail-closed

The push gate (`push-gate-hook.ts` → `gate-decision.ts`) is unchanged:

- The **only** way to `verdict = "allow"` is a PASS token for the exact HEAD
  sha, or a fresh PASS report (which also stamps the token).
- Empty/malformed HEAD sha **always blocks**.
- Unrecognised actions **always block**.
- CRITICAL security findings **always escalate** (regardless of how the review
  was started).
- Any hook error (git rev-parse failure, throwing getter, malformed input) →
  **BLOCK, never allow**.

### Exact-HEAD PASS stamping

A PASS token is stamped **only** for the sha the verifier child actually
reviewed (enforced in `orchestrator-reviewer-execution.ts`). The agent cannot
carry a token across a HEAD change, and there is no persistence — session reload
clears all tokens, so a re-review is required after reload (fail-safe default).

### Reviewer tool policy

The legacy/dependency-injected reviewer path is guarded by the strict tool policy
in `src/pr-gate/pr-review-config.ts`:

- No `bash`, no `git_safe`/`gh_safe`, no write/edit-style mutation tools.
- No mulch/seeds mutating tools.
- `assertPrReviewerToolPolicy()` runs at startup and **throws** if any forbidden
  tool appears in the allowed list.

The configured reviewer bridge runs the review, always host-side. The
default `host` bridge runs `git_inspect_safe` and custom validation runners
on the host; the `orchestrator` bridge (`PI_PR_REVIEW_BRIDGE=orchestrator`)
runs a host-side orchestrate `verifier`/`pr-review` child where the parent
instruction permits built-in read-only Git only; unavailable safe runners
are recorded as NOT_RUN and package scripts never run on the host. Host
mutation and publishing remain forbidden on both paths; HEAD/base
verification remains fail-closed.

### Linter prerequisite

`pr_review` is blocked unless `isLinterClean(ctx)` is true. This is the same
bridge `/pr-review` uses — review cannot start until the post-turn linter reports
clean.

### Compact, non-leaking kickoff state

The tool result deliberately carries no report, diff, or findings content. Bulky
reviewer output stays behind the dispatch result and the sidecar/report hygiene
machinery. The agent gets enough state to drive the loop, nothing more.

### No new publication authority

The agent gains the ability to **start** a review autonomously. It gains **no**
ability to publish, merge, or self-approve. Approval still requires the
reviewer bridge (host child or orchestrator verifier) to return PASS with
verified test execution, on the exact HEAD.

## Decision flowchart (agent view)

```text
                 ┌─────────────────────────────────────────────┐
                 │ Is the work scoped & the linter clean?      │
                 └──────────────────────┬──────────────────────┘
                          no            │            yes
                 ┌──────────────────────┘ └─────────────────────┐
                 ▼                                               ▼
          fix / wait for                                   call pr_review
          clean linter                                              │
                                                            kickoff status?
              ┌──────────────────┬──────────────────┬──────────────────┐
              ▼                  ▼                  ▼                  ▼
         disabled          already-passed      in-progress          started
         (publish not      (re-check, then     (wait for the        (WAIT for the
          gated)            publish)            completion          pr-review-pass
                                                  message)           message, THEN
                                                                     re-check &
                                                                     publish)
                                                                    │
                              if blocked → address reason (linter / commit), retry
                              if escalated → STOP, await human ack
```

## When the agent should NOT rely on `pr_review` alone

- **CRITICAL security escalation**: a `pr-review-escalation` message means a
  human ack is required. The agent must stop and wait; the gate will not allow
  publication and there is no self-service path around it.
- **After session reload**: all in-memory PASS tokens are cleared. Re-request a
  review even if one was previously green.
- **HEAD changed mid-review**: tokens are sha-scoped, not branch-scoped. A new
  commit needs a fresh review of the new HEAD.
- **Bulk retry / parallel kickoff**: the shared in-progress guard collapses
  duplicate concurrent requests to `in-progress`. Serialize review requests.

## Source map (agent-review path)

| File | Purpose |
|---|---|
| `src/pr-gate/pr-review-tool.ts` | Agent-callable `pr_review` custom tool definition |
| `src/pr-gate/review-coordinator.ts` | Shared coordinator (eligibility, kickoff, in-progress guard) — `/pr-review` + `pr_review` |
| `src/pr-gate/index.ts` | Registers the tool and the coordinator once |
| `src/pr-gate/pr-review-dispatch.ts` | Background dispatch (diff scope, report parsing, stamp/escalate/block) |
| `src/pr-gate/orchestrator-reviewer-execution.ts` | Host-side orchestrator dispatch + exact-HEAD PASS stamping |
| `src/pr-gate/pr-review-config.ts` | Reviewer tool policy + `assertPrReviewerToolPolicy()` |
| `src/pr-gate/gate-decision.ts` | Fail-closed decision core (unchanged by the agent path) |
| `src/pr-gate/push-gate-hook.ts` | Veto-only `tool_call` interceptor (unchanged by the agent path) |

## Invariants

1. `pr_review` and the coordinator **never publish** — no
   `git_safe`/`gh_safe` push/pr_create/update/merge.
2. `/pr-review` and `pr_review` share one coordinator, one in-progress guard, one
   dispatch instance, and one exact-HEAD token store — no duplicate path.
3. `pr_review` is asynchronous: `execute` kicks off the background dispatch and
   returns compact state; it never awaits the follow-up `orchestrate` result.
4. The push gate stays fail-closed until the exact HEAD has a PASS token; a
   parallel `pr_review` + publish batch cannot bypass it.
5. An explicit `baseRef` is an intentional re-review in both wrappers.
6. The kickoff result carries no report/diff/findings content.
7. Legacy/injected execution has no bash; the orchestrator bridge's verifier
   child may use built-in read-only Git only. When a safe validation runner is
   unavailable, that validation is recorded as NOT_RUN; package scripts from
   the reviewed checkout never run on the host. Neither path permits host
   mutation or publishing.
8. PASS requires verified test execution; missing/failed tests →
   `CANNOT_REVIEW` → blocked.
