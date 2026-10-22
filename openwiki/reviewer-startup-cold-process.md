<!-- markdownlint-disable MD013 -->

# 68e0: Pinned adapter and cold-process checkpoint

**Unregistered engineering candidate. Not safe-startup admission.**
Canonical work remains `pi-quality-gates-68e0`, parent `pi-quality-gates-7823`,
`pl-a4d5` revision 3. PR #61 merged the preceding inert seam as
`0fd44fdd69917874e5ccfed60cda682b6db72fa5`; it released no downstream hold.
This checkpoint starts from that merge on `reviewer-startup-cold-process-68e0`.

No real Pi SDK startup canary, extension activation, production bridge change,
dependency change, protected sandbox operation or integration is included.
Native code review/publication of an inert checkpoint is not startup acceptance.
Greptile, not Codex, is the automated GitHub reviewer.

## Source-audit continuation

The prior TypeScript-AST inventory reported 1,338 static files across 30 packages,
including 43 JSON assets, with no missing static edges or parse failures.
Those numbers describe an inventory, not 1,338 independently reviewed files.
The 23 captured native dynamic-import sites have the following startup routing.
Paths below are relative to the public installed Pi 1.3.0 package; `AI/` means
`node_modules/@earendil-works/pi-ai/dist/`.

| Sites | Source | Trigger and candidate routing |
|---|---|---|
| 3 | `dist/core/extensions/loader.js:24,29` | Two Jiti alternatives and virtual modules require extension-loader operations. The closed resource loader and empty extension/runtime set do not request them. `jiti.import()` at line 481 is a separate extension-evaluation capability, not a native `import()` AST node. |
| 1 | `AI/env-api-keys.js:13-28` | Eager Node initialization schedules fs/os/path builtin imports. These are reachable; they must be explicitly allowed and predicted, not called unreachable merely because no provider request runs. |
| 1 | `AI/auth/context.js:10` | Variable builtin import helper is used by ambient auth-resolution callbacks. In-memory credentials, no model, disabled refresh and no provider operation exclude those callbacks from the proposed lifecycle. |
| 1 | `AI/auth/oauth/load.js:17` | Provider-flow loading requires login/refresh/auth conversion. None is admitted. |
| 14 | `AI/api/*.lazy.js` in the captured graph | Thirteen literal provider/classifier imports plus the variable Bedrock loader require stream/image/classify operations. Registering lazy APIs is not executing those operations. No prompt, classifier or model request is issued. |
| 1 | `AI/providers/images/register-builtins.js:15` | Deferred OpenRouter image implementation requires image generation. No image operation is admitted. |
| 1 | `dist/utils/syntax-highlight.js:55` | Optional language-loading fallback requires highlighter initialization/unknown-language handling, not the JSON-mode startup lifecycle. |
| 1 | `dist/utils/photon.js:108` | Transcoding requires image conversion. It remains excluded, including the temporary fs patch and WASM initialization described in the preceding audit. |

The fourteen captured API wrappers are Anthropic messages, Azure OpenAI responses,
Bedrock converse stream, Cloudflare Workers AI System One, Google generative AI,
Google Vertex, Mistral conversations, OpenAI Codex responses/completions/decisions/
responses, OpenRouter images, Pi messages and TypeSafe System One. A broader
API-directory text search also finds a Llama CPP wrapper; it has no literal
importer in the inspected SDK/provider sources and is not thereby added to the
captured graph. A directory match is not startup reachability evidence.

This classification follows the previously inspected create/bind/dispose path.
It does not independently accept the complete executed closure, prove every
transitive initialization/cleanup effect, or provide an authoritative manifest.
Public package metadata/schema/catalog initialization remains reachable.
Built-in tool definitions are constructed even when no tools are active.
Disposal can invoke registered cleanup callbacks; those callbacks remain part
of the acceptance obligation. CLI cleanup, migrations, dispatcher setup and
ambient reviewer/orchestrator bootstrap remain excluded, not silently repaired.

## Components

| Component | Responsibility |
|---|---|
| `src/pr-gate/reviewer-startup-adapter.ts` | Six exact Pi 1.3.0 internal entry files; own data-property ABI inspection without invoking getters; static receiver preservation; frozen structural runtime; no ambient SDK package-index import. |
| `src/pr-gate/reviewer-startup-loader.ts` | Child-only synchronous hooks; exact canonical source pins; verified bytes supplied directly to Node; builtin allowlist and `getBuiltinModule` fence; sticky denials even when SDK code catches errors. |
| `src/pr-gate/reviewer-startup-process.ts` | Parent deadline/cancellation/revocation/output/error supervision; SIGKILL and bounded close confirmation; no cleanup or success on `exit`/receipt alone. |
| `src/pr-gate/reviewer-startup-cold.ts` | Explicit preparation of fresh owned fixtures; trusted owner claim; immutable binding/source snapshots; pinned executable/bootstrap/module checks; exact predicted trace verification; restrictive spawn and ownership-checked cleanup. |
| `src/pr-gate/reviewer-startup-worker.mjs` | Dedicated unregistered child; native TypeScript bootstrap; startup/bind/dispose only; no review report or PASS-token authority. |

