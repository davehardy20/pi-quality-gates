import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { watchReviewerColdProcess } from "../src/pr-gate/reviewer-startup-process.js";

interface FixtureFile {
	name: string;
	body: string;
	format: "module" | "commonjs" | "module-typescript";
	admitted?: boolean;
	tampered?: boolean;
}

/** Never imports Pi. All executable fixture files are fabricated here. */
async function run(files: FixtureFile[], builtins: string[] = []) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "qg-loader-fixture-")));
	const sdk = join(root, "fabricated-sdk");
	mkdirSync(sdk);
	copyFileSync(
		fileURLToPath(
			new URL("../src/pr-gate/reviewer-startup-loader.ts", import.meta.url),
		),
		join(root, "loader.mts"),
	);
	const pins = files.flatMap((file) => {
		const path = join(sdk, file.name);
		writeFileSync(path, file.body);
		if (file.admitted === false) return [];
		return [
			{
				path,
				format: file.format,
				sha256: file.tampered
					? "0".repeat(64)
					: createHash("sha256").update(file.body).digest("hex"),
			},
		];
	});
	const script = `
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { installPinnedReviewerHooks } from './loader.mts';
if (process.platform === 'darwin') delete process.env.__CF_USER_TEXT_ENCODING;
let result = { status: 'denied' };
try {
  const proof = installPinnedReviewerHooks(${JSON.stringify(pins)}, ${JSON.stringify(builtins)});
  await import(pathToFileURL(${JSON.stringify(join(sdk, files[0].name))}).href);
  proof.guard();
  result = { status: 'startup-completed', indices: proof.loadedIndices(), builtins: proof.builtinImports(), envNames: Object.keys(process.env).sort() };
} catch {}
writeSync(3, JSON.stringify(result));
`;
	writeFileSync(join(root, "worker.mjs"), script);
	const args = [
		"--permission",
		`--allow-fs-read=${root}`,
		join(root, "worker.mjs"),
	];
	const child = spawn(realpathSync(process.execPath), args, {
		cwd: root,
		env: {
			LANG: "C",
			TZ: "UTC",
			NODE_V8_COVERAGE: "",
			FORCE_COLOR: "0",
		},
		stdio: ["ignore", "pipe", "pipe", "pipe"],
	});
	const receipt = child.stdio[3] as Readable;
	let evidence: unknown;
	const result = await watchReviewerColdProcess({
		child: Object.assign(child, {
			stdout: child.stdout as Readable,
			stderr: child.stderr as Readable,
		}),
		receipt,
		deadline: Date.now() + 3_000,
		isAccepted: () => true,
		checkReceipt: (input) => {
			evidence = input;
			return true;
		},
		cleanup: async () => {
			rmSync(root, { recursive: true });
			return true;
		},
	});
	return { result, evidence };
}

describe("cold-child import fence (fabricated files, no Pi)", () => {
	it("evaluates only pinned ESM bytes", async () => {
		const output = await run([
			{ name: "entry.mjs", body: "export {};", format: "module" },
		]);
		expect(output.result.status).toBe("cold-startup-completed");
		expect(output.evidence).toMatchObject({ indices: [0] });
	});

	it("loads the inert canary through native TypeScript stripping", async () => {
		const canary = readFileSync(
			new URL("../src/pr-gate/reviewer-startup-canary.ts", import.meta.url),
			"utf8",
		);
		const output = await run([
			{
				name: "entry.mjs",
				body: "import { createReviewerStartupCanary } from './canary.mts';",
				format: "module",
			},
			{ name: "canary.mts", body: canary, format: "module-typescript" },
		]);
		expect(output.result.status).toBe("cold-startup-completed");
	});

	it("uses only its explicit fixture environment", async () => {
		const output = await run([
			{ name: "entry.mjs", body: "export {};", format: "module" },
		]);
		const names = (output.evidence as { envNames: string[] }).envNames;
		const expected = ["FORCE_COLOR", "LANG", "NODE_V8_COVERAGE", "TZ"];
		expect(JSON.stringify(names)).toBe(JSON.stringify(expected));
	});

	it("also traces CommonJS require dependencies", async () => {
		const output = await run([
			{
				name: "entry.cjs",
				body: "require('./dep.cjs');",
				format: "commonjs",
			},
			{
				name: "dep.cjs",
				body: "module.exports = 42;",
				format: "commonjs",
			},
		]);
		expect(output.result.status).toBe("cold-startup-completed");
		expect(output.evidence).toMatchObject({ indices: [0, 1] });
	});

	it("records explicitly admitted builtin lookup", async () => {
		const output = await run(
			[
				{
					name: "entry.mjs",
					body: "process.getBuiltinModule('node:os');",
					format: "module",
				},
			],
			["node:os"],
		);
		expect(output.result.status).toBe("cold-startup-completed");
		expect(output.evidence).toMatchObject({ builtins: ["node:os"] });
	});

	const denied = [
		"try { await import('./unlisted.mjs'); } catch {}",
		"try { await import('data:text/javascript,export default 42'); } catch {}",
		"try { process.getBuiltinModule('node:os'); } catch {}",
		"try { process.getBuiltinModule(42); } catch {}",
		"try { await import('node:os'); } catch {}",
	];
	it.each(denied)("blocks caught import %s", async (body) => {
		const output = await run([
			{ name: "entry.mjs", body, format: "module" },
			{
				name: "unlisted.mjs",
				body: "export const value = 42;",
				format: "module",
				admitted: false,
			},
		]);
		expect(output.result.status).toBe("denied");
	});

	it("keeps denial for a caught CommonJS require", async () => {
		const output = await run([
			{
				name: "entry.cjs",
				body: "try { require('./unlisted.cjs'); } catch {}",
				format: "commonjs",
			},
			{
				name: "unlisted.cjs",
				body: "module.exports = 42;",
				format: "commonjs",
				admitted: false,
			},
		]);
		expect(output.result.status).toBe("denied");
	});

	const deniedScopes = ["fs.write", "child", "worker", "addons", "wasi", "net"];
	it.each(deniedScopes)("denies Node capability %s", async (scope) => {
		const output = await run([
			{
				name: "entry.mjs",
				body: `if (process.permission.has(${JSON.stringify(scope)})) throw new Error();`,
				format: "module",
			},
		]);
		expect(output.result).toMatchObject({ status: "cold-startup-completed" });
	});

	it("rejects changed bytes before their evaluation", async () => {
		const output = await run([
			{
				name: "entry.mjs",
				body: "export const value = 42;",
				format: "module",
				tampered: true,
			},
		]);
		expect(output.result.status).toBe("denied");
	});
});
