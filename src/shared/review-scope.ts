/**
 * Shared review scoping primitives: diff gathering, file filtering, and task
 * intent extraction.
 *
 * Used by both the post-turn reviewer (working-tree vs HEAD) and the PR
 * pre-push review gate (HEAD vs a base ref). Keeping these in one place means
 * both reviewers apply the same gitignore/skip-filter rules, diff capping,
 * and intent-extraction heuristics.
 */

import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

/**
 * Options for filtering files before gathering diffs.
 *
 * Two filtering layers are supported:
 *  1. `.gitignore` filtering via `git check-ignore` (accurate, respects nested files)
 *  2. `.pi/reviewer.skip` filtering via the `ignore` package (gitignore-format patterns)
 */
export interface DiffFilterOptions {
	/** Whether to exclude git-ignored files. Defaults to `false`. */
	respectGitignore?: boolean;
	/**
	 * A pre-loaded skip filter (from `loadSkipFilter`).
	 * Files matching these patterns are excluded regardless of gitignore.
	 */
	skipFilter?: {
		loaded: boolean;
		patternCount: number;
		ig: {
			ignores: (path: string) => boolean;
			filter: (paths: string[]) => string[];
		};
	} | null;
}

// ---------------------------------------------------------------------------
// Intent extraction
// ---------------------------------------------------------------------------

/**
 * Extract the most recent user task from session entries.
 * Scans entries in reverse, skipping extension-generated messages,
 * and returns the last meaningful user prompt.
 */
export function extractOriginalTask(
	entries: Array<{
		type: string;
		message?: {
			role?: string;
			content?: string | Array<{ type?: string; text?: string }>;
		};
	}>,
): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "user") continue;

		const content = msg.content;
		if (!content) continue;

		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((p) => p.type === "text" && typeof p.text === "string")
							.map((p) => p.text)
							.join("\n")
					: "";

		if (text.trim().length > 0) {
			return text.trim();
		}
	}
	return "";
}

// ---------------------------------------------------------------------------
// File filtering
// ---------------------------------------------------------------------------

/**
 * Filter a list of file paths by removing those that match .gitignore rules.
 *
 * Uses `git check-ignore` which correctly handles nested `.gitignore` files,
 * `.git/info/exclude`, and other gitignore resolution rules.
 *
 * @param files  File paths relative to `cwd`.
 * @param cwd    The git working tree root.
 * @returns      A new array with gitignored files removed.
 */
export async function filterGitignoredFiles(
	files: string[],
	cwd: string,
): Promise<string[]> {
	if (files.length === 0) return [];

	// Use `git check-ignore --stdin -z` for NUL-separated I/O.
	// With -z, stdin expects NUL-separated paths and output is NUL-separated too.
	const filesInput = files.join("\0");
	const result = await runReadonlyCommandWithInput(
		`git check-ignore --stdin -z`,
		cwd,
		filesInput,
	);

	// git check-ignore exits 0 if paths match, 1 if none match,
	// and outputs each ignored path separated by NUL bytes.
	if (result.exitCode === 1 || !result.stdout) {
		// No files are ignored — return all
		return [...files];
	}

	// Parse NUL-separated ignored paths
	const ignoredSet = new Set(
		result.stdout
			.split("\0")
			.map((p) => p.trim())
			.filter((p) => p.length > 0),
	);

	// Keep files that are NOT ignored
	return files.filter((f) => !ignoredSet.has(f));
}

/**
 * Apply all configured filters to a file list.
 *
 * Filtering order:
 *  1. `.gitignore` (if `respectGitignore` is true) — via `git check-ignore`
 *  2. `.pi/reviewer.skip` (if `skipFilter` is loaded) — via `ignore` package
 *
 * @param files   File paths relative to `cwd`.
 * @param cwd     The working directory.
 * @param options Filter options.
 * @returns       A new array with filtered files removed.
 */
