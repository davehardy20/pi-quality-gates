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
orchestrate `verifier`/`pr-review` child (no container is involved on either
bridge today).
There is no separate reviewer config file; PR review uses built-in diff limits
and the reviewer tool policy.

#### Validation-budget foundations (not yet wired)

This prerequisite slice adds trusted policy and monotonic-deadline APIs/tests
only. Existing review execution is unchanged: fixed 300000-ms validation calls
and the built-in 45-minute reviewer timeout. A separate consumer PR will connect
these APIs; do not apply the following policy or retry the sandbox harness yet.

The proposed user-global `~/.pi/agent/settings.json` block is:

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

`src/shared/review-validation-policy.ts` reads only the user-global file, never
merged/project settings or repository policy. Missing file/block/fields default;
null, unknown policy keys, invalid integers, nonregular/oversized settings and
unsafe paths fail closed with content-free errors. The read is bounded to 1 MiB,
same-UID owned, without symlink components and with descriptor identity checks.
Unrelated settings are neither returned nor modified; never commit this file.

Call budgets must be safe integer milliseconds, at least 1000 and at most the
same file's authoritative `safeTools.validation.maxTimeoutMs` (default and
immutable ceiling 1800000). Its default is also checked. Incompatible review
budgets refuse, never clamp. Override keys are exact canonical absolute roots
and normalized relative existing files, not globs, traversal or symlink aliases.
All configured overrides are validated, including other repositories.

The pure parent-budget API computes `max(existing reviewer floor, sum(each
required call once) + overhead)`. Defaults are 300000 per call, 600000 overhead,
and 7200000 parent maximum. One 20-minute and seven five-minute calls therefore
require 65 minutes with default overhead, not a 30-minute parent cap. Parent
maximum is independently bounded to 24 hours; excessive plans refuse without
removing checks. `src/shared/review-deadline.ts` provides one monotonic deadline
for preparation and successive attempts. Consumer integration, runtime reload,
actual settings application and complete-harness retry remain separate steps.
Progress/timeout alone never establishes completion or live readiness.

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
