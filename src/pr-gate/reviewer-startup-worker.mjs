// Unregistered cold-child entry. Never start against real Pi without approval.
import { createHash } from "node:crypto";
import { readSync, writeSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installPinnedReviewerHooks } from "./loader.mts";

function emit(result) {
	const bytes = Buffer.from(JSON.stringify(result));
	if (bytes.length > 16_384) throw new Error();
	let offset = 0;
	while (offset < bytes.length) {
		offset += writeSync(3, bytes, offset, bytes.length - offset);
	}
}

let stage = "policy";

async function main() {
	// Darwin may add this after spawn. Do not forward its value into the SDK.
	if (process.platform === "darwin") {
		delete process.env.__CF_USER_TEXT_ENCODING;
	}
	const input = Buffer.alloc(512 * 1024 + 1);
	let length = 0;
	while (length < input.length) {
		const count = readSync(0, input, length, input.length - length, null);
		if (count === 0) break;
		length += count;
	}
	if (length > 512 * 1024) throw new Error();
	const { binding, sdkRoot, modulePins, builtins } = JSON.parse(
		input.subarray(0, length).toString("utf8"),
	);
	const environment = [
		"LANG",
		"TZ",
		"PI_OFFLINE",
		"NODE_V8_COVERAGE",
		"FORCE_COLOR",
	];
	const flags = [
		"--permission",
		`--allow-fs-read=${sdkRoot}`,
		`--allow-fs-read=${binding.fixtureRoot}/bootstrap`,
	];
	if (
		process.version !== "v26.12.0" ||
		process.version !== binding.nodeVersion ||
		!process.permission ||
		JSON.stringify(process.execArgv) !== JSON.stringify(flags) ||
		process.env.NODE_V8_COVERAGE !== "" ||
		process.env.FORCE_COLOR !== "0" ||
		Object.keys(process.env).some((name) => !environment.includes(name))
	) {
		throw new Error();
	}
	const denied = ["fs.write", "child", "worker", "addons", "wasi", "net"];
	for (const scope of denied) {
		if (process.permission.has(scope)) throw new Error();
	}
	const proof = installPinnedReviewerHooks(modulePins, builtins);
	const guard = () => {
		proof.guard();
		const now = Date.now();
		if (now < binding.issuedAt || now >= binding.expiresAt) throw new Error();
	};
	stage = "bootstrap";
	const { createPinnedPi130Adapter } = await import("./adapter.mts");
	const { createReviewerStartupCanary } = await import("./canary.mts");
	let claimed = false;
	let runtime;
	const startup = createReviewerStartupCanary({
		now: Date.now,
		claimAcceptedCanary: (id) => {
			if (claimed || id !== binding.checkpointId) return undefined;
			claimed = true;
			return binding;
		},
		isAccepted: () => {
			guard();
			return true;
		},
		loadRuntime: async () => {
			stage = "sdk";
			runtime = await createPinnedPi130Adapter({
				root: pathToFileURL(`${sdkRoot}/`).href,
				load: (url) => import(url),
				assertLoaded(url) {
					const path = fileURLToPath(url);
					const indices = proof.loadedIndices();
					return indices.some((index) => modulePins[index].path === path);
				},
				guard,
			});
			stage = "startup";
			return runtime;
		},
		verifyLoadedRuntime: (_binding, candidate) => {
			guard();
			return candidate === runtime;
		},
	});
	const result = await startup(binding.checkpointId);
	guard();
	if (result.status !== "startup-completed") throw new Error();
	stage = "receipt";
	proof.seal(() => writeSync(3, "\nIMPORT_REFUSED\n"));
	const indices = proof.loadedIndices();
	const loaded = indices.map((index) => {
		const pin = modulePins[index];
		return [pin.path, pin.sha256];
	});
	const hash = createHash("sha256");
	hash.update(JSON.stringify(loaded));
	const digest = hash.digest("hex");
	emit({
		status: "startup-completed",
		checkpointId: binding.checkpointId,
		nodeVersion: process.version,
		sdkVersion: "1.3.0",
		indices,
		builtins: proof.builtinImports(),
		digest,
	});
}

try {
	await main();
} catch {
	try {
		emit({ status: "denied", stage });
	} catch {
		// Never print source paths, caller data or SDK errors.
	}
	process.exitCode = 1;
}
