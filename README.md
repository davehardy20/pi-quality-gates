# @davehardy20/pi-quality-gates

Pi quality-gates bundle: post-turn linting, LSP diagnostics, and a PR review
gate that blocks unsafe publishing until changes are reviewed.

## What it adds

### Post-Turn Linter

- Automatically runs lint checks on files modified during each agent turn
- Supports: markdownlint, biome, ruff, cppcheck, tflint, cargo clippy
- Optional LSP diagnostics integration (typescript-language-server, pyright, etc.)
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
- `/pr-review` runs a read-only headless child Pi review scoped to the PR diff
  (default base ref `origin/master`); on PASS it stamps a token for that HEAD
- The main agent remains the sole publisher; the gate only vetoes and steers
- Child reviewer runs `--no-extensions` with read-only tools and safe validation
  runners only (no `bash`, no mutating tools)
- On CRITICAL security findings the gate escalates for a human acknowledgement
- `/pr-review` — Run a PR review for the current HEAD (optional base ref arg)
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
    → agent runs /pr-review
      → review executes (read-only headless child Pi)
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
been retired in favour of the PR gate (`/pr-review`), which is the supported
review path. `/pr-review` runs the same read-only headless child Pi reviewer,
scoped to a PR diff and gated to a PASS token before publishing. There is no
separate reviewer configuration file; the PR reviewer uses built-in read-only
tool and timeout defaults.

## Notes

- The `/pr-review` child reviewer runs `--no-extensions` with read-only tools
  and safe validation runners only (no `bash`, no mutating tools).
- LSP diagnostics are optional and disabled by default. Enable via linter config.
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
