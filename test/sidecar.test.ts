import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	defaultReportSidecarDir,
	deriveSessionId,
	type LinterReportSidecarMetadata,
	parseReportRecoveryArgs,
	type ReviewerReportSidecarMetadata,
	recoverReportSidecar,
	redactSecrets,
	writeReportSidecar,
} from "../src/shared/report-sidecar.js";

describe("shared report sidecar", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(`${tmpdir()}/pi-quality-gates-sidecar-`);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("redacts common secret patterns", () => {
		const apiKey = `apiKey: ${"s".repeat(20)}`;
		expect(redactSecrets(apiKey)).toContain("[REDACTED]");

		const bearer = `Authorization: Bearer ${"a".repeat(12)}`;
		expect(redactSecrets(bearer)).toBe("Authorization: Bearer [REDACTED]");

		const awsKey = `AWS ${"AKIA"}${"A".repeat(16)}`;
		expect(redactSecrets(awsKey)).toContain("[REDACTED_AWS_ACCESS_KEY]");

		const jwt = `jwt: ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
		expect(redactSecrets(jwt)).toContain("[REDACTED_JWT]");
	});

	it("writes a redacted sidecar with complete metadata", async () => {
		const sensitiveValue = "x".repeat(12);
		const report = `findings\npassword: ${sensitiveValue}`;
		const result = await writeReportSidecar<LinterReportSidecarMetadata>({
			report,
			toolName: "post-turn-linter",
			summaryMode: "post-turn-linter-summary",
			sessionId: "test-session",
			sidecarDir: tempDir,
			now: new Date("2026-06-15T00:00:00.000Z"),
		});

		expect(result.ok).toBe(true);
		expect(result.metadata.toolName).toBe("post-turn-linter");
		expect(result.metadata.summaryMode).toBe("post-turn-linter-summary");
		expect(result.metadata.sessionId).toBe("test-session");
		expect(result.metadata.originalChars).toBe(report.length);
		expect(result.metadata.originalBytes).toBeGreaterThan(0);
		expect(result.metadata.redactedChars).toBeLessThanOrEqual(
			result.metadata.originalChars,
		);
		expect(result.metadata.originalSha256).not.toBe("");
		expect(result.metadata.redactedSha256).not.toBe("");
		expect(result.metadata.path).toContain(tempDir);

		const persisted = JSON.parse(fs.readFileSync(result.metadata.path, "utf8"));
		expect(persisted.content).toContain("[REDACTED]");
		expect(persisted.content).not.toContain(sensitiveValue);
		expect(persisted.metadata.id).toBe(result.metadata.id);
	});

	it("supports reviewer metadata shape via the same core", async () => {
		const result = await writeReportSidecar<ReviewerReportSidecarMetadata>({
			report: "reviewer transcript",
			toolName: "post-turn-reviewer",
			summaryMode: "post-turn-reviewer-summary",
			sessionId: "review-session",
			sidecarDir: tempDir,
			now: new Date("2026-06-15T00:00:00.000Z"),
		});

		expect(result.ok).toBe(true);
		expect(result.metadata.toolName).toBe("post-turn-reviewer");
		expect(result.metadata.summaryMode).toBe("post-turn-reviewer-summary");
	});

	it("recovers metadata mode", async () => {
		const result = await writeReportSidecar<LinterReportSidecarMetadata>({
			report: "report body",
			toolName: "post-turn-linter",
			summaryMode: "post-turn-linter-summary",
			sessionId: "test-session",
			sidecarDir: tempDir,
		});

		const recovered = await recoverReportSidecar<LinterReportSidecarMetadata>({
			recordPath: result.metadata.path,
			mode: "metadata",
		});

		expect(recovered.mode).toBe("metadata");
		expect(recovered.content).toContain(result.metadata.id);
		expect(recovered.metadata.id).toBe(result.metadata.id);
	});

	it("recovers preview with truncation hint", async () => {
		const report = "a".repeat(10_000);
		const result = await writeReportSidecar<LinterReportSidecarMetadata>({
			report,
			toolName: "post-turn-linter",
			summaryMode: "post-turn-linter-summary",
			sessionId: "test-session",
			sidecarDir: tempDir,
		});

		const recovered = await recoverReportSidecar<LinterReportSidecarMetadata>({
			recordPath: result.metadata.path,
			mode: "preview",
			previewChars: 80,
		});

		expect(recovered.mode).toBe("preview");
		expect(recovered.content.length).toBeLessThan(report.length);
		expect(recovered.content).toContain("[preview truncated");
	});

	it("recovers a bounded slice", async () => {
		const report = "0123456789";
		const result = await writeReportSidecar<LinterReportSidecarMetadata>({
			report,
			toolName: "post-turn-linter",
			summaryMode: "post-turn-linter-summary",
			sessionId: "test-session",
			sidecarDir: tempDir,
		});

		const recovered = await recoverReportSidecar<LinterReportSidecarMetadata>({
			recordPath: result.metadata.path,
			mode: "slice",
			offset: 2,
			length: 4,
		});

		expect(recovered.mode).toBe("slice");
		expect(recovered.content).toContain("2345");
		expect(recovered.content).toContain("offset=2");
	});

	it("requires acknowledgement for full recovery", async () => {
		const result = await writeReportSidecar<LinterReportSidecarMetadata>({
			report: "secret report",
			toolName: "post-turn-linter",
			summaryMode: "post-turn-linter-summary",
			sessionId: "test-session",
			sidecarDir: tempDir,
		});

		await expect(
			recoverReportSidecar<LinterReportSidecarMetadata>({
				recordPath: result.metadata.path,
				mode: "full",
			}),
		).rejects.toThrow(/requires --ack-context-cost/);

		const allowed = await recoverReportSidecar<LinterReportSidecarMetadata>({
			recordPath: result.metadata.path,
			mode: "full",
			allowFullWithoutAck: true,
		});
		expect(allowed.mode).toBe("full");

		const acked = await recoverReportSidecar<LinterReportSidecarMetadata>({
			recordPath: result.metadata.path,
			mode: "full",
			acknowledgeContextCost: true,
		});
		expect(acked.mode).toBe("full");
	});

	it("derives session id from session file path", () => {
		expect(
			deriveSessionId({
				sessionManager: { getSessionFile: () => "/tmp/sessions/foo.jsonl" },
			}),
		).toBe("foo");
		expect(
			deriveSessionId({
				sessionManager: { getSessionFile: () => undefined },
			}),
		).toBe("default-session");
	});

	it("parses recovery args with defaults and flags", () => {
		expect(parseReportRecoveryArgs(undefined)).toEqual({
			mode: "preview",
			acknowledgeContextCost: false,
			offset: 0,
			length: 4000,
		});

		expect(
			parseReportRecoveryArgs(
				"full --ack-context-cost --offset=10 --length=100",
			),
		).toEqual({
			mode: "full",
			acknowledgeContextCost: true,
			offset: 10,
			length: 100,
		});
	});

	it("respects the configured sidecar directory", () => {
		const original = process.env.PI_QUALITY_GATES_SIDECAR_DIR;
		process.env.PI_QUALITY_GATES_SIDECAR_DIR = tempDir;
		try {
			expect(defaultReportSidecarDir()).toBe(tempDir);
		} finally {
			if (original === undefined) {
				delete process.env.PI_QUALITY_GATES_SIDECAR_DIR;
			} else {
				process.env.PI_QUALITY_GATES_SIDECAR_DIR = original;
			}
		}
	});
});
