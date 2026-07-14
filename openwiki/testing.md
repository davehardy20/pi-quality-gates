# Testing

## Commands

```bash
npm run typecheck   # tsc --noEmit — type-check only
npm run test        # vitest run — run all tests once (CI mode)
npm run test:watch  # vitest — watch mode
npm run build       # tsc -p tsconfig.build.json → dist/
```

There is **no `lint` script** in `package.json`. Formatting/linting is via Biome (config in `/biome.json`).

## Framework

- **Vitest 3.2.4** — all tests use explicit imports: `import { describe, expect, it } from "vitest"` (with `vi` for mocking).
- Globals are available via `tsconfig.json` types: `["node", "vitest/globals"]`, but explicit imports are used everywhere.
- Config: `/vitest.config.ts` — minimal (`environment: "node"`, no aliases, no coverage).

## Mocking strategy

**No `vi.mock()` module mocking is used anywhere.** All mocking is manual via **dependency injection**:

- Production functions accept a deps/options object with injectable implementations.
- Tests provide fake implementations inline.
- `vi.fn()` is used for individual function spies (e.g., `setStatus`, `dispatch`, `runAttempt`).
- Mock Pi APIs are built with `createMockPi()` factory functions returning `{ pi, commands, messages }` or `{ pi, handlers }`.

This is a deliberate architectural choice — modules expose `__test__` namespaces for otherwise-private functions, and factory functions accept injectable dependencies.

## Conventions

| Convention | Details |
|---|---|
| **File naming** | `<topic>.test.ts` — flat in `/test/`, no subdirectories |
| **Suite naming** | `describe("<module-name>: <function>")` or `describe("<feature name>")` |
| **Test naming** | `it("<imperative or declarative statement>")` — behaviour-focused |
| **No `.spec.ts`** | All tests use `.test.ts` suffix |
| **No test setup files** | Each file manages its own lifecycle (`beforeEach`/`afterEach`) |
| **Imports** | From `../src/` using `.js` extensions (NodeNext resolution) |
| **Indent** | Most files use tabs; 4 specific test files use 2-space indent per `biome.json` override |

Files with 2-space indent (biome.json override):
- `test/linter-cli-adapter.test.ts`
- `test/pr-gate-gate-decision.test.ts`
- `test/pr-gate-integration.test.ts`
- `test/pr-gate-push-gate-hook.test.ts`

## Test file map

### Linter tests

| File | Type | Coverage |
|---|---|---|
| `test/index.test.ts` | Unit + integration | Post-turn linter file detection, arg tokenization, JSONC config parsing, markdownlint formatting, summary-first message building, sidecar write/recover, built-in ignored file filtering, path utilities, reviewer helpers (`buildReviewerPiArgs`, `parseReviewReport`, `capDiff`, `extractOriginalTask`), reviewer-skip logic. Uses `__test__` export from `src/linter/index.js`. |
| `test/linter-cli-adapter.test.ts` | Unit | CLI adapter working-directory resolution (Biome vs non-Biome). Creates temp dirs with `mkdtempSync`. Uses `__test__` from `src/linter/adapters/cli.js`. |
| `test/linter-pipeline.test.ts` | Integration | Full linter pipeline — markdownlint execution, CLI linters, project-root/workspace modes, multi-file grouping, tool-error handling, code excerpts, outcome merging, LSP adapter independence. Creates real executable fake linter scripts. |
| `test/markdownlint-characterization.test.ts` | Integration | **Characterization tests** locking byte-level output of `runMarkdownlint`, `formatMarkdownlintResults`, and adapter `.run()`. Designed to be unmodified during refactoring. File header documents the refactor invariant. |
| `test/post-turn-linter-fix-prompt.test.ts` | Unit/integration | Verifies fix prompt instructs agent to continue active task. Uses `createLinterOrchestrator` with fully-mocked deps. Simulates full lifecycle: `initialize` → `onToolExecutionEnd` → `onTurnEnd`. |
| `test/sidecar.test.ts` | Integration | Secret redaction, sidecar write with metadata, recovery modes (metadata/preview/slice/full), session ID derivation, recovery arg parsing, env-var sidecar directory. Real filesystem I/O. |

### PR gate tests

