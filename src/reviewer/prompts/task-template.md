# Post-Turn Code Review — Task

## Original Task

{{TASK}}

## Changed Files

{{FILES}}

## Diff

{{DIFF}}

---

## Instructions

1. Read each changed file listed above using your `read` tool.
2. For each file, work through **all seven review domains** defined in your
   system prompt. Do not skip any domain.
3. For each finding, cite the exact file path, line number, and code excerpt
   as evidence.
4. Calibrate severity strictly per the definitions in your system prompt.
5. When all files are reviewed, emit the `## Review Report` block and stop.

### Important

- You are **read-only**. Do not use `write`, `edit`, or `hashline_edit`.
- Use `bash` only for read-only commands: `cat`, `head`, `tail`, `wc`, `diff`,
  `git diff`, `git log`, `git show`, `git blame`, `git status`, `grep`, `find`,
  `ls`, `file`, `stat`, `jq`.
- Never run mutating commands (`rm`, `mv`, `chmod`, `>`, `>>`, `tee`, `npm
  install`, `pip install`, etc.).
- If you cannot read a file, note it under "What could not be verified" with
  the reason.
- Focus on the **diff and the changed files**. Do not review unchanged code
  unless it directly interacts with the changes in a way that introduces risk.
- The original task is your ground-truth intent. Verify the output against
  what was *asked for*, not just what the code *claims to do*.
