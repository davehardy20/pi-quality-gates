import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PI130_ENTRIES } from "../src/pr-gate/reviewer-startup-adapter.js";
import {
	createReviewerColdCanary,
	prepareReviewerColdFixture,
	type ReviewerColdFixture,
	type ReviewerColdGrant,
	readReviewerBootstrap,
	releaseReviewerColdFixture,
	reviewerBootstrapDigest,
	reviewerRuntimeDigest,
	reviewerStartupDigest,
} from "../src/pr-gate/reviewer-startup-cold.js";
import type { ReviewerModulePin } from "../src/pr-gate/reviewer-startup-loader.js";

const fixtures: ReviewerColdFixture[] = [];
const nodePath = realpathSync(process.execPath);
const nodeSha256 = reviewerStartupDigest(readFileSync(nodePath));
const sourceURL = new URL("../src/pr-gate/", import.meta.url);
const sourceRoot = fileURLToPath(sourceURL).replace(/\/$/, "");
const bootstrap = readReviewerBootstrap(sourceRoot);

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		if (existsSync(fixture.root)) {
			expect(releaseReviewerColdFixture(fixture)).toBe(true);
		}
	}
});

function fixture() {
	const workspace = prepareReviewerColdFixture();
	fixtures.push(workspace);
	const sdkRoot = join(workspace.root, "fabricated-sdk");
	mkdirSync(sdkRoot);
	const sources: Record<string, string> = {
		"package.json": '{"version":"1.3.0","type":"module"}',
		[PI130_ENTRIES["auth-storage"]]:
			"export class AuthStorage { static inMemory() { return {}; } }",
		[PI130_ENTRIES["settings-manager"]]:
			"export class SettingsManager { static inMemory() { return {}; } }",
		[PI130_ENTRIES["session-manager"]]:
			"export class SessionManager { static inMemory() { return {}; } }",
		[PI130_ENTRIES["model-runtime"]]:
			"export class ModelRuntime { static async create() { return {}; } }",
		[PI130_ENTRIES["extensions/loader"]]:
			"export function createExtensionRuntime() { return {}; }",
		[PI130_ENTRIES.sdk]: `
export async function createAgentSession() {
  return {
    session: { model: undefined, getActiveToolNames: () => [],
      bindExtensions: async () => {}, dispose: () => {} },
    extensionsResult: { extensions: [], errors: [] }
  };
}
`,
	};
	const files: ReviewerModulePin[] = Object.entries(sources).map(
		([path, body]) => {
			mkdirSync(dirname(join(sdkRoot, path)), { recursive: true });
			writeFileSync(join(sdkRoot, path), body);
			return {
				path,
				sha256: reviewerStartupDigest(body),
				format: path.endsWith(".json") ? "json" : "module",
			};
		},
	);
	const grant: ReviewerColdGrant = {
		fixture: workspace,
		nodePath,
		sdkRoot,
		files,
		builtins: [],
		expectedFiles: Object.values(PI130_ENTRIES),
		expectedBuiltins: [],
		bootstrap,
		binding: {
			version: 1,
			checkpointId: "fabricated-sdk-only",
			sdkVersion: "1.3.0",
			nodeVersion: "v26.12.0",
			nodeSha256,
			runtimeClosureSha256: reviewerRuntimeDigest(
				sdkRoot,
				files,
				[],
				Object.values(PI130_ENTRIES),
				[],
			),
			bootstrapSha256: reviewerBootstrapDigest(bootstrap),
			sourceCommit: "a".repeat(40),
			fixtureRoot: workspace.root,
			issuedAt: Date.now(),
			expiresAt: Date.now() + 30_000,
		},
	};
	const owner = {
		claimAcceptedCanary: vi.fn(() => grant),
		isAccepted: vi.fn(() => true),
	};
	return { workspace, grant, owner, run: createReviewerColdCanary(owner) };
}

function rebindRuntime(grant: ReviewerColdGrant) {
	grant.binding = {
		...grant.binding,
		runtimeClosureSha256: reviewerRuntimeDigest(
			grant.sdkRoot,
			grant.files,
			grant.builtins,
			grant.expectedFiles,
			grant.expectedBuiltins,
		),
	};
}

