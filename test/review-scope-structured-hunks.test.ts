import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	capDiff,
	countDiffLinesFast,
	gatherDiff,
	STRUCTURED_HUNK_NEW,
	STRUCTURED_HUNK_OLD,
	toStructuredHunks,
} from "../src/shared/review-scope.js";

// A representative unified diff used across several assertions.
const SAMPLE_DIFF = [
	"diff --git a/src/foo.ts b/src/foo.ts",
	"index 1111111..2222222 100644",
	"--- a/src/foo.ts",
	"+++ b/src/foo.ts",
	"@@ -10,3 +10,4 @@ function example() {",
	"   const a = 1;",
	"-  const b = 2;",
	"+  const b = 3;",
	"+  const c = 4;",
	"   return a + b;",
].join("\n");

describe("toStructuredHunks", () => {
	it("returns empty string for empty / undefined input", () => {
		expect(toStructuredHunks("")).toBe("");
		expect(toStructuredHunks(undefined as unknown as string)).toBe("");
	});

	it("emits __new hunk__ and __old hunk__ blocks per hunk", () => {
		const out = toStructuredHunks(SAMPLE_DIFF);
		const newIdx = out.indexOf(STRUCTURED_HUNK_NEW);
		const oldIdx = out.indexOf(STRUCTURED_HUNK_OLD);
		expect(newIdx).toBeGreaterThan(-1);
		expect(oldIdx).toBeGreaterThan(-1);
		// new side carries added lines without the leading '+'.
		const newBlock = out
			.slice(newIdx + STRUCTURED_HUNK_NEW.length, oldIdx)
			.trim();
		expect(newBlock).toContain("const b = 3;");
		expect(newBlock).toContain("const c = 4;");
		expect(newBlock).toContain("const a = 1;"); // context shared
		expect(newBlock).not.toContain("const b = 2;"); // removed, old only
		// old side carries removed lines without the leading '-'.
		const oldBlock = out.slice(oldIdx + STRUCTURED_HUNK_OLD.length).trim();
		expect(oldBlock).toContain("const b = 2;");
		expect(oldBlock).toContain("const a = 1;");
		expect(oldBlock).not.toContain("const b = 3;");
	});

	it("preserves file header and hunk header lines verbatim", () => {
		const out = toStructuredHunks(SAMPLE_DIFF);
		expect(out).toContain("diff --git a/src/foo.ts b/src/foo.ts");
		expect(out).toContain("--- a/src/foo.ts");
		expect(out).toContain("+++ b/src/foo.ts");
		expect(out).toContain("@@ -10,3 +10,4 @@ function example() {");
	});

	it("is deterministic (same input -> identical output)", () => {
		expect(toStructuredHunks(SAMPLE_DIFF)).toEqual(
			toStructuredHunks(SAMPLE_DIFF),
		);
	});

	it("classifies removed `--` and added `++` body lines as hunk content, not file headers", () => {
		// Within a hunk, a removed line whose content starts with `--` (diff line
		// `---foo`) and an added line whose content starts with `++` (diff line
		// `+++i`) must be treated as body content, not mistaken for `---`/`+++`
		// file headers (which only appear before the first `@@`).
		const doubleSignDiff = [
			"diff --git a/src/x.ts b/src/x.ts",
			"index 1111111..2222222 100644",
			"--- a/src/x.ts",
			"+++ b/src/x.ts",
			"@@ -1,3 +1,3 @@ context",
			" keep",
			"---foo",
			"+++i",
		].join("\n");
		const out = toStructuredHunks(doubleSignDiff);

		// File header preserved verbatim; the body line is NOT echoed as a header.
		expect(out).toContain("--- a/src/x.ts");
		expect(out).not.toContain("---foo");
		expect(out).not.toContain("+++i");

		const newIdx = out.indexOf(STRUCTURED_HUNK_NEW);
		const oldIdx = out.indexOf(STRUCTURED_HUNK_OLD);
		expect(newIdx).toBeGreaterThan(-1);
		expect(oldIdx).toBeGreaterThan(newIdx);
		const newBlock = out
			.slice(newIdx + STRUCTURED_HUNK_NEW.length, oldIdx)
			.trim();
		const oldBlock = out.slice(oldIdx + STRUCTURED_HUNK_OLD.length).trim();

		// Added `++i` (content) lands in the new block; removed `--foo` (content)
		// lands in the old block — both without their diff sign prefix.
		expect(newBlock).toContain("++i");
		expect(oldBlock).toContain("--foo");
		expect(newBlock).not.toContain("--foo");
		expect(oldBlock).not.toContain("++i");
	});

	it("never leaks raw '+' or '-' diff signs into the labelled bodies", () => {
		const out = toStructuredHunks(SAMPLE_DIFF);
		const newStart = out.indexOf(STRUCTURED_HUNK_NEW);
		const oldStart = out.indexOf(STRUCTURED_HUNK_OLD);
		const newBody = out
			.slice(newStart + STRUCTURED_HUNK_NEW.length, oldStart)
			.split("\n");
		const oldBody = out
			.slice(oldStart + STRUCTURED_HUNK_OLD.length)
			.split("\n");
		for (const line of newBody) {
			expect(line.startsWith("+")).toBe(false);
			expect(line.startsWith("-")).toBe(false);
		}
		for (const line of oldBody) {
			expect(line.startsWith("+")).toBe(false);
			expect(line.startsWith("-")).toBe(false);
		}
	});

	it("handles a pure-addition hunk (new file body)", () => {
		const diff = [
			"diff --git a/new.txt b/new.txt",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/new.txt",
			"@@ -0,0 +1,2 @@",
			"+hello",
			"+world",
		].join("\n");
		const out = toStructuredHunks(diff);
		expect(out).toContain("new file mode 100644");
		const newStart = out.indexOf(STRUCTURED_HUNK_NEW);
		const oldStart = out.indexOf(STRUCTURED_HUNK_OLD);
		expect(newStart).toBeGreaterThan(-1);
		expect(oldStart).toBeGreaterThan(-1);
		const newBody = out
			.slice(newStart + STRUCTURED_HUNK_NEW.length, oldStart)
			.trim();
		expect(newBody).toBe("hello\nworld");
		// old side is empty for a pure-addition hunk but still emitted.
		expect(out.slice(oldStart + STRUCTURED_HUNK_OLD.length).trim()).toBe("");
	});

	it("handles multiple hunks and files, flushing each", () => {
		const diff = [
			"diff --git a/a.ts b/a.ts",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1,2 +1,2 @@",
			"-x",
			"+y",
			"diff --git a/b.ts b/b.ts",
			"--- a/b.ts",
			"+++ b/b.ts",
			"@@ -5,2 +5,2 @@",
			"-p",
			"+q",
		].join("\n");
		const out = toStructuredHunks(diff);
		// Two files -> at least two new-hunk and two old-hunk blocks.
		expect(out.split(STRUCTURED_HUNK_NEW).length - 1).toBe(2);
		expect(out.split(STRUCTURED_HUNK_OLD).length - 1).toBe(2);
		expect(out).toContain("diff --git a/b.ts b/b.ts");
	});

	it("passes through no-newline markers without dropping them", () => {
		const diff = [
			"diff --git a/f.txt b/f.txt",
			"--- a/f.txt",
			"+++ b/f.txt",
			"@@ -1,1 +1,1 @@",
			"-old",
			"\\ No newline at end of file",
			"+new",
		].join("\n");
		const out = toStructuredHunks(diff);
		expect(out).toContain("\\ No newline at end of file");
	});
});

