import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readJson(path: string) {
	return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

const manifest = readJson("../package.json");
const lock = readJson("../package-lock.json");
const config = readJson("../biome.json");

describe("repository Biome configuration", () => {
	it("keeps the exact package pin, lockfile and schema on the same version", () => {
		const version = manifest.devDependencies["@biomejs/biome"];
		expect(version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(lock.packages[""].devDependencies["@biomejs/biome"]).toBe(version);
		expect(lock.packages["node_modules/@biomejs/biome"].version).toBe(version);
		expect(config.$schema).toBe(
			`https://biomejs.dev/schemas/${version}/schema.json`,
		);
	});

	it("keeps source checks enabled while leaving Markdown formatting to markdownlint", () => {
		expect(config.formatter.enabled).toBe(true);
		expect(config.linter.enabled).toBe(true);
		expect(config.markdown?.formatter?.enabled).toBe(false);
	});
});
