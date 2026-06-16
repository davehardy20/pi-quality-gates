/**
 * Shared severity/threshold helpers for review reports.
 *
 * Used by the post-turn reviewer state machine and the PR pre-push review
 * gate so both subsystems agree on what counts as actionable.
 */

import type { ReviewReport, Severity } from "./review-types.js";

const SEVERITY_ORDER: Record<Severity, number> = {
	CRITICAL: 3,
	WARNING: 2,
	NIT: 1,
};

/**
 * Returns true if `severity` meets or exceeds the configured auto-fix
 * threshold. "none" means nothing is actionable; "warning" means CRITICAL
 * and WARNING; "critical" means CRITICAL only.
 */
export function severityMeetsThreshold(
	severity: Severity,
	threshold: "critical" | "warning" | "none",
): boolean {
	if (threshold === "none") return false;
	if (threshold === "warning") {
		return severity === "CRITICAL" || severity === "WARNING";
	}
	return severity === "CRITICAL";
}

/**
 * Returns true if the report contains at least one finding at or above the
 * given threshold. A null report or threshold "none" returns false.
 */
export function hasFindingsAboveThreshold(
	report: ReviewReport | null,
	threshold: "critical" | "warning" | "none",
): boolean {
	if (!report || threshold === "none") return false;

	const minLevel = threshold === "critical" ? 3 : 2;
	return report.findings.some((f) => SEVERITY_ORDER[f.severity] >= minLevel);
}

/**
 * Check whether a report contains a CRITICAL security finding.
 * This is the gate's escalation trigger (human acknowledgement required).
 */
export function hasCriticalSecurityFinding(report: ReviewReport): boolean {
	return report.findings.some(
		(f) => f.severity === "CRITICAL" && f.domain === "security",
	);
}
