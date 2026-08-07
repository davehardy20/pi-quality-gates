/**
 * `.pi/reviewer.skip` file parser — gitignore-format skip rules for the
 * post-turn-reviewer — plus `loadExtraInstructions`, which reads per-repo
 * `.pi/review-instructions.md` guidance appended to the reviewer task prompt.
 *
 * Uses the `ignore` package which implements the full
 * [.gitignore spec 2.22.1](https://git-scm.com/docs/gitignore).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import ignoreModule, { type Ignore } from "ignore";

type IgnoreFactory = (opts?: { ignoreCase?: boolean }) => Ignore;
const createIgnore = ignoreModule as unknown as IgnoreFactory;

// ── Types ──────────────────────────────────────────────────────────────

/** Result of loading and parsing a reviewer.skip file. */
export interface SkipFilter {
	/** `true` when the skip file was found and parsed. */
	loaded: boolean;
	/** Absolute path of the parsed skip file, or `null` if not found. */
	filePath: string | null;
	/** Number of non-comment, non-blank pattern lines parsed. */
	patternCount: number;
	/** The underlying `ignore` instance. Use `filter()` or `ignores()`. */
	readonly ig: Ignore;
}

/** Options for loading a skip file. */
export interface SkipFilterOptions {
	/**
	 * Optional logger for warnings (file not found is *not* warned by default).
	 * Defaults to `console.error`.
	 */
	log?: (msg: string) => void;
}

// ── Implementation ─────────────────────────────────────────────────────

const NOOP_FILTER: SkipFilter = Object.freeze({
	loaded: false,
	filePath: null,
	patternCount: 0,
	ig: createIgnore(),
});

/**
 * Load and parse a `.pi/reviewer.skip` file (gitignore format).
 */
export function loadSkipFilter(
	projectRoot: string,
	skipFilePath: string | null | undefined,
	opts?: SkipFilterOptions,
): SkipFilter {
	if (!skipFilePath) return { ...NOOP_FILTER, ig: createIgnore() };

	const log = opts?.log ?? console.error;
	const absPath = path.resolve(projectRoot, skipFilePath);

	let raw: string;
	try {
		raw = fs.readFileSync(absPath, "utf8");
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return { ...NOOP_FILTER, ig: createIgnore() };
		}
		log(`[pi-reviewer-skip] Failed to read skip file ${absPath}: ${error}`);
		return { ...NOOP_FILTER, ig: createIgnore() };
	}

	return parseSkipContent(raw, absPath, opts);
}

/**
 * Parse gitignore-format content directly (useful for tests or embedded config).
 */
export function parseSkipContent(
	content: string,
	labelPath?: string,
	opts?: SkipFilterOptions,
): SkipFilter {
	const log = opts?.log ?? console.error;
	const ig = createIgnore();
	const lines = content.split(/\r?\n/);

	let patternCount = 0;
	const addable: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		const line = rawLine.replace(/\r$/, "");

		if (line.trim() === "") continue;
		if (line.startsWith("#")) continue;

		patternCount++;
		addable.push(line);
	}

	try {
		ig.add(addable);
	} catch (error: unknown) {
		const label = labelPath ?? "<inline>";
		log(`[pi-reviewer-skip] Invalid pattern in ${label}: ${error}`);
		return {
			loaded: true,
			filePath: labelPath ?? null,
			patternCount: 0,
			ig: createIgnore(),
		};
	}

	return {
		loaded: true,
		filePath: labelPath ?? null,
		patternCount,
		ig,
	};
}

// ── Convenience helpers ────────────────────────────────────────────────

/**
 * Check whether a single file path should be skipped.
 */
export function shouldSkip(filter: SkipFilter, filePath: string): boolean {
	if (!filter.loaded) return false;
	const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
	return filter.ig.ignores(normalized);
}

/**
 * Filter a list of file paths, removing those that match skip patterns.
 */
export function filterSkipped(
	filter: SkipFilter,
	filePaths: string[],
): string[] {
	if (!filter.loaded || filter.patternCount === 0) return filePaths;
	const normalized = filePaths.map((p) =>
		p.replace(/\\/g, "/").replace(/^\.\//, ""),
	);
	return filter.ig.filter(normalized);
}

// ── Per-repo extra instructions ───────────────────────────────────────

/** Default relative path for per-repo reviewer extra instructions. */
export const DEFAULT_EXTRA_INSTRUCTIONS_PATH = ".pi/review-instructions.md";

/**
 * Load per-repo extra instructions appended to the reviewer task.
 *
 * Reads a plain text/markdown file (default `.pi/review-instructions.md`)
 * relative to `projectRoot`. Returns the trimmed contents, or `undefined`
 * when the file is absent or empty — mirroring the silent-absent behavior of
 * `loadSkipFilter`. Never throws on a missing file (ENOENT); other read
 * errors are logged (via `opts.log`, default `console.error`) and treated as
 * absent so a bad instructions file can never block a review.
 */
export interface ExtraInstructionsOptions {
	/** Optional logger for warnings (file not found is *not* warned). Defaults to `console.error`. */
	log?: (msg: string) => void;
}

export function loadExtraInstructions(
	projectRoot: string,
	relativePath: string = DEFAULT_EXTRA_INSTRUCTIONS_PATH,
	opts?: ExtraInstructionsOptions,
): string | undefined {
	const log = opts?.log ?? console.error;
	const absPath = path.resolve(projectRoot, relativePath);
	let raw: string;
	try {
		raw = fs.readFileSync(absPath, "utf8");
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return undefined;
		}
		log(
			`[pi-reviewer-skip] Failed to read extra instructions ${absPath}: ${error}`,
		);
		return undefined;
	}
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
