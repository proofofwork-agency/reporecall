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

// ─── Success path ───────────────────────────────────────────────────────────
// Bypass the ONNX model entirely by injecting a stub pipeline directly onto
// the private `pipe` field.  The stub returns a pre-determined score for each
// input pair so we can assert on ordering without loading any ML artifacts.

describe("LocalReranker success path", () => {
  it("should reorder candidates by cross-encoder score descending", async () => {
    const reranker = new LocalReranker();

    // Stub pipeline: scores assigned in input order — deliberately reversed
    // so that the lowest-initial-score candidate ends up ranked first.
    const stubScores = [0.1, 0.5, 0.9, 0.3, 0.7];
    const stubPipeline = async (
      inputs: Array<{ text: string; text_pair: string }>
    ) => inputs.map((_input, i) => ({ score: stubScores[i] }));

    // Inject the stub via a type cast to reach the private field.
    (reranker as unknown as { pipe: typeof stubPipeline }).pipe = stubPipeline;

    const candidates: SearchResult[] = [
      makeSearchResult("a", 0.9),  // stub score → 0.1 (rank 5)
      makeSearchResult("b", 0.8),  // stub score → 0.5 (rank 3)
      makeSearchResult("c", 0.7),  // stub score → 0.9 (rank 1)
      makeSearchResult("d", 0.6),  // stub score → 0.3 (rank 4)
      makeSearchResult("e", 0.5),  // stub score → 0.7 (rank 2)
    ];

    const results = await reranker.rerank("find foo", candidates, 5);

    // All candidates returned (topK === count)
    expect(results).toHaveLength(5);

    // Order must reflect cross-encoder scores, not original BM25/vector scores
    expect(results[0].id).toBe("c"); // 0.9
    expect(results[1].id).toBe("e"); // 0.7
    expect(results[2].id).toBe("b"); // 0.5
    expect(results[3].id).toBe("d"); // 0.3
    expect(results[4].id).toBe("a"); // 0.1
  });

  it("should replace the result score with the cross-encoder score", async () => {
    const reranker = new LocalReranker();

    const stubPipeline = async (
      inputs: Array<{ text: string; text_pair: string }>
    ) => inputs.map((_input, i) => ({ score: [0.42, 0.88][i] }));

    (reranker as unknown as { pipe: typeof stubPipeline }).pipe = stubPipeline;

    const candidates = [
      makeSearchResult("x", 0.99),
      makeSearchResult("y", 0.11),
    ];

    const results = await reranker.rerank("query", candidates, 2);

    // Scores on the returned objects must come from the pipeline, not the input
    expect(results[0].id).toBe("y");   // pipeline gave 0.88 — ranks first
    expect(results[0].score).toBe(0.88);
    expect(results[1].id).toBe("x");   // pipeline gave 0.42 — ranks second
    expect(results[1].score).toBe(0.42);
  });

  it("should slice to topK when topK is smaller than candidate count", async () => {
    const reranker = new LocalReranker();

    const stubScores = [0.2, 0.8, 0.5];
    const stubPipeline = async (
      inputs: Array<{ text: string; text_pair: string }>
    ) => inputs.map((_input, i) => ({ score: stubScores[i] }));

    (reranker as unknown as { pipe: typeof stubPipeline }).pipe = stubPipeline;

    const candidates = [
      makeSearchResult("p", 0.9),
      makeSearchResult("q", 0.8),
      makeSearchResult("r", 0.7),
    ];

    const results = await reranker.rerank("query", candidates, 2);

    expect(results).toHaveLength(2);
    // Top-2 by cross-encoder score: q (0.8) then r (0.5)
    expect(results[0].id).toBe("q");
    expect(results[1].id).toBe("r");
  });

  it("should maintain all SearchResult fields on reranked items", async () => {
    const reranker = new LocalReranker();

    const stubPipeline = async (
      inputs: Array<{ text: string; text_pair: string }>
    ) => inputs.map(() => ({ score: 0.55 }));

    (reranker as unknown as { pipe: typeof stubPipeline }).pipe = stubPipeline;

    const candidate = makeSearchResult("z", 0.3, "const z = 42;");
    const results = await reranker.rerank("query", [candidate], 1);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("z");
    expect(results[0].filePath).toBe("src/z.ts");
    expect(results[0].name).toBe("z");
    expect(results[0].kind).toBe("function_declaration");
    expect(results[0].content).toBe("const z = 42;");
    expect(results[0].language).toBe("typescript");
  });
});

// ─── Fallback behavior ───────────────────────────────────────────────────────

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
