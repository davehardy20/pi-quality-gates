/**
 * pr-gate extension entry — wires the push gate hook and /pr-review command
 * into a Pi extension.
 *
 * ACTOR SEPARATION (firm):
 *  - This module ONLY registers the veto hook + the /pr-review command.
 *  - It NEVER calls gh_safe / git_safe push/pr_create itself.
 *  - The main agent remains the sole publisher; this gate only vetoes.
 *
 * Loop (driven by the main agent, not by this extension):
 *   agent calls gh_safe pr_create/push
 *     -> tool_call hook vetoes (no PASS token) with a steer
 *     -> agent runs /pr-review
 *     -> review dispatch runs the configured PR reviewer
 *     -> on PASS, token stamped; agent retries the push; hook allows
 *     -> on ISSUES, agent fixes -> lint-clean -> re-review
 *     -> on CRITICAL security, escalate for human ack
 */

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { decidePushGate } from "./gate-decision.js";
import {
	createOrchestratorReviewerExecution,
	type OrchestratorReviewerExecutionBridge,
} from "./orchestrator-reviewer-execution.js";
import {
	createPassTokenStore,
	type PassTokenStore,
} from "./pass-token-store.js";
import { assertPrReviewerToolPolicy } from "./pr-review-config.js";
import { createPrReviewDispatch } from "./pr-review-dispatch.js";
import { createPrReviewToolDefinition } from "./pr-review-tool.js";
import {
	DEFAULT_GATED_ACTIONS,
	registerPushGateHook,
} from "./push-gate-hook.js";
import {
	createReviewCoordinator,
	type ReviewKickoffResult,
} from "./review-coordinator.js";
import { createReviewerExecution, type ReviewerExecution } from "./reviewer.js";

export interface PrGateConfig {
	/** Whether the push gate is active. Default: true. */
	enabled: boolean;
	/** Mutating actions to gate. Default: push + pr_create. */
	gatedActions: ReadonlySet<string>;
	/**
	 * Opt-in below-threshold auto-PASS (C6). When true, a review that returns
	 * only NIT-level findings (no CRITICAL/WARNING) and no test-execution FAIL
	 * auto-stamps a PASS token instead of blocking. Default OFF — the gate
	 * fails closed on ISSUES. See `decidePushGate` / `autoPassOnNitOnly`.
	 */
	autoPassOnNitOnly?: boolean;
}

export const DEFAULT_PR_GATE_CONFIG: PrGateConfig = {
	enabled: true,
	gatedActions: DEFAULT_GATED_ACTIONS,
	autoPassOnNitOnly: false,
};

/**
 * Resolve the current HEAD sha. Returns "" if unknown (the hook fails closed
 * on empty). Kept here so tests can inject a fake without spawning git.
 */
