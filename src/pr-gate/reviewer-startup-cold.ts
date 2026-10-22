import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { PI130_ENTRIES } from "./reviewer-startup-adapter.js";
import {
	type ReviewerCanaryBinding,
	snapshotReviewerCanaryBinding,
} from "./reviewer-startup-canary.js";
import type { ReviewerModulePin } from "./reviewer-startup-loader.js";
import {
	type ColdCanaryProcessResult,
	watchReviewerColdProcess,
} from "./reviewer-startup-process.js";

export interface ReviewerColdFixture {
	readonly root: string;
}

interface OwnedFixture {
	dev: number;
	ino: number;
	active: boolean;
	claimed: boolean;
}

const owned = new WeakMap<ReviewerColdFixture, OwnedFixture>();
const BOOTSTRAP_FILES = Object.freeze({
	"worker.mjs": "reviewer-startup-worker.mjs",
	"loader.mts": "reviewer-startup-loader.ts",
	"adapter.mts": "reviewer-startup-adapter.ts",
	"canary.mts": "reviewer-startup-canary.ts",
});

export type ReviewerBootstrap = Record<keyof typeof BOOTSTRAP_FILES, Buffer>;
export interface ReviewerColdGrant {
	binding: ReviewerCanaryBinding;
	fixture: ReviewerColdFixture;
	nodePath: string;
	sdkRoot: string;
	/** Package-relative, exact public source/metadata files, never directory globs. */
	files: readonly ReviewerModulePin[];
	builtins: readonly string[];
	/** Independently predicted evaluated SDK files/builtins, not just an allowlist. */
	expectedFiles: readonly string[];
	expectedBuiltins: readonly string[];
	bootstrap: ReviewerBootstrap;
}

export interface ReviewerColdOwner {
	/** Trusted single-use owner registry. A model/parsed JSON is NOT this authority. */
	claimAcceptedCanary(id: string): ReviewerColdGrant | undefined;
	isAccepted(binding: Readonly<ReviewerCanaryBinding>): boolean;
}

export function reviewerStartupDigest(input: string | Uint8Array): string {
	return createHash("sha256").update(input).digest("hex");
}

function safePath(path: string): boolean {
	if (
		typeof path !== "string" ||
		path.length > 4096 ||
		!isAbsolute(path) ||
		path === "/"
	) {
		return false;
	}
	const unsafe = Array.from(path).some((char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 127 || "\\*?,[]".includes(char);
	});
	const denied = ["", ".", "..", ".pi", ".git"];
	const parts = path.slice(1).split("/");
	return !unsafe && !parts.some((part) => denied.includes(part.toLowerCase()));
}

/** Explicit preparation only. No Pi imports/startup; never called on module load. */
export function prepareReviewerColdFixture(): ReviewerColdFixture {
	const proposed = tmpdir().replace(/\/$/, "");
	if (!safePath(proposed)) throw new Error("Cold fixture refused");
	const parent = realpathSync(proposed);
	if (!safePath(parent)) throw new Error("Cold fixture refused");
	const root = mkdtempSync(join(parent, "qg-reviewer-cold-"));
	const stat = lstatSync(root);
	const fixture = Object.freeze({ root });
	owned.set(fixture, {
		dev: stat.dev,
		ino: stat.ino,
		active: false,
		claimed: false,
	});
	try {
		mkdirSync(join(root, "bootstrap"), { mode: 0o700 });
		mkdirSync(join(root, "state"), { mode: 0o700 });
		for (const name of ["auth.json", "settings.json", "models.json"]) {
			writeFileSync(join(root, "state", name), '{"fabricated_poison":true}\n', {
				mode: 0o600,
			});
		}
		return fixture;
	} catch {
		releaseReviewerColdFixture(fixture);
		throw new Error("Cold fixture refused");
	}
}

