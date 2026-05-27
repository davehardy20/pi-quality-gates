# @davehardy20/pi-quality-gates

Pi quality-gates bundle: post-turn linting, LSP diagnostics, and automated code
review.

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

### Post-Turn Reviewer

- After the linter reports clean, spawns a headless Pi child process to review
  changes
- 7-domain checklist: task completion, correctness, error handling, security,
  quality, testing, documentation
- Severity levels: CRITICAL (auto-fix loop), WARNING (advisory), NIT (info only)
- Re-review after fixes with configurable max passes
- Summary-first reviewer reports keep parent context bounded by default
- Full redacted reviewer transcripts are written to sidecars for manual recovery
- Parse-fail and timeout notices omit raw output/stderr from parent context
- `/reviewer-status` — Show reviewer state machine
- `/reviewer-run` — Manually trigger a review
- `/reviewer-report` — Recover the latest reviewer sidecar report
  metadata/preview/slice/full
- `/reviewer-model` — Switch review model mid-session
- `/reviewer-toggle` — Enable or disable the reviewer

### Workflow

```text
Agent modifies files → turn_end fires
  → Post-turn-linter runs (mechanical checks)
    → findings → auto-fix turn → linter re-runs (loop)
    → clean   → triggers post-turn-reviewer
      → PASS       → done
      → CRITICAL   → fix-up turn → linter → reviewer re-runs (max 1 loop)
      → WARNING    → advisory message
      → max loops  → escalate to user
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

Create `.pi/reviewer.config.json` in your project root:

```jsonc
{
  "model": null,
  "enabled": true,
  "minChangedLines": 5,
  "maxChangedLines": 500,
  "maxReReviewPasses": 1,
  "autoFixThreshold": "critical",
  "timeoutMs": 120000,
  "respectGitignore": true,
  "skipFile": ".pi/reviewer.skip",
  "reviewDelayMs": 10000
}
```

Create `.pi/reviewer.skip` (gitignore format) to exclude files from review:

```gitignore
*.generated.ts
dist/
vendor/**
```

## Notes

- The reviewer spawns a child Pi process with `--no-extensions` and read-only
  tools only.
- LSP diagnostics are optional and disabled by default. Enable via linter config.
- Reviewer sidecar `full` recovery always requires `--ack-context-cost`,
  including orchestrator/sub-agent sessions. Linter sidecar `full` recovery
  requires `--ack-context-cost` in parent sessions; in orchestrator/sub-agent
  sessions, linter `runtimeMode: "auto"` detects
  `PI_QUALITY_GATES_SUBAGENT_MODE=1` or `PI_ORCH_*` worker env and allows full
  redacted recovery without the parent-session acknowledgement. Set linter
  `runtimeMode` to `"parent"` or `"sub-agent"` to override linter detection.
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
- Run `/reviewer-status` to check reviewer state
- Check `~/.pi/lsp-config.yaml` for LSP server configuration

## Build and test

```bash
npm run typecheck
npm run test
npm run build
```
