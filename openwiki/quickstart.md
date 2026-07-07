<!-- markdownlint-disable MD013 -->

# pi-quality-gates — Quickstart

`@davehardy20/pi-quality-gates` is a Pi extension package that adds two quality gates to an agent workflow:

1. **Post-Turn Linter** — automatically lints files modified during each agent turn.
2. **PR Gate** — blocks `git_safe push` / `gh_safe pr_create` until current HEAD has a PASS review token.

## What it does

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
      → review runs via sandboxed orchestrator pr-reviewer
      → on PASS, token stamped; agent retries the push; hook allows
      → on ISSUES, agent fixes → lint-clean → re-review
      → on CRITICAL security, escalate for human ack
```

## Install

```bash
# From a local checkout during development
pi install /Users/dave/tools/pi-quality-gates

# From git
pi install git:github.com/davehardy20/pi-quality-gates

# For one run only
pi -e /Users/dave/tools/pi-quality-gates
```

## Slash commands

| Command | Subsystem | Description |
|---|---|---|
| `/post-turn-linter-run [files...]` | Linter | Run linter now (optional file paths; `--no-fix` flag) |
| `/post-turn-linter-fix` | Linter | Start a fix turn for latest findings (`--report-id=N`) |
| `/post-turn-linter-report [mode]` | Linter | Recover sidecar report: `metadata`/`preview`/`slice`/`full` |
| `/post-turn-linter-status` | Linter | Show current linter state |
| `/pr-review [baseRef]` | PR Gate | Run a PR review for the current HEAD |
| `/pr-review-status` | PR Gate | Show PR review state |
| `/pr-gate-status` | PR Gate | Show push gate state (enabled, gated actions, tokens) |
| `/pr-gate-toggle [on\|off]` | PR Gate | Enable or disable the push gate |
| `/quality-gates-status` | Both | Show package identity and debug info |

> Source: command registration in `src/index.ts`, `src/linter/orchestrator.ts` (`registerCommands`), and `src/pr-gate/index.ts`.

## Configuration

### Linter config

Create `.pi/linter.config.json` in your project root (JSONC — comments allowed):

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

Key fields (source: `src/linter/types.ts`, `src/linter/config-loader.ts`):

| Field | Default | Purpose |
|---|---|---|
| `cooldownMs` | 15000 | Minimum ms between turn-end lint runs |
| `reportMode` | `"auto-follow-up"` | `"report-only"` or `"auto-follow-up"` (auto-triggers fix turn) |
| `runtimeMode` | `"auto"` | `"auto"`/`"parent"`/`"sub-agent"` — controls sidecar full-recovery behaviour |
| `lsp.enabled` | `false` | Enable LSP diagnostics |
| `lsp.settleMs` | 500 | Wait time for LSP diagnostics to settle |
| `lsp.minSeverity` | `"warning"` | Minimum severity to report (1=error…4=hint) |
| `linters` | see DEFAULT_CONFIG | Map of file extension → linter definition |

If no config file exists, `DEFAULT_CONFIG` from `src/linter/config-loader.ts` is used.

Default linter assignments: `.md` → markdownlint, `.ts/.tsx/.js/.jsx/.mjs/.cjs` → Biome, `.py/.pyi` → Ruff, `.c/.cpp/.cc/.h/.hpp` → cppcheck, `.tf/.tfvars` → tflint, `.rs` → cargo clippy.

### PR gate config

No separate config file. The PR gate uses built-in defaults defined in `src/pr-gate/pr-review-config.ts` and `src/pr-gate/index.ts`. The gate is **enabled by default** and gates `push` and `pr_create` actions.

PR reviewer config (`src/pr-gate/pr-review-config.ts`): model, `timeoutMs: 600_000`, `maxDiffLines: 4000`, `maxChangedLines: 5000`, read-only + safe-runner tools only.

### LSP server config

LSP server mappings live in `~/.pi/lsp-config.yaml`. See `src/shared/lsp-server-resolver.ts` for built-in server definitions and override format.

## Build and test

```bash
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
npm run build       # tsc -p tsconfig.build.json → dist/
```

There is no `lint` script in `package.json`. Formatting/linting is via Biome (config in `/biome.json`).

## Documentation map

- [Architecture](architecture.md) — Extension model, module dependency graph, shared modules, how the two subsystems interact.
- [Post-Turn Linter](linter.md) — Lifecycle, pipeline/adapter model, orchestrator state machine, report hygiene, LSP integration, change-entrypoints, invariants, safe-edit guidance.
- [PR Gate](pr-gate.md) — PASS token flow, gate decision logic, push gate hook, child Pi reviewer dispatch, auto-review trigger, test execution plan, change-entrypoints, invariants, safe-edit guidance.
- [Testing](testing.md) — Test patterns, conventions, commands, and source maps.

## Key facts for agents

- **Entry point**: `src/index.ts` exports `qualityGatesExtension` (default), which registers both subsystems via `pi.registerCommand` and `pi.on`.
- **Two subsystems**: `src/linter/` (post-turn linter) and `src/pr-gate/` (PR review gate), sharing infrastructure in `src/shared/`.
- **TypeScript**: strict mode, ES2022, NodeNext module resolution. Import paths use `.js` extensions in source (NodeNext convention).
- **No `vi.mock()` anywhere** — all test mocking is via dependency injection through factory functions with injected deps objects.
- **Biome formatter**: tab indent by default; 8 specific files use 2-space indent (see `/biome.json` overrides).
- **In-memory PASS tokens**: the PR gate's token store is not persisted. Session reload clears all tokens, requiring re-review.
