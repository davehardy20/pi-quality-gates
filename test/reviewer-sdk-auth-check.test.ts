import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Only fabricated SDK modules are imported by the child. No installed SDK,
// real credential files, sessions, providers or admission tokens are used.
const script = fileURLToPath(
	new URL("../scripts/reviewer-sdk-auth-check.mjs", import.meta.url),
);
const roots: string[] = [];
const childTimeoutMs = 10_000;
type Mode =
	| "clean"
	| "baseline"
	| "overlay"
	| "api"
	| "removed-baseline"
	| "removed-overlay"
	| "removed-api"
	| "nested"
	| "nested-leak"
	| "symlink"
	| "oversized"
	| "entries";

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture(
	mode: Mode = "clean",
	version = "1.3.0",
	name = "@earendil-works/pi-coding-agent",
) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "qg-auth-fixture-")));
	roots.push(root);
	const sdk = join(root, "sdk");
	const core = join(sdk, "dist/core");
	mkdirSync(core, { recursive: true });
	writeFileSync(
		join(sdk, "package.json"),
		JSON.stringify({
			name,
			version,
			type: "module",
		}),
	);
	const imported = join(root, "imported");
	const outside = join(root, "outside-public-fixture");
	writeFileSync(outside, "harmless fixture outside the contract directory");
	writeFileSync(
		join(core, "auth-storage.js"),
		"export const AuthStorage = { inMemory: () => ({ fixtureMemory: true }) };",
	);
	writeFileSync(
		join(core, "model-runtime.js"),
		`
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
assert.deepEqual(Object.keys(process.env).sort(), ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "TMPDIR"]);
assert.equal(process.env.PI_OFFLINE, "1");
assert.equal(process.env.TMPDIR, process.env.PI_CODING_AGENT_DIR);
writeFileSync(${JSON.stringify(imported)}, "fixture import");
const mode = ${JSON.stringify(mode)};
export const ModelRuntime = {
  async create(options) {
    assert.equal(options.credentials.fixtureMemory, true);
    assert.equal(options.refreshOnCreate, false);
    assert.equal(options.allowModelNetwork, false);
    const overlay = options.modelsPath !== null;
    if (overlay) {
      const config = JSON.parse(readFileSync(options.modelsPath, "utf8"));
      assert.equal(config.providers["openai-codex"].apiKey, "$" + "{PI_REVIEWER_NO_FALLBACK_AUTH}");
      assert.equal(process.env.PI_REVIEWER_NO_FALLBACK_AUTH, undefined);
    }
    const root = process.env.PI_CODING_AGENT_DIR;
    if (mode === "nested" || mode === "nested-leak") {
      mkdirSync(join(root, "cache"), { recursive: true });
      writeFileSync(join(root, "cache", "fixture.json"), "{}");
    }
    if (mode === "symlink" && !existsSync(join(root, "alias")))
      symlinkSync(${JSON.stringify(outside)}, join(root, "alias"));
    if (mode === "oversized") writeFileSync(join(root, "large"), Buffer.alloc(1_048_577));
    if (mode === "entries") {
      for (let index = 0; index < 129; index++) writeFileSync(join(root, String(index)), "");
    }
    let key;
    const file = join(root, mode === "nested-leak" ? "cache/persisted-key" : "persisted-key");
    // A later runtime clears stale scratch state: only the immediate
    // post-removal checkpoint can catch a removal-time leak.
    rmSync(file, { force: true });
    function phase(provider) { return provider === "openai" ? "api" : overlay ? "overlay" : "baseline"; }
    function supported(provider) { return provider === "openai" || overlay; }
    return {
      getProvider(provider) {
        return { auth: provider === "openai" || overlay ? { apiKey: {} } : { oauth: {} } };
      },
      async setRuntimeApiKey(provider, value) {
        key = value;
        if (mode === phase(provider) || (mode === "nested-leak" && overlay)) writeFileSync(file, value);
      },
      async removeRuntimeApiKey(provider) {
        const previous = key;
        key = undefined;
        rmSync(file, { force: true });
        if (mode === "removed-" + phase(provider)) writeFileSync(file, previous);
      },
      hasConfiguredAuth(provider) { return supported(provider) && key !== undefined; },
      async checkAuth(provider) {
        return supported(provider) && key !== undefined ? { type: "api_key" } : undefined;
      },
      async getAuth(provider) {
        if (!supported(provider)) return undefined;
        if (key === undefined) {
          // SDK 1.3.0 envApiKeyAuth returns no result without a key or ambient env.
          if (provider === "openai") return undefined;
          throw Object.assign(new Error("fixture missing auth"), { code: "auth" });
        }
        return { auth: { apiKey: key } };
      },
    };
  },
};
`,
	);
	return { root, sdk, imported };
}

