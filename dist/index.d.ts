/**
 * Pi Quality Gates — Post-turn linting + automated code review
 *
 * This package bundles two tightly-coupled quality gate extensions:
 *
 * 1. **Post-Turn Linter** — runs lint checks on files modified during each
 *    agent turn. Supports markdownlint, biome, ruff, cppcheck, tflint,
 *    cargo clippy, and LSP diagnostics.
 *
 * 2. **Post-Turn Reviewer** — after the linter reports clean, spawns a
 *    headless child Pi process to review changes against the original task
 *    using a structured 7-domain checklist (task completion, correctness,
 *    error handling, security, quality, testing, documentation).
 *
 * Commands added:
 *   /post-turn-linter-run    — Run linter now
 *   /post-turn-linter-fix    — Fix latest linter findings
 *   /post-turn-linter-status — Show linter state
 *   /reviewer-status         — Show reviewer state
 *   /reviewer-run            — Manually trigger a review
 *   /reviewer-model          — Switch review model mid-session
 *   /reviewer-toggle         — Enable or disable the reviewer
 *   /quality-gates-status    — Show package identity and debug info
 *
 * Install:
 *   pi install /Users/dave/tools/pi-quality-gates
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function qualityGatesExtension(pi: ExtensionAPI): void;
