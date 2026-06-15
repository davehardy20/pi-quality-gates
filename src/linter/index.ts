import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createLinterOrchestrator,
	type LinterOrchestrator,
	type LinterOrchestratorDependencies,
	type LinterToolExecutionEvent,
	__test__ as orchestratorTest,
} from "./orchestrator.js";

export {
	createLinterOrchestrator,
	type LinterOrchestrator,
	type LinterOrchestratorDependencies,
	type LinterStateSnapshot,
	type LinterToolExecutionEvent,
} from "./orchestrator.js";

export function createPostTurnLinter(
	pi: ExtensionAPI,
	deps?: LinterOrchestratorDependencies,
): LinterOrchestrator {
	const orchestrator = createLinterOrchestrator(pi, deps);

	pi.on("session_start", async (_event, ctx) => {
		await orchestrator.initialize(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await orchestrator.onSessionTree(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await orchestrator.shutdown(ctx);
	});

	pi.on("tool_execution_start", async (event) => {
		orchestrator.onToolExecutionStart(event as LinterToolExecutionEvent);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		await orchestrator.onToolExecutionEnd(
			event as LinterToolExecutionEvent,
			ctx,
		);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await orchestrator.onTurnEnd(ctx);
	});

	orchestrator.registerCommands(pi);
	return orchestrator;
}

export default function postTurnLinter(pi: ExtensionAPI) {
	return createPostTurnLinter(pi);
}

export const __test__ = {
	...orchestratorTest,
	createPostTurnLinter,
};
