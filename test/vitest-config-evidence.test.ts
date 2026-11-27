import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createVitestConfigGuard,
	type RequiredVitestCall,
} from "../src/pr-gate/reviewer-closed-session.js";

let required: RequiredVitestCall;
beforeEach(() => {
	const cwd = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "qg-receipt-")),
	);
	fs.mkdirSync(path.join(cwd, "test"));
	for (const file of [
		"vitest.legacy.config.ts",
		"test/legacy.test.ts",
		"test/other.test.ts",
	])
		fs.writeFileSync(path.join(cwd, file), "");
	required = {
		cwd,
		config: "vitest.legacy.config.ts",
		paths: ["test/legacy.test.ts"],
		timeoutMs: 60000,
	};
});
afterEach(() => fs.rmSync(required.cwd, { recursive: true, force: true }));

function evidence(call = required) {
	return {
		details: {
			toolName: "run_vitest",
			command:
				"vitest run --reporter=verbose --config vitest.legacy.config.ts test/legacy.test.ts --reporter=json --outputFile.json=/private/report.json",
			cwd: call.cwd,
			exitCode: 0,
			timedOut: false,
			aborted: false,
			spawnError: false,
			success: true,
			validation: { passed: true },
			requestedTimeoutMs: call.timeoutMs,
			effectiveTimeoutMs: call.timeoutMs,
			elapsedMs: 12,
			vitestCollection: {
				version: 1,
				source: "vitest-json-reporter",
				status: "complete",
				request: {
					cwd: call.cwd,
					config: call.config,
					paths: [...call.paths],
					testNamePattern: null,
				},
				files: [
					{ path: call.paths[0], passed: 1, failed: 0, skipped: 0, todo: 0 },
				],
				reportBytes: 512,
				reportSha256: "a".repeat(64),
			},
		},
	};
}
function tool(
	result: unknown = evidence(),
	configSchema: unknown = { type: "string" },
) {
	return {
		name: "run_vitest",
		parameters: { type: "object", properties: { config: configSchema } },
		execute: async (..._args: never[]) => result,
	};
}
async function execute(
	guard: ReturnType<typeof createVitestConfigGuard>,
	params = required,
) {
	return guard.tools[0].execute(...(["id", params] as never[]));
}
async function refused(result: unknown) {
	const guard = createVitestConfigGuard([tool(result)], [required]);
	await execute(guard);
	expect(() => guard.assertComplete()).toThrow(/NOT_RUN/);
}

