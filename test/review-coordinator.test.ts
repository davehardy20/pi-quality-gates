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
	dispatch?: (input: PrReviewDispatchInput) => Promise<PrReviewDispatchResult>;
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

	for (const outcome of ["pass", "findings", "escalation", "error"] as const) {
		it(`wakes the agent after releasing review state: ${outcome}`, async () => {
			const dispatch = vi.fn(async (): Promise<PrReviewDispatchResult> => {
				if (outcome === "error") throw new Error("fixture dispatch failure");
				return {
					report: null,
					stamped: outcome === "pass",
					escalated: outcome === "escalation",
					blocked: outcome !== "pass",
					message:
						outcome === "findings" ? "NIT: assess this finding" : outcome,
				};
			});
			const { coordinator, state, pi } = createCoordinator({ dispatch });
			const runningAtCompletion: boolean[] = [];
			pi.sendMessage.mockImplementation((_message, options) => {
				if (options?.triggerTurn)
					runningAtCompletion.push(coordinator.isInProgress());
			});
			const kickoff = coordinator.startReview({
				ctx: createContext(),
				state,
				origin: "tool",
			});
			expect(kickoff.status).toBe("started");
			expect(pi.sendMessage.mock.calls[0][1]?.triggerTurn).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 0));
			const terminal = pi.sendMessage.mock.calls.filter(
				(call) => call[1]?.triggerTurn,
			);
			expect(terminal).toHaveLength(1);
			expect(terminal[0][1]).toEqual({
				triggerTurn: true,
				deliverAs: "followUp",
			});
			expect(terminal[0][0].customType).toBe(
				outcome === "pass"
					? "pr-review-pass"
					: outcome === "escalation"
						? "pr-review-escalation"
						: "pr-review-status",
			);
			expect(runningAtCompletion).toEqual([false]);
			expect(state.tokens.size).toBe(0);
			expect(pi.sendUserMessage).not.toHaveBeenCalled();
		});
	}

	it("does not release a new review started from the completion handler", async () => {
		const completed: PrReviewDispatchResult = {
			report: null,
			stamped: true,
			escalated: false,
			blocked: false,
			message: "PASS",
		};
		let resolveSecond: (value: PrReviewDispatchResult) => void = () => {};
		const dispatch = vi
			.fn()
			.mockResolvedValueOnce(completed)
			.mockImplementationOnce(
				() =>
					new Promise<PrReviewDispatchResult>((resolve) => {
						resolveSecond = resolve;
					}),
			);
		const { coordinator, state, pi } = createCoordinator({ dispatch });
		let nextKickoff: ReviewKickoffResult | undefined;
		pi.sendMessage.mockImplementation((message, options) => {
			if (message.customType === "pr-review-pass" && options?.triggerTurn) {
				nextKickoff = coordinator.startReview({
					ctx: createContext(),
					state,
					origin: "tool",
				});
			}
		});
		coordinator.startReview({ ctx: createContext(), state, origin: "tool" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(nextKickoff?.status).toBe("started");
		expect(dispatch).toHaveBeenCalledTimes(2);
		expect(coordinator.isInProgress()).toBe(true);
		coordinator.dispose();
		resolveSecond(completed);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(
			pi.sendMessage.mock.calls.filter((call) => call[1]?.triggerTurn),
		).toHaveLength(1);
	});

	for (const outcome of ["resolve", "reject"] as const) {
		it(`never wakes a disposed session after late ${outcome}`, async () => {
			let resolveDispatch: (value: PrReviewDispatchResult) => void = () => {};
			let rejectDispatch: (error: Error) => void = () => {};
			const dispatch = vi.fn(
				() =>
					new Promise<PrReviewDispatchResult>((resolve, reject) => {
						resolveDispatch = resolve;
						rejectDispatch = reject;
					}),
			);
			const { coordinator, state, pi } = createCoordinator({ dispatch });
			coordinator.startReview({ ctx: createContext(), state, origin: "tool" });
			coordinator.dispose();
			if (outcome === "resolve") {
				resolveDispatch({
					report: null,
					stamped: true,
					escalated: false,
					blocked: false,
					message: "late PASS",
				});
			} else {
				rejectDispatch(new Error("late fixture failure"));
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(pi.sendMessage).toHaveBeenCalledTimes(1);
			expect(pi.sendMessage.mock.calls[0][1]?.triggerTurn).toBe(false);
			expect(
				coordinator.startReview({
					ctx: createContext(),
					state,
					origin: "tool",
				}).status,
			).toBe("blocked");
			expect(dispatch).toHaveBeenCalledTimes(1);
		});
	}

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
				"tokenCount",
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
