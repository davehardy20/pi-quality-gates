import { promises as fs } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { normalizeAndSortPaths } from "../shared/path-utils.js";

const CODE_CONTEXT_LINES = 2;
const MAX_EXCERPT_RANGES = 12;

export interface IssueLocation {
	filePath: string;
	lineNumber: number;
}

export function extractIssueLocations(
	report: string,
	directory: string,
): IssueLocation[] {
	const locations = new Map<string, Set<number>>();
	const linePattern = /^(.+?):(\d+)(?::\d+)?\b/;

	for (const line of report.split(/\r?\n/)) {
		const match = line.match(linePattern);
		if (!match) continue;

		const rawPath = match[1]?.trim();
		const lineNumber = Number.parseInt(match[2] ?? "", 10);
		if (!rawPath || !Number.isFinite(lineNumber) || lineNumber < 1) continue;
		if (rawPath.startsWith("http://") || rawPath.startsWith("https://"))
			continue;

		const filePath = normalizeAndSortPaths([
			isAbsolute(rawPath) ? rawPath : resolve(directory, rawPath),
		])[0];
		const existing = locations.get(filePath) ?? new Set<number>();
		existing.add(lineNumber);
		locations.set(filePath, existing);
	}

	return Array.from(locations.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([filePath, lineNumbers]) =>
			Array.from(lineNumbers)
				.sort((a, b) => a - b)
				.map((lineNumber) => ({ filePath, lineNumber })),
		);
}

export function extractAffectedFiles(
	output: string,
	directory: string,
): string[] {
	const locations = extractIssueLocations(output, directory);
	return normalizeAndSortPaths(locations.map((loc) => loc.filePath));
}

export async function buildCodeExcerptSection(
	report: string,
	directory: string,
): Promise<string> {
	if (!report.trim()) return "";

	const issueLocations = extractIssueLocations(report, directory).slice(
		0,
		MAX_EXCERPT_RANGES,
	);
	if (issueLocations.length === 0) return "";

	const byFile = new Map<string, number[]>();
	for (const issue of issueLocations) {
		const lines = byFile.get(issue.filePath) ?? [];
		lines.push(issue.lineNumber);
		byFile.set(issue.filePath, lines);
	}

	const sections: string[] = [];
	for (const [filePath, rawLineNumbers] of byFile.entries()) {
		try {
			const fileContent = await fs.readFile(filePath, "utf8");
			const fileLines = fileContent.split(/\r?\n/);
			const lineNumbers = Array.from(new Set(rawLineNumbers)).sort(
				(a, b) => a - b,
			);
			const highlightedLines = new Set(lineNumbers);
			const ranges: Array<{ start: number; end: number }> = [];

			for (const lineNumber of lineNumbers) {
				const start = Math.max(1, lineNumber - CODE_CONTEXT_LINES);
				const end = Math.min(fileLines.length, lineNumber + CODE_CONTEXT_LINES);
				const previous = ranges.at(-1);
				if (previous && start <= previous.end + 1) {
					previous.end = Math.max(previous.end, end);
				} else {
					ranges.push({ start, end });
				}
			}

			sections.push(
				...ranges.map((range) =>
					formatExcerptBlock(
						filePath,
						fileLines,
						range.start,
						range.end,
						highlightedLines,
					),
				),
			);
		} catch {
			// ignore unreadable files
		}
	}

	if (sections.length === 0) return "";
	return `--- Code excerpts ---\n${sections.join("\n\n")}`;
}

function formatExcerptBlock(
	filePath: string,
	lines: string[],
	startLine: number,
	endLine: number,
	highlightedLines: Set<number>,
): string {
	const content = lines
		.slice(startLine - 1, endLine)
		.map((line, index) => {
			const lineNumber = startLine + index;
			const marker = highlightedLines.has(lineNumber) ? ">" : " ";
			return `${marker} ${String(lineNumber).padStart(4, " ")} | ${line}`;
		})
		.join("\n");

	return `${filePath}:${startLine}-${endLine}\n\`\`\`text\n${content}\n\`\`\``;
}

export const __test__ = {
	extractIssueLocations,
	extractAffectedFiles,
	buildCodeExcerptSection,
};
