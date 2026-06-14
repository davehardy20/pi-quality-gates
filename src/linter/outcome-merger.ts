import { normalizeAndSortPaths } from "../shared/path-utils.js";
import type {
	CombinedValidationOutcome,
	ReportMode,
	ValidationOutcome,
} from "./types.js";

export function buildCombinedSignature(results: ValidationOutcome[]): string {
	return JSON.stringify(
		results
			.map((result) => ({
				kind: result.kind,
				signature: result.signature,
			}))
			.sort((a, b) => {
				if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
				return a.signature.localeCompare(b.signature);
			}),
	);
}

export function mergeValidationOutcomes(args: {
	reportMode: ReportMode;
	results: ValidationOutcome[];
}): CombinedValidationOutcome {
	const findings = args.results.filter(
		(result) => result.kind === "findings" && result.report.trim().length > 0,
	);
	const toolErrors = args.results.filter(
		(result) => result.kind === "tool-error" && result.report.trim().length > 0,
	);
	const cleanResults = args.results.filter((result) => result.kind === "clean");
	const signature = buildCombinedSignature(args.results);

	if (findings.length > 0) {
		return {
			kind: "findings",
			report: [...findings, ...toolErrors]
				.map((result) => result.report)
				.join("\n\n"),
			affectedFiles: normalizeAndSortPaths(
				findings.flatMap((result) => result.affectedFiles),
			),
			reportMode: args.reportMode,
			signature,
		};
	}

	if (toolErrors.length > 0) {
		return {
			kind: "tool-error",
			report: toolErrors.map((result) => result.report).join("\n\n"),
			affectedFiles: [],
			reportMode: args.reportMode,
			signature,
		};
	}

	if (cleanResults.length > 0 || args.results.length === 0) {
		return {
			kind: "clean",
			report: "",
			affectedFiles: [],
			reportMode: args.reportMode,
			signature,
		};
	}

	return {
		kind: "clean",
		report: "",
		affectedFiles: [],
		reportMode: args.reportMode,
		signature,
	};
}

export const __test__ = {
	buildCombinedSignature,
	mergeValidationOutcomes,
};
