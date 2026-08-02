<!-- markdownlint-disable MD013 MD032 -->

# PR Gate

Gates `git_safe push` / `gh_safe pr_create` behind a **PASS token**. The hook vetoes publishing until the current HEAD has been reviewed. A review is requested two ways, both over the **same shared coordinator**: the human `/pr-review` command, or the agent-callable `pr_review` custom tool. On PASS it stamps a token for that HEAD.

## Architecture overview

```text
Agent calls git_safe push / gh_safe pr_create
         │
         ▼
   push-gate-hook (tool_call interceptor)     ← src/pr-gate/push-gate-hook.ts
         │
         ▼
   decidePushGate                              ← src/pr-gate/gate-decision.ts
         │                              ▲
         │ hasPass(sha)?           stampPass(PASS report)
         ▼                              │
   allow / block / escalate         pr-review-dispatch.ts
         │                              │
         │                         reviewer.ts (spawn child Pi)
         │                              │
         │                         parseReviewReport
         │                              │
   /pr-review command ──────────────► dispatch ──► ReviewReport
```

**Core design principle**: The gate **only vetoes** — it never calls `gh_safe`/`git_safe` push/pr_create itself (actor separation). The main agent remains the sole publisher.

## PASS token flow

Tokens are stored in-memory via `PassTokenStore` (`src/pr-gate/pass-token-store.ts`) — a closure over `Map<string, PassToken>` keyed by sha.

| Method | Behaviour |
|---|---|
| `hasPass(sha)` | Check if token exists for sha |
| `stampPass(token)` | Store token — **only `reportStatus: "PASS"` stamps**; empty/whitespace shas rejected; silently no-ops otherwise |
| `get(sha)` | Retrieve token |
| `invalidate(sha)` | Remove token for sha (exists but unused in current codebase) |
| `clear()` | Remove all tokens |
| `size` | Count |

