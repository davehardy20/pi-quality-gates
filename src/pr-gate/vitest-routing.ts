import * as fs from "node:fs";
import * as path from "node:path";
import { parseDocument } from "yaml";

const METADATA = ".pi/vitest-routing.json";
const MAX_BYTES = 65_536;
const MAX_FILES = 2048;
const ERROR =
	"Invalid or incomplete .pi/vitest-routing.json; required Vitest validation is NOT_RUN.";

function invalid(): never {
	throw new Error(ERROR);
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
	if (
		Object.keys(value).length !== expected.length ||
		expected.some((key) => !Object.hasOwn(value, key))
	)
		invalid();
}
function relativeFile(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 512 ||
		path.posix.normalize(value) !== value ||
		path.isAbsolute(value) ||
		/^[A-Za-z]:/.test(value) ||
		/[\\*?[\]{}\p{Cc}]/u.test(value) ||
		value
			.split("/")
			.some(
				(part) =>
					!part || part === "." || part === ".." || part.startsWith("-"),
			)
	)
		invalid();
	return value;
}
function contains(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return (
		!path.isAbsolute(relative) &&
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`)
	);
}
function physicalFile(root: string, relative: string): string {
	const real = fs.realpathSync(path.join(root, relative));
	if (!contains(root, real) || !fs.statSync(real).isFile()) invalid();
	return real;
}

/** Read JSON only; never import configs, expand globs, or run package scripts. */
function readDeclaration(root: string): unknown | undefined {
	const file = path.join(root, METADATA);
	try {
		fs.lstatSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	physicalFile(root, METADATA);
	const fd = fs.openSync(
		file,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const before = fs.fstatSync(fd);
		if (!before.isFile() || before.size > MAX_BYTES) invalid();
		const bytes = Buffer.alloc(MAX_BYTES + 1);
		let total = 0;
		while (total < bytes.length) {
			const count = fs.readSync(fd, bytes, total, bytes.length - total, null);
			if (!count) break;
			total += count;
		}
		const after = fs.fstatSync(fd);
		if (
			total > MAX_BYTES ||
			total !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs ||
			fs.statSync(physicalFile(root, METADATA)).ino !== before.ino
		)
			invalid();
		const text = bytes.subarray(0, total).toString("utf8");
		const parsed: unknown = JSON.parse(text);
		// JSON.parse accepts duplicate keys. Existing YAML parser detects them
		// (including escaped duplicates); JSON.parse above still enforces JSON.
		const document = parseDocument(text, { uniqueKeys: true });
		if (document.errors.length || document.warnings.length) invalid();
		return parsed;
	} finally {
		fs.closeSync(fd);
	}
}

export interface VitestRouteRequest {
	/** Repository-relative entry, not workspace-relative. */
	file: string;
	/** Selected owning runner, already determined by workspace discovery. */
	cwd: string;
}
export interface VitestRoute {
	config?: string;
	blockedReason?: string;
}

/** A declaration is exhaustive for changed Vitest entries. null explicitly owns
 * a default-config file; absence never means an implicit default after opt-in. */
export function routeVitestTests(
	root: string,
	tests: VitestRouteRequest[],
): { routes: Map<string, VitestRoute>; blockedReason?: string } {
	const result = new Map<string, VitestRoute>();
	try {
		const raw = readDeclaration(root);
		if (raw === undefined) {
			// This only detects a need for ownership, never infers membership from
			// scripts. Preserve default-only projects; explicit config scripts need
			// the declaration even if there is just one such script.
			for (const cwd of new Set(tests.map((test) => test.cwd))) {
				const manifest = physicalFile(
					root,
					path.relative(root, path.join(cwd, "package.json")),
				);
				if (fs.statSync(manifest).size > 262_144) invalid();
				const pkg = record(JSON.parse(fs.readFileSync(manifest, "utf8")));
				if (pkg.scripts === undefined) continue;
				const scripts = record(pkg.scripts);
				if (Object.values(scripts).some((script) => typeof script !== "string"))
					invalid();
				if (
					Object.values(scripts).some((script) =>
						/(?:^|[\s/])vitest(?=\s|$)[^;&|\r\n]*\s(?:--config(?:=|\s|$)|-c(?:\s|$))/.test(
							script as string,
						),
					)
				)
					invalid();
			}
			return { routes: result };
		}
		const declaration = record(raw);
		keys(declaration, ["version", "routes"]);
		if (
			declaration.version !== 1 ||
			!Array.isArray(declaration.routes) ||
			!declaration.routes.length ||
			declaration.routes.length > 128
		)
			invalid();
		const ownership = new Map<string, string | null>();
		const physical = new Set<string>();
		for (const value of declaration.routes) {
			const route = record(value);
			keys(route, ["files", "config"]);
			const config = route.config === null ? null : relativeFile(route.config);
			if (config !== null) physicalFile(root, config);
			if (
				!Array.isArray(route.files) ||
				!route.files.length ||
				route.files.length > MAX_FILES
			)
				invalid();
			for (const value of route.files) {
				const file = relativeFile(value);
				if (!/\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)) invalid();
				const real = physicalFile(root, file);
				const stat = fs.statSync(real);
				const identity = `${stat.dev}:${stat.ino}`;
				if (
					ownership.has(file) ||
					physical.has(identity) ||
					ownership.size >= MAX_FILES
				)
					invalid();
				ownership.set(file, config);
				physical.add(identity);
			}
		}
		for (const test of tests) {
			if (!ownership.has(test.file)) invalid();
			const config = ownership.get(test.file);
			if (config == null) {
				result.set(test.file, {});
				continue;
			}
			const absolute = path.join(root, config);
			if (
				!contains(test.cwd, absolute) ||
				!contains(test.cwd, physicalFile(root, config))
			)
				invalid();
			result.set(test.file, {
				config: path.relative(test.cwd, absolute).split(path.sep).join("/"),
			});
		}
		return { routes: result };
	} catch {
		// Preserve every obligation; callers must mechanically refuse publication
		// when any route is blocked, independent of the reviewer's prose.
		return {
			routes: new Map(
				tests.map((test) => [test.file, { blockedReason: ERROR }]),
			),
			blockedReason: ERROR,
		};
	}
}
