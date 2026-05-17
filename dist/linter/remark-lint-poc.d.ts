/**
 * Proof-of-concept: remark-lint runner for post-turn-linter.
 *
 * This file demonstrates how remark-lint (via the unified ecosystem)
 * could replace or supplement markdownlint in the post-turn-linter.
 *
 * To use: swap the ".md" linter in DEFAULT_CONFIG from runMarkdownlint
 * to runRemarkLint (see bottom of file).
 */
import type { ApiLinterRunner } from "./core.js";
export declare const runRemarkLint: ApiLinterRunner;
