import { describe, it, expect } from "vitest";
import {
  findQuantitativeClaims,
  isClearlyNonClaim,
  looksLikeQuantitativePerformanceClaim,
} from "../../scripts/quality/claim-detector.js";

/**
 * The claims gate is the mechanism that stops an unsupported number reaching the
 * README, so it failing quietly is worse than it not existing. It did fail
 * quietly: the percent pattern ended in `\b`, which needs a word character after
 * the `%`, and prose never puts one there. Every real claim slipped past for the
 * whole life of the gate while it kept reporting success.
 *
 * These tests exist to make that exact regression loud. The first block is the
 * important one — if `%` followed by a space, a comma or end-of-line ever stops
 * matching again, it fails here instead of in a release.
 */
describe("quantitative claim detection", () => {
  describe("the regression that made this gate inert", () => {
    // Each of these is a real published claim line, or its shape.
    it.each([
      ["% then a space", "costs a median of 75.4% fewer tokens than reading the files whole"],
      ["% then a space, twice", "Retrieval holds 91.6% context precision and 95.6% recall"],
      ["% then a comma", "precision 41%, recall 33%"],
      ["% at end of line", "median reduction 75.4%"],
      ["% then a period", "aggregate token saving of 86.4%."],
      ["% then a hyphen", "a 75%-token reduction across the cohort"],
      ["% with a space before it", "recall improved by 12 %"],
      ["a percentage range", "precision of 91.6-95.6% depending on route"],
    ])("detects a claim when the %s", (_label, line) => {
      expect(looksLikeQuantitativePerformanceClaim(line)).toBe(true);
    });
  });

  it("needs both a percentage and performance vocabulary", () => {
    expect(looksLikeQuantitativePerformanceClaim("battery is at 80% capacity")).toBe(false);
    expect(looksLikeQuantitativePerformanceClaim("recall is excellent")).toBe(false);
    expect(looksLikeQuantitativePerformanceClaim("indexed 1,306 files and 5,591 chunks")).toBe(false);
  });

  it("treats thresholds, examples and historical figures as non-claims", () => {
    for (const line of [
      "the gate requires 60% precision",
      "for example, 90% recall",
      "target: 85% recall",
      "threshold is 10% pollution",
      "v0.8.0 historically reported 70% precision",
      "token savings are insufficient evidence, not 3-8% measured",
    ]) {
      expect(isClearlyNonClaim(line)).toBe(true);
    }
  });

  it("does not excuse an ordinary claim as a non-claim", () => {
    expect(isClearlyNonClaim("costs a median of 75.4% fewer tokens")).toBe(false);
  });
});

describe("findQuantitativeClaims", () => {
  it("returns the marker for a registered claim and the line it is on", () => {
    const doc = [
      "# Evidence",
      "",
      "| Costs a median of 75.4% fewer tokens <!-- claim:context_cost_median_reduction --> | cmd |",
    ].join("\n");

    expect(findQuantitativeClaims(doc)).toEqual([
      { lineNumber: 3, marker: "context_cost_median_reduction" },
    ]);
  });

  it("flags an unmarked claim with no marker so the caller can reject it", () => {
    const doc = "Reporecall delivers a 99% token reduction in all cases.";

    expect(findQuantitativeClaims(doc)).toEqual([{ lineNumber: 1, marker: undefined }]);
  });

  it("ignores figures inside fenced blocks, which quote results without asserting them", () => {
    const doc = [
      "Reproduce it:",
      "",
      "```text",
      "median reduction   75.4%             aggregate        86.4%",
      "by route           R0 54.5%   R1 70.4%   R2 90.8%",
      "```",
      "",
      "Both figures come from the committed artifact.",
    ].join("\n");

    expect(findQuantitativeClaims(doc)).toEqual([]);
  });

  it("resumes detecting after a fence closes", () => {
    const doc = [
      "```bash",
      "npm run benchmark:context-cost",
      "```",
      "This release reaches 91.6% precision.",
    ].join("\n");

    expect(findQuantitativeClaims(doc)).toEqual([{ lineNumber: 4, marker: undefined }]);
  });

  it("handles CRLF documents, since Windows checkouts produce them", () => {
    const doc = "intro\r\nreaches 91.6% precision\r\n";

    expect(findQuantitativeClaims(doc)).toEqual([{ lineNumber: 2, marker: undefined }]);
  });

  it("finds every claim in a document, not just the first", () => {
    const doc = [
      "costs a median of 75.4% fewer tokens <!-- claim:context_cost_median_reduction -->",
      "holds 91.6% precision <!-- claim:retrieval_gates -->",
      "and an unregistered 99% latency win",
    ].join("\n");

    expect(findQuantitativeClaims(doc).map((claim) => claim.marker)).toEqual([
      "context_cost_median_reduction",
      "retrieval_gates",
      undefined,
    ]);
  });
});