| File | Type | Coverage |
|---|---|---|
| `test/pr-gate-gate-decision.test.ts` | Unit | Push gate verdicts: allow/block/escalate/noop. Exhaustive `decidePushGate` testing with factory `makeReport(overrides)`. Security escalation: only CRITICAL + security triggers; CRITICAL + correctness goes to fix loop. |
| `test/pr-gate-push-gate-hook.test.ts` | Unit/integration | `tool_call` interceptor: registration, non-gated pass-through, push/pr_create gating, stale sha, fail-safe (throwing/empty HEAD), disable config, action allowlist, observation vs stamping separation. |
| `test/pr-gate-integration.test.ts` | Integration | End-to-end push gate cycle: block → review PASS → token stamped → allow → new commit → block again. Fix-loop and escalation scenarios. Uses real `decidePushGate` + `createPassTokenStore` + `registerPushGateHook`. Does NOT spawn a real reviewer child. |
| `test/pr-gate-pass-token-store.test.ts` | Unit | Token store CRUD: stamp, has, get, invalidate, clear, idempotency, defensive rejections. Uses `@ts-expect-error` for wrong `reportStatus`. |
| `test/pr-gate-pr-review-config.test.ts` | Unit | Reviewer tool policy: no forbidden tools granted, bash blocked, specific safe tools present. Tests `assertPrReviewerToolPolicy()`. |
| `test/pr-gate-pr-review-dispatch.test.ts` | Integration | Review dispatch flow: PASS stamping, missing/failed test execution blocking, ISSUES fix instruction, CRITICAL escalation, already-passed fast-path, HEAD resolution failure, linter-not-clean guard, no-files-changed guard, unparseable report, explicit base ref, re-review override. Uses dependency-injected mocks. |
| `test/pr-gate-auto-review-trigger.test.ts` | Unit | Auto-review decision logic: all six gating conditions. Includes regression test for sticky guard (failed review must not loop). Captures `turn_end` handlers from mock `pi.on()`. |
| `test/pr-gate-index-commands.test.ts` | Unit/integration | Extension entry point: slash command + `pr_review` tool registration, status display, linter-clean precondition, UI status updates, command/tool coordinator parity. Uses `createMockPi()`/`createMockContext()` factories. |
| `test/pr-gate-test-execution.test.ts` | Unit + integration | Project ecosystem detection, test command recommendation, plan formatting. Tests against real project root. Creates temp dirs with `go.mod`. |
| `test/pr-review-dispatch.test.ts` | Integration | Single focused test: dispatch surfaces sidecar path on unparsable output. |
| `test/review-coordinator.test.ts` | Unit | Shared coordinator eligibility/in-progress guard: disabled, unknown HEAD, dirty linter, already-passed, explicit base-ref re-review, in-progress dedup, PASS/escalation background messages, compact kickoff contract (no bulky content). |
| `test/pr-review-tool.test.ts` | Unit | `pr_review` custom tool: contract exposure, kickoff/already-passed/base-ref/linter/HEAD/disabled/in-progress states, no bulky details, non-deadlocking async execute. |
| `test/reviewer.test.ts` | Unit | Report parser: well-formed report, malformed test execution status, missing marker, case-insensitivity, embedded-in-large-output (500KB prefix). |

## Patterns for adding tests

### Mock Pi API
```typescript
function createMockPi() {
    const commands = new Map();
    const messages: any[] = [];
    const handlers = new Map();
    const pi = {
        registerCommand(name, def) { commands.set(name, def); },
        on(event, handler) { handlers.set(event, handler); },
        sendMessage(msg) { messages.push(msg); },
        sendUserMessage(msg) { messages.push(msg); },
        // ... other methods as needed
    };
    return { pi, commands, messages, handlers };
}
```

### Dependency injection
```typescript
// Production: factory accepts deps
const orchestrator = createLinterOrchestrator(pi, {
    existsSync: mockExists,
    loadLinterConfig: mockLoadConfig,
    createPipeline: mockCreatePipeline,
    // ...
});

// Test: provide mocks
```

### Temp directories
```typescript
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-"));
});
afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
function makeFile(relPath, content) {
    const fullPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    return fullPath;
}
```

### `__test__` namespace
Internal functions exposed for testing:
```typescript
// In source:
export const __test__ = { detectModifiedFilesFromToolEvent, tokenizeArgs };

// In test:
import linterTest from "../src/linter/index.js";
const { detectModifiedFilesFromToolEvent } = linterTest.__test__;
```

### Characterization tests
When locking behaviour before refactoring, add a file-level comment documenting the invariant:
```typescript
// Characterization tests for the markdownlint adapter refactor (pl-c5fc).
// These tests lock the observable output of runMarkdownlint and must
// not change during the refactor.
```

## Integration vs unit split

| Integration (real I/O or real engines) | Unit (pure logic / mocked deps) |
|---|---|
| `linter-pipeline.test.ts` | `index.test.ts` (partial) |
| `markdownlint-characterization.test.ts` | `pr-gate-gate-decision.test.ts` |
| `sidecar.test.ts` | `pr-gate-pass-token-store.test.ts` |
| `pr-gate-integration.test.ts` | `pr-gate-auto-review-trigger.test.ts` |
| `pr-gate-test-execution.test.ts` | `reviewer.test.ts` |
| `index.test.ts` (sidecar portions) | `pr-gate-pr-review-config.test.ts` |
| | `linter-cli-adapter.test.ts` |

## What to run before submitting changes

```bash
# Always:
npm run typecheck
npm run test

# If you changed Biome-formatted files:
# Run Biome to verify formatting (no lint script in package.json — use biome CLI directly)
```

If you change gate decision logic: add cases to `test/pr-gate-gate-decision.test.ts`.
If you change report format: update `test/reviewer.test.ts` and the prompt in `src/pr-gate/prompts/system.md`.
If you change adapter behaviour: add characterization-style tests following `test/markdownlint-characterization.test.ts` patterns.
