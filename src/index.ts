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

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import postTurnLinter from "./linter/index.js";
import prGateExtension from "./pr-gate/index.js";
import postTurnReviewerExtension from "./reviewer/index.js";

interface PackageMetadata {
	name: string;
	version: string;
	packageRoot: string;
	sourcePath: string;
}

const sourcePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(sourcePath), "..");
let cachedPackageMetadata: PackageMetadata | null = null;

function getPackageMetadata(): PackageMetadata {
	if (cachedPackageMetadata) return cachedPackageMetadata;

	let name = "pi-quality-gates";
	let version = "0.1.0";

	try {
		const packageJsonPath = path.join(packageRoot, "package.json");
		const packageJson = JSON.parse(
			fs.readFileSync(packageJsonPath, "utf8"),
		) as { name?: string; version?: string };
		name = packageJson.name ?? name;
		version = packageJson.version ?? version;
	} catch {
		// best-effort metadata only
	}

	cachedPackageMetadata = { name, version, packageRoot, sourcePath };
	return cachedPackageMetadata;
}

export default function qualityGatesExtension(pi: ExtensionAPI) {
	postTurnLinter(pi);
	postTurnReviewerExtension(pi);
	prGateExtension(pi);

	pi.registerCommand("quality-gates-status", {
		description: "Show pi-quality-gates package status and debug info",
		handler: async (_args, _ctx) => {
			const metadata = getPackageMetadata();
			pi.sendMessage({
				customType: "quality-gates-status",
				content: [
					`${metadata.name} v${metadata.version}`,
					`source: ${metadata.sourcePath}`,
					`packageRoot: ${metadata.packageRoot}`,
				].join("\n"),
				details: metadata,
				display: true,
			});
		},
	});
}