export async function applyDiffFilters(
	files: string[],
	cwd: string,
	options?: DiffFilterOptions,
): Promise<string[]> {
	if (!options || files.length === 0) return [...files];

	let filtered = [...files];

	// Layer 1: .gitignore filtering via git check-ignore
	if (options.respectGitignore) {
		filtered = await filterGitignoredFiles(filtered, cwd);
	}

	// Layer 2: reviewer.skip filtering via ignore package
	if (options.skipFilter?.loaded && options.skipFilter.patternCount > 0) {
		const normalized = filtered.map((p) =>
			p.replace(/\\/g, "/").replace(/^\.\//, ""),
		);
		filtered = options.skipFilter.ig.filter(normalized);
	}

	return filtered;
}

// ---------------------------------------------------------------------------
// Diff gathering
// ---------------------------------------------------------------------------

/**
 * Generate a git diff for the given files.
 *
 * By default compares the working tree against `HEAD` (post-turn reviewer
 * use case). Pass `baseRef` to compare `baseRef..HEAD` instead (PR gate use
 * case). If a file has no HEAD (new file), falls back to
 * `git diff --no-index /dev/null`.
 *
 * When `filterOptions` are provided, files matching .gitignore or reviewer.skip
 * patterns are excluded from the diff before it is generated.
 */
export async function gatherDiff(
	files: string[],
	cwd: string,
	maxLines: number,
	baseRef?: string,
	filterOptions?: DiffFilterOptions,
): Promise<string> {
	// Apply filters first
	const filteredFiles = await applyDiffFilters(files, cwd, filterOptions);

	if (filteredFiles.length === 0) return "";

	const baseSpec = baseRef ? `${baseRef}..HEAD` : "HEAD";

	// First try `git diff <base> -- <files>` for tracked files
	const headResult = await runReadonlyCommand(
		`git diff ${baseSpec} -- ${filteredFiles.map((f) => shellQuote(f)).join(" ")}`,
		cwd,
	);

	// Also check for untracked files (new files not yet committed)
	const untracked: string[] = [];
	for (const file of filteredFiles) {
		// Check if the file is tracked by git
		const tracked = await runReadonlyCommand(
			`git ls-files --error-unmatch ${shellQuote(file)} 2>/dev/null`,
			cwd,
		);
		if (tracked.exitCode !== 0) {
			untracked.push(file);
		}
	}

	let diff = headResult.stdout;

	// Add full content for untracked files
	for (const file of untracked) {
		const content = await runReadonlyCommand(
			`git diff --no-index /dev/null ${shellQuote(file)}`,
			cwd,
		);
		if (content.exitCode === 0 || content.exitCode === 1) {
			diff += `\n${content.stdout}`;
		}
	}

	// Cap at maxLines
	return capDiff(diff, maxLines);
}

/**
 * Resolve the merge base between two refs. Returns the empty string if git
 * cannot resolve a common ancestor.
 */
export async function resolveMergeBase(
	cwd: string,
	head: string,
	base: string,
): Promise<string> {
	const result = await runReadonlyCommand(
		`git merge-base ${shellQuote(head)} ${shellQuote(base)}`,
		cwd,
	);
	return result.exitCode === 0 ? result.stdout.trim() : "";
}

/**
 * Count changed lines (+/-) in a diff using `git diff --stat`.
 *
 * This is much cheaper than fetching the full diff text just to count lines.
 * Uses `--numstat` which outputs `added\tdeleted\tfilename` per file.
 * Returns total added + deleted lines.
 *
 * @param files  File paths relative to `cwd`.
 * @param cwd    The working directory.
 * @param baseRef Optional base ref; defaults to HEAD (working-tree diff).
 * @returns      Total number of added + deleted lines, or -1 on error.
 */
export async function countDiffLinesFast(
	files: string[],
	cwd: string,
	baseRef?: string,
): Promise<number> {
	if (files.length === 0) return 0;

	const baseSpec = baseRef ? `${baseRef}..HEAD` : "HEAD";

	// --numstat: "added\tdeleted\tfilename" — no diff body, just counts
	// --no-color: avoid ANSI escape codes
	const result = await runReadonlyCommand(
		`git diff --numstat --no-color ${baseSpec} -- ${files.map((f) => shellQuote(f)).join(" ")}`,
		cwd,
	);

	if (result.exitCode !== 0 || !result.stdout.trim()) {
		// May be all new (untracked) files — fall back to wc -l per file
		let total = 0;
		for (const file of files) {
			const tracked = await runReadonlyCommand(
				`git ls-files --error-unmatch ${shellQuote(file)} 2>/dev/null`,
				cwd,
			);
			if (tracked.exitCode !== 0) {
				// Untracked file — count its lines
				const wc = await runReadonlyCommand(`wc -l < ${shellQuote(file)}`, cwd);
				if (wc.exitCode === 0 && wc.stdout.trim()) {
					total += parseInt(wc.stdout.trim(), 10) || 0;
				}
			}
		}
		return total;
	}

	// Parse numstat lines: "added\tdeleted\tfilename"
	let total = 0;
	for (const line of result.stdout.trim().split("\n")) {
		const parts = line.split("\t");
		if (parts.length >= 2) {
			const added = parseInt(parts[0], 10);
			const deleted = parseInt(parts[1], 10);
			if (!Number.isNaN(added)) total += added;
			if (!Number.isNaN(deleted)) total += deleted;
		}
	}
	return total;
}

/**
 * Cap a diff string at maxLines, keeping the most recent changes.
 * Adds a truncation notice if truncated.
 */
export function capDiff(diff: string, maxLines: number): string {
	const lines = diff.split("\n");
	if (lines.length <= maxLines) return diff;

	const kept = lines.slice(0, maxLines);
	const dropped = lines.length - maxLines;
	kept.push(
		``,
		`--- DIFF TRUNCATED: ${dropped} lines omitted (cap: ${maxLines}) ---`,
	);
	return kept.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function shellQuote(str: string): string {
	return `'${str.replace(/'/g, "'\\''")}'`;
}

async function runReadonlyCommand(
	command: string,
	cwd: string,
): Promise<{ stdout: string; exitCode: number }> {
	return new Promise((resolve) => {
		let stdout = "";
		const proc = spawn("sh", ["-c", command], {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "ignore"],
		});

		proc.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});

		proc.on("close", (code) => {
			resolve({ stdout, exitCode: code ?? 0 });
		});
	});
}

async function runReadonlyCommandWithInput(
	command: string,
	cwd: string,
	stdin: string,
): Promise<{ stdout: string; exitCode: number }> {
	return new Promise((resolve) => {
		let stdout = "";
		// Parse command into args to avoid shell NUL-byte issues
		const proc = spawn("sh", ["-c", command], {
			cwd,
			shell: false,
			stdio: ["pipe", "pipe", "ignore"],
		});

		proc.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});

		proc.on("close", (code) => {
			resolve({ stdout, exitCode: code ?? 0 });
		});

		// Write stdin as a Buffer to preserve NUL bytes, then close
		proc.stdin.write(Buffer.from(stdin, "utf8"));
		proc.stdin.end();
	});
}
