// Optional local SDK 1.3.0 auth contract, not a live reviewer or startup grant.
// Run: node --test scripts/reviewer-sdk-auth-check.mjs
// Set PI_REVIEWER_SDK_ROOT for a trusted installation outside Homebrew.
import assert from "node:assert/strict";
import {
	closeSync,
	constants,
	fstatSync,
	mkdtempSync,
	opendirSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const sdkRoot = realpathSync(
	process.env.PI_REVIEWER_SDK_ROOT ??
		"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
);
assert.ok(isAbsolute(sdkRoot));
const metadata = JSON.parse(
	readFileSync(join(sdkRoot, "package.json"), "utf8"),
);
assert.equal(metadata.name, "@earendil-works/pi-coding-agent");
assert.equal(metadata.version, "1.3.0");
const root = realpathSync(mkdtempSync(join(tmpdir(), "qg-auth-contract-")));
after(() => rmSync(root, { recursive: true, force: true }));
// This dedicated test child has no ambient provider credentials or home.
// No session, stream, credential file or provider registration is used.
for (const name of Object.keys(process.env)) delete process.env[name];
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_OFFLINE = "1";
process.env.TMPDIR = root;
const { ModelRuntime } = await import(
	pathToFileURL(join(sdkRoot, "dist/core/model-runtime.js")).href
);
const { AuthStorage } = await import(
	pathToFileURL(join(sdkRoot, "dist/core/auth-storage.js")).href
);
const key = [
	"!opaque",
	"$not_an_environment_lookup",
	"fixture-not-a-real-token",
].join("-");
// Check only this run's private directory, with bounded traversal and reads.
// These checkpoints detect persistence, not an OS sandbox or a write audit.
function assertNoPersistedKey() {
	let entriesLeft = 128;
	let bytesLeft = 1_048_576;
	const directories = [root];
	while (directories.length) {
		const directory = opendirSync(directories.pop());
		try {
			while (true) {
				const entry = directory.readSync();
				if (entry === null) break;
				assert.ok(--entriesLeft >= 0, "SDK contract scan limit exceeded.");
				assert.ok(!entry.isSymbolicLink(), "Unsafe SDK contract scan target.");
				const path = join(directory.path, entry.name);
				if (entry.isDirectory()) {
					directories.push(path);
					continue;
				}
				assert.ok(entry.isFile(), "Unsafe SDK contract scan target.");
				const fd = openSync(
					path,
					constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				);
				try {
					const stat = fstatSync(fd);
					assert.ok(
						stat.isFile() && stat.size <= bytesLeft,
						"SDK contract scan limit exceeded.",
					);
					const data = Buffer.alloc(stat.size + 1);
					let size = 0;
					while (size < data.length) {
						const count = readSync(fd, data, size, data.length - size, null);
						if (count === 0) break;
						size += count;
					}
					assert.equal(size, stat.size, "SDK contract scan target changed.");
					bytesLeft -= size;
					assert.equal(
						data.subarray(0, size).includes(key),
						false,
						"Runtime key persisted in SDK contract files.",
					);
				} finally {
					closeSync(fd);
				}
			}
		} finally {
			directory.closeSync();
		}
	}
}

async function runtime(modelsPath = null) {
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
}

test("reproduces the OAuth-only credential-type mismatch before the overlay", async () => {
	const original = await runtime();
	assert.ok(original.getProvider("openai-codex").auth.oauth);
	assert.equal(original.getProvider("openai-codex").auth.apiKey, undefined);
	await original.setRuntimeApiKey("openai-codex", key);
	assert.equal(original.hasConfiguredAuth("openai-codex"), false);
	assert.equal(await original.checkAuth("openai-codex"), undefined);
	assert.equal(await original.getAuth("openai-codex"), undefined);
	assertNoPersistedKey();
	await original.removeRuntimeApiKey("openai-codex");
	assert.equal(original.hasConfiguredAuth("openai-codex"), false);
	assert.equal(await original.checkAuth("openai-codex"), undefined);
	assert.equal(await original.getAuth("openai-codex"), undefined);
	assertNoPersistedKey();
});

test("the credential-free overlay passes SDK auth and resolves the unchanged bearer", async () => {
	const modelsPath = join(root, "reviewer-models.json");
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				"openai-codex": {
					apiKey: ["$", "{PI_REVIEWER_NO_FALLBACK_AUTH}"].join(""),
				},
			},
		}),
		{ flag: "wx", mode: 0o400 },
	);
	const borrowed = await runtime(modelsPath);
	assert.equal(await borrowed.checkAuth("openai-codex"), undefined);
	await assert.rejects(borrowed.getAuth("openai-codex"), { code: "auth" });
	await borrowed.setRuntimeApiKey("openai-codex", key);
	assert.equal(borrowed.hasConfiguredAuth("openai-codex"), true);
	assert.equal((await borrowed.checkAuth("openai-codex")).type, "api_key");
	assert.equal((await borrowed.getAuth("openai-codex")).auth.apiKey, key);
	assertNoPersistedKey();
	await borrowed.removeRuntimeApiKey("openai-codex");
	assert.equal(borrowed.hasConfiguredAuth("openai-codex"), false);
	assert.equal(await borrowed.checkAuth("openai-codex"), undefined);
	await assert.rejects(borrowed.getAuth("openai-codex"), { code: "auth" });
	assertNoPersistedKey();
});

test("API-key providers still pass SDK auth without any overlay", async () => {
	const api = await runtime();
	assert.ok(api.getProvider("openai").auth.apiKey);
	await api.setRuntimeApiKey("openai", key);
	assert.equal(api.hasConfiguredAuth("openai"), true);
	assert.equal((await api.checkAuth("openai")).type, "api_key");
	assert.equal((await api.getAuth("openai")).auth.apiKey, key);
	assertNoPersistedKey();
	await api.removeRuntimeApiKey("openai");
	assert.equal(api.hasConfiguredAuth("openai"), false);
	assert.equal(await api.checkAuth("openai"), undefined);
	// Built-in env auth returns no result; the overlay's missing env reference throws.
	assert.equal(await api.getAuth("openai"), undefined);
	assertNoPersistedKey();
});
