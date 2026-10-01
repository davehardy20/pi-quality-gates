# PR Review — Task

## Original Task

{{TASK}}

## Changed Files

{{FILES}}

## Diff

{{DIFF}}

## Test Execution Plan

{{TEST_PLAN}}

{{EXTRA_INSTRUCTIONS}}

---

## Instructions

1. Read each changed file listed above.
2. Follow the generated Test Execution Plan using its JSON tool arguments,
   including explicit `timeoutMs`. Keep per-file test calls separate, preserve
   Node loaders, retain whole-project typecheck, and lint only listed paths.
   Run additional relevant tests when changed behavior needs unchanged coverage.
3. Work through all seven review domains defined in your system prompt.
4. For each finding, cite the exact file path, line number, and code excerpt.
5. Calibrate severity strictly per the definitions in your system prompt.
6. Emit the `## Review Report` block and stop.

### Important

- You are **read-only**. Do not use `write`, `edit`, `hashline_edit`, `bash`,
  `git_safe`, `gh_safe`, or any mutating Seeds/Mulch tools.
- Do not use `container_safe`; this reviewer runs host-side with no container.
- Use only the safe validation runners (`run_biome`, `run_vitest`,
  `run_typecheck`, `run_pytest`, `run_cargo_test`, `run_node_test`) to execute
  project tests.
- Include bounded test results in `### Test execution`; cite any sidecar ref
  instead of pasting raw logs. Incomplete or unavailable required validation
  stays `NOT_RUN`; executed failures stay `FAIL`. A passing subset cannot
  turn an incomplete required check into `PASS`.
- Focus on the **diff between the base ref and HEAD**.
- If you cannot read a file or run a test, note it under
  "What could not be verified" with the reason.
