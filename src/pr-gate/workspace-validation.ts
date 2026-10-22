import * as fs from "node:fs";
import * as path from "node:path";
import { Minimatch } from "minimatch";
import { parseDocument } from "yaml";

const MAX_METADATA_BYTES = 256 * 1024;
const MAX_PATTERNS = 64;
const MAX_DIRECTORIES = 2_000;
const MAX_DEPTH = 16;
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git"]);

export interface WorkspaceValidationProjects {
	/** Canonical repository root */
	root: string;
	/** Declared package directories relative to the repository root */
	packages: string[];
	/** Required TypeScript configurations relative to the repository root */
	projects: string[];
}

/** Inspect only bounded, repository-contained files; never load executable config. */
function metadataFile(root: string, relative: string): string | undefined {
	const absolute = path.join(root, relative);
	try {
		fs.lstatSync(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const real = fs.realpathSync(absolute);
	const contained = path.relative(root, real);
	if (
		contained === ".." ||
		contained.startsWith(`..${path.sep}`) ||
		path.isAbsolute(contained)
	) {
		throw new Error("PR review workspace metadata escapes the repository.");
	}
	const stat = fs.statSync(real);
	if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) {
		throw new Error("PR review workspace metadata is not a bounded file.");
	}
	return real;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid PR review workspace metadata.");
	}
	return value as Record<string, unknown>;
}

function packageManifest(
	root: string,
	relative: string,
): Record<string, unknown> | undefined {
	const manifest = metadataFile(root, relative);
	if (!manifest) return undefined;
	try {
		return record(JSON.parse(fs.readFileSync(manifest, "utf8")));
	} catch {
		// JSON parse errors can contain manifest content; never expose it.
		throw new Error("Invalid PR review workspace package manifest.");
	}
}

function workspacePatterns(root: string): Minimatch[] {
	const pkg = packageManifest(root, "package.json") ?? {};
	let patterns = pkg.workspaces;
	if (patterns !== undefined && !Array.isArray(patterns)) {
		patterns = record(patterns).packages;
		if (patterns === undefined) {
			throw new Error("Invalid PR review workspace package list.");
		}
	}
	const pnpm = metadataFile(root, "pnpm-workspace.yaml");
	if (pnpm) {
		const document = parseDocument(fs.readFileSync(pnpm, "utf8"));
		if (document.errors.length || document.warnings.length) {
			throw new Error("Invalid PR review workspace YAML.");
		}
		const config = record(document.toJS());
		if (config.packages !== undefined) patterns = config.packages;
	}
	if (patterns === undefined) return [];
	if (!Array.isArray(patterns) || patterns.length > MAX_PATTERNS) {
		throw new Error("Invalid or excessive PR review workspace patterns.");
	}
	return patterns.map((value: unknown) => {
		if (typeof value !== "string" || !value || value.length > 256) {
			throw new Error("Invalid PR review workspace pattern.");
		}
		const pattern = value
			.replace(/^!/, "")
			.replace(/^\.\//, "")
			.replace(/\/+$/, "");
		if (
			!pattern ||
			pattern.startsWith("!") ||
			path.isAbsolute(pattern) ||
			/^[A-Za-z]:/.test(pattern) ||
			/[\\{}()\p{Cc}]/u.test(pattern) ||
			pattern
				.split("/")
				.some((part) => part === ".." || EXCLUDED_DIRECTORIES.has(part))
		) {
			throw new Error("Unsafe or unsupported PR review workspace pattern.");
		}
		return new Minimatch(`${value.startsWith("!") ? "!" : ""}${pattern}`, {
			dot: true,
			nobrace: true,
			noext: true,
			nocomment: true,
		});
	});
}

/** Static workspace discovery, bounded and fail-closed on incomplete inspection. */
export function discoverWorkspaceValidationProjects(
	cwd: string,
): WorkspaceValidationProjects {
	const root = fs.realpathSync(cwd);
	const patterns = workspacePatterns(root);
	const positive = patterns.filter((pattern) => !pattern.negate);
	const negative = patterns.filter((pattern) => pattern.negate);
	const packages: string[] = [];
	let visited = 0;
	function walk(relative: string, depth: number): void {
		if (++visited > MAX_DIRECTORIES || depth > MAX_DEPTH) {
			throw new Error("PR review workspace discovery limit exceeded.");
		}
		if (
			relative &&
			positive.some((pattern) => pattern.match(relative)) &&
			negative.every((pattern) => pattern.match(relative)) &&
			packageManifest(root, `${relative}/package.json`)
		) {
			packages.push(relative);
		}
		for (const entry of fs.readdirSync(path.join(root, relative), {
			withFileTypes: true,
		})) {
			if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
			const child = relative ? `${relative}/${entry.name}` : entry.name;
			if (!positive.some((pattern) => pattern.match(child, true))) continue;
			// Only a trailing globstar proves every descendant is excluded.
			// Exact package exclusions must not hide included nested packages.
			if (
				negative.some(
					(pattern) =>
						(pattern.pattern === "**" || pattern.pattern.endsWith("/**")) &&
						!pattern.match(`${child}/`),
				)
			) {
				continue;
			}
			if (entry.isSymbolicLink()) {
				throw new Error("PR review workspace directory is a symlink.");
			}
			if (entry.isDirectory()) walk(child, depth + 1);
		}
	}
	if (positive.length) walk("", 0);
	packages.sort();
	const projects: string[] = [];
	for (const dir of ["", ...packages]) {
		const project = dir ? `${dir}/tsconfig.json` : "tsconfig.json";
		if (metadataFile(root, project)) projects.push(project);
	}
	// Retain the mandatory check (and its failure) if discovery finds no config.
	if (!projects.length) projects.push("tsconfig.json");
	return { root, packages, projects };
}
