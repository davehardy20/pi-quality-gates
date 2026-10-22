<!-- markdownlint-disable MD013 -->

# 68e0: Pi 1.3.0 startup audit and canary checkpoint

Status: **Inert checkpoint only; real startup canary and activation remain held.**
Dave separately requested native code review and PR publication of this checkpoint.
That request does not establish safe-startup acceptance or authorize integration.
Canonical issue: `pi-quality-gates-68e0`; parent `pi-quality-gates-7823`,
`pl-a4d5` revision 3. Execution remains single-foreground.

Dave requested all four stages. This checkpoint advances the source audit,
adds a local startup-only seam and validates fabricated fixtures. It does not
claim a complete transitive-import audit, production bootstrap repair,
independent acceptance, real startup canary or Gondolin review.

## Four-stage ledger

| Stage | Evidence | Remaining work |
|---|---|---|
| Source-only audit | Installed launcher, bundled CLI startup excerpts and SDK lifecycle/default seams inspected below | Complete runtime/dependency import closure and independent source acceptance |
| Bounded repair | New `src/pr-gate/reviewer-startup-canary.ts`, with no imports, automatic importer, bridge registration or model request | Accepted cold-process loader/process envelope; actual reviewer facade/integration remain held |
| Fixture validation | New `test/reviewer-startup-canary.test.ts`; fabricated SDK objects only; targeted tests, no-emit typecheck and changed-file Biome | These are not actual SDK compatibility or non-interference evidence |
| Separately scoped real canary | Exact proposed limits and acceptance criteria below; **NOT RUN** | Accepted complete closure, fixed loader and independently accepted process envelope before launch |

Earlier inert checkpoint `b8488eb22c673d0a8b55722d7d54f20951b5e118` remains on
`reviewer-startup-admission-68e0`. Its prospective **0.74.1** schema is not a
1.3.0 adapter or execution lease. It was not overwritten, imported or promoted.
This new branch starts from current default HEAD
`c6a1cde4da738a8b251708e3c8e26f3e39ab5814`.

## Installation identity, not loaded-source attestation

Owner evidence: `pi`, version 1.3.0, launcher `/opt/homebrew/bin/pi`, shell Node
`/opt/homebrew/bin/node` resolving to Cellar Node 26.12.0. Owner status identifies
Quality Gates v0.1.2 at `/Users/dave/tools/pi-quality-gates/src/index.ts`.
These facts do not attest the already-running parent's complete loaded closure.

