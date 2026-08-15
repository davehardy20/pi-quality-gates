import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createPrGateState, type PrGateState } from "../src/pr-gate/index.js";
import type {
	PrReviewDispatchInput,
	PrReviewDispatchResult,
} from "../src/pr-gate/pr-review-dispatch.js";
import {
	createReviewCoordinator,
	type ReviewKickoffResult,
} from "../src/pr-gate/review-coordinator.js";

interface SentMessage {
	customType?: string;
	content?: string;
	details?: Record<string, unknown>;
	display?: boolean;
}

interface FakePi {
	sendMessage: ReturnType<typeof vi.fn>;
	sendUserMessage: ReturnType<typeof vi.fn>;
}

function createPi(): FakePi {
	return {
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
	};
}

function createContext(opts?: {
	hasUI?: boolean;
	branch?: unknown[];
}): ExtensionContext {
	return {
		cwd: "/repo",
		hasUI: Boolean(opts?.hasUI),
		ui: { setStatus: vi.fn() },
		sessionManager: { getBranch: () => opts?.branch ?? [] },
	} as unknown as ExtensionContext;
}

function createCoordinator(opts?: {
	state?: PrGateState;
	headSha?: string;
	dispatch?: ReturnType<typeof vi.fn>;
	pi?: FakePi;
}) {
	const state = opts?.state ?? createPrGateState();
	const dispatch =
		opts?.dispatch ??
		vi.fn(
			async () =>
				({
					report: null,
					stamped: true,
					escalated: false,
					blocked: false,
					message: "done",
				}) as PrReviewDispatchResult,
		);
	const pi = opts?.pi ?? createPi();
	const coordinator = createReviewCoordinator({
		pi: pi as never,
		resolveHeadSha: () => opts?.headSha ?? "abc123",
		dispatch: { dispatch },
	});
	return { coordinator, state, dispatch, pi };
}