/** No adopted paths; no deletion while active; never follows a replaced root. */
export function releaseReviewerColdFixture(
	fixture: ReviewerColdFixture,
): boolean {
	const state = owned.get(fixture);
	if (!state || state.active) return false;
	try {
		const stat = lstatSync(fixture.root);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.dev !== state.dev ||
			stat.ino !== state.ino ||
			realpathSync(fixture.root) !== fixture.root
		) {
			return false;
		}
		rmSync(fixture.root, { recursive: true });
		owned.delete(fixture);
		return true;
	} catch {
		return false;
	}
}

/** Read exact checkout files as bytes; does not load or trust them. */
export function readReviewerBootstrap(sourceRoot: string): ReviewerBootstrap {
	if (!safePath(sourceRoot) || realpathSync(sourceRoot) !== sourceRoot) {
		throw new Error("Cold bootstrap refused");
	}
	return Object.fromEntries(
		Object.entries(BOOTSTRAP_FILES).map(([name, source]) => [
			name,
			readPinnedBytes(join(sourceRoot, source), 128 * 1024),
		]),
	) as ReviewerBootstrap;
}

function readPinnedBytes(path: string, limit: number): Buffer {
	if (!safePath(path) || realpathSync(path) !== path) throw new Error();
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size > limit) throw new Error();
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const bytes = readFileSync(fd);
		if (bytes.length > limit) throw new Error();
		return bytes;
	} finally {
		closeSync(fd);
	}
}

export function reviewerBootstrapDigest(bootstrap: ReviewerBootstrap): string {
	const hashes = Object.keys(BOOTSTRAP_FILES).map((name) => [
		name,
		reviewerStartupDigest(bootstrap[name as keyof ReviewerBootstrap]),
	]);
	return reviewerStartupDigest(JSON.stringify(hashes));
}

export function reviewerRuntimeDigest(
	sdkRoot: string,
	files: readonly ReviewerModulePin[],
	builtins: readonly string[],
	expectedFiles: readonly string[],
	expectedBuiltins: readonly string[],
): string {
	const policy = { sdkRoot, files, builtins, expectedFiles, expectedBuiltins };
	return reviewerStartupDigest(JSON.stringify(policy));
}

