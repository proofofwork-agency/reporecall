import { describe, it, expect } from "vitest";
import { assembleDeepRouteContext } from "../../src/search/context-assembler.js";
import type { SearchResult } from "../../src/search/types.js";

function makeResult(id: string, score: number): SearchResult {
  return {
    id,
    score,
    filePath: `src/${id}.ts`,
    name: id,
    kind: "function",
    startLine: 1,
    endLine: 5,
    content: `function ${id}() { return true; }`,
    language: "typescript",
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("assembleDeepRouteContext — duplicate file-list fix", () => {
  // regression: the deep route header rebuilds its own file list, but the base
  // assembleContext output still carried its own "> Files included:" line,
  // emitting the file list twice.
  it("emits the \"> Files included:\" line exactly once", () => {
    const chunks = [
      makeResult("alpha", 1.0),
      makeResult("beta", 0.9),
      makeResult("gamma", 0.8),
    ];

    const ctx = assembleDeepRouteContext(chunks, 2000);

    expect(countOccurrences(ctx.text, "> Files included:")).toBe(1);
  });

  it("returns a finite positive token count and the deep route style", () => {
    const chunks = [
      makeResult("alpha", 1.0),
      makeResult("beta", 0.9),
    ];

    const ctx = assembleDeepRouteContext(chunks, 2000);

    expect(Number.isFinite(ctx.tokenCount)).toBe(true);
    expect(ctx.tokenCount).toBeGreaterThan(0);
    expect(ctx.routeStyle).toBe("deep");
  });
});
