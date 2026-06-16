# Shared 7-Domain Review Checklist

Used by both the post-turn reviewer and the PR pre-push review gate.
Work through every domain for each changed file. Mark a domain "not
applicable" with a reason if it does not apply to the change.

## Domain 1: Task Completion

- Does the output actually address what was asked in the original task?
- Are there leftover TODOs, FIXMEs, HACKs, or placeholder implementations?
- Are there stub functions that return hardcoded values instead of real logic?
- Was the full scope covered, or was part of the request silently dropped?
- If the task specified acceptance criteria, are they all met?

## Domain 2: Correctness & Logic

- Are there off-by-one errors (loop boundaries, array indices, pagination)?
- Are conditional branches correct — do they cover the right cases?
- Are there negation errors (`!` where there shouldn't be, or missing `!`)?
- Are comparisons using the right operator (`===` vs `==`, `>` vs `>=`)?
- Are there integer overflow, floating-point precision, or type coercion issues?
- Are there race conditions in concurrent or async code?
- Are there resource leaks (unclosed files, connections, streams)?
- Are return values checked and handled, not silently ignored?
- Are there infinite loops or unbounded recursion risks?
- Does the code handle the empty collection / zero / null / undefined case?

## Domain 3: Error Handling & Robustness

- Are errors caught at the right level (not too broad, not too narrow)?
- Are error messages informative without leaking sensitive data?
- Are there bare `catch` blocks that swallow errors silently?
- Are there `try`/`catch` blocks around I/O, network, and file operations?
- Do error paths clean up resources (close handles, release locks)?
- Are user-facing error messages actionable (tell the user what to do)?
- Are there assertions or assumptions that could fail in production?
- Is there graceful degradation, or does everything crash on the first error?

## Domain 4: Security (OWASP-Informed)

### Injection (OWASP A03:2021)

- SQL injection: Are queries parameterized, not string-concatenated?
- Command injection: Are shell commands escaped or avoided?
- LDAP / XPath / template injection risks?
- Log injection — can user input contain newlines that forge log entries?

### Broken Access Control (OWASP A01:2021)

- Are authorization checks present on all sensitive operations?
- Can a user access or modify another user's data (IDOR)?
- Are there admin-only endpoints without admin checks?

### Cryptographic Failures (OWASP A02:2020)

- Are passwords hashed with modern algorithms (bcrypt, argon2, scrypt)?
- Are secrets hardcoded in source, or loaded from environment/config?
- Is HTTPS enforced for sensitive data in transit?
- Are cryptographic keys rotated, not hardcoded?

### Security Misconfiguration (OWASP A05:2021)

- Are debug modes disabled for production code?
- Are default credentials changed?
- Are directory listings disabled?
- Are unnecessary services or ports exposed?

### Sensitive Data Exposure

- Are API keys, tokens, or passwords logged or included in error messages?
- Is PII handled according to data protection requirements?
- Are secrets redacted before logging or display?

### Supply Chain / Dependency Risks

- Are new dependencies well-maintained and widely used?
- Are dependency versions pinned, not floating (`^` or `~`)?
- Are there known vulnerabilities in newly introduced packages?

### Cross-Site Scripting (XSS) — where web code is present

- Is user input sanitized before rendering in HTML?
- Are template engines used correctly (auto-escaping enabled)?

### Path Traversal

- Are file paths validated to prevent `../` traversal?
- Are user-supplied filenames sanitized?

### Denial of Service

- Are there unbounded loops or recursive operations on user input?
- Are file uploads size-limited?
- Are regex patterns safe from catastrophic backtracking (ReDoS)?

## Domain 5: Code Quality & Maintainability

- Are functions/methods doing one thing (single responsibility)?
- Are functions short enough to understand at a glance (< 30 lines)?
- Are names descriptive and consistent with the codebase conventions?
- Is there duplicate code that should be extracted into a shared function?
- Are magic numbers/strings extracted into named constants?
- Is dead code (unreachable paths, unused variables, unused imports) present?
- Are comments explaining *why*, not *what* (code should explain what)?
- Is the code consistent with existing patterns in the codebase?
- Are there deeply nested conditionals that should be flattened or extracted?
- Are there long parameter lists that should use an options/config object?
- Is the code testable (dependencies injectable, not hardcoded)?

## Domain 6: Testing & Verification

- Were tests added or updated for the change?
- Do tests cover the happy path AND the error/failure paths?
- Are edge cases tested (empty input, null, max values, boundary conditions)?
- Do tests actually assert the right things, or just check "it doesn't throw"?
- Are tests independent (can run in any order, no shared mutable state)?
- Are test names descriptive enough to understand what failed without reading the test body?
- Are mocks/stubs used correctly (not over-mocked to the point of testing nothing real)?
- If the change fixes a bug, is there a regression test that would catch it?

## Domain 7: Documentation & Contracts

- Are public APIs documented (parameters, return types, exceptions)?
- Are breaking changes reflected in documentation?
- Are type annotations present and accurate (where the language supports it)?
- Are README/docs updated if the change affects usage or configuration?
- Are there comments on non-obvious business logic or algorithms?
- Are error codes or status codes documented?
