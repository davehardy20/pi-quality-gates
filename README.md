# @davehardy20/pi-quality-gates

Pi quality-gates bundle: post-turn linting, LSP diagnostics, and a PR review
gate that blocks unsafe publishing until changes are reviewed.

## What it adds

### Post-Turn Linter

- Automatically runs lint checks on files modified during each agent turn
- Supports: markdownlint, Biome, Ruff, cppcheck, tflint, cargo clippy, and Go (`gofmt` + `go vet`)
- Optional LSP diagnostics integration, including `gopls` for supplementary Go diagnostics
- Auto-fix follow-up turns for findings
- Summary-first finding reports that keep parent context bounded by default
- Full redacted linter reports are written to sidecars for manual recovery
- Built-in ignores for generated `agent/plans/*.md` and archived plan files
- `/post-turn-linter-run` — Run linter now (optionally pass file paths)
- `/post-turn-linter-fix` — Start a fix turn for the latest findings
- `/post-turn-linter-report` — Recover the latest sidecar report
  preview/slice/full
- `/post-turn-linter-status` — Show current linter state

### PR Gate

- Gates `gh_safe` `push` / `pr_create` behind a PASS token: the hook vetoes
  publishing until the current HEAD has been reviewed
- `/pr-review` prepares the PR diff, then runs the configured reviewer bridge
  (default host; orchestrator verifier child via `PI_PR_REVIEW_BRIDGE=orchestrator` —
  still host-side, never a container) to review it; on PASS it stamps a token for that HEAD
- An agent-callable `pr_review` custom tool requests the same review autonomously
  (over the shared coordinator) without a human running `/pr-review`
- The main agent remains the sole publisher; the gate only vetoes and steers
- The default host bridge runs read-only validation (`run_typecheck`, `run_vitest`,
  `run_biome`, etc.) against the repository checkout; the orchestrator bridge runs
  a host-side orchestrate verifier child (no container). Publishing and
  durable state mutation stay denied on both paths
- Validation plans run existing changed JS/TS test files individually with
  explicit five-minute initial budgets, retain whole-project typecheck, and
  lint only existing changed JS/TS/JSON/JSONC files. Failed or incomplete
  required checks still block PASS; this is not full CI or live-readiness proof
- Per-file test selection uses runner-specific entry basenames, never directory
  membership alone. Helpers stay linted; inspect configured and relevant tests
  separately.
- The orchestrator bridge refuses required plans over 4,000 characters rather
  than silently truncating checks. Split the PR or use a complete-plan bridge.
- On CRITICAL security findings the gate escalates for a human acknowledgement
- `/pr-review` — Run a PR review for the current HEAD (optional base ref arg)
- `pr_review` (LLM tool) — Agent-callable review request; asynchronous kickoff,
  same coordinator as `/pr-review`; never publishes
- `/pr-review-status` — Show PR review state
- `/pr-gate-status` — Show push gate state (enabled, gated actions, tokens)
- `/pr-gate-toggle` — Enable or disable the push gate

### Workflow

```text
Post-turn (per turn):
  Agent modifies files → turn_end fires
    → Post-turn-linter runs (mechanical checks)
      → findings → auto-fix turn → linter re-runs (loop)
      → clean   → done

PR gate (per publish):
  Agent calls gh_safe push / pr_create
    → tool_call hook vetoes (no PASS token) with a steer
    → agent runs /pr-review OR calls pr_review
      → review runs via the configured reviewer bridge (host default)
      → on PASS, token stamped; agent retries the push; hook allows
      → on ISSUES, agent fixes → lint-clean → re-review
      → on CRITICAL security, escalate for human ack
```

## Install

From a local checkout during development:

```bash
pi install /Users/dave/tools/pi-quality-gates
```

From git:

```bash
pi install git:github.com/davehardy20/pi-quality-gates
```

For one run only:

```bash
pi -e /Users/dave/tools/pi-quality-gates
```

## Configuration

### Linter

Create `.pi/linter.config.json` in your project root:

```jsonc
{
  "cooldownMs": 15000,
  "reportMode": "auto-follow-up",
  "runtimeMode": "auto",
  "lsp": {
    "enabled": false,
    "settleMs": 500,
    "minSeverity": "warning"
  }
}
```

### Reviewer

This bundle previously shipped an auto-triggering post-turn reviewer. It has
been retired in favour of explicit `/pr-review` and governed Seeds closeout
review requests. `/pr-review` prepares a PR diff and runs the configured
reviewer bridge to produce the `## Review Report`, stamping a PASS token before
publishing. The default host bridge spawns a read-only headless child Pi; set
`PI_PR_REVIEW_BRIDGE=orchestrator` to route the review through a host-side
orchestrate `verifier`/`pr-review` child when a trusted execution-deadline
adapter is available (no container is involved on either bridge).
There is no separate reviewer config file; PR review uses built-in diff limits
and the reviewer tool policy.

#### Trusted validation budgets

Only user-global `~/.pi/agent/settings.json` is read for validation policy;
merged Pi settings, project settings and repository policy cannot relax it.
Example (configuration only; this does not establish harness completion):

