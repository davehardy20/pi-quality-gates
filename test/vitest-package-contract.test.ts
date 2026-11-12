import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readJson(path: string) {
	return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

const manifest = readJson("../package.json");
const lock = readJson("../package-lock.json");
// Keep this audited candidate explicit; review the graph again when updating it.
const version = "4.1.12";

function resolvedPackages(name: string): [string, { version?: string }][] {
	return Object.entries(lock.packages).filter(
		([path]) =>
			path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`),
	) as [string, { version?: string }][];
}

describe("repository Vitest dependency contract", () => {
	it("pins Vitest and V8 coverage to the same reviewed version", () => {
		for (const name of ["vitest", "@vitest/coverage-v8"]) {
			expect(manifest.devDependencies[name], name).toBe(version);
			expect(lock.packages[""].devDependencies[name], name).toBe(version);
		}
	});

	it("keeps every resolved Vitest, coverage and mocker copy aligned", () => {
		for (const name of ["vitest", "@vitest/coverage-v8", "@vitest/mocker"]) {
			const packages = resolvedPackages(name);
			expect(packages.length, name).toBeGreaterThan(0);
			for (const [path, entry] of packages) {
				expect(entry.version, path).toBe(version);
			}
		}
	});

	it("does not retain Tinypool after the Vitest 4 pool migration", () => {
		expect(resolvedPackages("tinypool")).toEqual([]);
	});
});
