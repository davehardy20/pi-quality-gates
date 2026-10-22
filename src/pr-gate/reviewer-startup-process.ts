import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

export const COLD_CANARY_TIMEOUT_MS = 15_000;
export const COLD_CANARY_STREAM_BYTES = 16_384;
export const COLD_CANARY_EXIT_WAIT_MS = 2_000;

export interface ColdCanaryChild extends Pick<EventEmitter, "on" | "off"> {
	pid?: number;
	stdout: Readable;
	stderr: Readable;
	kill(signal: "SIGKILL"): boolean;
}

export interface ColdCanaryWatch {
	child: ColdCanaryChild;
	receipt: Readable;
	deadline: number;
	isAccepted(): boolean;
	/** Trusted owned-root release; called only after confirmed close. */
	cleanup(): Promise<boolean>;
	/** Validates actual loader evidence against the accepted manifest. */
	checkReceipt(input: unknown): boolean;
	signal?: AbortSignal;
}

export type ColdCanaryDenial =
	| "invalid"
	| "authority"
	| "cancelled"
	| "timeout"
	| "output"
	| "process"
	| "evidence"
	| "cleanup"
	| "termination-unconfirmed";

export type ColdCanaryProcessResult =
	| {
			status: "cold-startup-completed";
			childExited: true;
			cleanup: "complete";
	  }
	| {
			status: "denied";
			reason: ColdCanaryDenial;
			childExited: boolean;
			cleanup: "complete" | "held";
			pid?: number;
			/** Diagnostic only; never trusted as acceptance evidence. */
			selfReportedStage?: string;
	  };

/** Supervision is not startup acceptance, integration or review PASS authority. */
export function watchReviewerColdProcess(
	deps: ColdCanaryWatch,
): Promise<ColdCanaryProcessResult> {
	return new Promise((resolve) => {
		let settled = false;
		let closed = false;
		let reason: ColdCanaryDenial | undefined;
		let selfReportedStage: string | undefined;
		let previousNow = Date.now();
		const deadline = Math.min(
			deps.deadline,
			previousNow + COLD_CANARY_TIMEOUT_MS,
		);
		const body: Buffer[] = [];
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		let authorityTimer: ReturnType<typeof setInterval> | undefined;
		let exitTimer: ReturnType<typeof setTimeout> | undefined;
		const clearTimers = () => {
			clearTimeout(deadlineTimer);
			clearInterval(authorityTimer);
			clearTimeout(exitTimer);
		};
		const finish = (result: ColdCanaryProcessResult) => {
			if (settled) return;
			settled = true;
			clearTimers();
			deps.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const stop = (denial: ColdCanaryDenial) => {
			if (reason || closed || settled) return;
			reason = denial;
			clearTimers();
			try {
				deps.child.kill("SIGKILL");
			} catch {
				// A failed signal is never evidence of termination.
			}
			if (closed || settled) return;
			exitTimer = setTimeout(() => {
				const pid = deps.child.pid;
				finish({
					status: "denied",
					reason: "termination-unconfirmed",
					childExited: false,
					cleanup: "held",
					...(Number.isSafeInteger(pid) && Number(pid) > 0 ? { pid } : {}),
				});
			}, COLD_CANARY_EXIT_WAIT_MS);
		};
		const gate = (): ColdCanaryDenial | undefined => {
			if (deps.signal?.aborted) return "cancelled";
			const now = Date.now();
			if (now < previousNow || now >= deadline) return "timeout";
			previousNow = now;
			try {
				if (deps.isAccepted() !== true) return "authority";
			} catch {
				return "authority";
			}
			const after = Date.now();
			if (after < previousNow || after >= deadline) return "timeout";
			previousNow = after;
			return deps.signal?.aborted ? "cancelled" : undefined;
		};
		const streams = [deps.child.stdout, deps.child.stderr, deps.receipt];
		const handlers = streams.map((stream, index) => {
			let bytes = 0;
			const onData = (chunk: Buffer | string) => {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				bytes = Math.min(
					COLD_CANARY_STREAM_BYTES + 1,
					bytes + buffer.byteLength,
				);
				if (bytes > COLD_CANARY_STREAM_BYTES) {
					stop("output");
				} else if (index === 2 && !settled && !closed) {
					body.push(Buffer.from(buffer));
				}
			};
			const onError = () => stop("process");
			stream.on("data", onData);
			stream.on("error", onError);
			return { stream, onData, onError };
		});
		const onAbort = () => stop("cancelled");
		deps.child.on("error", () => stop("process"));
		const onClose = async (code: number | null, signal: string | null) => {
			if (closed) return;
			closed = true;
			clearTimers();
			for (const { stream, onData } of handlers) stream.off("data", onData);
			if (settled) return; // Late close never triggers deferred deletion.
			if (!reason && (code !== 0 || signal !== null)) reason = "process";
			if (reason === "process") {
				try {
					const data = JSON.parse(Buffer.concat(body).toString("utf8"));
					const stages = ["policy", "bootstrap", "sdk", "startup", "receipt"];
					if (
						data?.status === "denied" &&
						stages.includes(data.stage) &&
						Object.keys(data).sort().join(",") === "stage,status"
					) {
						selfReportedStage = data.stage;
					}
				} catch {
					// Only the closed stage vocabulary may escape the child.
				}
			}
			if (!reason) reason = gate();
			if (!reason) {
				try {
					const input: unknown = JSON.parse(
						Buffer.concat(body).toString("utf8"),
					);
					if (
						input === null ||
						typeof input !== "object" ||
						!("status" in input) ||
						input.status !== "startup-completed" ||
						deps.checkReceipt(input) !== true
					) {
						reason = "evidence";
					}
				} catch {
					reason = "evidence";
				}
			}
			let cleaned = false;
			try {
				cleaned = (await deps.cleanup()) === true;
			} catch {
				// No error text from the process or filesystem escapes.
			}
			if (!cleaned) reason = "cleanup";
			if (!reason) reason = gate();
			finish(
				reason
					? {
							status: "denied",
							reason,
							childExited: true,
							cleanup: cleaned ? "complete" : "held",
							...(selfReportedStage ? { selfReportedStage } : {}),
						}
					: {
							status: "cold-startup-completed",
							childExited: true,
							cleanup: "complete",
						},
			);
		};
		deps.child.on("close", onClose);
		deps.signal?.addEventListener("abort", onAbort, { once: true });
		deadlineTimer = setTimeout(
			() => stop("timeout"),
			Math.max(0, deadline - Date.now()),
		);
		authorityTimer = setInterval(() => {
			const denial = gate();
			if (denial) stop(denial);
		}, 25);
		const initial = Number.isSafeInteger(deps.deadline) ? gate() : "invalid";
		if (initial) stop(initial);
	});
}