export function resolveHeadSha(cwd: string): string {
	try {
		const sha = execSync("git rev-parse HEAD", {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return sha || "";
	} catch {
		return "";
	}
}

export interface PrGateState {
	tokens: PassTokenStore;
	config: PrGateConfig;
}

export function createPrGateState(
	config: Partial<PrGateConfig> = {},
): PrGateState {
	return {
		tokens: createPassTokenStore(),
		config: { ...DEFAULT_PR_GATE_CONFIG, ...config },
	};
}

export interface StampFromReviewInput {
	/** HEAD sha the review covered. */
	headSha: string;
	/** The review report status. Only "PASS" stamps. */
	reportStatus: "PASS" | "ISSUES" | "CANNOT_REVIEW";
	/** Optional summary from the report. */
	summary?: string;
}

/**
 * Stamp a PASS token from a review result. Called by the observation path
 * (the tool_result hook on the review orchestrator call) — NOT by the veto
 * hook. Returns true if a token was stamped.
 */
export function stampPassFromReview(
	state: PrGateState,
	input: StampFromReviewInput,
): boolean {
	if (input.reportStatus !== "PASS") return false;
	// Re-use decidePushGate's stamping path by feeding it a PASS report-shaped
	// input. This keeps a single source of truth for "what stamps a token".
	const before = state.tokens.size;
	decidePushGate({
		action: "push",
		headSha: input.headSha,
		baseSha: "unknown",
		tokens: state.tokens,
		// Minimal report stub: decidePushGate only reads .status for the PASS
		// branch (no security findings here).
		reviewReport: {
			status: "PASS",
			confidence: "HIGH",
			findings: [],
			verified: [],
			unverifiable: [],
			summary: input.summary ?? "",
		},
	});
	return state.tokens.size > before;
}

interface ReviewerBridgeStatus {
	pending: ReadonlyArray<{ requestId: string; headSha: string }>;
	lastDiagnostic: {
		at: number;
		requestId: string | null;
		headSha: string | null;
		kind: string;
		detail: string;
	} | null;
}

function sendPrReviewStatus(
	pi: ExtensionAPI,
	state: PrGateState,
	ctx: ExtensionContext,
	reviewerBridge?: { getStatus: () => ReviewerBridgeStatus },
): void {
	const headSha = resolveHeadSha(ctx.cwd);
	const hasPass = headSha ? state.tokens.hasPass(headSha) : false;
	const status = reviewerBridge?.getStatus();
	const pendingLines: string[] = [];
	if (status && status.pending.length > 0) {
		pendingLines.push(
			"Pending /pr-review requests:",
			...status.pending.map(
				(p) =>
					`- ${p.requestId} (HEAD ${p.headSha.slice(0, 12) || "(unknown)"})`,
			),
		);
	} else {
		pendingLines.push("Pending /pr-review requests: none");
	}
	const diagnosticLines: string[] = [];
	if (status?.lastDiagnostic) {
		const d = status.lastDiagnostic;
		diagnosticLines.push(
			"Last reviewer observation:",
			`- kind: ${d.kind}`,
			`- HEAD: ${d.headSha?.slice(0, 12) || "(unknown)"}`,
			`- request: ${d.requestId ?? "(none)"}`,
			`- detail: ${d.detail}`,
		);
	}
	pi.sendMessage({
		customType: "pr-review-status",
		content: [
			`PR gate enabled: ${state.config.enabled}`,
			`HEAD sha: ${headSha || "(unknown)"}`,
			`HEAD has PASS: ${hasPass}`,
			`Total PASS tokens: ${state.tokens.size}`,
			...pendingLines,
			...diagnosticLines,
			state.config.enabled
				? "Run /pr-review to request a PASS token for the current HEAD."
				: "Reviews are not required while the gate is disabled.",
		].join("\n"),
		display: true,
		details: {
			headSha,
			hasPass,
			enabled: state.config.enabled,
			tokenCount: state.tokens.size,
			pendingRequests: status?.pending ?? [],
			lastDiagnostic: status?.lastDiagnostic ?? null,
		},
	});
}

/**
 * PR reviewer execution bridge. The review is read-only, so the default `host`
 * bridge spawns a headless child Pi that runs validation (e.g. run_typecheck)
 * against the repository checkout, where dependencies already live. The Apple
 * container sandbox is reserved for mutating workers; opt back into the
 * sandboxed orchestrator `pr-reviewer` with PI_PR_REVIEW_BRIDGE=orchestrator
 * once the container reviewer is stable (see mx-87a9dd).
 */
export type PrReviewerBridgeMode = "host" | "orchestrator";

/** Resolve the shipped reviewer prompts directory (src/pr-gate/prompts). */
function getPromptsDir(): string {
	return fileURLToPath(new URL("./prompts", import.meta.url));
}

function resolveReviewerBridgeMode(
	override?: PrReviewerBridgeMode,
): PrReviewerBridgeMode {
	if (override === "host" || override === "orchestrator") return override;
	const fromEnv = (process.env.PI_PR_REVIEW_BRIDGE ?? "").trim().toLowerCase();
	return fromEnv === "orchestrator" ? "orchestrator" : "host";
}

export interface PrGateExtensionDeps {
	createPrReviewDispatch?: typeof createPrReviewDispatch;
	/** Override HEAD sha resolution (tests inject a fake without spawning git). */
	resolveHeadSha?: (cwd: string) => string;
	/**
	 * Force the reviewer bridge (tests). Defaults to PI_PR_REVIEW_BRIDGE or
	 * "host" (read-only review runs on the host; the container sandbox is for
	 * mutating workers).
	 */
	reviewerBridgeMode?: PrReviewerBridgeMode;
}

export default function prGateExtension(
	pi: ExtensionAPI,
	deps: PrGateExtensionDeps = {},
): void {
	assertPrReviewerToolPolicy();
	const state = createPrGateState();
	const resolveHead = deps.resolveHeadSha ?? resolveHeadSha;

	registerPushGateHook(pi, {
		tokens: state.tokens,
		getHeadSha: (input) => {
			// Best-effort; the hook fails closed on empty/throw. Prefer the
			// mutating tool call cwd so cross-repo pushes are reviewed/gated
			// against the repo being published, not Pi's process cwd.
			try {
				const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
				return resolveHead(cwd);
			} catch {
				return "";
			}
		},
		enabled: () => state.config.enabled,
		gatedActions: () => state.config.gatedActions,
	});

	const bridgeMode = resolveReviewerBridgeMode(deps.reviewerBridgeMode);
	let orchestratorReviewer: OrchestratorReviewerExecutionBridge | undefined;
	if (bridgeMode === "orchestrator") {
		orchestratorReviewer = createOrchestratorReviewerExecution(pi, {
			tokens: state.tokens,
			resolveHeadSha: () => resolveHead(process.cwd()),
		});
	}
	const reviewerExecution: ReviewerExecution = orchestratorReviewer
		? orchestratorReviewer.reviewerExecution
		: createReviewerExecution({ getPromptsDir });

	// The orchestrator bridge is async: it routes review through a follow-up
	// `orchestrate` call and stamps PASS from the observed tool_result. The host
	// bridge spawns a headless child Pi directly and returns its report, so it
	// needs no tool_result listener.
	if (orchestratorReviewer) {
		pi.on("tool_result", (event) => {
			orchestratorReviewer.handleToolResult(event);
		});
	}

	const createDispatch = deps.createPrReviewDispatch ?? createPrReviewDispatch;
	const dispatch = createDispatch({
		getHeadSha: resolveHead,
		...(deps.createPrReviewDispatch ? {} : { reviewerExecution }),
	});

	// Shared review coordinator — the single seam used by BOTH the human
	// `/pr-review` command and the agent-callable `pr_review` custom tool.
	// One dispatch instance, one in-progress guard, one token store, one set
	// of eligibility checks. See src/pr-gate/review-coordinator.ts.
	const coordinator = createReviewCoordinator({
		pi,
		resolveHeadSha: resolveHead,
		dispatch,
	});

	pi.on("session_shutdown", async () => {
		coordinator.dispose();
		orchestratorReviewer?.dispose();
		state.tokens.clear();
	});

	// Agent-callable custom tool over the SAME coordinator/state. Registered
	// once so the LLM can request the gate-compatible review autonomously.
	pi.registerTool(
		createPrReviewToolDefinition({
			coordinator,
			state,
		}),
	);

	function sendKickoffMessage(result: ReviewKickoffResult): void {
		pi.sendMessage({
			customType: "pr-review-status",
			content: result.message,
			display: true,
			details: {
				headSha: result.headSha,
				baseRef: result.baseRef ?? null,
				status: result.status,
				started: result.started,
				enabled: result.gateEnabled,
				tokenCount: result.tokenCount,
			},
		});
	}

	pi.registerCommand("pr-review", {
		description:
			"Run a PR review for the current HEAD, then stamp a PASS token if clean. Required before gh_safe push / pr_create when the gate is enabled.",
		handler: async (args, ctx: ExtensionContext) => {
			const rawArgs = (args ?? "").trim();
			if (rawArgs === "status" || rawArgs === "--status") {
				sendPrReviewStatus(pi, state, ctx, orchestratorReviewer);
				return;
			}

			const baseRef = rawArgs || undefined;
			const result = coordinator.startReview({
				ctx,
				state,
				baseRef,
				origin: "command",
			});
			sendKickoffMessage(result);
		},
	});

	pi.registerCommand("pr-review-status", {
		description:
			"Show PR review gate status without running a review or treating status as a base ref.",
		handler: async (_args, ctx: ExtensionContext) => {
			sendPrReviewStatus(pi, state, ctx, orchestratorReviewer);
		},
	});

	pi.registerCommand("pr-gate-status", {
		description: "Show PR review gate state: enabled, HEAD sha, PASS tokens.",
		handler: async (_args, ctx: ExtensionContext) => {
			const headSha = resolveHead(ctx.cwd);
			pi.sendMessage({
				customType: "pr-gate-status",
				content: [
					`PR gate enabled: ${state.config.enabled}`,
					`Gated actions: ${[...state.config.gatedActions].join(", ")}`,
					`HEAD sha: ${headSha || "(unknown)"}`,
					`HEAD has PASS: ${headSha ? state.tokens.hasPass(headSha) : false}`,
					`Total PASS tokens: ${state.tokens.size}`,
				].join("\n"),
				display: true,
			});
		},
	});

	pi.registerCommand("pr-gate-test-block", {
		description:
			"Simulate a git_safe push tool_call to verify the gate blocks without a PASS token.",
		handler: async (_args, ctx: ExtensionContext) => {
			const headSha = resolveHead(ctx.cwd);

			if (!state.config.enabled) {
				pi.sendMessage({
					customType: "pr-gate-test-block",
					content:
						"PR gate test: tool_call would NOT be blocked (gate is disabled).",
					display: true,
					details: {
						headSha,
						enabled: false,
					},
				});
				return;
			}

			const decision = decidePushGate({
				action: "push",
				headSha,
				baseSha: "unknown",
				tokens: state.tokens,
			});

			if (decision.verdict === "allow") {
				pi.sendMessage({
					customType: "pr-gate-test-block",
					content:
						"PR gate test: tool_call would NOT be blocked (PASS token present).",
					display: true,
					details: {
						headSha,
						verdict: decision.verdict,
						hasPass: state.tokens.hasPass(headSha),
					},
				});
				return;
			}

			pi.sendMessage({
				customType: "pr-gate-test-block",
				content: `PR gate test: tool_call would be BLOCKED.\n${decision.steer ?? decision.reason ?? "PASS required before push."}`,
				display: true,
				details: {
					headSha,
					verdict: decision.verdict,
					hasPass: state.tokens.hasPass(headSha),
				},
			});
		},
	});

	pi.registerCommand("pr-gate-toggle", {
		description: "Enable or disable the PR review gate (on|off).",
		handler: async (args, ctx: ExtensionContext) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "on" || arg === "enable") {
				state.config.enabled = true;
			} else if (arg === "off" || arg === "disable") {
				state.config.enabled = false;
			} else {
				state.config.enabled = !state.config.enabled;
			}
			pi.sendMessage({
				customType: "pr-gate-toggle",
				content: `PR gate ${state.config.enabled ? "enabled" : "disabled"}.`,
				display: true,
			});
			void ctx;
		},
	});
}
