/**
 * Post-Turn Reviewer — Extension entry point
 *
 * Thin Pi wiring that delegates lifecycle hooks, state machine transitions,
 * and command handling to ReviewerOrchestrator.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReviewerModelCommand } from "./commands/reviewer-model.js";
import { loadReviewConfig } from "./config.js";
import { createReviewerOrchestrator } from "./orchestrator.js";
import { writeReviewerReportSidecar } from "./report-hygiene.js";
import {
	countDiffLinesFast,
	gatherDiff,
	readSystemPrompt,
	renderTaskTemplate,
	spawnReviewer,
} from "./reviewer.js";
import { loadSkipFilter } from "./reviewer-skip.js";

export default function postTurnReviewerExtension(pi: ExtensionAPI): void {
	const orchestrator = createReviewerOrchestrator(pi, {
		loadConfig: async (cwd) => loadReviewConfig(cwd),
		loadSkipFilter,
		countDiffLines: countDiffLinesFast,
		runReview: async (task, files, cwd, config, filterOptions, signal) => {
			const systemPrompt = readSystemPrompt(getPromptsDir());
			const diff = await gatherDiff(
				files,
				cwd,
				config.maxDiffLines,
				filterOptions,
			);
			const taskPrompt = renderTaskTemplate(
				getPromptsDir(),
				task,
				Array.from(files),
				diff,
			);
			return spawnReviewer(taskPrompt, systemPrompt, config, cwd, signal);
		},
		writeSidecar: async (report, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile?.();
			const sessionId = sessionFile
				? (sessionFile
						.replace(/\.(jsonl|json)$/i, "")
						.split("/")
						.pop() ?? "default-session")
				: "default-session";
			return writeReviewerReportSidecar({
				report,
				sessionId,
			});
		},
		getSystemPrompt: readSystemPrompt,
		getTaskPrompt: renderTaskTemplate,
		getPromptsDir,
	});

	pi.on("session_start", async (_event, ctx) => {
		await orchestrator.initialize(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		// Future: forward session-tree events if the orchestrator needs them.
		void ctx;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await orchestrator.shutdown(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await orchestrator.onTurnEnd(ctx);
	});

	orchestrator.registerCommands(pi);

	registerReviewerModelCommand(pi, {
		getConfig: () => orchestrator.getStateSnapshot().config,
		setConfig: (updater) => orchestrator.updateConfig(updater),
	});
}

function getPromptsDir(): string {
	// Package-local prompts directory, resolved relative to this source file.
	// eslint-disable-next-line no-undef
	const sourcePath = new URL(import.meta.url).pathname;
	const packageRoot = sourcePath.split("/").slice(0, -3).join("/");
	return `${packageRoot}/src/reviewer/prompts`;
}
