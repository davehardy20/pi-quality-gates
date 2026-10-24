import { constants, lstatSync, realpathSync } from "node:fs";
import { mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

export interface ReviewerFailureOutput {
	rawOutput: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
	usage?: string;
	command: string;
}

export class ReviewerFailureOutputError extends Error {
	constructor(readonly retainedDirectory?: string) {
		super("Reviewer failure output refused.");
		this.name = "ReviewerFailureOutputError";
	}
}

/** Retained diagnostics only, never report/termination acceptance evidence.
 * Explicit destinations must already be caller-owned private temp roots.
 * Metadata checks are not protection against hostile concurrent replacement. */
export async function writeReviewerFailureOutput(
	payload: ReviewerFailureOutput,
	systemPrompt: string,
	failureDirectory?: string,
): Promise<string> {
	let directory: string | undefined;
	try {
		const temporary = realpathSync(tmpdir());
		const base = failureDirectory ?? temporary;
		if (failureDirectory !== undefined) {
			if (
				typeof base !== "string" ||
				base.length > 4096 ||
				!isAbsolute(base) ||
				normalize(base) !== base
			) {
				throw new ReviewerFailureOutputError();
			}
			const suffix = relative(temporary, base);
			if (
				isAbsolute(suffix) ||
				suffix === ".." ||
				suffix.startsWith(`..${sep}`)
			) {
				throw new ReviewerFailureOutputError();
			}
			const stat = lstatSync(base);
			if (
				realpathSync(base) !== base ||
				!stat.isDirectory() ||
				typeof process.getuid !== "function" ||
				stat.uid !== process.getuid() ||
				(stat.mode & 0o7777) !== 0o700
			) {
				throw new ReviewerFailureOutputError();
			}
		}
		const json = JSON.stringify(
			{ ...payload, timestamp: new Date().toISOString() },
			null,
			2,
		);
		if (
			Buffer.byteLength(json) > 1_048_576 ||
			Buffer.byteLength(systemPrompt) > 1_048_576
		)
			throw new ReviewerFailureOutputError();
		directory = await mkdtemp(join(base, "pi-reviewer-failure-"));
		for (const [name, content] of [
			["sidecar.json", json],
			["reviewer-prompt.md", systemPrompt],
		]) {
			const file = await open(
				join(directory, name),
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW,
				0o600,
			);
			try {
				await file.writeFile(content, "utf8");
			} finally {
				await file.close();
			}
		}
		return directory;
	} catch {
		throw new ReviewerFailureOutputError(directory);
	}
}
