/**
 * Pi Quality Gates — post-turn linting + PR review gate
 *
 * This package bundles two quality gate extensions:
 *
 * 1. **Post-Turn Linter** — runs lint checks on files modified during each
 *    agent turn. Supports markdownlint, biome, ruff, cppcheck, tflint,
 *    cargo clippy, and LSP diagnostics.
 *
 * 2. **PR Gate** — gates gh_safe push / pr_create behind a PASS token stamped
 *    by the `/pr-review` command, which runs a read-only headless child Pi
 *    review scoped to the PR diff.
 *
 * Commands added:
 *   /post-turn-linter-run    — Run linter now
 *   /post-turn-linter-fix    — Fix latest linter findings
 *   /post-turn-linter-status — Show linter state
 *   /pr-review               — Run a PR review for the current HEAD
 *   /pr-review-status        — Show PR review state
 *   /pr-gate-status          — Show push gate state
 *   /pr-gate-toggle          — Enable or disable the push gate
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