describe("cold startup launcher (fabricated SDK, never installed Pi)", () => {
	it("requires an owner claim before any launch", async () => {
		const run = createReviewerColdCanary({
			claimAcceptedCanary: () => undefined,
			isAccepted: () => true,
		});
		expect(await run("unknown")).toMatchObject({ reason: "authority" });
	});

	it("runs the fixed worker only with the pinned Node ABI", async () => {
		const f = fixture();
		const result = await f.run(f.grant.binding.checkpointId);
		if (process.version === "v26.12.0") {
			expect(result.status, JSON.stringify(result)).toBe(
				"cold-startup-completed",
			);
		} else {
			// CI on other Node versions must observe refusal, never implicit support.
			expect(result.status).toBe("denied");
		}
		expect(result.childExited).toBe(true);
		expect(result.cleanup).toBe("complete");
		expect(existsSync(f.workspace.root)).toBe(false);
	});

	it("cannot read the poisoned state even when SDK code tries", async () => {
		const f = fixture();
		const path = PI130_ENTRIES["auth-storage"];
		const source = `
import { readFileSync } from 'node:fs';
const root = new URL('../../../', import.meta.url);
const paths = ['state/auth.json', 'state/settings.json', 'state/models.json'];
const denied = paths.every((path) => {
  try { readFileSync(new URL(path, root)); return false; }
  catch (error) { return error.code === 'ERR_ACCESS_DENIED'; }
});
export class AuthStorage {
  static inMemory() { if (!denied) throw new Error(); return {}; }
}
`;
		writeFileSync(join(f.grant.sdkRoot, path), source);
		f.grant.files = f.grant.files.map((file) =>
			file.path === path
				? { ...file, sha256: reviewerStartupDigest(source) }
				: file,
		);
		f.grant.builtins = ["node:fs"];
		f.grant.expectedBuiltins = ["node:fs"];
		rebindRuntime(f.grant);
		const result = await f.run(f.grant.binding.checkpointId);
		const expected =
			process.version === "v26.12.0" ? "cold-startup-completed" : "denied";
		expect(result.status, JSON.stringify(result)).toBe(expected);
		expect(result.cleanup).toBe("complete");
	});

	it("requires exact predicted evaluation, not merely membership in an allowlist", async () => {
		const f = fixture();
		const sdk = PI130_ENTRIES.sdk;
		const extra = "dist/core/unexpected.js";
		const bytes = "export {};";
		const previous = readFileSync(join(f.grant.sdkRoot, sdk), "utf8");
		const body = [previous, "import './unexpected.js';"].join("\n");
		writeFileSync(join(f.grant.sdkRoot, sdk), body);
		writeFileSync(join(f.grant.sdkRoot, extra), bytes);
		f.grant.files = [
			...f.grant.files.map((file) =>
				file.path === sdk
					? { ...file, sha256: reviewerStartupDigest(body) }
					: file,
			),
			{ path: extra, sha256: reviewerStartupDigest(bytes), format: "module" },
		];
		rebindRuntime(f.grant);
		const result = await f.run(f.grant.binding.checkpointId);
		expect(result.status, JSON.stringify(result)).toBe("denied");
		if (process.version === "v26.12.0") {
			expect(result).toMatchObject({ reason: "evidence" });
		}
		expect(result.cleanup).toBe("complete");
	});

	const lateImports = ["allowed-file", "denied-file", "builtin"];
	it.each(lateImports)("seals late import: %s", async (kind) => {
		const f = fixture();
		const sdk = PI130_ENTRIES.sdk;
		const extra = "dist/core/unexpected.js";
		const path = join(f.grant.sdkRoot, sdk);
		const specifier = kind === "builtin" ? "node:fs" : "./unexpected.js";
		const load = `import(${JSON.stringify(specifier)}).catch(() => {})`;
		const dispose = `dispose: () => { setTimeout(() => ${load}, 40); }`;
		const original = readFileSync(path, "utf8");
		const source = original.replace("dispose: () => {}", dispose);
		writeFileSync(path, source);
		writeFileSync(join(f.grant.sdkRoot, extra), "export {};");
		f.grant.files = f.grant.files.map((file) =>
			file.path === sdk
				? { ...file, sha256: reviewerStartupDigest(source) }
				: file,
		);
		if (kind === "allowed-file") {
			f.grant.files = [
				...f.grant.files,
				{
					path: extra,
					sha256: reviewerStartupDigest("export {};"),
					format: "module",
				},
			];
		}
		if (kind === "builtin") f.grant.builtins = ["node:fs"];
		rebindRuntime(f.grant);
		const result = await f.run(f.grant.binding.checkpointId);
		expect(result.status, JSON.stringify(result)).toBe("denied");
		if (process.version === "v26.12.0") {
			expect(result).toMatchObject({ reason: "process" });
		}
		expect(result.cleanup).toBe("complete");
	});

	it("seals repeated CommonJS evaluation after completion", async () => {
		const f = fixture();
		const sdk = PI130_ENTRIES.sdk;
		const extra = "dist/core/repeat.cjs";
		const path = join(f.grant.sdkRoot, sdk);
		const again = "module.exports = 42;";
		const reload = [
			"delete require.cache[require.resolve('./repeat.cjs')];",
			"try { require('./repeat.cjs'); } catch {}",
		].join("\n");
		const dispose = `dispose: () => { setTimeout(() => { ${reload} }, 40); }`;
		const source = [
			"import { createRequire } from 'node:module';",
			"const require = createRequire(import.meta.url);",
			"require('./repeat.cjs');",
			readFileSync(path, "utf8").replace("dispose: () => {}", dispose),
		].join("\n");
		writeFileSync(path, source);
		writeFileSync(join(f.grant.sdkRoot, extra), again);
		f.grant.files = [
			...f.grant.files.map((file) =>
				file.path === sdk
					? { ...file, sha256: reviewerStartupDigest(source) }
					: file,
			),
			{ path: extra, sha256: reviewerStartupDigest(again), format: "commonjs" },
		];
		f.grant.expectedFiles = [...f.grant.expectedFiles, extra];
		f.grant.builtins = ["node:module"];
		f.grant.expectedBuiltins = ["node:module"];
		rebindRuntime(f.grant);
		const result = await f.run(f.grant.binding.checkpointId);
		expect(result.status, JSON.stringify(result)).toBe("denied");
		if (process.version === "v26.12.0") {
			expect(result).toMatchObject({ reason: "process" });
		}
		expect(result.cleanup).toBe("complete");
	});

	it("rejects altered source bytes before startup and releases only its root", async () => {
		const f = fixture();
		writeFileSync(join(f.grant.sdkRoot, PI130_ENTRIES.sdk), "export {};");
		expect(await f.run(f.grant.binding.checkpointId)).toMatchObject({
			status: "denied",
			reason: "invalid",
			cleanup: "complete",
		});
	});

	const refusals = ["expired", "revoked", "bootstrap", "node", "traversal"];
	it.each(refusals)("denies preflight drift: %s", async (kind) => {
		const f = fixture();
		if (kind === "expired") {
			f.grant.binding = {
				...f.grant.binding,
				issuedAt: Date.now() - 10_000,
				expiresAt: Date.now() - 1,
			};
		}
		if (kind === "revoked") f.owner.isAccepted.mockReturnValue(false);
		if (kind === "bootstrap") {
			f.grant.bootstrap = {
				...bootstrap,
				"worker.mjs": Buffer.from("changed"),
			};
		}
		if (kind === "node") {
			f.grant.binding = { ...f.grant.binding, nodeSha256: "0".repeat(64) };
		}
		if (kind === "traversal") {
			f.grant.files = [{ ...f.grant.files[0], path: "../outside.js" }];
			rebindRuntime(f.grant);
		}
		const result = await f.run(f.grant.binding.checkpointId);
		expect(result).toMatchObject({ status: "denied", cleanup: "complete" });
		expect(existsSync(f.workspace.root)).toBe(false);
	});

	it("does not adopt or delete a copied workspace descriptor", async () => {
		const f = fixture();
		f.grant.fixture = { ...f.workspace };
		expect(await f.run(f.grant.binding.checkpointId)).toMatchObject({
			status: "denied",
			cleanup: "held",
		});
		expect(existsSync(f.workspace.root)).toBe(true);
	});

	it("rejects the same prepared fixture on replay", async () => {
		const f = fixture();
		await f.run(f.grant.binding.checkpointId);
		expect(await f.run(f.grant.binding.checkpointId)).toMatchObject({
			status: "denied",
			cleanup: "held",
		});
	});

	const forgedSignals = [{}, Object.create(AbortSignal.prototype)];
	it.each(forgedSignals)("rejects forged signals", async (signal) => {
		const claim = vi.fn(() => undefined);
		const run = createReviewerColdCanary({
			claimAcceptedCanary: claim,
			isAccepted: () => true,
		});
		const result = await run("fabricated-only", signal as AbortSignal);
		expect(result).toMatchObject({ reason: "invalid" });
		expect(claim).not.toHaveBeenCalled();
	});

	it("does not claim authority for a pre-cancelled call", async () => {
		const f = fixture();
		const controller = new AbortController();
		controller.abort();
		const result = await f.run(f.grant.binding.checkpointId, controller.signal);
		expect(result).toMatchObject({ reason: "cancelled" });
		expect(f.owner.claimAcceptedCanary).not.toHaveBeenCalled();
	});
});
