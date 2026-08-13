<!-- markdownlint-disable MD013 MD032 -->

# Post-Turn Linter

Automatically runs lint checks on files modified during each agent turn. Supports markdownlint, Biome, Ruff, Go (`gofmt` plus `go vet`), cppcheck, tflint, cargo clippy, and optional LSP diagnostics.

## Architecture overview

```text
Extension API (src/linter/index.ts)
    └── Orchestrator (src/linter/orchestrator.ts) — lifecycle, events, commands, state
         └── Pipeline (src/linter/pipeline.ts) — config, adapter selection, execution, merging
              ├── Adapters (src/linter/adapters/) — CLI, Markdownlint, Go, LSP
              ├── Report Builder (src/linter/report-builder.ts) — issue parsing, code excerpts
              ├── Outcome Merger (src/linter/outcome-merger.ts) — combine adapter results
              └── Report Hygiene (src/linter/report-hygiene.ts) — summary, sidecar persistence
```

## Lifecycle and modified-file detection

The orchestrator tracks modified files across a turn via tool execution events:

1. **`tool_execution_start`** — records the tool call in `pendingToolFiles`.
2. **`tool_execution_end`** — extracts modified file paths from the tool result.
3. **`turn_end`** — runs the linter if: cooldown has elapsed, there are queued files, and no run is in progress.

Modified-file detection (`src/linter/orchestrator.ts`, `detectModifiedFilesFromToolEvent` / `detectModifiedFilesFromToolResult`) handles these tool names:
- `write`, `edit`, `create_text_file` → path field
- `hashline_edit` → filePath field (and rename field)
- `lsp_rename` → filePath field
- `ast_grep_replace` → paths array

It also checks `result.details.modifiedFiles` (a shared contract) as a fallback.

**Invariants:**
- Only one run at a time (`runInProgress` guard).
- Cooldown enforced: `now - lastRunAt >= cooldownMs`.
- Modified files capped at `MAX_MODIFIED_FILES = 1000` (`src/linter/config-loader.ts`).
- Files that were "clean" and haven't changed (same mtime+size) are skipped (`recentlyClean` cache).
- Signature dedup prevents re-reporting identical findings (`lastReportedSignature`).

## Pipeline and adapter model

`src/linter/pipeline.ts` — `createLinterPipeline(options)` creates a `LinterPipeline` with `runChecks`, `summarize`, and `persist` methods.

**`runChecks` flow:**
1. Load config (from options or via `loadLinterConfig`).
2. Build adapters from config (or use injected test adapters).
3. Filter out built-in ignored artifacts (`agent/plans/*.md` and `agent/plans/archive/*.md`).
4. Group files by extension adapter.
5. Run all extension adapters in parallel (`Promise.all`).
6. Run LSP adapter separately on all filtered files (always last).
7. Merge all results via `mergeValidationOutcomes`.
8. Record `checkedFiles` routed to a validator and `skippedFiles` with no validator.
9. If findings: append `buildCodeExcerptSection` (code snippets around issue lines).

### Adapter interface

All adapters implement `LinterAdapter` (`src/linter/adapters/types.ts`):

```typescript
interface LinterAdapter {
    readonly name: string;
    readonly key: string;  // unique dedup/grouping key
    run(filePaths: string[], cwd: string): Promise<ValidationOutcome>;
}
```

### CLI adapter (`src/linter/adapters/cli.ts`)

Spawns CLI linters as child processes. Three execution modes:

| Mode | Behavior |
|---|---|
| `per-file` (default) | Appends file paths to args; runs in batches of 50 (`BATCH_SIZE`); groups by execution cwd for Biome |
| `workspace` | Groups by project root (walks up to `Cargo.toml`, `package.json`, `.tflint.hcl`, `.git`); no file args |
| `project-root` | Groups by explicit `rootMarker`; no file args |

Exit-code semantics: 0 → `clean`; non-zero → `findings`; spawn error/timeout → `tool-error`.

**Biome special handling**: `BIOME_ROOT_MARKERS` and `groupFilesByExecutionCwd` ensure Biome runs from the directory containing `biome.json`.

> **Indent note**: This file uses 2-space indent (biome.json override).

### Markdownlint adapter (`src/linter/adapters/markdownlint.ts`)

Thin adapter wrapping the markdownlint engine (`src/linter/markdownlint.ts`). The engine module handles `.markdownlintignore` discovery/filtering (via `minimatch`), violation formatting, and the default config (`{ default: true, MD013: { line_length: 120 } }`). Dynamically imports `markdownlint/promise` at call time.

### Go adapter (`src/linter/adapters/go.ts`)

Composes two CLI adapters behind one `.go` API adapter. `gofmt -l` checks only the modified Go files and normalizes listed paths into actionable `GOFMT` findings. `go vet ./...` runs once per nearest `go.mod` root through project-root mode, providing semantic and static-analysis validation without executing the program. Either missing executable produces a `tool-error`; findings from one check are preserved alongside tool errors from the other.

### LSP adapter (`src/linter/adapters/lsp.ts`)

