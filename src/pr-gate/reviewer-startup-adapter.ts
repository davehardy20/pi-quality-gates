import type { CanaryRuntime } from "./reviewer-startup-canary.js";

/** Internal 1.3.0 files, not the package index (which also exports CLI/UI). */
export const PI130_ENTRIES = Object.freeze({
	"auth-storage": "dist/core/auth-storage.js",
	"settings-manager": "dist/core/settings-manager.js",
	"session-manager": "dist/core/session-manager.js",
	"model-runtime": "dist/core/model-runtime.js",
	"extensions/loader": "dist/core/extensions/loader.js",
	sdk: "dist/core/sdk.js",
});

export interface PinnedPi130Loader {
	/** Canonical, owner-accepted package directory URL, including trailing slash. */
	root: string;
	load(url: string): Promise<unknown>;
	/** Trusted loader receipt for bytes actually loaded, not namespace metadata. */
	assertLoaded(url: string): boolean;
	guard(): void;
}

function own(value: unknown, key: string): unknown {
	if (
		value === null ||
		(typeof value !== "object" && typeof value !== "function")
	) {
		throw new Error();
	}
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !("value" in descriptor)) throw new Error();
	return descriptor.value;
}

/** No importer, IO, registration, authority issuance or SDK dependency. */
export async function createPinnedPi130Adapter(
	deps: PinnedPi130Loader,
): Promise<CanaryRuntime> {
	const refused = () => new Error("Pinned Pi adapter refused");
	try {
		deps.guard();
		const root = new URL(deps.root);
		if (
			root.protocol !== "file:" ||
			root.host ||
			root.search ||
			root.hash ||
			root.href !== deps.root ||
			root.pathname === "/" ||
			!root.pathname.endsWith("/")
		) {
			throw refused();
		}
		const modules: Record<string, unknown> = Object.create(null);
		for (const [name, path] of Object.entries(PI130_ENTRIES)) {
			deps.guard();
			const url = new URL(path, root).href;
			const namespace = await deps.load(url);
			deps.guard();
			if (deps.assertLoaded(url) !== true) throw refused();
			deps.guard();
			modules[name] = namespace;
		}
		const method = (owner: unknown, name: string) => {
			const fn = own(owner, name);
			if (typeof fn !== "function") throw refused();
			return (...args: unknown[]): unknown => {
				try {
					deps.guard();
					const result: unknown = Reflect.apply(fn, owner, args);
					deps.guard();
					return result;
				} catch {
					throw refused();
				}
			};
		};
		const credentials = method(
			own(modules["auth-storage"], "AuthStorage"),
			"inMemory",
		);
		const settings = method(
			own(modules["settings-manager"], "SettingsManager"),
			"inMemory",
		);
		const sessions = method(
			own(modules["session-manager"], "SessionManager"),
			"inMemory",
		);
		const models = method(
			own(modules["model-runtime"], "ModelRuntime"),
			"create",
		);
		const extensions = method(
			modules["extensions/loader"],
			"createExtensionRuntime",
		);
		const create = method(modules.sdk, "createAgentSession");
		deps.guard();
		return Object.freeze({
			sdkVersion: "1.3.0",
			AuthStorage: Object.freeze({ inMemory: credentials }),
			SettingsManager: Object.freeze({ inMemory: settings }),
			SessionManager: Object.freeze({ inMemory: sessions }),
			ModelRuntime: Object.freeze({ create: models }),
			createExtensionRuntime: extensions,
			createAgentSession: create,
		}) as CanaryRuntime;
	} catch {
		throw refused();
	}
}
