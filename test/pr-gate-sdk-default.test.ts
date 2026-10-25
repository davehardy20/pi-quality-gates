import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import prGateExtension, {
	type PrGateExtensionDeps,
} from "../src/pr-gate/index.js";
import { createReviewerExecution } from "../src/pr-gate/reviewer.js";

// Inert dependency ports: no module mocks, SDK imports, credentials or children.
describe("default host SDK wiring", () => {
	it("binds the registered-tool collector to the actual host executor", () => {
		const bindHostSpawner = vi.fn();
		const createLauncher = vi.fn(
			(_getToolInfos: () => readonly unknown[]) => bindHostSpawner,
		);
		const createExecution = vi.fn(createReviewerExecution);
		const tools = [{ name: "fixed-fixture-tool" }];
		const getAllTools = vi.fn(() => tools);
		const pi = {
			on: vi.fn(),
			registerCommand: vi.fn(),
			registerTool: vi.fn(),
			getAllTools,
		} as unknown as ExtensionAPI;
		prGateExtension(pi, {
			reviewerBridgeMode: "host",
			createSdkReviewerLauncher: createLauncher,
			createReviewerExecution: createExecution,
		} as PrGateExtensionDeps);
		expect(createLauncher).toHaveBeenCalledOnce();
		expect(createExecution).toHaveBeenCalledWith(
			expect.objectContaining({ bindHostSpawner }),
		);
		// Registration must not collect tools or start a reviewer prematurely.
		expect(getAllTools).not.toHaveBeenCalled();
		const collector = createLauncher.mock.calls[0]?.[0] as unknown as
			| (() => unknown)
			| undefined;
		if (!collector) throw new Error("Missing tool collector");
		expect(collector()).toBe(tools);
		expect(getAllTools).toHaveBeenCalledOnce();
	});
});