describe("selected Vitest config execution evidence", () => {
	it("blocks unavailable or mismatched config capability before prompting", () => {
		expect(() => createVitestConfigGuard([], [required])).toThrow();
		for (const schema of [undefined, { type: "number" }, { anyOf: [] }]) {
			const runner = tool();
			runner.parameters.properties.config = schema;
			expect(() => createVitestConfigGuard([runner], [required])).toThrow();
		}
	});
	it("does not accept a model PASS or a call to the wrong config", async () => {
		const guard = createVitestConfigGuard([tool()], [required]);
		expect(() => guard.assertComplete()).toThrow(/NOT_RUN/);
		await execute(guard, { ...required, config: "different.ts" });
		expect(() => guard.assertComplete()).toThrow(/NOT_RUN/);
	});
	it("accepts same-run exact collection despite additional private reporter arguments", async () => {
		const guard = createVitestConfigGuard([tool()], [required]);
		await execute(guard);
		expect(() => guard.assertComplete()).not.toThrow();
	});
	it("rejects invocation-only success, even with the old matching command", async () => {
		const result = evidence();
		Reflect.deleteProperty(result.details, "vitestCollection");
		result.details.command = `vitest run --reporter=verbose --config ${required.config} ${required.paths[0]}`;
		await refused(result);
	});
	it.each([
		{ exitCode: 1 },
		{ timedOut: true },
		{ aborted: true },
		{ spawnError: true },
		{ success: false },
		{ validation: { passed: false } },
		{ cwd: "/another-workspace" },
		{ requestedTimeoutMs: 1000 },
		{ effectiveTimeoutMs: Number.POSITIVE_INFINITY },
		{ effectiveTimeoutMs: 60001 },
		{ elapsedMs: -1 },
	])("rejects incomplete execution %j", async (patch) => {
		const result = evidence();
		Object.assign(result.details, patch);
		await refused(result);
	});
	it.each([
		{ version: 2 },
		{ source: "stdout" },
		{ status: "empty" },
		{ status: "mismatch" },
		{ status: "missing" },
		{ status: "invalid" },
		{ status: "not-completed" },
		{ status: "failed" },
		{ status: "redacted" },
		{ status: "limit-exceeded" },
		{ files: [] },
		{ files: {} },
		{ reportBytes: 0 },
		{ reportBytes: 4 * 1024 * 1024 + 1 },
		{ reportBytes: 1.5 },
		{ reportSha256: "truncated" },
		{ reportSha256: undefined },
	])(
		"rejects missing, malformed or non-complete collection %j",
		async (patch) => {
			const result = evidence();
			Object.assign(result.details.vitestCollection, patch);
			await refused(result);
		},
	);
	it.each([
		{ cwd: "/elsewhere" },
		{ config: null },
		{ config: "other.ts" },
		{ paths: ["test/other.test.ts"] },
		{ paths: [] },
		{ testNamePattern: "subset" },
		{ testNamePattern: undefined },
	])("rejects request mismatch %j", async (patch) => {
		const result = evidence();
		Object.assign(result.details.vitestCollection.request, patch);
		await refused(result);
	});
	it.each([
		{ path: "test/other.test.ts" },
		{ path: "../outside.test.ts" },
		{ path: "/absolute.test.ts" },
		{ path: "test/../test/legacy.test.ts" },
		{ path: "test\\legacy.test.ts" },
		{ passed: 0 },
		{ passed: -1 },
		{ passed: 0.5 },
		{ passed: "1" },
		{ passed: 100001 },
		{ failed: 1 },
		{ skipped: undefined },
		{ todo: Number.NaN },
	])(
		"rejects wrong identities, empty collection and invalid counters %j",
		async (patch) => {
			const result = evidence();
			Object.assign(result.details.vitestCollection.files[0], patch);
			await refused(result);
		},
	);
	it("rejects a different file containing the requested path as a substring", async () => {
		const wrong = "test/legacy.test.ts.other.test.ts";
		fs.writeFileSync(path.join(required.cwd, wrong), "");
		const result = evidence();
		result.details.vitestCollection.files[0].path = wrong;
		await refused(result);
	});
	it("validates every collected file and bounded totals, not only the required one", async () => {
		for (const files of [
			Array(2049).fill(evidence().details.vitestCollection.files[0]),
			[
				evidence().details.vitestCollection.files[0],
				evidence().details.vitestCollection.files[0],
			],
			[
				evidence().details.vitestCollection.files[0],
				{
					path: "test/other.test.ts",
					passed: 1,
					failed: 1,
					skipped: 0,
					todo: 0,
				},
			],
			[
				{
					path: required.paths[0],
					passed: 100000,
					failed: 0,
					skipped: 1,
					todo: 0,
				},
			],
		]) {
			const result = evidence();
			result.details.vitestCollection.files = files;
			await refused(result);
		}
	});
	it("accepts collected skips and todos without requiring body execution", async () => {
		const result = evidence();
		Object.assign(result.details.vitestCollection.files[0], {
			passed: 0,
			skipped: 1,
			todo: 1,
		});
		const guard = createVitestConfigGuard([tool(result)], [required]);
		await execute(guard);
		expect(() => guard.assertComplete()).not.toThrow();
	});
	it("matches canonical contained aliases and filenames with spaces", async () => {
		fs.renameSync(
			path.join(required.cwd, required.paths[0]),
			path.join(required.cwd, "test/real file.test.ts"),
		);
		fs.symlinkSync(
			"real file.test.ts",
			path.join(required.cwd, required.paths[0]),
		);
		const result = evidence();
		result.details.vitestCollection.files[0].path = "test/real file.test.ts";
		const guard = createVitestConfigGuard([tool(result)], [required]);
		await execute(guard);
		expect(() => guard.assertComplete()).not.toThrow();
	});
	it("requires every independent call, and a failed rerun revokes its completion", async () => {
		const other = { ...required, paths: ["test/other.test.ts"] };
		let result = evidence();
		const runner = { ...tool(), execute: async () => result };
		const guard = createVitestConfigGuard([runner], [required, other]);
		await execute(guard);
		expect(() => guard.assertComplete()).toThrow(/NOT_RUN/);
		result = evidence(other);
		await execute(guard, other);
		expect(() => guard.assertComplete()).not.toThrow();
		result.details.success = false;
		await execute(guard, other);
		expect(() => guard.assertComplete()).toThrow(/NOT_RUN/);
	});
	it("does not let stale concurrent success replace a newer failed run", async () => {
		let finish!: (value: unknown) => void;
		let first = true;
		const runner = {
			...tool(),
			execute: async () => {
				if (first) {
					first = false;
					return new Promise((resolve) => {
						finish = resolve;
					});
				}
				return { details: { success: false } };
			},
		};
		const guard = createVitestConfigGuard([runner], [required]);
		const pending = execute(guard);
		await execute(guard);
		finish(evidence());
		await pending;
		expect(() => guard.assertComplete()).toThrow(/NOT_RUN/);
	});
	it("does not accept text-only results or inherit live permission from a plan", async () => {
		await refused({ content: [{ text: "PASS" }] });
		const guard = createVitestConfigGuard([tool()], [required]);
		await expect(
			guard.tools[0].execute(
				...([
					"id",
					{ ...required, env: { PI_APPLE_CONTAINER_LIVE: "1" } },
				] as never[]),
			),
		).rejects.toThrow();
	});
	it("rejects malformed required calls and missing or escaping physical files", () => {
		expect(() => createVitestConfigGuard([tool()], {} as never)).toThrow();
		for (const call of [
			{ ...required, paths: ["../outside.test.ts"] },
			{ ...required, paths: ["test/missing.test.ts"] },
			{ ...required, config: "../config.ts" },
		])
			expect(() => createVitestConfigGuard([tool()], [call])).toThrow();
		fs.unlinkSync(path.join(required.cwd, required.paths[0]));
		fs.symlinkSync(
			import.meta.filename,
			path.join(required.cwd, required.paths[0]),
		);
		expect(() => createVitestConfigGuard([tool()], [required])).toThrow();
	});
	it("keeps old no-config sessions unchanged", () => {
		const tools = [tool()];
		const guard = createVitestConfigGuard(tools, []);
		expect(guard.tools).toBe(tools);
		expect(() => guard.assertComplete()).not.toThrow();
	});
});
