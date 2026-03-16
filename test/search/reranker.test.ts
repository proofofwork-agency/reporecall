import { describe, it, expect } from "vitest";
import { LocalReranker } from "../../src/search/reranker.js";
import type { SearchResult } from "../../src/search/types.js";

// 3J: Reranker fallback behavior

function makeSearchResult(id: string, score: number, content = "function foo() {}"): SearchResult {
  return {
    id,
    score,
    filePath: `src/${id}.ts`,
    name: id,
    kind: "function_declaration",
    startLine: 1,
    endLine: 10,
    content,
    language: "typescript",
  };
}

describe("LocalReranker fallback (3J)", () => {
  it("should return original order sliced to topK when pipeline fails to load", async () => {
    // Use a deliberately invalid model name to force load failure
    const reranker = new LocalReranker("nonexistent-model-that-will-not-load/xyz");

    const candidates: SearchResult[] = [
      makeSearchResult("a", 0.9),
      makeSearchResult("b", 0.8),
      makeSearchResult("c", 0.7),
      makeSearchResult("d", 0.6),
      makeSearchResult("e", 0.5),
    ];

    const topK = 3;
    const results = await reranker.rerank("test query", candidates, topK);

    // When model loading fails, should fall back to original order sliced to topK
    expect(results).toHaveLength(topK);
    expect(results[0].id).toBe("a");
    expect(results[1].id).toBe("b");
    expect(results[2].id).toBe("c");
  }, 30000);

  it("should return all candidates when topK exceeds candidate count on fallback", async () => {
    const reranker = new LocalReranker("nonexistent-model-that-will-not-load/xyz");

    const candidates: SearchResult[] = [
      makeSearchResult("x", 0.9),
      makeSearchResult("y", 0.8),
    ];

    const results = await reranker.rerank("query", candidates, 10);

    // Slice to topK=10 but only 2 candidates — should return all 2
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("x");
    expect(results[1].id).toBe("y");
  }, 30000);

  it("should return empty array when no candidates are provided on fallback", async () => {
    const reranker = new LocalReranker("nonexistent-model-that-will-not-load/xyz");

    const results = await reranker.rerank("query", [], 5);

    expect(results).toHaveLength(0);
  }, 30000);

  it("should cache failed state and not retry loading on subsequent calls", async () => {
    const reranker = new LocalReranker("nonexistent-model-that-will-not-load/xyz");

    const candidates = [
      makeSearchResult("p", 0.95),
      makeSearchResult("q", 0.85),
    ];

    // First call — triggers load attempt and failure
    const result1 = await reranker.rerank("first query", candidates, 2);
    expect(result1).toHaveLength(2);

    // Second call — should use cached failed state (no retry)
    const result2 = await reranker.rerank("second query", candidates, 1);
    expect(result2).toHaveLength(1);
    expect(result2[0].id).toBe("p");
  }, 30000);

  it("should preserve score values from original candidates in fallback output", async () => {
    const reranker = new LocalReranker("nonexistent-model-that-will-not-load/xyz");

    const candidates: SearchResult[] = [
      makeSearchResult("m", 0.77),
      makeSearchResult("n", 0.66),
    ];

    const results = await reranker.rerank("query", candidates, 5);

    expect(results[0].score).toBe(0.77);
    expect(results[1].score).toBe(0.66);
  }, 30000);
});
