import { describe, it, expect } from "vitest";
import { extractSemanticFeatures } from "../../src/analysis/semantic-features.js";
import type { CodeChunk } from "../../src/parser/types.js";
import type { CallEdge } from "../../src/analysis/call-graph.js";

type FeatureChunk = CodeChunk & { indexedAt: string; fileMtime?: string };

function makeFeatureChunk(
  overrides: Partial<FeatureChunk> = {}
): FeatureChunk {
  return {
    id: "chunk-1",
    filePath: "src/predicates.ts",
    name: "someFunction",
    kind: "function",
    content: "function someFunction() { return true; }",
    startLine: 1,
    endLine: 5,
    language: "typescript",
    indexedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCallEdge(overrides: Partial<CallEdge> = {}): CallEdge {
  return {
    sourceChunkId: "caller-1",
    targetName: "foo",
    callType: "call",
    filePath: "src/caller.ts",
    line: 1,
    ...overrides,
  };
}

describe("semantic-features predicate boundary", () => {
  // regression: isPredicate must require a camelCase/underscore boundary
  // after the prefix so island/checkout/canvas are not classified as predicates
  it("classifies isAuthenticated as a predicate but not island/checkout/canvas", () => {
    const chunks: FeatureChunk[] = [
      makeFeatureChunk({
        id: "chk-auth",
        name: "isAuthenticated",
        content: "function isAuthenticated(req): boolean { if (req.user) return true; return false; }",
      }),
      makeFeatureChunk({
        id: "chk-island",
        name: "island",
        content: "function island(geometry) { return geometry.area; }",
      }),
      makeFeatureChunk({
        id: "chk-checkout",
        name: "checkout",
        content: "function checkout(cart) { return cart.total; }",
      }),
      makeFeatureChunk({
        id: "chk-canvas",
        name: "canvas",
        content: "function canvas(width, height) { return { width, height }; }",
      }),
    ];

    const { chunkFeatures } = extractSemanticFeatures(chunks, [], new Map());

    const auth = chunkFeatures.find((f) => f.chunkId === "chk-auth")!;
    const island = chunkFeatures.find((f) => f.chunkId === "chk-island")!;
    const checkout = chunkFeatures.find((f) => f.chunkId === "chk-checkout")!;
    const canvas = chunkFeatures.find((f) => f.chunkId === "chk-canvas")!;

    expect(auth.isPredicate).toBe(true);
    expect(island.isPredicate).toBe(false);
    expect(checkout.isPredicate).toBe(false);
    expect(canvas.isPredicate).toBe(false);
  });

  it("counts only isAuthenticated in file-level predicateCount", () => {
    const chunks: FeatureChunk[] = [
      makeFeatureChunk({
        id: "chk-auth",
        name: "isAuthenticated",
        filePath: "src/auth.ts",
        content: "function isAuthenticated(): boolean { return true; }",
      }),
      makeFeatureChunk({
        id: "chk-island",
        name: "island",
        filePath: "src/auth.ts",
        content: "function island() { return 1; }",
      }),
      makeFeatureChunk({
        id: "chk-checkout",
        name: "checkout",
        filePath: "src/auth.ts",
        content: "function checkout() { return 1; }",
      }),
      makeFeatureChunk({
        id: "chk-canvas",
        name: "canvas",
        filePath: "src/auth.ts",
        content: "function canvas() { return 1; }",
      }),
    ];

    const { fileFeatures } = extractSemanticFeatures(chunks, [], new Map());
    const fileFeature = fileFeatures.find((f) => f.filePath === "src/auth.ts")!;

    // regression: only isAuthenticated should contribute, not the false positives
    expect(fileFeature.predicateCount).toBe(1);
  });

  it("accepts other valid predicate prefixes with proper boundary", () => {
    const chunks: FeatureChunk[] = [
      makeFeatureChunk({
        id: "chk-has",
        name: "hasPermission",
        content: "function hasPermission(): boolean { return true; }",
      }),
      makeFeatureChunk({
        id: "chk-can",
        name: "canEdit",
        content: "function canEdit(): boolean { return true; }",
      }),
      makeFeatureChunk({
        id: "chk-should",
        name: "shouldRetry",
        content: "function shouldRetry(): boolean { return true; }",
      }),
    ];

    const { chunkFeatures } = extractSemanticFeatures(chunks, [], new Map());

    expect(chunkFeatures.find((f) => f.chunkId === "chk-has")!.isPredicate).toBe(true);
    expect(chunkFeatures.find((f) => f.chunkId === "chk-can")!.isPredicate).toBe(true);
    expect(chunkFeatures.find((f) => f.chunkId === "chk-should")!.isPredicate).toBe(true);
  });

  it("does not classify test/doc/registry functions as predicates even with matching names", () => {
    const chunks: FeatureChunk[] = [
      makeFeatureChunk({
        id: "chk-test",
        name: "isAuthenticated",
        filePath: "test/auth.test.ts",
        content: "function isAuthenticated() { return true; }",
      }),
      makeFeatureChunk({
        id: "chk-doc",
        name: "isAuthenticated",
        filePath: "docs/auth.md",
        content: "function isAuthenticated() { return true; }",
      }),
    ];

    const { chunkFeatures } = extractSemanticFeatures(chunks, [], new Map());

    expect(chunkFeatures.find((f) => f.chunkId === "chk-test")!.isPredicate).toBe(false);
    expect(chunkFeatures.find((f) => f.chunkId === "chk-doc")!.isPredicate).toBe(false);
  });

  it("counts callsPredicateCount for a caller that calls isAuthenticated", () => {
    const callerChunk = makeFeatureChunk({
      id: "caller-chunk",
      name: "handleRequest",
      content: "function handleRequest() { if (isAuthenticated()) return true; }",
    });

    const edges: CallEdge[] = [
      makeCallEdge({ sourceChunkId: "caller-chunk", targetName: "isAuthenticated" }),
    ];

    const { chunkFeatures } = extractSemanticFeatures(
      [callerChunk],
      edges,
      new Map()
    );

    const caller = chunkFeatures.find((f) => f.chunkId === "caller-chunk")!;
    expect(caller.callsPredicateCount).toBe(1);
  });
});
