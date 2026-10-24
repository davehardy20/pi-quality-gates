import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PR_REVIEW_CONFIG } from "../src/pr-gate/pr-review-config.js";
import {
	createReviewerExecution,
	spawnReviewer,
} from "../src/pr-gate/reviewer.js";
import { writeReviewerFailureOutput as writeFailure } from "../src/pr-gate/reviewer-failure-output.js";
import { createReviewDeadline } from "../src/shared/review-deadline.js";

const roots: string[] = [];
function fixture(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "qg-failure-test-")));
	roots.push(root);
	return root;
}
const payload = {
	rawOutput: "fixed fixture output",
	stderr: "fixed fixture error",
	exitCode: 7,
	timedOut: false,
	command: "(fixed fixture, arguments omitted)",
};
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("owned reviewer failure output", () => {
	it("persists private, unique diagnostics inside the supplied owned directory", async () => {
		const base = fixture();
		const first = await writeFailure(payload, "fixed system prompt", base);
		const second = await writeFailure(payload, "fixed system prompt", base);
		expect(first).not.toBe(second);
		for (const directory of [first, second]) {
			expect(dirname(directory)).toBe(base);
			expect(lstatSync(directory).mode & 0o7777).toBe(0o700);
			const report = join(directory, "sidecar.json");
			expect(lstatSync(report).mode & 0o7777).toBe(0o600);
			expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject(payload);
			const prompt = join(directory, "reviewer-prompt.md");
			expect(lstatSync(prompt).mode & 0o7777).toBe(0o600);
			expect(readFileSync(prompt, "utf8")).toBe("fixed system prompt");
		}
	});

	it("defaults to a fresh private temporary directory, never the home directory", async () => {
		const directory = await writeFailure(payload, "fixed system prompt");
		roots.push(directory);
		expect(dirname(directory)).toBe(realpathSync(tmpdir()));
		expect(lstatSync(directory).mode & 0o7777).toBe(0o700);
	});

	it("rejects non-owned, noncanonical or symlink destinations safely", async () => {
		const root = fixture();
		const alias = join(root, "alias");
		symlinkSync(root, alias);
		const nonprivate = fixture();
		chmodSync(nonprivate, 0o755);
		for (const destination of [nonprivate, `${root}/../escape`, alias]) {
			await expect(
				writeFailure(payload, "prompt", destination),
			).rejects.toThrow(/^Reviewer failure output refused\.$/);
		}
	});

	it("refuses oversized diagnostics before allocating a directory", async () => {
		const base = fixture();
		await expect(
			writeFailure({ ...payload, rawOutput: "x".repeat(1_048_577) }, "", base),
		).rejects.toThrow(/^Reviewer failure output refused\.$/);
		expect(readdirSync(base)).toEqual([]);
	});

	it("spools a native parse failure through the fake child into owned output", async () => {
		const base = fixture();
		const child = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
		});
		const fakeSpawn = vi.fn(() => {
			queueMicrotask(() => {
				child.stderr.emit("data", Buffer.from("fixed child error"));
				child.emit("close", 7);
			});
			return child;
		});
		const result = await spawnReviewer(
			"fixed task",
			"fixed system prompt",
			PR_REVIEW_CONFIG,
			process.cwd(),
			undefined,
			createReviewDeadline(PR_REVIEW_CONFIG.timeoutMs),
			fakeSpawn as unknown as typeof spawn,
			base,
		);
		expect(result.report).toBeNull();
		expect(dirname(result.sidecarPath ?? "")).toBe(base);
		expect(
			JSON.parse(
				readFileSync(join(result.sidecarPath ?? "", "sidecar.json"), "utf8"),
			),
		).toMatchObject({ exitCode: 7, stderr: "fixed child error" });
	});

	it("carries the same owned destination through primary and fallback attempts", async () => {
		const base = fixture();
		const fakeSpawn = vi.fn<typeof spawnReviewer>(async () => ({
			report: null,
			rawOutput: "",
			exitCode: 0,
			timedOut: false,
			stderr: "",
			command: "(fixed fixture)",
		}));
		const execution = createReviewerExecution({
			getPromptsDir: () => "/fixed-unused-prompts",
			readSystemPrompt: () => "fixed system prompt",
			renderTaskTemplate: () => "fixed task",
			spawnReviewer: fakeSpawn,
			failureDirectory: base,
		});
		await execution.runAttempt({
			task: "fixed task",
			files: [],
			cwd: process.cwd(),
			diff: "fixed diff",
			config: { ...PR_REVIEW_CONFIG, fallbackModels: ["fixture/fallback"] },
		});
		expect(fakeSpawn).toHaveBeenCalledTimes(2);
		for (const args of fakeSpawn.mock.calls) expect(args[7]).toBe(base);
	});
});
