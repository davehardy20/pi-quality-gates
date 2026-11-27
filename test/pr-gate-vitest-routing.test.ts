import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	formatTestExecutionPlan,
	recommendTestCommands,
} from "../src/pr-gate/test-execution.js";
import { parseReviewValidationPolicy } from "../src/shared/review-validation-policy.js";

const roots: string[] = [];
const files = [
	"test/active.test.ts",
	"test/apple-container-sidecar-pool-subnet-lease.test.ts",
	"test/apple-container-sidecar-pool-state-store.test.ts",
	"test/gondolin-tool-delegation.live.test.ts",
];
const configs = [
	"vitest.apple-legacy.config.ts",
	"vitest.gondolin-live.config.ts",
];
function put(root: string, file: string, content = ""): void {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), content);
}
function fixture() {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "qg-routing-")),
	);
	roots.push(root);
	put(
		root,
		"package.json",
		JSON.stringify({
			devDependencies: { vitest: "4" },
			scripts: {
				test: "vitest run",
				"test:legacy": `vitest run --config ${configs[0]}`,
				"test:live": `PI_GONDOLIN_TOOL_DELEGATION_LIVE=1 vitest run --config ${configs[1]}`,
			},
		}),
	);
	for (const file of [...files, ...configs, "tsconfig.json"]) put(root, file);
	return root;
}
function declaration() {
	return {
		version: 1,
		routes: [
			{ files: [files[0]], config: null },
			{ files: files.slice(1, 3), config: configs[0] },
			{ files: [files[3]], config: configs[1] },
		],
	};
}
function route(root: string, value: unknown = declaration()) {
	put(root, ".pi/vitest-routing.json", JSON.stringify(value));
}
function plan(root: string, changed = files) {
	return recommendTestCommands(changed, root, parseReviewValidationPolicy({}));
}
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

function testsFor(root: string) {
	return plan(root).runnerCommands.filter((call) => call.scope === "targeted");
}
function blocked(root: string) {
	return plan(root).runnerCommands.some((call) => call.blockedReason);
}

