import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PR_REVIEW_CONFIG } from "../src/pr-gate/pr-review-config.js";
import { spawnReviewer } from "../src/pr-gate/reviewer.js";
import { createReviewDeadline } from "../src/shared/review-deadline.js";

const roots: string[] = [];
const report =
	"## Review Report\nSTATUS: PASS\nCONFIDENCE: HIGH\n### Findings\nNone.\n### Test execution\n- **Status:** PASS\n- **Summary:** fixed fixture\n### Summary\nfixed fixture";
function assistant(stopReason: string | undefined, text = report) {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			stopReason,
			content: [{ type: "text", text }],
		},
	});
}
const event = assistant("stop");
const failedReasons = ["error", "aborted", "length"];
const launch = {
	command: "/fixed-node-fixture",
	args: ["/fixed-sdk-worker-fixture.mjs"],
	environment: { FIXED_REVIEWER_ENV: "fixture-only" },
	assistantOutputOnly: true,
};
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "qg-sdk-launch-")));
	roots.push(root);
	const child = Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		pid: 12345,
		kill: vi.fn(() => true),
	});
	return { root, child };
}
function run(f: ReturnType<typeof fixture>, spawnProcess: () => unknown) {
	return spawnReviewer(
		"fixed task",
		"fixed system prompt",
		PR_REVIEW_CONFIG,
		process.cwd(),
		undefined,
		undefined,
		spawnProcess as unknown as typeof spawn,
		f.root,
		launch,
	);
}
afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("host SDK launch through the existing native supervisor", () => {
	async function complete(events: string[]) {
		const f = fixture();
		return run(f, () => {
			queueMicrotask(() => {
				f.child.stdout.emit("data", Buffer.from(`${events.join("\n")}\n`));
				f.child.emit("close", 0, null);
			});
			return f.child;
		});
	}

	for (const reason of [
		"error",
		"aborted",
		"length",
		"pending",
		"deferred",
		"unknown",
		"toolUse",
		undefined,
	]) {
		it(`refuses PASS with assistant outcome ${reason} even on exit zero`, async () => {
			const result = await complete([assistant(reason)]);
			expect(result.report).toBeNull();
		});
	}

	for (const reason of failedReasons) {
		it(`vetoes an earlier PASS after an empty ${reason} completion`, async () => {
			const result = await complete([event, assistant(reason, "")]);
			expect(result.report).toBeNull();
		});

		it(`keeps ${reason} failure sticky before a later clean PASS`, async () => {
			const result = await complete([assistant(reason, ""), event]);
			expect(result.report).toBeNull();
		});
	}

	it("does not parse an earlier PASS when the final completed answer has no report", async () => {
		const result = await complete([event, assistant("stop", "no report")]);
		expect(result.report).toBeNull();
	});

	it("requires a completed assistant answer, not just an empty clean child", async () => {
		const result = await complete([]);
		expect(result.report).toBeNull();
	});

	it("invalidates an earlier PASS on an unfinished later assistant response", async () => {
		const result = await complete([
			event,
			JSON.stringify({ type: "message_start", message: { role: "assistant" } }),
		]);
		expect(result.report).toBeNull();
	});

	it("parses only the last successful answer rather than concatenating completed reports", async () => {
		const result = await complete([event, event]);
		expect(result.report?.status).toBe("PASS");
	});

	it("allows successful tool continuation before the terminal answer", async () => {
		const result = await complete([assistant("toolUse", "checking"), event]);
		expect(result.report?.status).toBe("PASS");
	});

	it("typechecks the foundation without the later SDK launcher or worker modules", () => {
		const root = fileURLToPath(new URL("../", import.meta.url));
		const config = ts.readConfigFile(
			join(root, "tsconfig.json"),
			ts.sys.readFile,
		);
		expect(config.error).toBeUndefined();
		const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
		expect(parsed.errors).toEqual([]);
		const hidden = new Set([
			join(root, "src/pr-gate/reviewer-sdk-spawn.ts"),
			join(root, "src/pr-gate/reviewer-sdk-worker.mjs"),
		]);
		const host = ts.createCompilerHost(parsed.options);
		const { fileExists, readFile, getSourceFile } = host;
		host.fileExists = (file) => !hidden.has(file) && fileExists(file);
		host.readFile = (file) => (hidden.has(file) ? undefined : readFile(file));
		host.getSourceFile = (file, ...args) =>
			hidden.has(file) ? undefined : getSourceFile(file, ...args);
		const program = ts.createProgram(
			[
				"src/pr-gate/reviewer.ts",
				"src/pr-gate/reviewer-closed-session.ts",
				"test/reviewer-sdk-launch.test.ts",
				"test/reviewer-closed-session.test.ts",
			].map((file) => join(root, file)),
			parsed.options,
			host,
		);
		const errors = ts
			.getPreEmitDiagnostics(program)
			.map((diagnostic) =>
				ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
			);
		expect(errors).toEqual([]);
	}, 15_000);

	it("uses the fixed invocation/environment without a CLI or task argument", async () => {
		const f = fixture();
		const spawnProcess = vi.fn(() => {
			queueMicrotask(() => {
				f.child.stdout.emit("data", Buffer.from(`${event}\n`));
				f.child.emit("close", 0, null);
			});
			return f.child;
		});
		const result = await run(f, spawnProcess);
		expect(spawnProcess).toHaveBeenCalledWith(
			launch.command,
			launch.args,
			expect.objectContaining({ env: launch.environment, shell: false }),
		);
		expect(result.report?.status).toBe("PASS");
		expect(result.command).toContain(launch.command);
		expect(result.command).not.toContain("fixed task");
	});

	it("never promotes stderr into an SDK assistant report", async () => {
		const f = fixture();
		const spawnProcess = () => {
			queueMicrotask(() => {
				f.child.stderr.emit("data", Buffer.from(report));
				f.child.emit("close", 0, null);
			});
			return f.child;
		};
		const result = await run(f, spawnProcess);
		expect(result.report).toBeNull();
		expect(result.stderr).toBe(report);
	});

	it("refuses a flushed PASS when the process terminates by signal", async () => {
		const f = fixture();
		const spawnProcess = () => {
			queueMicrotask(() => {
				f.child.stdout.emit("data", Buffer.from(`${event}\n`));
				f.child.emit("close", null, "SIGTERM");
			});
			return f.child;
		};
		const result = await run(f, spawnProcess);
		expect(result.report).toBeNull();
		expect(result.exitCode).not.toBe(0);
	});

	it("bounds an unconfirmed termination and retains its owned prompt root", async () => {
		vi.useFakeTimers();
		const f = fixture();
		let spawned: (() => void) | undefined;
		const didSpawn = new Promise<void>((resolve) => {
			spawned = resolve;
		});
		const spawnProcess = () => {
			spawned?.();
			return f.child;
		};
		const pending = spawnReviewer(
			"fixed task",
			"fixed system prompt",
			{ ...PR_REVIEW_CONFIG, timeoutMs: 1000 },
			process.cwd(),
			undefined,
			createReviewDeadline(1000, () => 0),
			spawnProcess as unknown as typeof spawn,
			f.root,
			launch,
		);
		let result: Awaited<typeof pending> | undefined;
		void pending.then((value) => {
			result = value;
		});
		try {
			await didSpawn;
			await vi.advanceTimersByTimeAsync(11_000);
			expect(result).toMatchObject({
				report: null,
				terminationConfirmed: false,
				pid: 12345,
			});
			expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
			expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
			if (result?.sidecarPath) roots.push(result.sidecarPath);
		} finally {
			f.child.emit("close", 1, null);
			await pending;
		}
	});
});