The canary's `Refusal` class uses erasable TypeScript rather than a parameter
property so the same source works with Node's native type stripping.
No package entrypoint imports or registers these components.

## Ownership, evidence and limits

- Only an opaque checkpoint ID and a genuine cancellation handle enter the
  controller. There is no registered canary CLI/model tool, default registry,
  default SDK root, ambient importer or JSON authority switch.
- The trusted owner must independently provision an accepted, single-use grant.
  Its binding covers Node version/hash, SDK closure policy, bootstrap bytes,
  source commit, owned fixture root and expiry. A callback returning `true` in
  a unit test is a fabrication, not that independent acceptance. The worker
  trusts its dedicated parent pipe; it does not implement another registry.
  Manually invoking the worker with JSON is not an admitted canary and cannot
  produce a parent registry grant or review PASS token.
- Fixtures are created explicitly under the canonical OS temp directory. An
  in-memory provenance capability records the root identity. Copied descriptors,
  replayed roots, changed identity and active children cannot authorize deletion.
  Fabricated auth/settings/models poison is never actual user state.
- The child can read the SDK tree and its owned bootstrap directory, not its
  poisoned state directory. SDK/state trees must be disjoint in both directions;
  reject equal, ancestor and descendant read scopes before launch. Delimiter-aware
  comparisons still permit harmless sibling names such as `state-sdk`.
  No filesystem-write, network, child-process,
  worker-thread, addon or WASI grant is supplied. Only stdin, stdout, stderr and
  a dedicated receipt pipe are inherited. Existing descriptors bypass Node's
  filesystem permission checks; none is a protected file descriptor.
- Environment is explicit: `LANG=C`, `TZ=UTC`, `PI_OFFLINE=1`,
  `NODE_V8_COVERAGE=` and `FORCE_COLOR=0`. Empty V8 coverage prevents Node's
  automatic propagation. Darwin's observed `__CF_USER_TEXT_ENCODING` addition
  is removed in the child before SDK imports; its value is never logged.
  Parent environment is not changed and HOME is not redirected.
- The manifest distinguishes permitted files/builtins from the exact predicted
  evaluated SDK file/builtin sets. The parent requires equality, not merely
  allowlist membership, and verifies the loaded-index digest after `close`.
  Bootstrap adapter/canary modules must also appear in the trace.
- Before emitting completion, the worker seals expansion. A later new module,
  new builtin, denied import or repeated non-builtin evaluation makes the child
  exit nonzero and invalidates the receipt pipe, even if SDK code catches the
  exception. Cached resolution alone does not add an evaluation. Waiting for `close`
  remains mandatory; the early completion frame is not final acceptance.
- Run budget is at most 15 seconds from immediately before spawn, with 16 KiB
  per output/receipt stream and 2 seconds to confirm termination. Preflight
  separately checks the short lease. Unconfirmed termination retains the root
  and reports PID. Successful completion requires awaited owned-root cleanup.
  These timers are not hard real-time OS guarantees; arbitrary trusted cleanup
  callbacks are not given an additional independent timeout by the generic watcher.
- Child-denial stage labels are a closed, redacted diagnostic vocabulary. They
  are self-reported, not acceptance evidence. Raw SDK errors/output are not returned.

## What this does not prove

Node permissions are defense-in-depth, **not an OS sandbox for malicious SDK
code**. Privileged builtins, code generation, native/platform initialization,
package-resolution metadata, mutable deployment paths and already-loaded modules
need explicit source/trust treatment. The hook trace covers module loads through
these hooks, not all filesystem reads or every possible evaluation mechanism.
Pre-exec file hashes are not kernel-loaded executable/shared-library attestation.
A source-commit field does not attest the running parent or its checkout.
The independent owner must establish those identities and deployment stability.

No production owner registry or independently accepted real-runtime manifest is
installed by this checkpoint. The source audit and exact real process envelope
still require independent acceptance. Fixture success, unchanged sentinels,
installation inventory and `/reload` smoke are not global non-interference proof.
`68e0`, `f165` and downstream integration remain blocked until their actual gates
are met. Do not launch the real startup canary just because these components exist.

## Validation

The adapter/process/fence and controller were developed against failing fabricated
fixtures. Controller stub failures were recorded before implementation. Further
red/green cases cover native type stripping, Darwin's added environment key,
poison-read denial, forged cancellation, exact trace equality and caught delayed
imports after completion. Tests launch disposable Node children against only
fabricated SDK files, never the installed SDK.

Targeted validation uses the five `test/reviewer-startup-*.test.ts` files,
`run_typecheck` and changed-file `run_biome`. The fixed worker receives real-child
positive coverage only on Node v26.12.0; other Node versions must refuse it.
That conditional assertion is an unsupported-ABI test, not SDK compatibility.
Repository CI uses Node 22: it cannot validate the fixed worker's positive profile.
Scope-introspection assertions are not packet-level network probes. No network
operation was issued. Node 26's documented default network denial is described in
[its CLI permission reference](https://github.com/nodejs/node/blob/v26.0.0/doc/api/cli.md).
See [the preceding admission audit](reviewer-startup-admission.md) for the still-held
real-canary criteria and [Testing](testing.md) for repository validation conventions.
