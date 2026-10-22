import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchReviewerColdProcess } from "../src/pr-gate/reviewer-startup-process.js";

function fixture() {
	const child = Object.assign(new EventEmitter(), {
		pid: 123,
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(() => true),
	});
	const receipt = new PassThrough();
	const isAccepted = vi.fn(() => true);
	const cleanup = vi.fn(async () => true);
	const checkReceipt = vi.fn(() => true);
	const deps = {
		child,
		receipt,
		deadline: Date.now() + 15_000,
		isAccepted,
		cleanup,
		checkReceipt,
	};
	return { ...deps, deps };
}

afterEach(() => vi.useRealTimers());

describe("parent-owned cold process supervision (no Pi imports)", () => {
	it("does not complete or clean up on a receipt or exit alone", async () => {
		const f = fixture();
		const finished = vi.fn();
		const pending = watchReviewerColdProcess(f.deps).then(finished);
		f.receipt.end('{"status":"startup-completed"}');
		f.child.emit("exit", 0, null);
		await Promise.resolve();
		expect(finished).not.toHaveBeenCalled();
		expect(f.cleanup).not.toHaveBeenCalled();
		f.child.emit("close", 0, null);
		await pending;
		expect(f.cleanup).toHaveBeenCalledOnce();
		expect(finished).toHaveBeenCalledWith({
			status: "cold-startup-completed",
			childExited: true,
			cleanup: "complete",
		});
	});

	it("kills a hung child at 15 seconds, then awaits confirmed close", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const done = vi.fn();
		const pending = watchReviewerColdProcess(f.deps).then(done);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(f.cleanup).not.toHaveBeenCalled();
		expect(done).not.toHaveBeenCalled();
		f.child.emit("close", null, "SIGKILL");
		await pending;
		expect(done).toHaveBeenCalledWith({
			status: "denied",
			reason: "timeout",
			childExited: true,
			cleanup: "complete",
		});
	});

	it.each(["stdout", "stderr", "receipt"])("caps %s bytes", async (name) => {
		const f = fixture();
		const pending = watchReviewerColdProcess(f.deps);
		const stream = name === "receipt" ? f.receipt : f.child[name as "stdout"];
		stream.write(Buffer.alloc(16_385));
		expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(f.cleanup).not.toHaveBeenCalled();
		f.child.emit("close", null, "SIGKILL");
		expect(await pending).toMatchObject({ status: "denied", reason: "output" });
	});

	it("kills on cancellation, with no early cleanup", async () => {
		const f = fixture();
		const controller = new AbortController();
		const pending = watchReviewerColdProcess({
			...f.deps,
			signal: controller.signal,
		});
		controller.abort();
		expect(f.child.kill).toHaveBeenCalledOnce();
		expect(f.cleanup).not.toHaveBeenCalled();
		f.child.emit("close", null, "SIGKILL");
		expect(await pending).toMatchObject({ reason: "cancelled" });
	});

	it("kills when admission is revoked during startup", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const pending = watchReviewerColdProcess(f.deps);
		f.isAccepted.mockReturnValue(false);
		await vi.advanceTimersByTimeAsync(25);
		expect(f.child.kill).toHaveBeenCalledOnce();
		f.child.emit("close", null, "SIGKILL");
		expect(await pending).toMatchObject({ reason: "authority" });
	});

	it("holds the root if termination cannot be confirmed", async () => {
		vi.useFakeTimers();
		const f = fixture();
		f.child.kill.mockReturnValue(false);
		const pending = watchReviewerColdProcess(f.deps);
		await vi.advanceTimersByTimeAsync(17_000);
		expect(await pending).toMatchObject({
			status: "denied",
			reason: "termination-unconfirmed",
			childExited: false,
			cleanup: "held",
			pid: 123,
		});
		expect(f.cleanup).not.toHaveBeenCalled();
		f.child.emit("close", null, "SIGKILL");
		await Promise.resolve();
		expect(f.cleanup).not.toHaveBeenCalled();
	});

	const badBodies = ["", "not-json", '{"status":"startup-completed"}'];
	it.each(badBodies)("refuses receipt %s", async (body) => {
		const f = fixture();
		f.checkReceipt.mockReturnValue(false);
		const pending = watchReviewerColdProcess(f.deps);
		f.receipt.end(body);
		f.child.emit("close", 0, null);
		expect(await pending).toMatchObject({ reason: "evidence" });
	});

	it("never cleans up twice on duplicate lifecycle events", async () => {
		const f = fixture();
		const pending = watchReviewerColdProcess(f.deps);
		f.child.emit("error", new Error("secret path"));
		f.child.emit("close", 1, null);
		f.child.emit("close", 1, null);
		expect(await pending).toMatchObject({ reason: "process" });
		expect(f.cleanup).toHaveBeenCalledOnce();
	});

	it("awaits cleanup and refuses cleanup failure", async () => {
		const f = fixture();
		let release: ((value: boolean) => void) | undefined;
		f.cleanup.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const done = vi.fn();
		const pending = watchReviewerColdProcess(f.deps).then(done);
		f.receipt.end("{}");
		f.child.emit("close", 0, null);
		await Promise.resolve();
		expect(done).not.toHaveBeenCalled();
		release?.(false);
		await pending;
		expect(done).toHaveBeenCalledWith({
			status: "denied",
			reason: "cleanup",
			childExited: true,
			cleanup: "held",
		});
	});
});
