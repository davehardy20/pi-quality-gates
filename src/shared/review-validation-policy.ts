import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Contract with pi-safe-tools: immutable validation-only ceiling. The effective
// ceiling is safeTools.validation.maxTimeoutMs from the SAME trusted file.
// No merged Pi/project settings, repository policy, or executable config.
const VALIDATION_HARD_MAX_MS = 1_800_000;
const REVIEW_HARD_MAX_MS = 86_400_000;
const MAX_SETTINGS_BYTES = 1_048_576;
const POLICY_ERROR = "Invalid trusted review validation policy.";

export interface ReviewValidationPolicy {
	defaultTimeoutMs: number;
	repoOverrides: Record<string, Record<string, number>>;
	reviewOverheadMs: number;
	maxReviewerTimeoutMs: number;
	validationMaxTimeoutMs: number;
}
function invalid(): never {
	throw new Error(POLICY_ERROR);
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function bounded(value: unknown, max: number, min = 1_000): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= min &&
		value <= max
	);
}
function block(value: unknown): Record<string, unknown> {
	if (value === undefined) return {};
	if (!record(value)) invalid();
	return value;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function unsafePath(value: string): boolean {
	return (
		Array.from(value).some((char) => {
			const code = char.charCodeAt(0);
			return code < 32 || code === 127;
		}) ||
		["\\", "*", "?", "[", "]", "{", "}"].some((char) => value.includes(char))
	);
}
function validateOverride(root: string, file: string): void {
	if (
		unsafePath(root) ||
		!path.isAbsolute(root) ||
		path.normalize(root) !== root ||
		fs.realpathSync(root) !== root ||
		!fs.statSync(root).isDirectory() ||
		!file ||
		unsafePath(file) ||
		path.isAbsolute(file) ||
		/^[A-Za-z]:/.test(file) ||
		file.split("/").some((part) => !part || part === "." || part === "..")
	)
		invalid();
	const target = path.join(root, file);
	if (fs.realpathSync(target) !== target || !fs.statSync(target).isFile())
		invalid();
}

/** Parse both policies together so incompatible budgets refuse, never clamp.
 * Unrelated global settings are ignored, never returned or logged. */
export function parseReviewValidationPolicy(
	settings: unknown,
): ReviewValidationPolicy {
	try {
		if (!record(settings)) invalid();
		const safe = block(block(settings.safeTools).validation);
		keys(safe, ["maxTimeoutMs", "defaultTimeoutMs"]);
		const ceiling =
			safe.maxTimeoutMs === undefined
				? VALIDATION_HARD_MAX_MS
				: safe.maxTimeoutMs;
		const runnerDefault =
			safe.defaultTimeoutMs === undefined ? 60_000 : safe.defaultTimeoutMs;
		if (
			!bounded(ceiling, VALIDATION_HARD_MAX_MS) ||
			!bounded(runnerDefault, ceiling)
		)
			invalid();
		const review = block(block(settings.qualityGates).reviewValidation);
		keys(review, [
			"defaultTimeoutMs",
			"repoOverrides",
			"reviewOverheadMs",
			"maxReviewerTimeoutMs",
		]);
		const defaultTimeoutMs =
			review.defaultTimeoutMs === undefined ? 300_000 : review.defaultTimeoutMs;
		const reviewOverheadMs =
			review.reviewOverheadMs === undefined ? 600_000 : review.reviewOverheadMs;
		const maxReviewerTimeoutMs =
			review.maxReviewerTimeoutMs === undefined
				? 7_200_000
				: review.maxReviewerTimeoutMs;
		if (
			!bounded(defaultTimeoutMs, ceiling) ||
			!bounded(reviewOverheadMs, REVIEW_HARD_MAX_MS, 0) ||
			!bounded(maxReviewerTimeoutMs, REVIEW_HARD_MAX_MS)
		)
			invalid();
		const repoOverrides: ReviewValidationPolicy["repoOverrides"] = {};
		for (const [root, files] of Object.entries(block(review.repoOverrides))) {
			if (!record(files)) invalid();
			// Validate roots even for empty maps (no dormant unsafe policy).
			if (
				unsafePath(root) ||
				!path.isAbsolute(root) ||
				path.normalize(root) !== root ||
				fs.realpathSync(root) !== root ||
				!fs.statSync(root).isDirectory()
			)
				invalid();
			const budgets: Record<string, number> = {};
			for (const [file, value] of Object.entries(files)) {
				validateOverride(root, file);
				if (!bounded(value, ceiling)) invalid();
				budgets[file] = value;
			}
			repoOverrides[root] = budgets;
		}
		return {
			defaultTimeoutMs,
			repoOverrides,
			reviewOverheadMs,
			maxReviewerTimeoutMs,
			validationMaxTimeoutMs: ceiling,
		};
	} catch {
		return invalid();
	}
}

/** Fixture-only home seam; production always reads the user-global path.
 * Initial absence alone defaults. Swaps/disappearance after inspection refuse.
 * Bounded descriptor read, no symlink components, same-UID regular file. */
export function loadReviewValidationPolicy(
	home = os.homedir(),
	io: typeof fs = fs,
): ReviewValidationPolicy {
	let fd: number | undefined;
	try {
		const root = io.realpathSync(home);
		let parent = root;
		for (const part of [".pi", "agent"]) {
			parent = path.join(parent, part);
			let stat: fs.Stats;
			try {
				stat = io.lstatSync(parent);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					return parseReviewValidationPolicy({});
				throw error;
			}
			if (!stat.isDirectory() || io.realpathSync(parent) !== parent) invalid();
		}
		const file = path.join(parent, "settings.json");
		let expected: fs.Stats;
		try {
			expected = io.lstatSync(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return parseReviewValidationPolicy({});
			throw error;
		}
		if (!expected.isFile()) invalid();
		fd = io.openSync(
			file,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		const stat = io.fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.dev !== expected.dev ||
			stat.ino !== expected.ino ||
			stat.size > MAX_SETTINGS_BYTES ||
			(process.getuid && stat.uid !== process.getuid()) ||
			io.realpathSync(parent) !== parent
		)
			invalid();
		const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = io.readSync(
				fd,
				buffer,
				length,
				buffer.length - length,
				null,
			);
			if (read === 0) break;
			length += read;
		}
		if (length > MAX_SETTINGS_BYTES) invalid();
		const current = io.lstatSync(file);
		if (
			!current.isFile() ||
			current.dev !== stat.dev ||
			current.ino !== stat.ino ||
			io.realpathSync(parent) !== parent
		)
			invalid();
		return parseReviewValidationPolicy(
			JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(
					buffer.subarray(0, length),
				),
			),
		);
	} catch {
		return invalid();
	} finally {
		if (fd !== undefined) io.closeSync(fd);
	}
}

/** Each required call counted once; retries consume the same overall deadline.
 * The existing reviewer timeout remains a floor, not the validation ceiling. */
export function reviewerTimeoutForPlan(
	commands: ReadonlyArray<{ timeoutMs?: number }>,
	policy: ReviewValidationPolicy,
	baseTimeoutMs: number,
): number {
	if (!bounded(baseTimeoutMs, REVIEW_HARD_MAX_MS)) invalid();
	let required = policy.reviewOverheadMs;
	for (const command of commands) {
		if (!bounded(command.timeoutMs, policy.validationMaxTimeoutMs)) invalid();
		required += command.timeoutMs;
		if (!Number.isSafeInteger(required)) invalid();
	}
	const total = Math.max(baseTimeoutMs, required);
	if (total > policy.maxReviewerTimeoutMs) {
		throw new Error(
			`Review deadline required ${total} ms exceeds trusted maximum ${policy.maxReviewerTimeoutMs} ms; no reviewer started. Split the PR or adjust trusted global policy; required checks cannot be dropped.`,
		);
	}
	return total;
}
