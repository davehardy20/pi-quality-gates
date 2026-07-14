import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createPrGateState, type PrGateState } from "../src/pr-gate/index.js";
import type { PrReviewDispatchResult } from "../src/pr-gate/pr-review-dispatch.js";
import { createPrReviewToolDefinition } from "../src/pr-gate/pr-review-tool.js";
import { createReviewCoordinator } from "../src/pr-gate/review-coordinator.js";

function createContext(branch: unknown[] = []): ExtensionContext {
	return {
		cwd: "/repo",
		hasUI: false,
		ui: { setStatus: vi.fn() },
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;
}

function buildTool(opts?: { state?: PrGateState; headSha?: string }) {
	const state = opts?.state ?? createPrGateState();
	const coordinator = createReviewCoordinator({
		pi: { sendMessage: vi.fn(), sendUserMessage: vi.fn() } as never,
		resolveHeadSha: () => opts?.headSha ?? "deadbeef",
		dispatch: {
			dispatch: vi.fn(async () => ({
				report: null,
				stamped: true,
				escalated: false,
				blocked: false,
				message: "ok",
			})),
		},
	});
	const tool = createPrReviewToolDefinition({ coordinator, state });
	return { tool, state, coordinator };
}

describe("pr_review custom tool", () => {
	it("exposes the agent-callable tool contract", () => {
		const { tool } = buildTool();
		expect(tool.name).toBe("pr_review");
		expect(tool.label).toBe("PR Review");
		expect(typeof tool.execute).toBe("function");
		expect(tool.parameters).toBeDefined();
		expect(tool.promptSnippet).toContain("pr_review");
		expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
		// Prompt must steer the agent to wait for PASS before publishing.
		expect(
			tool.promptGuidelines.some((g) => g.toLowerCase().includes("wait")),
		).toBe(true);
	});

	it("starts a review and returns compact structured kickoff state", async () => {
		const { tool } = buildTool();
		const result = await tool.execute(
			"call-1",
			{},
			undefined,
			undefined,
			createContext(),
		);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(result.details.status).toBe("started");
		expect(result.details.started).toBe(true);
		expect(result.details.headSha).toBe("deadbeef");
	});

	it("returns 'already-passed' state without starting when HEAD has a PASS token", async () => {
		const state = createPrGateState();
		state.tokens.stampPass({
			sha: "deadbeef",
			passedAt: Date.now(),
			reportStatus: "PASS",
			summary: "ok",
		});
		const { tool, coordinator } = buildTool({ state });
		const spy = vi.spyOn(coordinator, "startReview");
		const result = await tool.execute(
			"call-2",
			{},
			undefined,
			undefined,
			createContext(),
		);
		expect(result.details.status).toBe("already-passed");
		expect(result.details.started).toBe(false);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("treats a provided baseRef as an intentional re-review", async () => {
		const state = createPrGateState();
		state.tokens.stampPass({
			sha: "deadbeef",
			passedAt: Date.now(),
			reportStatus: "PASS",
			summary: "ok",
		});
		const { tool } = buildTool({ state });
		const result = await tool.execute(
			"call-3",
			{ baseRef: "origin/main" },
			undefined,
			undefined,
			createContext(),
		);
		expect(result.details.status).toBe("started");
		expect(result.details.baseRef).toBe("origin/main");
	});

	it("returns 'blocked' when the linter is not clean", async () => {
		const { tool } = buildTool();
		const branch = [
			{
				type: "custom_message",
				customType: "post-turn-linter-status",
				details: { status: "findings" },
			},
		];
		const result = await tool.execute(
			"call-4",
			{},
			undefined,
			undefined,
			createContext(branch),
		);
		expect(result.details.status).toBe("blocked");
		expect(result.details.started).toBe(false);
	});

	it("returns 'blocked' when HEAD is unknown", async () => {
		const { tool } = buildTool({ headSha: "" });
		const result = await tool.execute(
			"call-5",
			{},
			undefined,
			undefined,
			createContext(),
		);
		expect(result.details.status).toBe("blocked");
		expect(result.details.headSha).toBe("");
	});

	it("returns 'disabled' when the gate is disabled", async () => {
		const state = createPrGateState({ enabled: false });
		const { tool } = buildTool({ state });
		const result = await tool.execute(
			"call-6",
			{},
			undefined,
			undefined,
			createContext(),
		);
		expect(result.details.status).toBe("disabled");
		expect(result.details.gateEnabled).toBe(false);
	});

	it("returns 'in-progress' on a duplicate concurrent kickoff", async () => {
		const { tool, coordinator } = buildTool();
		// Force the coordinator into the in-progress state.
		coordinator.startReview({
			ctx: createContext(),
			state: createPrGateState(),
			origin: "command",
		});
		const result = await tool.execute(
			"call-7",
			{},
			undefined,
			undefined,
			createContext(),
		);
		expect(result.details.status).toBe("in-progress");
		expect(result.details.started).toBe(false);
	});

	it("never exposes bulky report/diff/findings content in details", async () => {
		const { tool } = buildTool();
		const result = await tool.execute(
			"call-8",
			{},
			undefined,
			undefined,
			createContext(),
		);
		const detailKeys = Object.keys(result.details);
		expect(detailKeys).not.toContain("report");
		expect(detailKeys).not.toContain("findings");
		expect(detailKeys).not.toContain("diff");
	});

	it("execute resolves without awaiting the background dispatch (no deadlock)", async () => {
		const state = createPrGateState();
		let resolveDispatch: (v: unknown) => void = () => {};
		const coordinator = createReviewCoordinator({
			pi: { sendMessage: vi.fn(), sendUserMessage: vi.fn() } as never,
			resolveHeadSha: () => "deadbeef",
			dispatch: {
				dispatch: (): Promise<PrReviewDispatchResult> =>
					new Promise((resolve) => {
						resolveDispatch = resolve as (v: unknown) => void;
					}),
			},
		});
		const tool = createPrReviewToolDefinition({ coordinator, state });
		const execPromise = tool.execute(
			"call-9",
			{},
			undefined,
			undefined,
			createContext(),
		);
		// Must resolve BEFORE the background dispatch resolves.
		const result = await Promise.race([
			execPromise.then((r) => r.details.status),
			new Promise<string>(() => {
				/* never resolves */
			}),
		]);
		expect(result).toBe("started");
		resolveDispatch({});
	});
});