**Token lifecycle:**
1. **Created**: `decidePushGate` stamps a token when a `reviewReport` with `status === "PASS"` arrives. Alternatively, `stampPassFromReview` in `index.ts` stamps via `decidePushGate` with a minimal PASS stub.
2. **Checked**: `push-gate-hook` calls `decidePushGate` which checks `tokens.hasPass(headSha)`.
3. **Invalidated**: Automatically when HEAD changes (new commit = new sha, old token doesn't match). No persistence — session reload clears all tokens (fail-safe default: re-review required).

## Gate decision logic

`src/pr-gate/gate-decision.ts` — the pure decision core. Given `{ action, headSha, baseSha, tokens, reviewReport? }`, returns a `GateDecision` with `verdict: "allow"|"block"|"escalate"|"noop"`.

**Complete truth table:**

| action | headSha | reviewReport | tokens.hasPass | → verdict |
|---|---|---|---|---|
| `other` | * | * | * | **noop** (pass through) |
| `push`/`pr_create` | * | CRITICAL security | * | **escalate** (`requiresHumanAck: true`) |
| `push`/`pr_create` | valid | status=PASS | * | **allow** (+ stamps token) |
| `push`/`pr_create` | valid | ISSUES | * | **block** (fix loop steer) |
| `push`/`pr_create` | valid | CANNOT_REVIEW | * | **block** (investigate) |
| `push`/`pr_create` | valid | (none) | true | **allow** |
| `push`/`pr_create` | valid | (none) | false | **block** (run /pr-review) |
| `push`/`pr_create` | empty | (none) | * | **block** (cannot prove pass) |
| unrecognized | * | * | * | **block** (fail-closed) |

**Invariants:**
- The **only** way to `verdict = "allow"` is a PASS token for the exact HEAD sha, or a fresh PASS report (which also stamps the token).
- CRITICAL security findings **always escalate** regardless of anything else.
- Empty/malformed HEAD sha **always blocks**.
- Unrecognised actions **always block** (fail-closed).

## Push gate hook

`src/pr-gate/push-gate-hook.ts` — the `tool_call` interceptor. Registered via `registerPushGateHook(pi, deps)`.

**Hook logic:**
1. Only inspects calls to `git_safe` or `gh_safe` (`GATED_TOOL_NAMES`).
2. If gate disabled → pass through.
3. Infers action from `event.input` (checks `.action`, `.command`, `.args[0]`).
4. Only `push` and `pr_create` are gated (`DEFAULT_GATED_ACTIONS`); other git/gh actions pass through.
5. Resolves HEAD sha — **any error or empty sha results in BLOCK** (fail-safe).
6. Delegates to `decidePushGate`, maps verdict to `{ block: true, reason }` or `undefined` (allow).
7. Unknown verdict → block (fail-closed).

**FAIL-SAFE contract**: any error (git rev-parse failure, throwing getter, malformed input) → BLOCK, never allow. This hook only vetoes — it never stamps tokens and never publishes.

## Child Pi reviewer dispatch

`src/pr-gate/pr-review-dispatch.ts` — `createPrReviewDispatch(partialDeps?)` returns `{ dispatch }`.

**Dispatch flow:**
1. Resolve HEAD sha → block if unknown.
2. If already has PASS token (and not re-review) → early return "already has PASS".
3. Check `isLinterClean(ctx)` → block if linter reported findings.
4. Run `runPrReview()`:
   - Resolve base ref (defaults: `origin/master` → `origin/main` → `master` → `main` → `HEAD~1`).
   - List changed files via `git diff --name-only`.
   - Load and apply `.gitignore` plus `.pi/reviewer.skip` filters to the review file scope; block if every changed file is excluded.
   - Count changed lines in the filtered scope → reject if it exceeds `maxChangedLines` (5000).
   - Pass the filtered file list to repository-direct sandbox review. For legacy/injected execution, gather a capped diff (`maxDiffLines` = 4000). The orchestrator bridge (`PI_PR_REVIEW_BRIDGE=orchestrator`) skips parent diff materialization.
   - Extract original task from session entries.
   - Generate test execution plan.
   - Call `reviewerExecution.runAttempt()`.
5. Parse report:
   - No parseable report → block with sidecar hint.
   - CRITICAL security finding → escalate.
   - **PASS but missing/failed test execution** → convert to `CANNOT_REVIEW` and block.
   - PASS → stamp token, return `stamped=true`.
   - CANNOT_REVIEW → block.
   - ISSUES → build fix instruction, inject as user message via `pi.sendUserMessage()`, block.

### `isLinterClean`

`isLinterClean(ctx)` scans the session branch for the most recent `post-turn-linter-status` entry. Returns `true` if clean or no entry exists. This is the bridge between the linter subsystem and the PR gate — review is blocked until the linter reports clean.

## Reviewer engine

`src/pr-gate/index.ts` selects the reviewer execution bridge at startup
(`PrReviewerBridgeMode`, env `PI_PR_REVIEW_BRIDGE`). The **default `host`
bridge** (`src/pr-gate/reviewer.ts`) spawns a read-only headless child Pi that
runs the safe validation runners against the repository checkout, where
dependencies already live — the review is read-only, so the Apple-container
sandbox (reserved for mutating workers) is not required. Opt back into the
sandboxed orchestrator `pr-reviewer` with `PI_PR_REVIEW_BRIDGE=orchestrator`
once the container reviewer is stable.

**Orchestrator bridge dispatch** (`PI_PR_REVIEW_BRIDGE=orchestrator`):
- Creates a unique `PR_REVIEW_REQUEST_ID`.
- Sends a bounded parent follow-up containing request/head/base metadata, a capped task/test-plan summary, and at most 32 capped file paths.
- Deliberately excludes the full diff; the sandbox reviewer inspects `baseRef..HEAD` directly.
- Listens for the matching `tool_result` from `orchestrate`.
- Parses a well-formed report even when `orchestrate` marks the result as an error, but stamps PASS only with explicit request-ID correlation, the exact recorded HEAD, and all normal PASS blockers satisfied; the raw error exit remains preserved. Malformed or uncorrelated error output fails closed.
- Bounds result capture at 262,144 characters and fails closed on overflow.
- Fails closed if `orchestrate` is unavailable, the request times out, or the session shuts down. Shutdown clears pending timers/correlation state.

`src/pr-gate/reviewer.ts` is the default host bridge: report parsing,
injectable reviewer execution, and `spawnReviewer` (the headless child Pi). The
host bridge materializes a capped diff (`maxDiffLines` = 4000) and passes it to
the child; the orchestrator bridge sets `inspectRepositoryDirectly` and skips
parent diff materialization.

Legacy direct child capture is also pre-close bounded: 1,048,576 characters per JSON line, 262,144 characters of assistant output, and 65,536 characters of stderr. Overflow produces a parse-failure sidecar and cannot stamp PASS.

**Report parsing** (`parseReviewReport`):
- Finds `## Review Report` marker (regex, case-insensitive).
- Extracts `STATUS:`, `CONFIDENCE:` fields.
- Parses `#### [SEVERITY] title` finding blocks → extracts File, Category, Rule, Issue, Evidence, Suggestion.
- Parses bullet-list sections: "What was verified", "What could not be verified".
- Parses "Test execution" subsection (Status, Summary, Sidecar).
- Parses "Summary" free text.

**Prompt rendering:**
- `readSystemPrompt(promptsDir)` → reads `system.md`.
- `renderTaskTemplate(promptsDir, task, files, diff, testPlan?)` → renders `task-template.md` with `{{TASK}}`, `{{FILES}}`, `{{DIFF}}`, `{{TEST_PLAN}}` placeholders.

## Reviewer tool policy

`src/pr-gate/pr-review-config.ts` defines review limits plus a legacy/injected
tool allowlist and blocklist.

**`PR_REVIEW_CONFIG`** (source: `src/pr-gate/pr-review-config.ts`):
- Model: `openai-codex/gpt-5.5` *(verify in source)*
- `timeoutMs: 45 * 60_000` (45 minutes)
- `maxDiffLines: 4000`, `maxChangedLines: 5000`
- Tool policy intentionally excludes host publishing and durable state mutation

**`PR_REVIEWER_FORBIDDEN_TOOLS`**: bash, git_safe, gh_safe, write/edit-style
mutation tools, and all mulch/seeds mutating tools. This allowlist protects
legacy/dependency-injected reviewer execution.

The configured reviewer bridge runs the review. The default `host` bridge runs
`git_inspect_safe` and custom validation runners on the host; the `orchestrator`
bridge (`PI_PR_REVIEW_BRIDGE=orchestrator`) runs the `pr-reviewer` inside a
disposable Apple container, where the parent instruction permits sandbox-local
read-only Git and trusted package scripts when runners are unavailable. Host
mutation and publishing remain forbidden on both paths, and unverifiable
HEAD/base state still fails closed.

**`assertPrReviewerToolPolicy()`**: startup-time safety check — throws if any
forbidden tool appears in `PR_REVIEW_CONFIG.tools`.

## Test execution plan

`src/pr-gate/test-execution.ts` — detects project ecosystem and recommends safe validation runner commands.

**Ecosystem detection** (`detectProjectEcosystem`): checks for `package.json`, `Cargo.toml`, `pyproject.toml`/`setup.py`, `go.mod`.

**Recommended commands per ecosystem:**

| Ecosystem | Commands | Scope |
|---|---|---|
| TypeScript | `run_vitest <test-files>` → `run_typecheck` → `run_biome src test` | Targeted first |
| Python | `run_pytest <test-files>` → broad `run_pytest` | Targeted first |
| Rust | `run_cargo_test` | All |
| Go | No runner commands, discovery only | — |

**Invariant**: A PASS requires executed validation. The default `host` bridge
runs the safe validation runners (e.g. `run_typecheck`) against the repository
checkout; the `orchestrator` bridge runs them in the Apple container sandbox
via `container_safe`.

**Mandatory test execution**: A review report that says PASS but omits `### Test execution` or reports `FAIL`/`NOT_RUN` is overridden to `CANNOT_REVIEW` and blocked (enforced in `pr-review-dispatch.ts`).

## Auto-review trigger

`src/pr-gate/auto-review-trigger.ts` contains the retired post-turn auto-review helper.
The package no longer registers it from `src/pr-gate/index.ts`; explicit `/pr-review`
or a governed Seeds closeout path should request review intentionally.

Manual `/pr-review` still bypasses PASS-token early return when a base ref is supplied,
and the push/pr_create gate remains fail-closed until the exact HEAD has a PASS token.

## Reviewer skip filter

`src/pr-gate/reviewer-skip.ts` — parses `.pi/reviewer.skip` files (gitignore format) to exclude files from review diff scope. Uses the `ignore` npm package. Returns a NOOP filter on ENOENT.

## Review scope and diff

`src/shared/review-scope.ts` — shared diff gathering and file filtering:

- `gatherDiff(files, cwd, maxLines, baseRef?, filterOptions?)` — generates `git diff`, handles untracked files via `git diff --no-index /dev/null`, caps at `maxLines`.
- `countDiffLinesFast(files, cwd, baseRef?)` — uses `git diff --numstat` for cheap counting.
- `filterGitignoredFiles(files, cwd)` — uses `git check-ignore --stdin -z`.
- `extractOriginalTask(entries)` — scans session entries in reverse for last user message text.

**Filtering order**: (1) `.gitignore` via `git check-ignore`, then (2) `.pi/reviewer.skip` via `ignore` package.

## Prompts

Located in `src/pr-gate/prompts/`:

| File | Purpose |
|---|---|
| `system.md` | Full system prompt — all 7 review domains inline, test execution instructions, output format |
| `pr-reviewer-system.md` | PR-specific variant — references shared checklist, mentions Apple container sandbox |
| `task-template.md` | Task prompt template with `{{TASK}}`, `{{FILES}}`, `{{DIFF}}`, `{{TEST_PLAN}}` placeholders |
| `pr-reviewer-task.md` | Identical content to `task-template.md` |

The 7 review domains (source: `src/shared/review-checklist.md`):
1. Task Completion
2. Correctness & Logic
3. Error Handling & Robustness
4. Security (OWASP-Informed)
5. Code Quality & Maintainability
6. Testing & Verification
7. Documentation & Contracts

## Commands

Registered in `src/pr-gate/index.ts`:

| Command / Tool | Behavior |
|---|---|
| `/pr-review [baseRef]` | Run PR review for current HEAD. Optional base ref arg. `status` subcommand shows state. |
| `/pr-review-status` | Show PR review state |
| `/pr-gate-status` | Show push gate state (enabled, gated actions, tokens) |
| `/pr-gate-toggle [on\|off]` | Enable or disable push gate |
| `/pr-gate-test-block` | Simulate hook decision without actually pushing |
| `pr_review` (LLM tool) | Agent-callable custom tool that requests the same review as `/pr-review` over the shared coordinator (configured reviewer bridge). Asynchronous kickoff; returns compact structured state. |

## Agent-callable `pr_review` tool

> The full agent's-perspective runbook — kickoff states, the end-to-end loop,
> and the consolidated safety contract — lives in
> [Agent-Driven Review Workflow](agent-review-workflow.md). The mechanism
> details below remain the canonical reference for this file.

`src/pr-gate/pr-review-tool.ts` defines a Pi custom tool named `pr_review`,
registered once from `src/pr-gate/index.ts` via `pi.registerTool(...)`. It lets
an autonomous agent request the gate-compatible review without a human running
`/pr-review`.

**Shared coordinator (single source of truth).** Both `/pr-review` and
`pr_review` go through `createReviewCoordinator()` in
`src/pr-gate/review-coordinator.ts` — one dispatch instance, one in-progress
 guard, one exact-HEAD token store, and one set of eligibility checks. There is
no second review or stamping path.

**Asynchronous by design.** The tool's `execute` runs the synchronous
eligibility checks and kicks off the background dispatch, then returns compact
kickoff state. It never blocks on completion — awaiting the follow-up would
deadlock (a tool result cannot run until the current tool batch completes).

Completion depends on the configured reviewer bridge:

- **host (default):** `src/pr-gate/reviewer.ts` spawns a headless child Pi that
  runs read-only validation and returns the report; the dispatch resumes and
  stamps a PASS token only for the exact reviewed HEAD.
- **orchestrator** (`PI_PR_REVIEW_BRIDGE=orchestrator`): the dispatch does NOT
  await the later `orchestrate` tool result; the matching `tool_result` handler
  in `orchestrator-reviewer-execution.ts` resumes the dispatch, parses the
  sandbox report, and stamps the same exact-HEAD PASS token.

**Kickoff states** (`ReviewKickoffStatus`): `started` | `already-passed` |
`in-progress` | `blocked` | `disabled`. The result carries only status,
identifying state (head sha, base ref), and a concise message — never bulky
report/diff/findings content (kept behind the dispatch result + sidecar
hygiene).

**Actor separation (firm).** `pr_review` and the coordinator NEVER call
`git_safe`, `gh_safe`, push, `pr_create`, update, or merge. They only request a
review and stamp gate state. The main agent remains the sole publisher through
the gated safe tools; the push gate stays fail-closed until the exact HEAD has
a PASS token. An agent that calls `pr_review` and a publishing tool in the same
parallel batch cannot bypass the gate — publication remains blocked until a
completed PASS is visible on the exact HEAD.

**Explicit base ref.** Supplying `baseRef` is treated consistently in both
wrappers as an intentional re-review: it bypasses the `already-passed` early
return even when the HEAD already has a token.

## Change-entrypoints

| To change... | Start at | Watch out for |
|---|---|---|
| Gated actions (push/pr_create) | `src/pr-gate/push-gate-hook.ts` → `DEFAULT_GATED_ACTIONS` | Must also update `inferAction` |
| Gate decision logic | `src/pr-gate/gate-decision.ts` → `decidePushGate` | Must maintain fail-closed invariants |
| PASS token behaviour | `src/pr-gate/pass-token-store.ts` | Only "PASS" stamps; no persistence |
| Reviewer tool allowlist | `src/pr-gate/pr-review-config.ts` → `PR_REVIEW_CONFIG` | Run `assertPrReviewerToolPolicy()` |
| Reviewer timeout/diff limits | `src/pr-gate/pr-review-config.ts` | Affects child Pi spawn and cost |
| Reviewer bridge (host vs container) | `src/pr-gate/index.ts` → `resolveReviewerBridgeMode` / `PI_PR_REVIEW_BRIDGE` | Host default; container needs the sandbox reviewer stable |
| Child Pi spawn args | `src/pr-gate/reviewer.ts` → `buildReviewerPiArgs` | Tool list must match policy |
| Report parsing format | `src/pr-gate/reviewer.ts` → `parseReviewReport` | Must match prompt output format in `system.md` |
| Base ref fallback chain | `src/pr-gate/pr-review-dispatch.ts` → `resolveBaseRef` | Ordered: origin/master → origin/main → master → main → HEAD~1 |
| Auto-review guards | `src/pr-gate/auto-review-trigger.ts` → `decideAutoReview` | Sticky `lastReviewedSha` prevents loops |
| Test execution recommendations | `src/pr-gate/test-execution.ts` | All via `container_safe` |
| Agent review kickoff logic | `src/pr-gate/review-coordinator.ts` → `createReviewCoordinator` | Shared by `/pr-review` and `pr_review`; keep parity |
| `pr_review` tool contract | `src/pr-gate/pr-review-tool.ts` | Tool stays async; never publishes |

## Invariants

1. The gate **only vetoes** — it never publishes.
2. Only `reportStatus: "PASS"` stamps a token.
3. Empty/malformed HEAD sha **always blocks**.
4. Unrecognised actions **always block** (fail-closed).
5. CRITICAL security findings **always escalate**.
6. PASS requires test execution — missing/failed tests → `CANNOT_REVIEW`.
7. Tokens are sha-scoped, not branch-scoped.
8. No persistence — session reload clears all tokens.
9. Auto-review sticky guard: once attempted, same HEAD not auto-attempted again.
10. Legacy/injected reviewer execution has no bash; the orchestrator bridge's disposable sandbox may use built-in shell only for sandbox-local read-only Git and trusted package scripts. Neither path permits host mutation or publishing.
11. `/pr-review` and `pr_review` share one coordinator, one in-progress guard, one dispatch instance, and one exact-HEAD token store — no duplicate review or stamping path.
12. `pr_review` is asynchronous: `execute` only kicks off the background dispatch and returns compact state; it never awaits the follow-up `orchestrate` result (no deadlock).
13. `pr_review` and the coordinator **never publish** — no `git_safe`/`gh_safe` push/pr_create/update/merge. The push gate stays fail-closed until the exact HEAD has a PASS token, so a parallel `pr_review` + publish batch cannot bypass it.
14. An explicit `baseRef` is an intentional re-review in both wrappers (bypasses the `already-passed` early return).

## Common failure modes

- **Token cleared on reload**: Session reload clears in-memory tokens. Re-run `/pr-review` after reload.
- **Linter not clean**: Review blocked by `isLinterClean`. Fix linter findings first.
- **Diff too large**: Diffs exceeding `maxChangedLines` (5000) are rejected before review. Use `.pi/reviewer.skip` to exclude files.
- **Report parse failure**: Child Pi output without `## Review Report` marker → sidecar written to `~/.pi/reviewer-failures/`. Check the sidecar for raw output.
- **Test execution missing**: Report says PASS but no `### Test execution` section → overridden to `CANNOT_REVIEW`. Ensure the reviewer runs test commands.
- **Base ref not found**: If `origin/master` doesn't exist, falls back through the chain. Verify the base ref exists.
- **Duplicate commands**: If Pi loads both this package and old local extension files. Disable old local extensions.

## Safe-edit guidance

- **Changing gate logic**: Always maintain the fail-closed contract. Any ambiguity or error → block. Add test cases to `test/pr-gate-gate-decision.test.ts`.
- **Adding a gated action**: Update `DEFAULT_GATED_ACTIONS` and `GATED_TOOL_NAMES`, ensure `inferAction` handles the new action shape.
- **Changing the reviewer tool list**: Update `PR_REVIEW_CONFIG.tools` and `PR_REVIEWER_FORBIDDEN_TOOLS`. Run `assertPrReviewerToolPolicy()` to verify. **Never** grant bash or mutating tools to the child reviewer.
- **Changing report format**: The parser in `parseReviewReport` and the output format in `system.md` are tightly coupled. Update both together. Add test cases to `test/reviewer.test.ts`.
- **Changing diff limits**: Update `maxDiffLines` and `maxChangedLines` in `pr-review-config.ts`. These are cost guards.

## Source map

| File | Purpose |
|---|---|
| `src/pr-gate/index.ts` | Extension entry point, command + tool registration, state factory |
| `src/pr-gate/gate-decision.ts` | Pure decision core (`decidePushGate`) |
| `src/pr-gate/push-gate-hook.ts` | `tool_call` interceptor (veto-only) |
| `src/pr-gate/pass-token-store.ts` | In-memory PASS token store |
| `src/pr-gate/pr-review-dispatch.ts` | Review orchestration |
| `src/pr-gate/reviewer.ts` | Child Pi spawn and report parsing |
| `src/pr-gate/pr-review-config.ts` | Reviewer tool policy and config |
| `src/pr-gate/auto-review-trigger.ts` | Linter-clean → auto-review bridge |
| `src/pr-gate/reviewer-skip.ts` | `.pi/reviewer.skip` parser |
| `src/pr-gate/test-execution.ts` | Ecosystem detection and test command recommendation |
| `src/pr-gate/review-coordinator.ts` | Shared review-start coordinator (`/pr-review` + `pr_review`) |
| `src/pr-gate/pr-review-tool.ts` | Agent-callable `pr_review` custom tool definition |
| `src/pr-gate/prompts/system.md` | Reviewer system prompt |
| `src/pr-gate/prompts/task-template.md` | Reviewer task template |
| `src/pr-gate/prompts/pr-reviewer-system.md` | PR-specific system prompt variant |
| `src/pr-gate/prompts/pr-reviewer-task.md` | PR-specific task template (identical to task-template.md) |