The following public installed files were read, not imported or executed.
Paths below `P/` mean
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`.

| Artifact | SHA-256 |
|---|---|
| Node `/opt/homebrew/Cellar/node/26.12.0/bin/node` | `958810801e23d50ee96c648b269ab1c37e73510d7de7e38f797e6822b5003b3b` |
| `P/package.json` | `83c3bb7619f590c213cc96a24216eb29a819a3ef6dc548607cc037ed276e8dc5` |
| `P/dist/bundle/cli.js` | `e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774` |
| `P/dist/bundle/cli-runtime.js` | `f9811fa28c52accb8e2433499a85e857b714a002956005b7859ad00e5e35f380` |
| `P/dist/core/sdk.js` | `8155c0b7d819d2248a1bbf0fa4b8e40d15552ff7fa6a772154cbbccb6ae59235` |
| `P/dist/core/model-runtime.js` | `578b742bea061fed029b8e139c6c0bcfe31e60665e9c0c6a08769761ef169dfd` |
| `P/dist/core/resource-loader.js` | `ad50235884ea6d5ee14cdae1efcfe6afef58b22b18ce574e81886d57ca9f4642` |

This is an **anchor inventory, not a complete closure manifest or authority**.
The CLI executes bundled chunks; the SDK candidate is a different entry path.
Bundled `chunk-66G7ITPS.js` was inspected as text for actual cleanup/migration
calls, not assumed equivalent merely from the unbundled source's filenames.
Installed `P/docs/` was used for version-specific API claims: the internal
`pi_docs` SDK text differed and cannot identify this installed runtime.

## Source-backed startup effects and controls

Line references are to the installed unbundled source unless stated otherwise.
Reachability is not evidence that a guarded mutation actually happened.

| Phase | Source/effect | Required exclusion or explicit control |
|---|---|---|
| CLI entry | `dist/bundle/cli.js:1-4` enables Node compile cache before loading `cli-runtime.js`; runtime configures HTTP dispatcher and calls bundled `main` | Do not launch the ambient CLI as a safety probe; a cold SDK entry must account for its own imports |
| Pre-mode work | `dist/main.js:450-479` invokes managed-install cleanup, file-backed global settings and HTTP setup before ordinary argument handling | Dedicated entry must not call CLI `main` or reuse its service factory implicitly |
| Cleanup | `dist/package-manager-cli.js:129-153` takes an update lock and calls staging cleanup under a managed-install guard | No claim that this npm installation satisfies the guard; no private-state probe to find out |
| Migrations | `dist/main.js:531-535`, `dist/migrations.js:274-280` call auth/session/tools/keybindings/extension migrations before session creation | `--no-session` is not a migration exemption; omit CLI migration path entirely |
| Resource selection | `dist/core/resource-loader.js:244-258,356-411` constructs package manager, reloads settings and resolves packages before `noExtensions` selects extensions | Supply a closed loader rather than filtering `DefaultResourceLoader` output |
| Pre-trust extension loading | `resource-loader.js:350-365` can load global/CLI extensions before deciding project trust | Untrusted cwd or declined trust does not prevent global extension startup |
| SDK imports | `dist/core/sdk.js:1-24` imports session, resources, tools and compatibility modules and sets the process default stream function | Injection avoids discovery defaults, not import effects; complete closure review is still required |
| Module initialization examples | `dist/config.js:456-468` reads public package metadata; `dist/core/model-config.js:72` compiles its schema; `pi-ai/dist/compat.js:140-141` initializes compatibility providers/catalog | These must be included in accepted closure; an empty ResourceLoader alone is insufficient |
| Auth import effects | Nested `pi-ai/dist/env-api-keys.js:13-28` eagerly schedules fs/os/path dynamic imports in Node; `auth/context.js:19-40` exposes ambient env/file probes behind callbacks | Include eager builtin imports in closure; never call ambient auth resolvers. In-memory credentials alone do not prove those callbacks unreachable |
| Lazy OAuth | Nested `pi-ai/dist/auth/helpers.js:37-52`, `auth/oauth/load.js:15-19` defer flow imports until login/refresh/toAuth | No login, refresh or auth conversion; verify their exclusion across the accepted actual startup path |
| Lazy image/WASM | `dist/utils/photon.js:98-118` temporarily patches `fs.readFileSync` around a dynamic import; its fallback includes cwd. Nested `photon-node/photon_rs.js:4512-4520` reads and instantiates WASM | Image conversion/transcoder setup must stay unreachable; account for native/WASM assets if admitted later, not only JS imports |
| SDK defaults | `sdk.js:69-83` otherwise creates model runtime, file settings/session and resource discovery | Supply every boundary explicitly; no missing-field fallback |
| Model/auth/storage | `dist/core/model-runtime.js:80-119` defaults to file credentials/models/store and refresh; `model-config.js:101-103` skips file load with no path | Canary candidate uses empty in-memory credentials, `modelsPath: null`, `refreshOnCreate: false`, `allowModelNetwork: false`; no prompt |
| Settings/session | `settings-manager.js:251-255` exposes in-memory storage; `session-manager.js:644-651,1364-1365` avoids mkdir/persistence with `inMemory` | No temporary HOME substitution and no reuse of actual auth/session files |
| Tool construction | `agent-session.js:2934-2960` still creates built-in tool definitions before active-tool selection; bash operations resolve shell only inside execution (`tools/bash.js:132-134,159-160`) | Do not claim tools were never constructed. Canary uses `noTools: "all"`, empty explicit tools/custom tools and asserts no active tools |
| Lifecycle | `agent-session.js:2631-2653` binding emits `session_start`, then resources discovery | Empty extension set/runtime, closed loader; attempted reload/extension must fail |
| Teardown | `agent-session.js:996-1015` aborts, invalidates, cancels warming, then calls `cleanupSessionResources`; `pi-ai/dist/session-resources.js:8-20` invokes registered callbacks | Disposal is mandatory; registered provider cleanup closure must be reviewed too. Disposal is not an automatic `session_shutdown` event |

Previously audited global orchestrator startup/recovery/mailbox pruning/Gate A
cleanup remains excluded in its entirety, not just Gate A. The new module does
not import that source, either reviewer bridge, or Quality Gates' entrypoint.
No protected private cache, marker, receipt, credential, log or Git state was
read to infer whether cleanup guards would pass.

An exploratory source-only regex inventory followed static and literal lazy
edges across 2,175 public installed files / 67 package roots. It left 44
unresolved candidates (including false positives and package-import aliases)
and 31 possible nonliteral edges. It did not execute the target. This is an
over-approximation diagnostic, **not** an authoritative resolver, complete
manifest or source review of those 2,175 files; no acceptance uses its digest.
A subsequent TypeScript-AST inventory resolved ESM static imports/re-exports and
literal CJS requires across **1,338 files / 30 packages**, with zero parse errors
or missing static edges. Its 43 non-JS assets were JSON; 23 dynamic-import sites
remain to classify. Traversal of literal requires is conservative, including
nested calls: neither that count nor a function wrapper proves startup reachability.
No target module was evaluated by either source inventory.

The unresolved closure is a real remaining stage-one task, not a permission
question that an owner inventory or passing fixture tests can settle.

## Local startup-only seam

`createReviewerStartupCanary` is an unregistered library factory. Its ports are
structural because this checkout's development SDK remains 0.74.x; no dependency,
lockfile, export, global configuration or protected source was changed.
Structural ports compiling does **not** demonstrate actual 1.3.0 compatibility.

An opaque checkpoint ID is the only request input. There is no JSON authority
flag, environment opt-in or default loader. Trusted host callbacks must supply:

1. A single-use accepted registry binding to exact Node, SDK closure, bootstrap,
   source commit, canonical freshly owned fixture root and bounded expiry.
2. Current independent acceptance **before import**, including actual path
   ownership/canonicalization and cold-process resource policy.
3. A fixed accepted SDK adapter and independent verification of its actual
   loaded origin/ABI. A version string or hash field is not that verification.

The binding is closed, copied and frozen. SDK 1.3.0 and Node v26.12.0 are the only
candidate versions. Lexical validation rejects traversal, controls, malformed
hashes and `.pi`/`.git` segments, but does not pretend to prove symlink safety.
Acceptance/time/cancellation are rechecked across setup, lifecycle and disposal.
Attempted resource expansion fails rather than silently loading resources.
Missing dependencies, failures, unexpected tools/model/extensions and failed
cleanup cannot produce a completed result. Diagnostics expose only reason codes.

The returned `startup-completed` value is **only a startup result**. Mocked SDKs
can produce it in unit tests. It is not an authenticated receipt, review report,
PASS token, grant, evidence of OS isolation, or permission to release 68e0.
The coordinator must own a real hard timeout: cooperative checks cannot forcibly
terminate an unresponsive import/factory. No such coordinator is shipped here.

## Separately scoped real canary: proposal, not execution admission

A real launch is held until the complete accepted import closure, fixed cold
loader and process envelope exist. Do not ask an owner to accept unresolved
source gaps as if they were completed safety evidence.

Proposed acceptance scope, once those prerequisites are independently met:

- Exactly one cold Node process using the pinned executable and accepted SDK
  entry/complete transitive closure; no CLI launcher, inherited `execArgv`,
  ambient extension loader, alternate bridge or protected worker pathway.
- Freshly allocated, owner-confirmed canonical temporary root; only fabricated
  extension/settings/context poison and sentinel fixtures. No real checkout,
  `.git`, actual HOME contents, auth file or protected sandbox inputs.
- No HOME redirection. Explicit minimal environment; no `NODE_OPTIONS`,
  `NODE_PATH`, compile-cache override, proxy, provider keys or other inherited
  ambient configuration. Environment hygiene is not OS containment.
- Startup/bind/dispose only; zero prompts, model requests, tool execution,
  validation subprocesses, backend/container/service calls or downloads.
- Maximum 15 seconds wall clock, bounded output (16 KiB per stream), then
  parent-owned termination and confirmed exit; kill the dedicated process on
  cancellation/failure. A timeout is a denial, never a partial success.
- Collect actual loaded-origin evidence through a source-audited mechanism;
  check its complete equality to the independently accepted manifest. Do not
  treat the current anchor inventory as that manifest.
- Read/hash only owned fixture sentinels before/after. Unexpected discovery or
  writes fail the canary. Never inspect protected runtime state to prove a
  negative. Sentinel success alone does not prove global non-interference.
- Cleanup removes only the exact created owned root, after confirmed exit;
  no prefix sweep, shared kev-ask cleanup, global reset or live state cleanup.
- Independently accept the complete result against the exact source/closure
  and limits before admitting this bootstrap for native review. Separately
  requested code review of the inert checkpoint is not that acceptance.
  Reject changed bytes or unsupported ABI; no fallback. OS containment needs a
  separately admitted mechanism; this trusted-host design does not supply it.

## Validation and closeout

Test-first stub: **55 expected failures, 8 passes** (63 initial tests), sidecar
`90ae0edd-9775-456a-a4fe-07ec5704fa89`. Subsequent cases cover expiry through
teardown and acceptance-callback expiry before import (that regression was
confirmed red separately, sidecar `63d2bbdb-6aa1-4418-ad3b-37a7d2645625`).
Initial checkpoint **70/70 PASS** (sidecar
`f1d286c8-61ee-4c40-bc7b-9e524fac41f9`), no-emit typecheck PASS and two-file
Biome PASS (`4cae74af-a47d-4eb8-94ef-8da48218550d`).

Dave then explicitly requested `pr_review` for `d954fb60`. It reported a warning:
nullish in-memory handles could re-enable ambient SDK defaults. Ten regression
cases (null/undefined credentials, settings, session, model and extension runtime)
were confirmed RED (`0b32a998-f680-4144-81d7-72bb0d32b765`), then fixed with
pre-factory handle validation. They assert no downstream factory/lifecycle runs.
Current **80/80 PASS** (`7aaf4b19-65c7-45d1-8f09-ffbce6c8e780`), no-emit typecheck
PASS and two-file Biome PASS (`c8ff342f-60d6-488e-9ae7-6ee80376c3bc`). These tests
import no actual SDK. Fresh exact-HEAD review is still required after the fix.

No broad suite, build emission, real startup canary, reload or activation was run.
The owner-requested native code review is separate from the source-only audit
and fabricated tests; its startup effects were not independently attested.
Default host/orchestrator bridge implementations and publication gates are
unchanged. Local fixture validation does not make the production path ready.

Eventual PR-first closeout still requires exact-HEAD native PASS with genuine
required validation, budget measurement, authorized push/PR, required CI/review
and applicable sensitive-path acceptance. Publication now has an explicit owner
request but still requires that PASS; unmerged/deferred work and unresolved
startup acceptance remain non-success for the parent plan.

See [PR Gate](pr-gate.md), [Testing](testing.md), and local historical proposal
`.seeds/drafts/pl-a4d5-startup-bootstrap-proposal.md` (its earlier installation
versions are historical, not current runtime selections).