```json
{
  "qualityGates": {
    "reviewValidation": {
      "defaultTimeoutMs": 300000,
      "repoOverrides": {
        "/Users/dave/.pi": {
          "test/apple-container-integrated-canary-harness.test.ts": 1200000
        }
      },
      "reviewOverheadMs": 600000,
      "maxReviewerTimeoutMs": 7200000
    }
  }
}
```

Defaults: five minutes per required call, ten minutes review overhead, two hours
maximum parent review. The existing 45-minute reviewer timeout is a floor.
Parent budget is `max(floor, sum(all required call budgets) + overhead)`;
one 20-minute and seven five-minute calls require 65 minutes with default
overhead. The safe-tools 30-minute per-call ceiling is **not** a parent ceiling.
One monotonic deadline includes preparation, primary/fallback attempts and
retries on the host and compatible orchestrator bridges; no attempt resets it.
Late/timeout PASS cannot stamp. Final HEAD/worktree checks and both PASS sinks
recheck the deadline; only dispatch grants authorization.
New explicit review requests (after a fix) start a new deadline.

The currently loaded orchestrator has no scoped cancellation/retry-deadline API.
Orchestrator review therefore **refuses before dispatch** unless the trusted
extension owner injects `orchestratorDeadlineAdapter` (protocol
`review-deadline-v1`) into `PrGateExtensionDeps`. It is not a JSON setting and
cannot come from repository policy. Mere `orchestrate` tool availability is not
proof of execution control. Use the default host bridge meanwhile.

The adapter must register the correlated request before dispatch, call
`beforeAttempt()` before every child spawn/fallback/retry, use that returned
remaining budget and supplied AbortSignal, reject unregistered requests, and
synchronously revoke retries/terminate its owned child on `cancel()`. `dispose()`
releases registration after completion/cancellation. The bridge owns the shared
deadline and abort controller, cancels at expiry/shutdown/abort, and fails closed
on adapter errors. Runtime integration remains a separate, explicitly authorized
handoff; no orchestrator source is changed here.

Call budgets must be safe integer milliseconds, at least 1000 and no greater
than the effective `safeTools.validation.maxTimeoutMs` in that same global file
(default/hard ceiling 1800000). Its `defaultTimeoutMs` is also validated against
that ceiling; incompatibility refuses before reviewer dispatch, never clamps.
Review overhead accepts 0–86400000; parent maximum accepts 1000–86400000
(24-hour immutable ceiling). Excessive complete plans refuse without dropping
checks. Generic safe-tool limits remain unchanged.

Override keys must be exact canonical absolute directory roots and exact
normalized relative existing file paths, not globs/aliases, traversal, controls
or symlinks. Overrides apply to targeted single-file validation calls; project
typecheck, scoped lint and broad discovery calls retain the explicit default.
All overrides are checked, including those for other repositories. Only absent
settings/blocks/fields default; null, unknown policy fields, invalid integers,
malformed/oversized/nonregular settings or unsafe paths fail closed with
content-free errors. Global settings are bounded to 1 MiB, same-UID owned, with
no symlink path components and descriptor identity checks around the read.
Preserve unrelated settings; never commit this user-owned file.

Required whole-file tests, project typecheck, scoped lint, imports/helpers and
complete-plan relay remain mandatory. Report trusted runner requested/effective/
elapsed budgets and bounded progress when available; otherwise say unknown.
Progress or timeout alone never proves completion; FAIL/NOT_RUN/missing evidence
remains blocking. Do not substitute harness subsets for the complete harness.

## Notes

- `/pr-review` runs the configured reviewer bridge (default host child Pi; the
  `orchestrate` tool is only required when `PI_PR_REVIEW_BRIDGE=orchestrator` is
  set to route through the host-side verifier child).
- LSP diagnostics are optional and disabled by default. Enable via linter config.
- Go files are validated by default with `gofmt -l` for modified files and
  `go vet ./...` once per nearest `go.mod` module. This does not require LSP.
- Clean/status messages distinguish files routed to validators from unsupported
  files that were skipped.
- Linter sidecar `full` recovery requires `--ack-context-cost` in parent
  sessions; in orchestrator/sub-agent sessions, linter `runtimeMode: "auto"`
  detects `PI_QUALITY_GATES_SUBAGENT_MODE=1` or `PI_ORCH_*` worker env and
  allows full redacted recovery without the parent-session acknowledgement.
  Set linter `runtimeMode` to `"parent"` or `"sub-agent"` to override linter
  detection.
- If commands appear twice, Pi may be loading both this package and old local
  extension files.
  Disable or remove old local extensions before testing.
- Both extensions share package-local copies of LSP helpers — they do not reach
  back into `~/.pi/agent/extensions/shared/*`.

## Update flow

1. Update the package repo
2. Push to GitHub
3. Run `pi update --extensions` or reinstall the package
4. Run `/reload`

`/reload` alone does not fetch newer package commits.

## Troubleshooting

- Run `/post-turn-linter-status` to check linter state
- Run `/pr-gate-status` to check push gate state
- Run `/pr-review-status` to check PR review state
- Check `~/.pi/lsp-config.yaml` for LSP server configuration

## Build and test

```bash
npm run typecheck
npm run test
npm run build
```
