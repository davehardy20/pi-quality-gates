import { describe, expect, it, vi } from "vitest";
import {
	createPinnedPi130Adapter,
	PI130_ENTRIES,
} from "../src/pr-gate/reviewer-startup-adapter.js";

function fixture() {
	const credentials = {};
	const settings = {};
	const sessionManager = {};
	const modelRuntime = {};
	const extensionRuntime = {};
	const namespaces: Record<string, object> = {
		"auth-storage": { AuthStorage: { inMemory: vi.fn(() => credentials) } },
		"settings-manager": {
			SettingsManager: { inMemory: vi.fn(() => settings) },
		},
		"session-manager": {
			SessionManager: { inMemory: vi.fn(() => sessionManager) },
		},
		"model-runtime": {
			ModelRuntime: { create: vi.fn(async () => modelRuntime) },
		},
		"extensions/loader": {
			createExtensionRuntime: vi.fn(() => extensionRuntime),
		},
		sdk: { createAgentSession: vi.fn(async () => ({ session: {} })) },
	};
	const root = "file:///approved/sdk/";
	const urls = Object.values(PI130_ENTRIES).map(
		(path) => new URL(path, root).href,
	);
	const load = vi.fn(async (url: string) => {
		const name = Object.keys(PI130_ENTRIES)[urls.indexOf(url)];
		return namespaces[name];
	});
	const assertLoaded = vi.fn(() => true);
	const guard = vi.fn();
	return {
		root,
		namespaces,
		urls,
		load,
		assertLoaded,
		guard,
		credentials,
		settings,
		sessionManager,
		modelRuntime,
		extensionRuntime,
	};
}

const refusal = "Pinned Pi adapter refused";

describe("pinned Pi 1.3.0 adapter (fabricated modules only)", () => {
	it("loads six exact internal entries, never the ambient package index", async () => {
		const f = fixture();
		const adapter = await createPinnedPi130Adapter(f);
		expect(f.load.mock.calls.map(([url]) => url)).toEqual(f.urls);
		expect(f.assertLoaded.mock.calls).toEqual(f.urls.map((url) => [url]));
		expect(adapter.sdkVersion).toBe("1.3.0");
		expect(adapter.AuthStorage.inMemory()).toBe(f.credentials);
		expect(adapter.SettingsManager.inMemory({})).toBe(f.settings);
		expect(adapter.SessionManager.inMemory("/fixture")).toBe(f.sessionManager);
		expect(
			await adapter.ModelRuntime.create({
				credentials: f.credentials,
				modelsPath: null,
				refreshOnCreate: false,
				allowModelNetwork: false,
			}),
		).toBe(f.modelRuntime);
		expect(adapter.createExtensionRuntime()).toBe(f.extensionRuntime);
		expect(Object.isFrozen(adapter)).toBe(true);
	});

	it.each(Object.keys(PI130_ENTRIES))("rejects missing %s", async (key) => {
		const f = fixture();
		f.namespaces[key] = {};
		await expect(createPinnedPi130Adapter(f)).rejects.toThrow(refusal);
	});

	it("rejects loaded-origin failure even when a matching ABI was supplied", async () => {
		const f = fixture();
		f.assertLoaded.mockReturnValue(false);
		await expect(createPinnedPi130Adapter(f)).rejects.toThrow(refusal);
		expect(f.load).toHaveBeenCalledTimes(1);
	});

	it("does not invoke getters while checking the ABI", async () => {
		const f = fixture();
		const getter = vi.fn(() => ({}));
		f.namespaces["auth-storage"] = Object.defineProperty({}, "AuthStorage", {
			get: getter,
		});
		await expect(createPinnedPi130Adapter(f)).rejects.toThrow(refusal);
		expect(getter).not.toHaveBeenCalled();
	});

	it("preserves static factory receivers", async () => {
		const f = fixture();
		const storage = {
			inMemory() {
				return this;
			},
		};
		f.namespaces["auth-storage"] = { AuthStorage: storage };
		expect((await createPinnedPi130Adapter(f)).AuthStorage.inMemory()).toBe(
			storage,
		);
	});

	it("rechecks admission after an awaited import", async () => {
		const f = fixture();
		f.load.mockImplementationOnce(async () => {
			f.guard.mockImplementation(() => {
				throw new Error("revoked secret");
			});
			return f.namespaces["auth-storage"];
		});
		await expect(createPinnedPi130Adapter(f)).rejects.toThrow(refusal);
		expect(f.load).toHaveBeenCalledTimes(1);
	});

	it.each([
		"file:///approved/sdk",
		"https://example.test/sdk/",
		"file:///approved/sdk/?query",
		"file:///approved/sdk/../other/",
	])("refuses noncanonical root %s without loading", async (root) => {
		const f = fixture();
		await expect(createPinnedPi130Adapter({ ...f, root })).rejects.toThrow(
			refusal,
		);
		expect(f.load).not.toHaveBeenCalled();
	});
});
