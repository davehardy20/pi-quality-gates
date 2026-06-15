/**
 * Shared report sidecar storage.
 *
 * Owns the redaction, persistence, and recovery contract used by both the
 * post-turn-linter and the post-turn-reviewer. Tool-specific modules supply
 * their own metadata literals and summary formatting.
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields common to every persisted sidecar record. */
export interface ReportSidecarMetadata {
	id: string;
	toolName: string;
	sessionId: string;
	path: string;
	createdAt: string;
	originalChars: number;
	originalBytes: number;
	redactedChars: number;
	redactedBytes: number;
	originalSha256: string;
	redactedSha256: string;
	summaryMode: string;
	failureState?: string;
}

/** Linter sidecar metadata discriminant. */
export interface LinterReportSidecarMetadata extends ReportSidecarMetadata {
	toolName: "post-turn-linter";
	summaryMode: "post-turn-linter-summary";
}

/** Reviewer sidecar metadata discriminant. */
export interface ReviewerReportSidecarMetadata extends ReportSidecarMetadata {
	toolName: "post-turn-reviewer";
	summaryMode: "post-turn-reviewer-summary";
}

export type ReportRecoveryMode = "metadata" | "preview" | "slice" | "full";

export interface WriteReportSidecarOptions<
	M extends ReportSidecarMetadata = ReportSidecarMetadata,
> {
	report: string;
	toolName: M["toolName"];
	summaryMode: M["summaryMode"];
	sessionId?: string;
	sidecarDir?: string;
	now?: Date;
}

export interface WriteReportSidecarResult<
	M extends ReportSidecarMetadata = ReportSidecarMetadata,
> {
	ok: boolean;
	metadata: M;
	error?: string;
}

export interface RecoverReportSidecarOptions {
	recordPath: string;
	mode: ReportRecoveryMode;
	acknowledgeContextCost?: boolean;
	allowFullWithoutAck?: boolean;
	offset?: number;
	length?: number;
	previewChars?: number;
	/** Label used in slice/preview output, e.g. "linter" or "reviewer". */
	reportLabel?: string;
	/** Command name used in recovery hints, e.g. "/post-turn-linter-report". */
	commandName?: string;
}

export interface RecoverReportSidecarResult<
	M extends ReportSidecarMetadata = ReportSidecarMetadata,
> {
	mode: ReportRecoveryMode;
	content: string;
	metadata: M;
}

export interface ParsedReportRecoveryArgs {
	mode: ReportRecoveryMode;
	acknowledgeContextCost: boolean;
	offset: number;
	length: number;
}

interface PersistedReportSidecar<
	M extends ReportSidecarMetadata = ReportSidecarMetadata,
