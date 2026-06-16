import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	formatContainerValidationEvidence,
	runContainerValidationEvidence,
} from "../src/pr-gate/container-validation.js";

describe("formatContainerValidationEvidence", () => {
	it("summarizes passing and failing container commands", () => {
		const evidence = formatContainerValidationEvidence({
			image: "test-image:latest",
			results: [
				{
					name: "typecheck",
					command: "tsc --noEmit",
					exitCode: 0,
					timedOut: false,
					stdout: "ok",
					stderr: "",
				},
				{
					name: "vitest",
					command: "vitest run",
					exitCode: 1,
					timedOut: false,
					stdout: "",
					stderr: "missing native dependency",
				},
			],
		});

		expect(evidence).toContain("**Apple container image:** test-image:latest");
		expect(evidence).toContain("Overall status:** FAILED");
		expect(evidence).toContain("typecheck: PASS");
		expect(evidence).toContain("vitest: FAIL");
		expect(evidence).toContain("missing native dependency");
	});
});

describe("runContainerValidationEvidence", () => {
	it("skips unsupported ecosystems without launching a container", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-qg-unknown-"));
		await writeFile(join(cwd, "README.md"), "# test\n");

		const evidence = await runContainerValidationEvidence([], cwd, {
			containerCommand: "definitely-not-container",
		});

		expect(evidence).toContain("unsupported ecosystem unknown");
	});
});