describe("explicit Vitest ownership", () => {
	it("routes the same-package multi-config root without dropping required tests", () => {
		const root = fixture();
		route(root);
		const result = plan(root);
		const tests = testsFor(root);
		expect(tests.map((call) => call.args)).toEqual(files.map((file) => [file]));
		expect(tests.map((call) => call.config)).toEqual([
			undefined,
			configs[0],
			configs[0],
			configs[1],
		]);
		expect(tests.every((call) => !call.blockedReason)).toBe(true);
		const rendered = formatTestExecutionPlan(result);
		expect(rendered).toContain(`"config":"${configs[0]}"`);
		expect(rendered).toContain(`"config":"${configs[1]}"`);
		expect(rendered).not.toContain('"env"');
		expect(rendered).not.toContain("PI_GONDOLIN_TOOL_DELEGATION_LIVE=1");
		expect(result.runnerCommands.map((call) => call.tool)).toEqual([
			"run_vitest",
			"run_vitest",
			"run_vitest",
			"run_vitest",
			"run_typecheck",
			"run_biome",
		]);
	});
	it("requires declarations for explicit config scripts, never guesses from them", () => {
		const root = fixture();
		expect(testsFor(root)).toHaveLength(4);
		expect(testsFor(root).every((call) => call.blockedReason)).toBe(true);
		expect(formatTestExecutionPlan(plan(root))).toContain("NOT_RUN");
	});
	it("retains no-declaration default-only projects", () => {
		const root = fixture();
		put(
			root,
			"package.json",
			JSON.stringify({
				devDependencies: { vitest: "4" },
				scripts: {
					test: "vitest run && eslint --config lint.json .",
					lint: "eslint --config lint.json .",
				},
			}),
		);
		expect(
			plan(root).runnerCommands.every(
				(call) => !call.blockedReason && !call.config,
			),
		).toBe(true);
	});
	it.each([
		[
			"missing ownership",
			{ version: 1, routes: [{ files: [files[0]], config: null }] },
		],
		[
			"overlap",
			{
				version: 1,
				routes: [
					...declaration().routes,
					{ files: [files[1]], config: configs[1] },
				],
			},
		],
		["unsupported version", { ...declaration(), version: 2 }],
		[
			"unknown key",
			{ ...declaration(), env: { PI_GONDOLIN_TOOL_DELEGATION_LIVE: "1" } },
		],
		[
			"missing config",
			{ version: 1, routes: [{ files, config: "missing.ts" }] },
		],
		[
			"unknown file",
			{
				version: 1,
				routes: [{ files: ["test/unknown.test.ts"], config: null }],
			},
		],
		[
			"absolute config",
			{ version: 1, routes: [{ files, config: "/etc/passwd" }] },
		],
		[
			"traversal",
			{ version: 1, routes: [{ files, config: "a/../vitest.config.ts" }] },
		],
		[
			"glob",
			{ version: 1, routes: [{ files: ["test/*.test.ts"], config: null }] },
		],
		["invalid schema", { version: 1, routes: "bad" }],
	])("blocks %s without losing obligations", (_name, value) => {
		const root = fixture();
		route(root, value);
		expect(testsFor(root).map((call) => call.args)).toEqual(
			files.map((file) => [file]),
		);
		expect(blocked(root)).toBe(true);
	});
	it("blocks malformed and oversized metadata safely", () => {
		const root = fixture();
		for (const value of ['{"secret fixture":', " ".repeat(65537)]) {
			put(root, ".pi/vitest-routing.json", value);
			expect(blocked(root)).toBe(true);
			expect(formatTestExecutionPlan(plan(root))).not.toContain(
				"secret fixture",
			);
		}
	});
	it("rejects duplicate JSON keys, including escaped duplicates", () => {
		const root = fixture();
		for (const key of ['"version"', '"\\u0076ersion"']) {
			put(
				root,
				".pi/vitest-routing.json",
				JSON.stringify(declaration()).replace(
					'"version":1',
					`"version":2,${key}:1`,
				),
			);
			expect(blocked(root)).toBe(true);
		}
	});
	it("blocks malformed metadata even without changed test entries", () => {
		const root = fixture();
		put(root, ".pi/vitest-routing.json", "invalid");
		expect(plan(root, ["tsconfig.json"]).blockedReason).toContain("NOT_RUN");
	});
	it("rejects hardlinked test ownership aliases", () => {
		const root = fixture();
		fs.linkSync(
			path.join(root, files[0]),
			path.join(root, "test/alias.test.ts"),
		);
		route(root, {
			version: 1,
			routes: [
				...declaration().routes,
				{ files: ["test/alias.test.ts"], config: configs[1] },
			],
		});
		expect(blocked(root)).toBe(true);
	});
	it("rejects metadata and config symlink escapes and physical overlaps", () => {
		const root = fixture();
		const outside = fixture();
		route(outside);
		fs.mkdirSync(path.join(root, ".pi"));
		fs.symlinkSync(
			path.join(outside, ".pi/vitest-routing.json"),
			path.join(root, ".pi/vitest-routing.json"),
		);
		expect(blocked(root)).toBe(true);
		fs.unlinkSync(path.join(root, ".pi/vitest-routing.json"));
		fs.symlinkSync(
			path.join(outside, configs[0]),
			path.join(root, "escape.ts"),
		);
		route(root, { version: 1, routes: [{ files, config: "escape.ts" }] });
		expect(blocked(root)).toBe(true);
		fs.symlinkSync(
			path.join(root, files[0]),
			path.join(root, "test/alias.test.ts"),
		);
		route(root, {
			version: 1,
			routes: [
				...declaration().routes,
				{ files: ["test/alias.test.ts"], config: configs[1] },
			],
		});
		expect(blocked(root)).toBe(true);
	});
	it("keeps package-local config paths and rejects cross-package ownership", () => {
		const root = fixture();
		put(root, "package.json", '{"workspaces":["packages/*"]}');
		put(root, "packages/a/package.json", '{"devDependencies":{"vitest":"4"}}');
		put(root, "packages/a/test/a.test.ts");
		put(root, "packages/a/config.ts");
		const changed = ["packages/a/test/a.test.ts"];
		route(root, {
			version: 1,
			routes: [{ files: changed, config: "packages/a/config.ts" }],
		});
		expect(plan(root, changed).runnerCommands[0]).toMatchObject({
			cwd: path.join(root, "packages/a"),
			args: ["test/a.test.ts"],
			config: "config.ts",
		});
		route(root, {
			version: 1,
			routes: [{ files: changed, config: configs[0] }],
		});
		expect(plan(root, changed).runnerCommands[0].blockedReason).toBeTruthy();
	});
});