Runs LSP diagnostics using cached clients from `src/shared/lsp-service.ts`. Groups files by server+workspace, opens documents, waits for diagnostics to settle (`settleMs`), filters by severity, formats results as `path:line:col [severity] message (code)`, and reports the files actually synchronized through `checkedFiles`.

If `config.enabled` is false, returns `clean` with no checked files. Go LSP support resolves to `gopls`, but remains optional because the default Go adapter already runs `gofmt` and `go vet`.

## Config loading

`src/linter/config-loader.ts`:
- `loadLinterConfig(directory)` — reads strict JSON from `.pi/linter.config.json`, then `.opencode/linter.config.json`; falls back to `DEFAULT_CONFIG`. These files are parsed with `JSON.parse`, so comments and trailing commas are not accepted.
- `parseJsoncConfig(configData)` — strips `//` and `/* */` comments and trailing commas for markdownlint config only.
- `getLinterForFile(filePath, config)` — looks up linter definition by file extension.
- `loadMarkdownlintConfig(directory)` — loads `.markdownlint.jsonc`/`.json` and merges over `DEFAULT_MARKDOWNLINT_CONFIG`.
- `MAX_MODIFIED_FILES = 1000` — cap on tracked modified files.

Config keys in `linters` are file extensions (e.g., `".ts"`).

## Report hygiene and sidecar

`src/linter/report-hygiene.ts` — the most complex reporting module. Key exports:
- `writeLinterReportSidecar(options)` — writes redacted sidecar via shared `writeReportSidecar` with `toolName: "post-turn-linter"`.
- `recoverLinterReportSidecar(options)` — tiered recovery.
- `buildSummaryFirstLintMessage(args)` — parses report, selects top findings, formats message with caps.

**Summary building constants** (`src/linter/report-hygiene.ts`):
- `DEFAULT_MAX_SUMMARY_FINDINGS = 20` — global cap on shown findings
- `DEFAULT_MAX_FINDINGS_PER_FILE = 3` — per-file cap
- `DEFAULT_SUMMARY_MAX_CHARS = 6000` — character cap on message

**Report parsing** (`parseLintReport`): detects `--- LinterName (N files) ---` section headers, parses `path:line:col: message` lines into `ParsedLintFinding`, flags `lowPriority: true` for MD013/line-length findings. Biome human output is normalized by the CLI adapter before summary parsing: formatter headers (`path format ━...`) become synthetic `path:line:1 format ...` diagnostics with short `fix:` hints when replacement lines are available, diagnostic headers (`path:line:col parse ━...`) receive their following `×/!/i` message, format-aborted pseudo-findings are suppressed when parse errors are present, and Biome diff-gutter lines are ignored even when they contain path-like strings. Finding selection prioritises non-low-priority findings.

See [Architecture](architecture.md) → Report sidecar for the generic sidecar system.

## Commands

Registered in `src/linter/orchestrator.ts` → `registerCommands`:

| Command | Behavior |
|---|---|
| `post-turn-linter-run` | Manually trigger lint. Accepts file paths, `--no-fix` flag. `skipDedup: true`. |
| `post-turn-linter-fix` | Start a fix turn for latest findings. Accepts `--report-id=N`. |
| `post-turn-linter-report` | Recover sidecar: `metadata`/`preview`/`slice`/`full`. `--offset`, `--length`, `--ack-context-cost`. Full allowed without ack in sub-agent runtime. |
| `post-turn-linter-status` | Display internal state snapshot. |

## Auto-fix turn flow

When `reportMode === "auto-follow-up"`, `requestFixTurn` polls `ctx.isIdle()` via `setTimeout` and sends `buildFixInstruction()` as a user message. The fix instruction includes sidecar recovery hints that differ for sub-agent vs parent runtime.

The fix prompt instructs the agent to **continue the active task** after fixing linter findings (verified in `test/post-turn-linter-fix-prompt.test.ts`).

## Outcome types

Defined in `src/linter/types.ts`:

| Type | Values |
|---|---|
| `ValidationKind` | `"clean"` \| `"findings"` \| `"tool-error"` |
| `ValidationOutcome` | `{ kind, report, affectedFiles, signature, checkedFiles? }` |
| `ReportMode` | `"report-only"` \| `"auto-follow-up"` |
| `CombinedValidationOutcome` | Extends `ValidationOutcome` with `reportMode`, required `checkedFiles`, and `skippedFiles` |

Merging logic (`src/linter/outcome-merger.ts`): `findings > tool-error > clean`. If any findings exist, the merged kind is `findings`; tool-errors are appended to the findings report.

The pipeline derives coverage after adapter execution. Status and findings summaries use `checkedFiles` for the checked count and report `skippedFiles` separately. Only checked files without findings enter the `recentlyClean` cache.

## Core shim (`src/linter/core.ts`)

A transitional re-export module for backward compatibility during refactoring. Re-exports symbols from `config-loader.ts`, `outcome-merger.ts`, `pipeline.ts`, `report-builder.ts`, and `markdownlint.ts`. Contains `@deprecated` functions (`runQueuedLintChecks`, `groupFilesByLinter`) — new code should import from the smaller modules directly.

