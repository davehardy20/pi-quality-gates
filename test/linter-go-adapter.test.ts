import { describe, expect, it } from "vitest";
import {
	createGoAdapter,
	type GoAdapterDependencies,
} from "../src/linter/adapters/go.js";
import type { LinterAdapter } from "../src/linter/adapters/types.js";
import {
	DEFAULT_CONFIG,
	getLinterForFile,
} from "../src/linter/config-loader.js";
import type {
	CliLinterDefinition,
	ValidationOutcome,
} from "../src/linter/types.js";

function outcome(
	kind: ValidationOutcome["kind"],
	report = "",
	affectedFiles: string[] = [],
): ValidationOutcome {
	return { kind, report, affectedFiles, signature: report || kind };
}

function fakeDependencies(
	results: Record<string, ValidationOutcome>,
	seen: CliLinterDefinition[],
): GoAdapterDependencies {
	return {
		createCliAdapter: ({ linter }): LinterAdapter => {
			seen.push(linter);
			return {
				name: linter.name,
				key: `fake:${linter.name}`,
				run: async () => results[linter.name] ?? outcome("clean"),
			};
		},
	};
}

describe("Go linter adapter", () => {
	it("is selected for Go files by default", () => {
		expect(getLinterForFile("/repo/main.go", DEFAULT_CONFIG)).toEqual({
			type: "api",
			name: "go",
		});
	});

	it("runs gofmt and go vet with module-aware definitions", async () => {
		const seen: CliLinterDefinition[] = [];
		const adapter = createGoAdapter(
			{ timeoutMs: 12_345 },
			fakeDependencies({}, seen),
		);

		const result = await adapter.run(["/repo/main.go"], "/repo");

		expect(result.kind).toBe("clean");
		expect(seen).toEqual([
			{
				type: "cli",
				command: "gofmt",
				args: ["-l"],
				name: "gofmt",
			},
			{
				type: "cli",
				command: "go",
				args: ["vet", "./..."],
				name: "go vet",
				mode: "project-root",
				rootMarker: "go.mod",
			},
		]);
	});

	it("combines formatting and semantic findings", async () => {
		const filePath = "/repo/main.go";
		const seen: CliLinterDefinition[] = [];
		const adapter = createGoAdapter(
			{},
			fakeDependencies(
				{
					gofmt: outcome(
						"findings",
						`--- gofmt (1 file) ---\n${filePath}:1:1 [warning] GOFMT file is not gofmt-formatted`,
						[filePath],
					),
					"go vet": outcome(
						"findings",
						`--- go vet (1 file) ---\n${filePath}:2:3 undefined: missing`,
						[filePath],
					),
				},
				seen,
			),
		);

		const result = await adapter.run([filePath], "/repo");

		expect(result.kind).toBe("findings");
		expect(result.affectedFiles).toEqual([filePath]);
		expect(result.report).toContain("GOFMT");
		expect(result.report).toContain("undefined: missing");
	});

	it("preserves tool errors beside actionable findings", async () => {
		const filePath = "/repo/main.go";
		const seen: CliLinterDefinition[] = [];
		const adapter = createGoAdapter(
			{},
			fakeDependencies(
				{
					gofmt: outcome(
						"findings",
						`${filePath}:1:1 [warning] GOFMT file is not gofmt-formatted`,
						[filePath],
					),
					"go vet": outcome("tool-error", "Error running go: not found"),
				},
				seen,
			),
		);

		const result = await adapter.run([filePath], "/repo");

		expect(result.kind).toBe("findings");
		expect(result.report).toContain("GOFMT");
		expect(result.report).toContain("Error running go: not found");
	});
});
