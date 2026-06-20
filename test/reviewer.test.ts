import { describe, expect, it } from "vitest";
import { parseReviewReport } from "../src/pr-gate/reviewer.js";

describe("parseReviewReport", () => {
  it("parses a well-formed review report", () => {
    const output = [
      "## Review Report",
      "STATUS: PASS",
      "CONFIDENCE: HIGH",
      "",
      "### Findings",
      "None.",
      "",
      "### What was verified",
      "- Foo",
      "",
      "### What could not be verified",
      "- Bar",
      "",
      "### Summary",
      "Looks good.",
    ].join("\n");

    const report = parseReviewReport(output);
    expect(report).not.toBeNull();
    expect(report?.status).toBe("PASS");
    expect(report?.confidence).toBe("HIGH");
    expect(report?.findings).toEqual([]);
    expect(report?.verified).toEqual(["Foo"]);
    expect(report?.unverifiable).toEqual(["Bar"]);
    expect(report?.summary).toBe("Looks good.");
  });

  it("returns null when the report marker is missing", () => {
    expect(parseReviewReport("just some chatter")).toBeNull();
  });

  it("returns null when STATUS is missing", () => {
    const output = "## Review Report\nCONFIDENCE: HIGH\n";
    expect(parseReviewReport(output)).toBeNull();
  });

  it("is case-insensitive and tolerant of markdown formatting", () => {
    const output = [
      "  ## Review Report  ",
      "**STATUS:** issues",
      "CONFIDENCE: medium",
      "",
      "### Findings",
      "None.",
      "",
      "### Summary",
      "OK.",
    ].join("\n");

    const report = parseReviewReport(output);
    expect(report).not.toBeNull();
    expect(report?.status).toBe("ISSUES");
    expect(report?.confidence).toBe("MEDIUM");
  });

  it("finds a report marker embedded in large output", () => {
    const prefix = "a".repeat(500_000);
    const suffix =
      "\n## Review Report\nSTATUS: PASS\nCONFIDENCE: LOW\n### Findings\nNone.\n### Summary\nOK.\n";
    const report = parseReviewReport(prefix + suffix);
    expect(report?.status).toBe("PASS");
    expect(report?.confidence).toBe("LOW");
  });
});
