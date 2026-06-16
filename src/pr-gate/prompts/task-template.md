# PR Review — Task

## Original Task

{{TASK}}

## Changed Files

{{FILES}}

## Diff

{{DIFF}}

## Validation Evidence and Plan

{{TEST_PLAN}}

---

## Instructions

1. Read each changed file listed above.
2. Use the Apple container validation evidence from the validation section as
   ground truth. Do not rerun commands already captured there.
3. Work through all seven review domains defined in your system prompt.
4. For each finding, cite the exact file path, line number, and code excerpt.
5. Calibrate severity strictly per the definitions in your system prompt.
6. Emit the `## Review Report` block and stop.

### Important

- You are **read-only**. Do not use `write`, `edit`, `hashline_edit`, `bash`,
  `git_safe`, `gh_safe`, `container_safe`, or any mutating Seeds/Mulch tools.
- Prefer the supplied Apple container validation evidence. Use safe validation
  runners only for additional checks not already captured in that evidence.
- Focus on the **diff between the base ref and HEAD**.
- If you cannot read a file or run a test, note it under
  "What could not be verified" with the reason.