describe("countDiffLinesFast", () => {
	function initRepo(cwd: string): void {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["config", "user.email", "t@t.test"], { cwd });
		execFileSync("git", ["config", "user.name", "Test"], { cwd });
	}

	it("returns zero when no files are provided", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "rs-count-empty-"));
		try {
			initRepo(cwd);
			writeFileSync(join(cwd, "foo.ts"), "one\ntwo\n");
			execFileSync("git", ["add", "."], { cwd });
			execFileSync("git", ["commit", "-q", "-m", "init"], { cwd });
			writeFileSync(join(cwd, "foo.ts"), "changed\ntwo\n");

			expect(await countDiffLinesFast([], cwd)).toBe(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("counts added and deleted lines for tracked working-tree changes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "rs-count-tracked-"));
		try {
			initRepo(cwd);
			writeFileSync(
				join(cwd, "foo.ts"),
				Array.from({ length: 11 }, (_, index) => `old-${index}\n`).join(""),
			);
			execFileSync("git", ["add", "."], { cwd });
			execFileSync("git", ["commit", "-q", "-m", "init"], { cwd });

			writeFileSync(
				join(cwd, "foo.ts"),
				Array.from({ length: 12 }, (_, index) => `new-${index}\n`).join(""),
			);

			expect(await countDiffLinesFast(["foo.ts"], cwd)).toBe(23);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("falls back to counting only untracked file lines", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "rs-count-untracked-"));
		try {
			initRepo(cwd);
			writeFileSync(join(cwd, "README.md"), "# test\n");
			execFileSync("git", ["add", "."], { cwd });
			execFileSync("git", ["commit", "-q", "-m", "init"], { cwd });

			writeFileSync(join(cwd, "new.ts"), "one\ntwo\nthree\n");

			expect(await countDiffLinesFast(["README.md", "new.ts"], cwd)).toBe(3);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("counts only requested tracked files", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "rs-count-filtered-"));
		try {
			initRepo(cwd);
			writeFileSync(join(cwd, "foo.ts"), "one\ntwo\n");
			writeFileSync(join(cwd, "bar.ts"), "alpha\nbeta\n");
			execFileSync("git", ["add", "."], { cwd });
			execFileSync("git", ["commit", "-q", "-m", "init"], { cwd });

			writeFileSync(join(cwd, "foo.ts"), "one\nthree\nfour\n");
			writeFileSync(join(cwd, "bar.ts"), "alpha\ngamma\ndelta\n");

			expect(await countDiffLinesFast(["foo.ts"], cwd)).toBe(3);
			expect(await countDiffLinesFast(["foo.ts", "bar.ts"], cwd)).toBe(6);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("counts staged tracked changes against HEAD by default", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "rs-count-staged-"));
		try {
			initRepo(cwd);
			writeFileSync(join(cwd, "foo.ts"), "one\ntwo\n");
			execFileSync("git", ["add", "."], { cwd });
			execFileSync("git", ["commit", "-q", "-m", "init"], { cwd });

			writeFileSync(join(cwd, "foo.ts"), "one\nthree\nfour\n");
			execFileSync("git", ["add", "foo.ts"], { cwd });

			expect(await countDiffLinesFast(["foo.ts"], cwd)).toBe(3);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("counts changed lines between baseRef and HEAD", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "rs-count-base-"));
		try {
			initRepo(cwd);
			writeFileSync(join(cwd, "foo.ts"), "one\ntwo\n");
			execFileSync("git", ["add", "."], { cwd });
			execFileSync("git", ["commit", "-q", "-m", "base"], { cwd });
			const baseRef = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd,
				encoding: "utf8",
			}).trim();

			writeFileSync(join(cwd, "foo.ts"), "one\nthree\nfour\n");
			execFileSync("git", ["add", "."], { cwd });
			execFileSync("git", ["commit", "-q", "-m", "change"], { cwd });

			expect(await countDiffLinesFast(["foo.ts"], cwd, baseRef)).toBe(3);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("gatherDiff structured option", () => {
	function initRepo(cwd: string): void {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["config", "user.email", "t@t.test"], { cwd });
		execFileSync("git", ["config", "user.name", "Test"], { cwd });
		writeFileSync(join(cwd, "foo.ts"), "const a = 1;\nconst b = 2;\n");
		execFileSync("git", ["add", "."], { cwd });
		execFileSync("git", ["commit", "-q", "-m", "init"], { cwd });
		// Mutate the working tree (post-turn working-tree-vs-HEAD diff).
		writeFileSync(
			join(cwd, "foo.ts"),
			"const a = 1;\nconst b = 3;\nconst c = 4;\n",
		);
	}

	it("returns a raw unified diff when structured is unset", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "rs-raw-"));
		try {
			initRepo(cwd);
			const result = await gatherDiff(["foo.ts"], cwd, 4000);
			const diff = result.text;
			expect(result).toMatchObject({ truncated: false, omittedLines: 0 });
			expect(diff).toContain("+++");
			expect(diff).toContain("-const b = 2;");
			expect(diff).not.toContain(STRUCTURED_HUNK_NEW);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rewrites into __new hunk__ / __old hunk__ blocks when structured=true", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "rs-struct-"));
		try {
			initRepo(cwd);
			const result = await gatherDiff(
				["foo.ts"],
				cwd,
				4000,
				undefined,
				undefined,
				true,
			);
			const diff = result.text;
			expect(result).toMatchObject({ truncated: false, omittedLines: 0 });
			expect(diff).toContain(STRUCTURED_HUNK_NEW);
			expect(diff).toContain(STRUCTURED_HUNK_OLD);
			const newIdx = diff.indexOf(STRUCTURED_HUNK_NEW);
			const oldIdx = diff.indexOf(STRUCTURED_HUNK_OLD);
			expect(diff.slice(newIdx, oldIdx)).toContain("const b = 3;");
			expect(diff.slice(newIdx, oldIdx)).toContain("const c = 4;");
			expect(diff.slice(oldIdx)).toContain("const b = 2;");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("caps the RAW diff before toStructuredHunks (omittedLines in raw-line terms)", () => {
		// gatherDiff's ordering: cap the raw diff, THEN run the structured-hunk
		// transform. Capping after structuring would count structured lines (which
		// expand context into both __new__/__old__ blocks), pushing effective
		// coverage below the raw cap and slicing a hunk block in half.
		const raw = SAMPLE_DIFF.repeat(500);
		const rawLineCount = raw.split("\n").length;

		const capped = capDiff(raw, 50);
		const structured = toStructuredHunks(capped.text);

		expect(capped.truncated).toBe(true);
		// Cap is in RAW-line terms: every line past the cap is dropped.
		expect(capped.omittedLines).toBe(rawLineCount - 50);
		// capDiff no longer embeds the notice; gatherDiff appends it post-structure.
		expect(capped.text).not.toContain("DIFF TRUNCATED");
		// Structuring the (already-capped) raw diff is total: every emitted hunk
		// flushes both sides, so no __new hunk__ is left without its __old hunk__.
		const news = structured.split(STRUCTURED_HUNK_NEW).length - 1;
		const olds = structured.split(STRUCTURED_HUNK_OLD).length - 1;
		expect(news).toBe(olds);
		expect(news).toBeGreaterThan(0);
	});

	it("gatherDiff appends a clean truncation notice after structuring", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "rs-trunc-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd });
			execFileSync("git", ["config", "user.email", "t@t.test"], { cwd });
			execFileSync("git", ["config", "user.name", "Test"], { cwd });
			const before =
				Array.from({ length: 120 }, (_, i) => `old line ${i}`).join("\n") +
				"\n";
			const after =
				Array.from({ length: 120 }, (_, i) => `new line ${i}`).join("\n") +
				"\n";
			writeFileSync(join(cwd, "big.ts"), before);
			execFileSync("git", ["add", "."], { cwd });
			execFileSync("git", ["commit", "-q", "-m", "init"], { cwd });
			writeFileSync(join(cwd, "big.ts"), after);

			// Full raw line count (unstructured, untruncated) for the omittedLines check.
			const full = await gatherDiff(["big.ts"], cwd, 100_000);
			const rawLineCount = full.text.split("\n").length;

			const result = await gatherDiff(
				["big.ts"],
				cwd,
				50,
				undefined,
				undefined,
				true,
			);

			expect(result.truncated).toBe(true);
			expect(result.omittedLines).toBe(rawLineCount - 50);
			// Notice is a clean footer appended AFTER structuring.
			expect(result.text).toContain("DIFF TRUNCATED");
			// No block sliced off: every __new hunk__ has its __old hunk__.
			const news = result.text.split(STRUCTURED_HUNK_NEW).length - 1;
			const olds = result.text.split(STRUCTURED_HUNK_OLD).length - 1;
			expect(news).toBe(olds);
			expect(news).toBeGreaterThan(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