describe("createReviewCoordinator (shared by /pr-review and pr_review)", () => {
	it("returns 'disabled' and never starts when the gate is disabled", () => {
		const state = createPrGateState({ enabled: false });
		const { coordinator, dispatch } = createCoordinator({ state });
		const result = coordinator.startReview({
			ctx: createContext(),
			state,
			origin: "command",
		});
		expect(result.status).toBe("disabled");
		expect(result.started).toBe(false);
		expect(result.startedAt).toBeUndefined();
		expect(result.gateEnabled).toBe(false);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("returns 'blocked' and never starts when HEAD is unknown", () => {
		const { coordinator, dispatch } = createCoordinator({ headSha: "" });
		const result = coordinator.startReview({
			ctx: createContext(),
			state: createPrGateState(),
			origin: "tool",
		});
		expect(result.status).toBe("blocked");
		expect(result.started).toBe(false);
		expect(result.headSha).toBe("");
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("returns 'blocked' when the linter is not clean, before HEAD is required", () => {
		const { coordinator, dispatch } = createCoordinator({ headSha: "" });
		const branch = [
			{
				type: "custom_message",
				customType: "post-turn-linter-status",
				details: { status: "findings" },
			},
		];
		const result = coordinator.startReview({
			ctx: createContext({ branch }),
			state: createPrGateState(),
			origin: "command",
		});
		expect(result.status).toBe("blocked");
		expect(result.message).toContain("linter is not clean");
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("returns 'already-passed' when HEAD already has a PASS token and no baseRef", () => {
		const state = createPrGateState();
		state.tokens.stampPass({
			sha: "abc123",
			passedAt: Date.now(),
			reportStatus: "PASS",
			summary: "ok",
		});
		const { coordinator, dispatch } = createCoordinator({ state });
		const result = coordinator.startReview({
			ctx: createContext(),
			state,
			origin: "tool",
		});
		expect(result.status).toBe("already-passed");
		expect(result.started).toBe(false);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("starts a review and reports 'started' when eligible", () => {
		const { coordinator, dispatch, pi } = createCoordinator();
		const result = coordinator.startReview({
			ctx: createContext(),
			state: createPrGateState(),
			origin: "command",
		});
		expect(result.status).toBe("started");
		expect(result.started).toBe(true);
		expect(result.headSha).toBe("abc123");
		expect(typeof result.startedAt).toBe("number");
		expect(result.startedAt ?? 0).toBeLessThanOrEqual(Date.now());
		expect(dispatch).toHaveBeenCalledTimes(1);
		const sent = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.find(
			(c: unknown[]) =>
				(c[0] as SentMessage)?.customType === "pr-review-status",
		);
		expect((sent?.[0] as SentMessage | undefined)?.content ?? "").toContain(
			"PR review started",
		);
	});

	it("treats an explicit baseRef as an intentional re-review even when already-passed", () => {
		const state = createPrGateState();
		state.tokens.stampPass({
			sha: "abc123",
			passedAt: Date.now(),
			reportStatus: "PASS",
			summary: "ok",
		});
		const { coordinator, dispatch } = createCoordinator({ state });
		const result = coordinator.startReview({
			ctx: createContext(),
			state,
			baseRef: "origin/main",
			origin: "tool",
		});
		expect(result.status).toBe("started");
		expect(result.baseRef).toBe("origin/main");
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				baseRef: "origin/main",
				isReReview: true,
			}),
		);
	});

	it("returns 'in-progress' on a second concurrent kickoff and does not start a second dispatch", async () => {
		let resolveDispatch: (value: PrReviewDispatchResult) => void = () => {};
		const dispatch = vi.fn(
			() =>
				new Promise<PrReviewDispatchResult>((resolve) => {
					resolveDispatch = resolve;
				}),
		);
		const { coordinator, state } = createCoordinator({ dispatch });
		const ctx = createContext();
		const first = coordinator.startReview({
			ctx,
			state,
			origin: "command",
		});
		expect(first.status).toBe("started");
		expect(coordinator.isInProgress()).toBe(true);

		const second = coordinator.startReview({
			ctx,
			state,
			origin: "tool",
		});
		expect(second.status).toBe("in-progress");
		expect(second.started).toBe(false);
		expect(dispatch).toHaveBeenCalledTimes(1);

		resolveDispatch({
			report: null,
			stamped: true,
			escalated: false,
			blocked: false,
			message: "ok",
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(coordinator.isInProgress()).toBe(false);
	});

	it("emits pr-review-pass and stamps nothing extra on a PASS dispatch result", async () => {
		const state = createPrGateState();
		const dispatch = vi.fn(
			async () =>
				({
					report: {
						status: "PASS",
						confidence: "HIGH",
						findings: [],
						verified: [],
						unverifiable: [],
						summary: "",
					},
					stamped: true,
					escalated: false,
					blocked: false,
					message: "PASS",
				}) as PrReviewDispatchResult,
		);
		const { coordinator, pi } = createCoordinator({ dispatch, state });
		coordinator.startReview({
			ctx: createContext(),
			state,
			origin: "tool",
		});
		await new Promise((r) => setTimeout(r, 0));
		const calls = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(
			(c: unknown[]) => c[0] as SentMessage,
		);
		expect(calls.some((m) => m.customType === "pr-review-pass")).toBe(true);
	});

	it("emits pr-review-escalation on a CRITICAL escalation result", async () => {
		const state = createPrGateState();
		const dispatch = vi.fn(
			async () =>
				({
					report: null,
					stamped: false,
					escalated: true,
					blocked: true,
					message: "escalated",
				}) as PrReviewDispatchResult,
		);
		const { coordinator, pi } = createCoordinator({ dispatch, state });
		coordinator.startReview({
			ctx: createContext(),
			state,
			origin: "command",
		});
		await new Promise((r) => setTimeout(r, 0));
		const calls = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(
			(c: unknown[]) => c[0] as SentMessage,
		);
		expect(calls.some((m) => m.customType === "pr-review-escalation")).toBe(
			true,
		);
	});

	it("returns a compact result with no bulky report content", () => {
		const { coordinator } = createCoordinator();
		const result: ReviewKickoffResult = coordinator.startReview({
			ctx: createContext(),
			state: createPrGateState(),
			origin: "tool",
		});
		const keys = Object.keys(result);
		expect(keys).toEqual(
			expect.arrayContaining([
				"status",
				"headSha",
				"message",
				"started",
				"startedAt",
				"gateEnabled",
			]),
		);
		// No report/findings/diff fields on the kickoff contract.
		expect(keys).not.toContain("report");
		expect(keys).not.toContain("findings");
		expect(keys).not.toContain("diff");
	});

	it("aborts the in-flight dispatch signal on dispose", async () => {
		let resolveDispatch: (value: PrReviewDispatchResult) => void = () => {};
		const dispatch = vi.fn(
			(_input: PrReviewDispatchInput) =>
				new Promise<PrReviewDispatchResult>((resolve) => {
					resolveDispatch = resolve;
				}),
		);
		const { coordinator, state } = createCoordinator({ dispatch });
		coordinator.startReview({
			ctx: createContext(),
			state,
			origin: "command",
		});
		expect(dispatch).toHaveBeenCalledTimes(1);
		const input = dispatch.mock.calls[0][0];
		expect(input.signal).toBeInstanceOf(AbortSignal);
		expect(input.signal?.aborted).toBe(false);

		coordinator.dispose();
		expect(input.signal?.aborted).toBe(true);

		resolveDispatch({
			report: null,
			stamped: false,
			escalated: false,
			blocked: true,
			message: "aborted",
		});
		await new Promise((r) => setTimeout(r, 0));
	});
});
