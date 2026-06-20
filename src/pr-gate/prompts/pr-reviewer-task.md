# PR Review — Task

## Original Task

{{TASK}}

## Changed Files

{{FILES}}

## Diff

{{DIFF}}

## Test Execution Plan

{{TEST_PLAN}}

---

## Instructions

1. Read each changed file listed above.
2. Run the recommended validation commands from the test execution plan.
3. Work through all seven review domains defined in your system prompt.
4. For each finding, cite the exact file path, line number, and code excerpt.
5. Calibrate severity strictly per the definitions in your system prompt.
6. Emit the `## Review Report` block and stop.

### Important

- You are **read-only**. Do not use `write`, `edit`, `hashline_edit`, `bash`,
  `git_safe`, `gh_safe`, or any mutating Seeds/Mulch tools.
- Use `container_safe` only as the Apple-container sandbox bridge for review-time
  validation. Do not build/publish arbitrary images or mutate the host repo.
- Use only the safe validation runners (`run_biome`, `run_vitest`,
  `run_typecheck`, `run_pytest`, `run_cargo_test`) to execute project tests.
- Include bounded test results in `### Test execution`; cite any sidecar ref
  instead of pasting raw logs.
- Focus on the **diff between the base ref and HEAD**.
- If you cannot read a file or run a test, note it under
  "What could not be verified" with the reason.
