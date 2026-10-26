import * as fs from "node:fs";
import * as path from "node:path";
import { Minimatch } from "minimatch";

const CONFIG_NAMES = ["biome.json", "biome.jsonc"];
const MAX_BYTES = 256 * 1024;
const MAX_PATTERNS = 64;
const MAX_DEPTH = 32;

interface BiomeScope {
	files: string[];
	note?: string;
}
interface Pattern {
	matcher: Minimatch;
	excluded: boolean;
	force: boolean;
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bounded static metadata only: no executable config, external paths or symlinks. */
function metadata(root: string, relative: string): string | undefined {
	const target = path.join(root, relative);
	let before: fs.Stats;
	try {
		before = fs.lstatSync(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error("Cannot inspect PR review Biome metadata.");
	}
	const real = fs.realpathSync(target);
	const within = path.relative(root, real);
	if (
		before.isSymbolicLink() ||
		within === ".." ||
		within.startsWith(`..${path.sep}`) ||
		path.isAbsolute(within)
	) {
		throw new Error("PR review Biome metadata escapes the repository.");
	}
	if (!before.isFile() || before.size > MAX_BYTES) {
		throw new Error("PR review Biome metadata is not a bounded file.");
	}
	const fd = fs.openSync(
		target,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
	);
	try {
		const opened = fs.fstatSync(fd);
		if (
			!opened.isFile() ||
			opened.dev !== before.dev ||
			opened.ino !== before.ino ||
			opened.size > MAX_BYTES
		) {
			throw new Error("PR review Biome metadata is not a stable bounded file.");
		}
		const buffer = Buffer.alloc(MAX_BYTES + 1);
		let size = 0;
		while (size < buffer.length) {
			const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
			if (!count) break;
			size += count;
		}
		if (size > MAX_BYTES) {
			throw new Error("PR review Biome metadata is not a bounded file.");
		}
		return buffer.subarray(0, size).toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/** Support a small, explicit Biome 2 glob subset; never approximate other syntax. */
function patterns(config: unknown): Pattern[] | undefined {
	if (!record(config) || config.extends !== undefined || config.root === false)
		return undefined;
	if (
		config.$schema !== undefined &&
		(typeof config.$schema !== "string" ||
			!/^https:\/\/biomejs\.dev\/schemas\/2\./.test(config.$schema))
	) {
		return undefined;
	}
	if (!record(config.files)) return undefined;
	const supportedKeys = new Set(["includes", "maxSize", "ignoreUnknown"]);
	if (Object.keys(config.files).some((key) => !supportedKeys.has(key)))
		return undefined;
	const includes = config.files.includes;
	if (
		!Array.isArray(includes) ||
		!includes.length ||
		includes.length > MAX_PATTERNS
	) {
		return undefined;
	}
	const result: Pattern[] = [];
	for (const value of includes) {
		if (typeof value !== "string" || !value || value.length > 256)
			return undefined;
		const glob = value.replace(/^!!?/, "");
		const parts = glob.split("/");
		// Keep matcher work bounded too, not just input bytes. Complex wildcard
		// combinations remain required Biome calls instead of local matching.
		if (
			!glob ||
			/[^a-zA-Z0-9_./*-]/.test(glob) ||
			parts.filter((part) => part === "**").length > 1 ||
			parts.some(
				(part) =>
					!part ||
					part === "." ||
					part === ".." ||
					(part !== "**" && part.split("*").length > 2),
			)
		) {
			return undefined;
		}
		result.push({
			matcher: new Minimatch(glob, {
				dot: true,
				nonegate: true,
				nocomment: true,
				nobrace: true,
				noext: true,
			}),
			excluded: value.startsWith("!"),
			force: value.startsWith("!!"),
		});
	}
	return result.some((pattern) => !pattern.excluded) ? result : undefined;
}

/** Only proven exclusions remove lint calls; uncertainty retains mandatory validation. */
export function scopeBiomeValidation(
	files: string[],
	cwd: string,
	changedPaths: string[] = files,
): BiomeScope {
	if (!files.length) return { files };
	for (const file of [...files, ...changedPaths]) {
		if (
			!file ||
			path.isAbsolute(file) ||
			/^[A-Za-z]:/.test(file) ||
			/[\\\p{Cc}]/u.test(file) ||
			file.split("/").some((part) => !part || part === "." || part === "..")
		) {
			throw new Error("Invalid PR review Biome candidate path.");
		}
	}
	const root = fs.realpathSync(cwd);
	const unresolved = (): BiomeScope => ({
		files,
		note: "Biome scope unresolved; retain all candidate paths as required lint. Do not treat excluded/unprocessed files as checked.",
	});
	const configs = CONFIG_NAMES.map((name) => metadata(root, name)).filter(
		(text): text is string => text !== undefined,
	);
	if (!configs.length) return { files };
	if (
		configs.length !== 1 ||
		changedPaths.some((file) => CONFIG_NAMES.includes(file))
	) {
		return unresolved();
	}
	let config: unknown;
	try {
		// JSONC comments/trailing commas and inheritance remain Biome's job. A
		// parse failure cannot become evidence for skipping a required check.
		config = JSON.parse(configs[0]);
	} catch {
		return unresolved();
	}
	if (
		record(config) &&
		config.files === undefined &&
		config.extends === undefined
	) {
		return { files };
	}
	const rules = patterns(config);
	if (!rules) return unresolved();
	const nested = new Map<string, boolean>();
	let uncertain = false;
	const excluded: string[] = [];
	const retained = files.filter((file) => {
		const parts = file.split("/");
		if (parts.length > MAX_DEPTH) {
			uncertain = true;
			return true;
		}
		const ancestors = parts.map((_, index) =>
			parts.slice(0, index + 1).join("/"),
		);
		for (const directory of ancestors.slice(0, -1)) {
			if (!nested.has(directory)) {
				nested.set(
					directory,
					CONFIG_NAMES.some(
						(name) => metadata(root, `${directory}/${name}`) !== undefined,
					),
				);
			}
			if (nested.get(directory)) {
				uncertain = true;
				return true;
			}
		}
		let included = false;
		for (const rule of rules) {
			if (!ancestors.some((ancestor) => rule.matcher.match(ancestor))) continue;
			included = !rule.excluded;
			if (rule.force) break;
		}
		if (!included) excluded.push(file);
		return included;
	});
	const notes: string[] = [];
	if (excluded.length) {
		notes.push(
			`Paths excluded by Biome files.includes (not linted): ${JSON.stringify(excluded)}. They remain in review scope; inspect them and run other applicable validation.`,
		);
	}
	if (uncertain)
		notes.push(
			"Biome scope unresolved for nested/deep paths; their lint checks remain required.",
		);
	return {
		files: retained,
		...(notes.length ? { note: notes.join(" ") } : {}),
	};
}