function run(f: ReturnType<typeof fixture>) {
	// Direct execution still runs node:test registrations, without an extra
	// test-runner child between this bounded driver and the fabricated SDK.
	const result = spawnSync(process.execPath, [script], {
		cwd: f.root,
		env: {
			PI_REVIEWER_SDK_ROOT: f.sdk,
			PI_REVIEWER_NO_FALLBACK_AUTH: "fixture-ambient-fallback",
			OPENAI_API_KEY: "fixture-ambient-key",
			HOME: join(f.root, "unused-home"),
			TMPDIR: f.root,
		},
		encoding: "utf8",
		timeout: childTimeoutMs,
		killSignal: "SIGKILL",
		maxBuffer: 131_072,
	});
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	for (const name of readdirSync(f.root)) {
		expect(name.startsWith("qg-auth-contract-")).toBe(false);
	}
	return { ...result, output: result.stdout + result.stderr };
}

describe("optional auth contract with fabricated SDK modules only", () => {
	it("accepts a memory-only runtime after clearing ambient credentials", () => {
		const f = fixture();
		const result = run(f);
		expect(result.status).toBe(0);
		expect(result.output).toContain("reproduces the OAuth-only");
		expect(result.output).toContain("credential-free overlay");
		expect(result.output).toContain("API-key providers still pass");
		expect(existsSync(f.imported)).toBe(true);
	}, 15_000);

	for (const mode of ["baseline", "overlay", "api"] as const) {
		it(`detects ${mode} key persistence before key removal can conceal it`, () => {
			const result = run(fixture(mode));
			expect(result.status).toBe(1);
			expect(result.output).toContain("Runtime key persisted");
		}, 15_000);
	}

	for (const phase of ["baseline", "overlay", "api"] as const) {
		it(`detects persistence introduced during ${phase} key removal`, () => {
			const result = run(fixture(`removed-${phase}`));
			expect(result.status).toBe(1);
			expect(result.output).toContain("Runtime key persisted");
		}, 15_000);
	}

	it("accepts nested regular cache files without treating directories as files", () => {
		const result = run(fixture("nested"));
		expect(result.status).toBe(0);
	}, 15_000);

	it("detects a key in a nested regular file", () => {
		const result = run(fixture("nested-leak"));
		expect(result.status).toBe(1);
		expect(result.output).toContain("Runtime key persisted");
	}, 15_000);

	it("rejects symlinks instead of scanning outside its private directory", () => {
		const result = run(fixture("symlink"));
		expect(result.status).toBe(1);
		expect(result.output).toContain("Unsafe SDK contract scan target");
	}, 15_000);

	for (const mode of ["oversized", "entries"] as const) {
		it(`bounds the scan for ${mode} fixture output`, () => {
			const result = run(fixture(mode));
			expect(result.status).toBe(1);
			expect(result.output).toContain("SDK contract scan limit exceeded");
		}, 15_000);
	}

	it("rejects other package identities before importing modules", () => {
		const f = fixture("clean", "1.3.0", "fixture-not-pi");
		const result = run(f);
		expect(result.status).toBe(1);
		expect(existsSync(f.imported)).toBe(false);
	}, 15_000);

	it("rejects unsupported SDK versions before importing modules", () => {
		const f = fixture("clean", "1.3.1");
		const result = run(f);
		expect(result.status).toBe(1);
		expect(existsSync(f.imported)).toBe(false);
	}, 15_000);
});
