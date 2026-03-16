import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { assembleContext } from "../../src/search/context-assembler.js";
import type { SearchResult } from "../../src/search/types.js";

function makeResult(content: string, score = 1.0): SearchResult {
  return {
    id: "test-id",
    score,
    filePath: "test.ts",
    name: "testFn",
    kind: "function",
    startLine: 1,
    endLine: 10,
    content,
    language: "typescript",
  };
}

describe("factExtractor regex safety", () => {
  it("valid safe patterns work normally", () => {
    const results = [makeResult('const PORT = 3000;\nconst HOST = "localhost";')];
    const ctx = assembleContext(results, 4000, {
      query: "what port is used",
      factExtractors: [
        { keyword: "port", pattern: "PORT\\s*=\\s*(\\d+)", label: "Port" },
      ],
    });
    expect(ctx.text).toContain("Port: 3000");
  });

  it("invalid syntax patterns are caught and skipped", () => {
    const results = [makeResult("some content")];
    // Invalid regex: unmatched parenthesis
    const ctx = assembleContext(results, 4000, {
      query: "find stuff",
      factExtractors: [
        { keyword: "stuff", pattern: "(unclosed", label: "Bad" },
      ],
    });
    // Should not throw, just skip
    expect(ctx.text).not.toContain("Bad:");
  });

  it("extraction respects match count limit", () => {
    // Create content with many matches
    const manyMatches = Array.from({ length: 200 }, (_, i) => `VAL=(item${i})`).join("\n");
    const results = [makeResult(manyMatches)];
    const ctx = assembleContext(results, 100000, {
      query: "find values",
      factExtractors: [
        { keyword: "values", pattern: "VAL=\\(([^)]+)\\)", label: "Values" },
      ],
    });
    // Should have at most 100 matches
    if (ctx.text.includes("Values:")) {
      const valuesLine = ctx.text.split("\n").find((l) => l.includes("Values:"))!;
      const matchCount = valuesLine.split(",").length;
      expect(matchCount).toBeLessThanOrEqual(100);
    }
  });
});
