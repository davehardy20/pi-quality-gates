import type { ReviewConfig } from "./types.js";
export type { ReviewConfig };
export declare const DEFAULT_CONFIG: ReviewConfig;
/**
 * Load reviewer config from the following locations in order:
 *
 * 1. `<directory>/.pi/reviewer.config.json` (project-local)
 * 2. `<directory>/reviewer.config.json` (repo root)
 * 3. `~/.pi/reviewer.config.json` (global fallback)
 *
 * - If all files are missing, returns defaults silently.
 * - If a file has invalid JSON, logs a warning and returns defaults.
 * - Partial configs are merged — any missing field falls back to its default.
 */
export declare function loadReviewConfig(directory: string, opts?: {
    log?: (msg: string) => void;
}): ReviewConfig;
