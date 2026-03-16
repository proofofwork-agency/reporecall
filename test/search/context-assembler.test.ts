import { describe, it, expect } from "vitest";
import { assembleContext } from "../../src/search/context-assembler.js";
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

describe("assembleContext — score floor", () => {
  it("excludes results below scoreFloorRatio of the top result", () => {
    const results = [
      makeResult("a", 1.0),
      makeResult("b", 0.8),
      makeResult("c", 0.6),
      makeResult("d", 0.4),
      makeResult("e", 0.2),
    ];

    const ctx = assembleContext(results, 100_000, 0.5);

    // Score floor = 1.0 * 0.5 = 0.5. Only a (1.0), b (0.8), c (0.6) should be included.
    const includedIds = ctx.chunks.map((c) => c.id);
    expect(includedIds).toContain("a");
    expect(includedIds).toContain("b");
    expect(includedIds).toContain("c");
    expect(includedIds).not.toContain("d");
    expect(includedIds).not.toContain("e");
  });

  it("includes all results when scoreFloorRatio is 0", () => {
    const results = [
      makeResult("a", 1.0),
      makeResult("b", 0.1),
    ];

    const ctx = assembleContext(results, 100_000, 0);
    expect(ctx.chunks).toHaveLength(2);
  });

  it("defaults to 0.5 scoreFloorRatio", () => {
    const results = [
      makeResult("a", 1.0),
      makeResult("b", 0.4), // below 0.5 floor
    ];

    const ctx = assembleContext(results, 100_000);
    expect(ctx.chunks).toHaveLength(1);
    expect(ctx.chunks[0].id).toBe("a");
  });
});

describe("assembleContext — maxChunks", () => {
  it("caps chunks at maxChunks", () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeResult(`chunk${i}`, 1.0 - i * 0.01)
    );

    const ctx = assembleContext(results, 100_000, { maxChunks: 3, scoreFloorRatio: 0 });
    expect(ctx.chunks).toHaveLength(3);
  });

  it("respects both maxChunks and budget", () => {
    // Create results with enough content to fill budget
    const results = Array.from({ length: 10 }, (_, i) =>
      makeResult(`chunk${i}`, 1.0 - i * 0.01)
    );

    // Use a very small budget that allows ~2 chunks, but maxChunks=5
    // Each chunk is roughly 30-40 tokens, header ~20 tokens
    const ctx = assembleContext(results, 100_000, { maxChunks: 2, scoreFloorRatio: 0 });
    expect(ctx.chunks).toHaveLength(2);
  });
});

describe("assembleContext — directive header", () => {
  it("includes directive header by default", () => {
    const results = [makeResult("a", 1.0)];
    const ctx = assembleContext(results, 100_000);
    expect(ctx.text).toContain("If a `Direct facts` section is present and it answers the question, answer directly from it.");
  });

  it("omits directive header when disabled", () => {
    const results = [makeResult("a", 1.0)];
    const ctx = assembleContext(results, 100_000, { directiveHeader: false });
    expect(ctx.text).not.toContain("Do not attempt to read files");
    expect(ctx.text).toContain("## Relevant codebase context");
  });
});

describe("assembleContext — summary section", () => {
  it("includes summary section with chunk names", () => {
    const results = [
      makeResult("createServer", 1.0),
      makeResult("handleRequest", 0.8),
    ];
    const ctx = assembleContext(results, 100_000, { scoreFloorRatio: 0 });
    expect(ctx.text).toContain("**Found:**");
    expect(ctx.text).toContain("`createServer` (function, src/createServer.ts:1-5)");
    expect(ctx.text).toContain("`handleRequest` (function, src/handleRequest.ts:1-5)");
  });

  it("extracts built-in direct facts for MCP tool queries", () => {
    const results: SearchResult[] = [
      {
        id: "mcp",
        score: 1,
        filePath: "src/daemon/mcp-server.ts",
        name: "createMCPServer",
        kind: "function",
        startLine: 1,
        endLine: 20,
        content:
          'server.registerTool("search_code", {});\nserver.registerTool("get_stats", {});',
        language: "typescript",
      },
    ];

    const ctx = assembleContext(results, 100_000, {
      scoreFloorRatio: 0,
      query: "What MCP tools are exposed?",
    });

    expect(ctx.text).toContain("## Direct facts");
    expect(ctx.text).toContain("Exposed tools: search_code, get_stats");
  });

  it("returns no direct facts for unrelated queries when factExtractors is empty", () => {
    const results: SearchResult[] = [
      {
        id: "mcp",
        score: 1,
        filePath: "src/daemon/mcp-server.ts",
        name: "createMCPServer",
        kind: "function",
        startLine: 1,
        endLine: 20,
        content:
          'server.registerTool("search_code", {});',
        language: "typescript",
      },
    ];

    const ctx = assembleContext(results, 100_000, {
      scoreFloorRatio: 0,
      query: "How does ranking work?",
      factExtractors: [],
    });

    expect(ctx.text).not.toContain("## Direct facts");
  });
});