## Change-entrypoints

| To change... | Start at | Watch out for |
|---|---|---|
| Default linter assignments | `src/linter/config-loader.ts` → `DEFAULT_CONFIG` | Config keys are file extensions |
| Markdownlint config defaults | `src/linter/markdownlint.ts` → `DEFAULT_MARKDOWNLINT_CONFIG` | User config merges over defaults |
| Summary finding caps | `src/linter/report-hygiene.ts` → `DEFAULT_*` constants | These control context budget |
| CLI adapter execution modes | `src/linter/adapters/cli.ts` → `buildCliArgs` / `groupFilesByExecutionCwd` | Biome root-marker handling |
| Auto-fix prompt text | `src/linter/orchestrator.ts` → `buildFixInstruction` | Sub-agent vs parent runtime hints differ |
| Built-in ignored artifacts | `src/linter/pipeline.ts` → `isBuiltInIgnoredAgentArtifact` (`__test__` export) | Currently `agent/plans/*.md` |
| Modified-file detection | `src/linter/orchestrator.ts` → `detectModifiedFilesFromToolEvent` / `...FromToolResult` | Must handle all tool name variants |

## Invariants

1. Only one lint run at a time (`runInProgress` guard).
2. Cooldown enforced before turn-end runs.
3. Modified files capped at 1000.
4. Checked, clean files with unchanged mtime+size are not re-linted; skipped files are never cached as clean.
5. Signature dedup prevents re-reporting identical findings.
6. LSP adapter always runs after extension adapters and receives all filtered files.
7. Sidecar files written atomically with `mode: 0o600`; secrets always redacted.
8. Built-in ignored artifacts (`agent/plans/*.md`) are never linted.

## Common failure modes

- **Linter not found**: CLI linter binary missing → adapter returns `tool-error`, which is merged into findings report.
- **Go tool missing**: The default Go adapter requires both `gofmt` and `go` on `PATH`; a missing command is reported as a tool error rather than clean.
- **Go module not found**: `go vet ./...` runs from the modified file's directory when no parent `go.mod` exists, so the resulting module error is surfaced rather than silently skipped.
- **Unsupported extension**: Files not routed to an extension adapter or completed LSP check appear in `skippedFiles` and are excluded from the checked count.
- **Biome wrong cwd**: If Biome is not run from its config directory, it may fail or produce no results. The adapter groups files by execution cwd to handle this.
- **LSP diagnostics not settling**: If `settleMs` is too low, diagnostics may be incomplete. Default is 500ms.
- **Duplicate commands**: If Pi loads both this package and old local extension files, commands appear twice. Disable old local extensions.
- **Sidecar full recovery blocked**: In parent runtime, `/post-turn-linter-report full` requires `--ack-context-cost`. Sub-agent runtime (detected via env vars or explicit `runtimeMode`) can recover full without ack.

## Safe-edit guidance

- **Adding a new CLI linter**: Add to `DEFAULT_CONFIG` in `config-loader.ts` with appropriate `rootMarker` and `mode`. Test via `test/linter-pipeline.test.ts` patterns (create real executable fake linter scripts).
- **Adding a new API linter**: Follow the markdownlint pattern — create an engine module with a `run<Name>(filePaths, config?)` function, then a thin adapter in `src/linter/adapters/`. The pipeline's `buildAdaptersFromConfig` dispatches based on `api` + `name`.
- **Changing summary caps**: Update constants in `report-hygiene.ts`. These directly affect how much context the agent receives — too large will bloat parent context.
- **Modifying modified-file detection**: Add the new tool name to `detectModifiedFilesFromToolEvent`. Check `result.details.modifiedFiles` contract in `detectModifiedFilesFromToolResult` if the tool reports modified files in results.

## Source map

| File | Purpose |
|---|---|
| `src/linter/index.ts` | Extension registration entry point |
| `src/linter/orchestrator.ts` | Central state machine: lifecycle, events, commands, state |
| `src/linter/pipeline.ts` | Adapter orchestration and execution |
| `src/linter/config-loader.ts` | Configuration loading and JSONC parsing |
| `src/linter/types.ts` | Core type definitions |
| `src/linter/core.ts` | Deprecated backward-compatibility re-export shim |
| `src/linter/markdownlint.ts` | Markdownlint engine (ignore handling, formatting, config) |
| `src/linter/outcome-merger.ts` | Validation outcome merging |
| `src/linter/report-builder.ts` | Issue parsing and code excerpts |
| `src/linter/report-hygiene.ts` | Summary building and sidecar persistence |
| `src/linter/adapters/types.ts` | `LinterAdapter` interface |
| `src/linter/adapters/cli.ts` | CLI linter adapter (Biome, Ruff, cppcheck, tflint, cargo) |
| `src/linter/adapters/go.ts` | Go adapter composing modified-file `gofmt` checks with module-scoped `go vet` |
| `src/linter/adapters/markdownlint.ts` | Markdownlint adapter wrapper |
| `src/linter/adapters/lsp.ts` | LSP diagnostics adapter |
