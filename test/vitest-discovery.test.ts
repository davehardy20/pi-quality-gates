import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { configDefaults } from "vitest/config";
import { createVitest } from "vitest/node";
import projectConfig from "../vitest.config.js";

const legitimateFiles = [
	"test/project.test.ts",
	"packages/widget/test/widget.spec.js",
	"src/nested/component.test.tsx",
	".seeds-like/legitimate.test.ts",
];
const archivedFiles = [
	".seeds/drafts/dependency-backup/vendor.test.js",
	".seeds/drafts/saved-worktree/test/old.test.ts",
];
const defaultExcludedFiles = [
	"node_modules/dependency/vendor.test.ts",
	"dist/generated.test.js",
];

// Discovery must not import even these fabricated modules, let alone archived
// third-party code. Every fixture throws immediately if it is ever executed.
const fixtureSource = 'throw new Error("Discovery imported a test fixture");\n';

describe("Vitest discovery", () => {
	it("ignores archived Seeds tests without hiding legitimate project tests", async () => {
		const root = await mkdtemp(join(tmpdir(), "quality-gates-discovery-"));
		let instance: Awaited<ReturnType<typeof createVitest>> | undefined;
		try {
			for (const file of [
				...legitimateFiles,
				...archivedFiles,
				...defaultExcludedFiles,
			]) {
				const target = join(root, file);
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, fixtureSource);
			}
			instance = await createVitest(
				"test",
				{
					root,
					config: false,
					watch: false,
					exclude: projectConfig.test?.exclude ?? configDefaults.exclude,
				},
				{ server: { watch: null }, cacheDir: join(root, ".vite") },
			);
			const specifications = await instance.globTestSpecifications();
			const files = specifications.map((specification) =>
				relative(root, specification.moduleId).split(sep).join("/"),
			);
			expect(files.sort()).toEqual([...legitimateFiles].sort());
			for (const file of archivedFiles) {
				expect(await readFile(join(root, file), "utf8")).toBe(fixtureSource);
			}
		} finally {
			await instance?.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("retains every default Vitest exclusion", () => {
		expect(projectConfig.test?.exclude).toEqual(
			expect.arrayContaining(configDefaults.exclude),
		);
	});
});