/** Fixed cold-process launcher. No registration, discovery or default owner. */
export function createReviewerColdCanary(owner: ReviewerColdOwner) {
	return async (
		id: unknown,
		signal?: AbortSignal,
	): Promise<ColdCanaryProcessResult> => {
		let fixture: ReviewerColdFixture | undefined;
		let state: OwnedFixture | undefined;
		let stage: "authority" | "invalid" = "authority";
		const denied = (
			reason: "authority" | "invalid" | "cancelled",
		): ColdCanaryProcessResult => ({
			status: "denied",
			reason,
			childExited: !state?.active,
			cleanup:
				fixture && releaseReviewerColdFixture(fixture) ? "complete" : "held",
		});
		if (signal !== undefined) {
			try {
				const prototype = AbortSignal.prototype;
				const aborted = Object.getOwnPropertyDescriptor(prototype, "aborted");
				if (
					Object.getPrototypeOf(signal) !== prototype ||
					Object.hasOwn(signal, "aborted") ||
					signal.addEventListener !== prototype.addEventListener ||
					signal.removeEventListener !== prototype.removeEventListener ||
					!aborted?.get
				) {
					return denied("invalid");
				}
				if (aborted.get.call(signal)) return denied("cancelled");
			} catch {
				return denied("invalid");
			}
		}
		if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id)) {
			return denied("invalid");
		}
		try {
			const grant = owner.claimAcceptedCanary(id);
			if (!grant) return denied("authority");
			const claimedFixture = grant.fixture;
			const candidateState = owned.get(claimedFixture);
			if (!candidateState || candidateState.claimed || candidateState.active) {
				return denied("authority");
			}
			fixture = claimedFixture;
			state = candidateState;
			state.claimed = true;
			stage = "invalid";
			const binding = snapshotReviewerCanaryBinding(grant.binding, id);
			if (binding.fixtureRoot !== fixture.root) return denied("invalid");
			let previousNow = Date.now();
			const guard = () => {
				const before = Date.now();
				if (
					signal?.aborted ||
					before < previousNow ||
					!Number.isSafeInteger(binding.issuedAt) ||
					!Number.isSafeInteger(binding.expiresAt) ||
					binding.issuedAt > before ||
					before >= binding.expiresAt ||
					binding.expiresAt - binding.issuedAt > 60_000 ||
					owner.isAccepted(binding) !== true
				) {
					throw new Error();
				}
				const after = Date.now();
				if (after < before || after >= binding.expiresAt || signal?.aborted) {
					throw new Error();
				}
				previousNow = after;
			};
			guard();
			const sdkRoot = grant.sdkRoot;
			const nodePath = grant.nodePath;
			const stateRoot = join(claimedFixture.root, "state");
			if (
				!safePath(sdkRoot) ||
				realpathSync(sdkRoot) !== sdkRoot ||
				sdkRoot === stateRoot ||
				stateRoot.startsWith(`${sdkRoot}/`) ||
				sdkRoot.startsWith(`${stateRoot}/`) ||
				!safePath(nodePath) ||
				realpathSync(nodePath) !== nodePath ||
				!Array.isArray(grant.files) ||
				grant.files.length > 2046 ||
				!Array.isArray(grant.builtins) ||
				grant.builtins.length > 128
			) {
				throw new Error();
			}
			const files = grant.files.map(({ path, sha256, format }) => {
				if (
					typeof path !== "string" ||
					isAbsolute(path) ||
					path.split("/").some((part) => ["", ".", ".."].includes(part)) ||
					!safePath(join(sdkRoot, path)) ||
					!/^[a-f0-9]{64}$/.test(sha256) ||
					!["module", "commonjs", "json"].includes(format)
				) {
					throw new Error();
				}
				return Object.freeze({ path, sha256, format });
			});
			const fileNames = new Set(files.map((file) => file.path));
			if (fileNames.size !== files.length) {
				throw new Error();
			}
			const builtins = [...grant.builtins];
			if (
				!Array.isArray(grant.expectedFiles) ||
				!Array.isArray(grant.expectedBuiltins) ||
				grant.expectedFiles.length > files.length ||
				grant.expectedBuiltins.length > builtins.length
			) {
				throw new Error();
			}
			const expectedFiles = [...grant.expectedFiles];
			const expectedBuiltins = [...grant.expectedBuiltins];
			if (
				new Set(expectedFiles).size !== expectedFiles.length ||
				new Set(expectedBuiltins).size !== expectedBuiltins.length ||
				expectedFiles.some((path) => !fileNames.has(path)) ||
				expectedBuiltins.some((name) => !builtins.includes(name))
			) {
				throw new Error();
			}
			if (
				builtins.some(
					(name) => !name.startsWith("node:") || !isBuiltin(name),
				) ||
				new Set(builtins).size !== builtins.length ||
				reviewerRuntimeDigest(
					sdkRoot,
					files,
					builtins,
					expectedFiles,
					expectedBuiltins,
				) !== binding.runtimeClosureSha256
			) {
				throw new Error();
			}
			const bootstrap = Object.fromEntries(
				Object.keys(BOOTSTRAP_FILES).map((name) => {
					const source = grant.bootstrap[name as keyof ReviewerBootstrap];
					if (!Buffer.isBuffer(source) || source.length > 128 * 1024) {
						throw new Error();
					}
					return [name, Buffer.from(source)];
				}),
			) as ReviewerBootstrap;
			if (reviewerBootstrapDigest(bootstrap) !== binding.bootstrapSha256) {
				throw new Error();
			}
			const nodeBytes = readPinnedBytes(nodePath, 256 * 1024 * 1024);
			if (reviewerStartupDigest(nodeBytes) !== binding.nodeSha256) {
				throw new Error();
			}
			let version: unknown;
			for (const file of files) {
				guard();
				const bytes = readPinnedBytes(
					join(sdkRoot, file.path),
					16 * 1024 * 1024,
				);
				if (reviewerStartupDigest(bytes) !== file.sha256) throw new Error();
				if (file.path === "package.json") {
					version = JSON.parse(bytes.toString()).version;
				}
			}
			if (version !== "1.3.0") throw new Error();
			const modulePins: ReviewerModulePin[] = files.map((file) => ({
				...file,
				path: join(sdkRoot, file.path),
			}));
			const bootstrapRoot = join(fixture.root, "bootstrap");
			for (const [name, bytes] of Object.entries(bootstrap)) {
				writeFileSync(join(bootstrapRoot, name), bytes, {
					flag: "wx",
					mode: 0o400,
				});
				if (name === "adapter.mts" || name === "canary.mts") {
					modulePins.push({
						path: join(bootstrapRoot, name),
						sha256: reviewerStartupDigest(bytes),
						format: "module-typescript",
					});
				}
			}
			const required = Object.values(PI130_ENTRIES).map((path) =>
				modulePins.findIndex((pin) => pin.path === join(sdkRoot, path)),
			);
			const expected = expectedFiles.map((path) =>
				modulePins.findIndex((pin) => pin.path === join(sdkRoot, path)),
			);
			if (
				required.includes(-1) ||
				required.some((index) => !expected.includes(index))
			) {
				throw new Error();
			}
			expected.push(modulePins.length - 2, modulePins.length - 1);
			expected.sort((a, b) => a - b);
			expectedBuiltins.sort();
			const envelope = { binding, sdkRoot, modulePins, builtins };
			const payload = Buffer.from(JSON.stringify(envelope));
			if (payload.length > 512 * 1024) throw new Error();
			guard();
			const deadline = Math.min(binding.expiresAt, Date.now() + 15_000);
			const argv = [
				"--permission",
				`--allow-fs-read=${sdkRoot}`,
				`--allow-fs-read=${bootstrapRoot}`,
				join(bootstrapRoot, "worker.mjs"),
			];
			const child = spawn(nodePath, argv, {
				cwd: fixture.root,
				env: {
					LANG: "C",
					TZ: "UTC",
					PI_OFFLINE: "1",
					NODE_V8_COVERAGE: "",
					FORCE_COLOR: "0",
				},
				stdio: ["pipe", "pipe", "pipe", "pipe"],
			});
			state.active = true;
			const liveState = state;
			child.once("close", () => {
				liveState.active = false;
			});
			const observed = Object.assign(child, {
				stdout: child.stdout ?? Readable.from([]),
				stderr: child.stderr ?? Readable.from([]),
			});
			const pending = watchReviewerColdProcess({
				child: observed,
				receipt: (child.stdio[3] as Readable) ?? Readable.from([]),
				deadline,
				signal,
				isAccepted: () => {
					guard();
					return true;
				},
				cleanup: async () => releaseReviewerColdFixture(claimedFixture),
				checkReceipt: (input) => {
					guard();
					const receipt = input as Record<string, unknown>;
					const indices = receipt.indices;
					const imported = receipt.builtins;
					if (
						Object.keys(receipt).sort().join(",") !==
							"builtins,checkpointId,digest,indices,nodeVersion,sdkVersion,status" ||
						receipt.checkpointId !== id ||
						receipt.nodeVersion !== binding.nodeVersion ||
						receipt.sdkVersion !== "1.3.0" ||
						!Array.isArray(indices) ||
						!Array.isArray(imported) ||
						indices.length !== expected.length ||
						indices.some(
							(index, i) =>
								!Number.isInteger(index) ||
								index < 0 ||
								index >= modulePins.length ||
								(i > 0 && indices[i - 1] >= index),
						) ||
						indices.some((index, i) => index !== expected[i]) ||
						imported.length !== expectedBuiltins.length ||
						imported.some((name, i) => name !== expectedBuiltins[i])
					) {
						return false;
					}
					const loaded = indices.map((index) => {
						const pin = modulePins[index];
						return [pin.path, pin.sha256];
					});
					return (
						receipt.digest === reviewerStartupDigest(JSON.stringify(loaded))
					);
				},
			});
			const inputFailed = () => child.emit("error", new Error("Input refused"));
			child.stdin?.on("error", inputFailed);
			try {
				child.stdin?.end(payload);
			} catch {
				inputFailed();
			}
			return await pending;
		} catch {
			return denied(signal?.aborted ? "cancelled" : stage);
		}
	};
}
