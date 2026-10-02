import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PR_REVIEW_CONFIG } from "../src/pr-gate/pr-review-config.js";
import {
	createReviewerExecution,
	type ReviewerResult,
	spawnReviewer,
} from "../src/pr-gate/reviewer.js";
import type { ReviewConfig } from "../src/shared/review-config.js";
import { createReviewDeadline } from "../src/shared/review-deadline.js";

const empty: ReviewerResult = {
	report: null,
	rawOutput: "",
	exitCode: 0,
	timedOut: false,
	stderr: "",
	command: "fake child",
};

describe("one monotonic reviewer deadline", () => {
	it("gives the host subprocess only remaining time and refuses PASS after timer termination", async () => {
		vi.useFakeTimers();
		try {
			let started!: () => void;
			const didSpawn = new Promise<void>((resolve) => {
				started = resolve;
			});
			const proc = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
				kill: vi.fn((_signal: string) => {
					// A terminated child can flush a late PASS before close.
					proc.stdout.emit(
						"data",
						Buffer.from(
							JSON.stringify({
								type: "message_end",
								message: {
									role: "assistant",
									content: [
										{
											type: "text",
											text: "## Review Report\nSTATUS: PASS\nCONFIDENCE: HIGH\n### Findings\nNone.\n### Test execution\n- **Status:** PASS\n- **Summary:** passed\n### Summary\nlate",
										},
									],
								},
							}),
						),
					);
					proc.emit("close", 0);
					return true;
				}),
			});
			const spawnProcess = vi.fn(() => {
				started();
				return proc;
			});
			const deadline = createReviewDeadline(3_900_000, () => 100, 0);
			const pending = spawnReviewer(
				"task",
				"system",
				{ ...PR_REVIEW_CONFIG, timeoutMs: 3_900_000 },
				process.cwd(),
				undefined,
				deadline,
				spawnProcess as unknown as typeof spawn,
			);
			await didSpawn;
			await vi.advanceTimersByTimeAsync(3_899_899);
			expect(proc.kill).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			const result = await pending;
			expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
			expect(result.timedOut).toBe(true);
			expect(result.report).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("subtracts preparation and primary time before fallback; never resets", async () => {
		let now = 0;
		const budgets: number[] = [];
		const exec = createReviewerExecution({
			now: () => now,
			getPromptsDir: () => "/prompts",
			readSystemPrompt: () => {
				now += 100;
				return "system";
			},
			renderTaskTemplate: () => "task",
			spawnReviewer: async (_task, _system, config) => {
				budgets.push(config.timeoutMs);
				now += 400;
				return empty;
			},
		});
		await exec.runAttempt({
			task: "task",
			files: [],
			cwd: "/repo",
			diff: "diff",
			config: {
				...PR_REVIEW_CONFIG,
				timeoutMs: 1_000,
				fallbackModels: ["fallback-one", "fallback-two"],
			},
		});
		expect(budgets).toEqual([900, 500, 100]);
	});

	it("refuses fallback after exhaustion and rejects late PASS evidence", async () => {
		for (const latePass of [false, true]) {
			let now = 0;
			const spawnReviewer = vi.fn(async () => {
				now = 1_001;
				return {
					...empty,
					...(latePass
						? {
								report: {
									status: "PASS" as const,
									confidence: "HIGH" as const,
									findings: [],
									verified: [],
									unverifiable: [],
									summary: "late",
								},
							}
						: {}),
				};
			});
			const exec = createReviewerExecution({
				now: () => now,
				getPromptsDir: () => "/prompts",
				readSystemPrompt: () => "system",
				renderTaskTemplate: () => "task",
				spawnReviewer,
			});
			const result = await exec.runAttempt({
				task: "task",
				files: [],
				cwd: "/repo",
				diff: "diff",
				config: {
					...PR_REVIEW_CONFIG,
					timeoutMs: 1_000,
					fallbackModels: ["fallback"],
				},
			});
			expect(spawnReviewer).toHaveBeenCalledOnce();
			expect(result.timedOut).toBe(true);
			expect(result.report).toBeNull();
			expect(result.rawOutput).toMatch(/budget=1000.*elapsed=1001/);
		}
	});

	it("does not allocate a child if preparation exhausts the deadline", async () => {
		let now = 0;
		const spawnReviewer = vi.fn();
		const exec = createReviewerExecution({
			now: () => now,
			getPromptsDir: () => "/prompts",
			readSystemPrompt: () => {
				now = 1_000;
				return "system";
			},
			renderTaskTemplate: () => "task",
			spawnReviewer,
		});
		const result = await exec.runAttempt({
			task: "task",
			files: [],
			cwd: "/repo",
			diff: "diff",
			config: { ...PR_REVIEW_CONFIG, timeoutMs: 1_000 },
		});
		expect(result.timedOut).toBe(true);
		expect(spawnReviewer).not.toHaveBeenCalled();
	});

	it("never retries a runner timeout as an empty-model failure", async () => {
		const spawnReviewer = vi.fn(
			async (_task, _system, _config: ReviewConfig) => ({
				...empty,
				timedOut: true,
			}),
		);
		const exec = createReviewerExecution({
			getPromptsDir: () => "/prompts",
			readSystemPrompt: () => "system",
			renderTaskTemplate: () => "task",
			spawnReviewer,
		});
		await exec.runAttempt({
			task: "task",
			files: [],
			cwd: "/repo",
			diff: "diff",
			config: { ...PR_REVIEW_CONFIG, fallbackModels: ["fallback"] },
		});
		expect(spawnReviewer).toHaveBeenCalledOnce();
	});
});
