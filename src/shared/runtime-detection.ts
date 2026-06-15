import type { QualityGatesRuntimeMode } from "../linter/types.js";

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);

function parseOptionalBooleanEnv(value: string | undefined): boolean | null {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return null;
	if (TRUE_ENV_VALUES.has(normalized)) return true;
	if (FALSE_ENV_VALUES.has(normalized)) return false;
	return null;
}

/**
 * Detect whether this process is running as an orchestrator sub-agent.
 *
 * Honours an explicit mode override, then environment hints, then the
 * presence of orchestrator worker variables.
 */
export function isQualityGatesSubAgentRuntime(
	env: Record<string, string | undefined> = process.env,
	mode: QualityGatesRuntimeMode = "auto",
): boolean {
	if (mode === "sub-agent") return true;
	if (mode === "parent") return false;

	const explicit = parseOptionalBooleanEnv(env.PI_QUALITY_GATES_SUBAGENT_MODE);
	if (explicit !== null) return explicit;

	const role = env.PI_ORCH_ROLE?.trim().toLowerCase();
	if (role === "worker" || role === "subagent" || role === "sub-agent") {
		return true;
	}

	return Boolean(
		env.PI_ORCH_RUN_ID?.trim() &&
			env.PI_ORCH_AGENT_ID?.trim() &&
			env.PI_ORCH_TASK_ID?.trim(),
	);
}
