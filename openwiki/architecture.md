<!-- markdownlint-disable MD013 -->

# Architecture

## Extension model

`pi-quality-gates` is a Pi coding-agent extension package. The entry point is `src/index.ts`, which exports a default function `qualityGatesExtension(pi: ExtensionAPI)`. This function:

1. Calls `postTurnLinter(pi)` — registers the linter subsystem.
2. Calls `prGateExtension(pi)` — registers the PR gate subsystem.
3. Registers `/quality-gates-status` — reports package metadata (name, version, source path).

Pi discovers the extension via `package.json` → `"pi": { "extensions": ["./src/index.ts"] }`.

Both subsystems subscribe to Pi lifecycle events via `pi.on(...)`:

| Event | Linter | PR Gate |
|---|---|---|
| `session_start` | `orchestrator.initialize(ctx)` | — |
| `session_tree` | `orchestrator.onSessionTree(ctx)` | — |
| `session_shutdown` | `orchestrator.shutdown(ctx)` | — |
| `tool_execution_start` | `orchestrator.onToolExecutionStart(event)` | — |
| `tool_execution_end` | `orchestrator.onToolExecutionEnd(event, ctx)` | — |
| `turn_end` | `orchestrator.onTurnEnd(ctx)` | — |
| `tool_call` | — | `push-gate-hook` handler (veto) |
| `tool_result` | — | orchestrator reviewer result observer |

Source: `src/linter/index.ts`, `src/pr-gate/index.ts`.

## Module dependency graph

```text
src/index.ts
├── src/linter/index.ts
│    └── src/linter/orchestrator.ts  ← central state machine
│         ├── src/linter/config-loader.ts
│         │    └── src/linter/markdownlint.ts
│         ├── src/linter/pipeline.ts
│         │    ├── src/linter/adapters/cli.ts
│         │    ├── src/linter/adapters/markdownlint.ts
│         │    ├── src/linter/adapters/lsp.ts
│         │    ├── src/linter/adapters/types.ts
│         │    ├── src/linter/outcome-merger.ts
│         │    ├── src/linter/report-builder.ts
│         │    └── src/linter/report-hygiene.ts
│         └── src/linter/types.ts
│
├── src/pr-gate/index.ts
│    ├── src/pr-gate/push-gate-hook.ts     ← tool_call veto
│    ├── src/pr-gate/gate-decision.ts      ← pure decision core
│    ├── src/pr-gate/pass-token-store.ts   ← in-memory tokens
│    ├── src/pr-gate/pr-review-dispatch.ts ← review orchestration
│    │    ├── src/pr-gate/orchestrator-reviewer-execution.ts ← default sandboxed reviewer bridge
│    │    └── src/pr-gate/reviewer.ts      ← legacy parser/test helpers
│    ├── src/pr-gate/pr-review-config.ts   ← tool policy
│    ├── src/pr-gate/auto-review-trigger.ts ← retired helper, not registered
│    ├── src/pr-gate/reviewer-skip.ts
│    └── src/pr-gate/test-execution.ts
│
└── src/shared/  (shared infrastructure)
     ├── path-utils.ts          ← path normalisation (leaf)
     ├── runtime-detection.ts   ← sub-agent detection (leaf)
     ├── report-sidecar.ts      ← report persistence + recovery
     ├── lsp-service.ts         ← LSP client cache + lifecycle
     ├── lsp-client.ts          ← JSON-RPC LSP client
     ├── lsp-server-resolver.ts ← ext→server mapping + config
     ├── lsp-auto-installer.ts  ← language server install
     ├── lsp-utils.ts           ← file filtering/grouping
     ├── review-config.ts       ← ReviewConfig interface
     ├── review-types.ts        ← ReviewReport, Finding, Severity
     ├── review-severity.ts     ← threshold helpers
     ├── review-scope.ts        ← diff gathering, gitignore filter
     └── review-checklist.md    ← 7-domain review checklist
```

## Shared modules

`src/shared/` contains cross-cutting infrastructure used by both subsystems:

### Path utilities (`path-utils.ts`)

Platform-agnostic path normalisation. All path comparisons in the codebase should go through `normalizePath`, `pathsEqual`, `normalizeAndSortPaths`, `displayPath`, and `resolveCommandPath`. `uriToNormalizedPath` converts `file://` URIs.

### Report sidecar (`report-sidecar.ts`)

Generic report persistence for both linter and reviewer. Writes redacted reports atomically (temp file + rename, mode 0o600). Supports tiered recovery: `metadata` → `preview` (2000 chars) → `slice` (offset/length, max 4000) → `full` (requires `--ack-context-cost` in parent runtime; sub-agent runtime can recover full without ack). Max sidecar size: 10MB. Secrets are redacted via regex (API keys, Bearer tokens, AWS keys, JWTs).

