/**
 * `.pi/reviewer.skip` file parser — gitignore-format skip rules for the
 * post-turn-reviewer.
 *
 * Uses the `ignore` package which implements the full
 * [.gitignore spec 2.22.1](https://git-scm.com/docs/gitignore).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Ignore } from "ignore";

// The `ignore` ESM default export is the factory function, but TypeScript's
// bundled types don't model the default correctly. Import as any and cast.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _ignoreModule: { default: (opts?: { ignoreCase?: boolean }) => Ignore } =
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  require("ignore") as any;
const createIgnore = _ignoreModule.default ?? _ignoreModule;

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
