# Biome scope in PR-review validation

The review planner must not require Biome to check files that the repository's
Biome configuration excludes. Such a call can check zero files and exit with an
error, making an otherwise valid review impossible to complete.

`src/pr-gate/biome-validation-scope.ts` filters lint candidates before
`test-execution.ts` creates a required `run_biome` call. It reports excluded paths
as **not linted** in the plan. Exclusion does not remove files from the review
diff, test calls or mandatory TypeScript project checks. Other applicable
validation and human/model inspection still apply.

For example, a preparatory PR containing only a pinned runtime manifest and
lockfile does not implement or verify a working guest image. Review that slice
as a prerequisite; image preparation, integration and boot evidence belong to
the implementation slice. A successful review must not claim image readiness
from manifest inspection or typechecking alone.

## Static resolution and limits

The resolver reads repository-contained `biome.json` or `biome.jsonc` as strict
JSON. It supports Biome 2 `files.includes` with ordered literal paths, `*`,
whole-segment `**`, `!` exclusions and `!!` force exclusions. Directory patterns
apply to descendants; matching remains case-sensitive. Each pattern permits
at most one `**` segment and one `*` in each other segment, keeping local matcher
work bounded. Metadata is bounded to 256 KiB, 64 patterns of at most 256 characters
and 32 path components.

It intentionally does not implement the entire Biome configuration language.
Comments/trailing commas, inheritance, non-root configurations, unsupported
patterns, conflicting config names and nested configurations retain required
lint checks for unresolved paths. Missing explicit file scope preserves the
existing lint plan. A changed or deleted root Biome configuration also retains
all checks. Dispatch passes the unfiltered changed-path set separately from
review-filtered candidates. The planner validates it before normalization and
uses it only for the config-change guard, including deleted config names.
Neither `.pi/reviewer.skip` nor gitignore filtering can hide a config change
from this guard; filtered/deleted files never enter runner arguments. A PR
cannot use its own new exclusions or a config-name switch to suppress required
lint validation.
Unsafe symlinks and oversized metadata fail planning with a safe error.
Repository configuration is never executed and no packages are installed.

This is not a fallback that marks a failed check as passing. Unprocessed files
are not counted as linted; remaining failures or incomplete required calls
still prevent PASS. Token binding, exact-HEAD review, deadlines and publication
gates are unchanged. No gate budget or repository lint configuration is changed.

## Regression coverage

`test/pr-gate-biome-scope.test.ts` reproduces the Gondolin manifest/lockfile
failure and covers mixed included/excluded files, preserved test/typecheck
calls, ordered patterns, conservative unresolved cases and metadata/path bounds.
`test/pr-gate-biome-scope-dispatch.test.ts` exercises real reviewer.skip filtering
through dispatch, including both config names, deletions and config-name switches.
The workspace and test-execution suites cover the surrounding planner contract.

After the fix is reviewed and installed, reload the owning Pi session before
requesting a new native review. Passing local tests does not establish that an
already-running extension has loaded this change or that a native review passed.