Default sidecar directory: `$PI_QUALITY_GATES_SIDECAR_DIR` or `~/.pi/agent/tool-output`.

### Runtime detection (`runtime-detection.ts`)

Detects whether the process runs as an orchestrator sub-agent, which affects sidecar recovery. Checks `runtimeMode` config, then `PI_QUALITY_GATES_SUBAGENT_MODE`, `PI_ORCH_ROLE`, and `PI_ORCH_*` env vars. Source: `src/shared/runtime-detection.ts`.

### LSP integration (`lsp-service.ts`, `lsp-client.ts`, `lsp-server-resolver.ts`, `lsp-auto-installer.ts`, `lsp-utils.ts`)

Full LSP diagnostics pipeline using `vscode-jsonrpc`. Built-in server mappings for TypeScript, Python, Rust, Go, Bash, YAML, JSON. User overrides in `~/.pi/lsp-config.yaml`. Auto-install via npm for npm-based servers; rust-analyzer and gopls have special handling. See `src/shared/lsp-server-resolver.ts` for built-in server list.

### Review primitives (`review-config.ts`, `review-types.ts`, `review-severity.ts`, `review-scope.ts`)

Shared types and logic for the PR gate's review system:

- **`review-types.ts`**: canonical `ReviewReport` schema with `Severity` (`CRITICAL`/`WARNING`/`NIT`), `ReviewStatus` (`PASS`/`ISSUES`/`CANNOT_REVIEW`), `ReviewConfidence`, 7 `ReviewDomain` values, and `Finding`/`TestExecutionSummary` interfaces.
- **`review-severity.ts`**: threshold helpers including `hasCriticalSecurityFinding` — the gate's escalation trigger (CRITICAL + security domain).
- **`review-scope.ts`**: `gatherDiff`, `countDiffLinesFast`, `extractOriginalTask`, `filterGitignoredFiles`, `capDiff`.
- **`review-checklist.md`**: 7-domain checklist (task-completion, correctness, error-handling, security, quality, testing, documentation) referenced by reviewer prompts.

## How the subsystems interact

The subsystems are intentionally loosely coupled:

1. The linter runs on `turn_end` and writes a `post-turn-linter-status` custom message to the session branch.
2. Manual `/pr-review` checks the latest linter status through `isLinterClean(ctx)`. If the linter reported findings, review is blocked until the linter is clean.
3. The PR gate's `tool_call` hook blocks `git_safe push` and `gh_safe pr_create` until the exact target HEAD has a PASS token.
4. On `/pr-review` PASS, the review result observer stamps that token; the agent retries the publish action and the hook allows it.

The old post-turn auto-review helper remains in `src/pr-gate/auto-review-trigger.ts` for compatibility/tests, but `src/pr-gate/index.ts` no longer registers it. Reviews should be explicit (`/pr-review`) or requested by governed Seeds closeout, not auto-triggered after every clean turn.

Source: `src/pr-gate/index.ts`, `src/pr-gate/pr-review-dispatch.ts` (`isLinterClean`), `src/pr-gate/orchestrator-reviewer-execution.ts`, `src/pr-gate/push-gate-hook.ts`.

## Package metadata

- **Name**: `@davehardy20/pi-quality-gates`
- **Version**: `0.1.2` (source: `package.json`)
- **Type**: ES module (`"type": "module"`)
- **Peer dependencies**: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox` (required); `@earendil-works/pi-tui` (optional)
- **Published files**: `src`, `README.md`, `LICENSE`, `package.json`
- **License**: MIT

## TypeScript configuration

| Config | Purpose |
|---|---|
| `tsconfig.json` | Base: ES2022, NodeNext, strict, noEmit. Includes `src/**/*.ts` and `test/**/*.ts`. Types: `node`, `vitest/globals`. |
| `tsconfig.build.json` | Extends base: noEmit=false, declaration=true, rootDir=`src`, outDir=`dist`, types=`node` only. |

Import paths use `.js` extensions in source files (NodeNext module resolution convention).

## Biome configuration

`/biome.json` — Biome 2.4.16. Formatter enabled, tab indent, LF line endings. Eight specific files use 2-space indent override:

- `src/linter/adapters/cli.ts`
- `src/pr-gate/gate-decision.ts`
- `src/pr-gate/pass-token-store.ts`
- `src/pr-gate/reviewer.ts`
- `test/linter-cli-adapter.test.ts`
- `test/pr-gate-gate-decision.test.ts`
- `test/pr-gate-integration.test.ts`
- `test/pr-gate-push-gate-hook.test.ts`

> **Safe-edit note**: When editing these files, use 2-space indent. All other files use tabs.