> {
	metadata: M;
	content: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PREVIEW_CHARS = 2000;
const DEFAULT_SLICE_CHARS = 4000;
const MAX_SINGLE_SIDECAR_BYTES = 10 * 1024 * 1024;
const ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE_CHAR}\\[[0-9;]*m`, "g");

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function defaultReportSidecarDir(): string {
	const configured = process.env.PI_QUALITY_GATES_SIDECAR_DIR?.trim();
	return configured && configured.length > 0
		? expandHome(configured)
		: join(homedir(), ".pi", "agent", "tool-output");
}

export function deriveSessionId(ctx: {
	sessionManager?: { getSessionFile?: () => string | null | undefined };
}): string {
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	if (!sessionFile) return "default-session";
	return basename(sessionFile).replace(/\.(jsonl|json)$/i, "");
}

export function redactSecrets(input: string): string {
	let output = input;
	output = output.replace(
		/(["']?\b(?:api[_-]?key|apiKey|token|secret|password|authorization)\b["']?\s*[:=]\s*)["']?[^\s"',}]{8,}["']?/gi,
		(_match, prefix: string) => `${normalizeSecretPrefix(prefix)}[REDACTED]`,
	);
	output = output.replace(
		/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g,
		"Bearer [REDACTED]",
	);
	output = output.replace(
		/\b(AWS|AKIA|ASIA)[A-Z0-9]{16}\b/g,
		"[REDACTED_AWS_ACCESS_KEY]",
	);
	output = output.replace(
		/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
		"[REDACTED_JWT]",
	);
	return output;
}

export function parseReportRecoveryArgs(
	args: string | undefined,
): ParsedReportRecoveryArgs {
	const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
	const modeToken = tokens.find((token) =>
		["metadata", "preview", "slice", "full"].includes(token),
	) as ReportRecoveryMode | undefined;
	const mode = modeToken ?? "preview";
	const acknowledgeContextCost = tokens.includes("--ack-context-cost");
	const offset = parseNumberFlag(tokens, "--offset", 0);
	const length = parseNumberFlag(tokens, "--length", DEFAULT_SLICE_CHARS);
	return { mode, acknowledgeContextCost, offset, length };
}

export async function writeReportSidecar<
	M extends ReportSidecarMetadata = ReportSidecarMetadata,
>(options: WriteReportSidecarOptions<M>): Promise<WriteReportSidecarResult<M>> {
	const now = options.now ?? new Date();
	const id = randomUUID();
	const sessionId = sanitizePathPart(options.sessionId ?? "default-session");
	const root = resolve(options.sidecarDir ?? defaultReportSidecarDir());
	const dir = join(root, sessionId);
	const filePath = join(dir, `${id}.json`);
	const redacted = redactSecrets(options.report);

	const metadata = {
		id,
		toolName: options.toolName,
		sessionId,
		path: filePath,
		createdAt: now.toISOString(),
		originalChars: options.report.length,
		originalBytes: byteLength(options.report),
		redactedChars: redacted.length,
		redactedBytes: byteLength(redacted),
		originalSha256: sha256(options.report),
		redactedSha256: sha256(redacted),
		summaryMode: options.summaryMode,
	} as M;

	if (metadata.redactedBytes > MAX_SINGLE_SIDECAR_BYTES) {
		return {
			ok: false,
			metadata: {
				...metadata,
				failureState: "record_exceeds_max_single_record_bytes",
			},
			error: "redacted report exceeds max single sidecar size",
		};
	}

	try {
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const payload: PersistedReportSidecar<M> = { metadata, content: redacted };
		const tempPath = join(dir, `.${id}.${process.pid}.tmp`);
		await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await fs.rename(tempPath, filePath);
		return { ok: true, metadata };
	} catch (error) {
		return {
			ok: false,
			metadata: { ...metadata, failureState: "write_failed" },
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function recoverReportSidecar<
	M extends ReportSidecarMetadata = ReportSidecarMetadata,
>(
	options: RecoverReportSidecarOptions,
): Promise<RecoverReportSidecarResult<M>> {
	const raw = await fs.readFile(options.recordPath, "utf8");
	const persisted = JSON.parse(raw) as PersistedReportSidecar<M>;
	const content = persisted.content;
	const previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;

	if (options.mode === "metadata") {
		return {
			mode: options.mode,
			content: JSON.stringify(persisted.metadata, null, 2),
			metadata: persisted.metadata,
		};
	}

	if (options.mode === "full") {
		if (!options.acknowledgeContextCost && !options.allowFullWithoutAck) {
			throw new Error(
				"full report recovery requires --ack-context-cost; use preview or slice first",
			);
		}
		return { mode: options.mode, content, metadata: persisted.metadata };
	}

	if (options.mode === "slice") {
		const offset = Math.max(0, options.offset ?? 0);
		const requestedLength = Math.max(1, options.length ?? DEFAULT_SLICE_CHARS);
		const length = Math.min(requestedLength, DEFAULT_SLICE_CHARS);
		const slice = content.slice(offset, offset + length);
		const label = options.reportLabel
			? `${options.reportLabel} report`
			: "report";
		return {
			mode: options.mode,
			content: [
				`${label} slice offset=${offset} length=${slice.length}/${content.length} (cap ${DEFAULT_SLICE_CHARS})`,
				"",
				slice,
			].join("\n"),
			metadata: persisted.metadata,
		};
	}

	const preview = content.slice(0, previewChars);
	const commandHint = options.commandName ? `${options.commandName} ` : "";
	const suffix =
		content.length > preview.length
			? `\n\n[preview truncated: ${content.length - preview.length} more character(s); use ${commandHint}slice --offset=${preview.length} --length=${DEFAULT_SLICE_CHARS} or ${commandHint}full --ack-context-cost]`
			: "";
	return {
		mode: options.mode,
		content: `${preview}${suffix}`,
		metadata: persisted.metadata,
	};
}

// ---------------------------------------------------------------------------
// Shared text helpers used by summary formatters
// ---------------------------------------------------------------------------

export function truncateText(input: string, maxChars: number): string {
	if (input.length <= maxChars) return input;
	return `${input.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function capText(input: string, maxChars: number): string {
	if (input.length <= maxChars) return input;
	return `${input.slice(0, Math.max(0, maxChars - 120))}\n\n[summary truncated to ${maxChars} chars; recover sidecar preview/slice for more]`;
}

export function stripAnsi(input: string): string {
	return input.replace(ANSI_PATTERN, "");
}

export function displayPath(filePath: string, cwd: string): string {
	const rel = relative(cwd, resolve(filePath));
	if (rel && !rel.startsWith("..") && rel !== "") return rel;
	return filePath;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sanitizePathPart(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
	return sanitized.length > 0 ? sanitized : "default-session";
}

function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function byteLength(input: string): number {
	return Buffer.byteLength(input, "utf8");
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function normalizeSecretPrefix(prefix: string): string {
	const match = prefix.match(
		/["']?\b(api[_-]?key|apiKey|token|secret|password|authorization)\b["']?/i,
	);
	return `${match?.[1] ?? "secret"}: `;
}

function parseNumberFlag(
	tokens: string[],
	flag: string,
	fallback: number,
): number {
	const inline = tokens.find((token) => token.startsWith(`${flag}=`));
	if (inline) {
		const value = Number.parseInt(inline.slice(flag.length + 1), 10);
		return Number.isFinite(value) ? value : fallback;
	}

	const flagIndex = tokens.indexOf(flag);
	if (flagIndex >= 0) {
		const value = Number.parseInt(tokens[flagIndex + 1] ?? "", 10);
		return Number.isFinite(value) ? value : fallback;
	}

	return fallback;
}
