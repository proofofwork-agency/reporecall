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

  it("skips oversized broad chunks instead of aborting later smaller chunks", () => {
    const results: SearchResult[] = [
      {
        ...makeResult("small1", 1.0),
        content: "function small1() { return true; }",
      },
      {
        ...makeResult("huge", 0.95),
        content: "x\n".repeat(5000),
      },
      {
        ...makeResult("small2", 0.9),
        content: "function small2() { return true; }",
      },
    ];

    const ctx = assembleContext(results, 220, {
      scoreFloorRatio: 0,
      compressionRank: 1,
    });

    const includedIds = ctx.chunks.map((chunk) => chunk.id);
    expect(includedIds).toContain("small1");
    expect(includedIds).toContain("small2");
  });

  it("covers distinct files before adding secondary chunks when diversity is requested", () => {
    const results: SearchResult[] = [
      { ...makeResult("target-main", 1), filePath: "src/target.ts" },
      { ...makeResult("target-helper", 0.98), filePath: "src/target.ts" },
      { ...makeResult("target-validator", 0.96), filePath: "src/target.ts" },
      { ...makeResult("dependency", 0.82), filePath: "src/dependency.ts" },
      { ...makeResult("caller", 0.8), filePath: "src/caller.ts" },
    ];

    const ctx = assembleContext(results, 100_000, {
      maxChunks: 3,
      scoreFloorRatio: 0,
      preferFileDiversity: true,
    });

    expect(ctx.chunks.map((chunk) => chunk.id)).toEqual([
      "target-main",
      "dependency",
      "caller",
    ]);
  });
});

describe("assembleContext — evidence compression", () => {
  function makeLargeResult(
    id: string,
    language: string,
    filePath: string,
    signature: string,
    bodyLine: string,
    score: number
  ): SearchResult {
    const filler = Array.from({ length: 70 }, (_, i) =>
      `  // filler implementation detail ${i} auth token route session`
    ).join("\n");
    return {
      id,
      score,
      filePath,
      name: id,
      kind: "function",
      startLine: 10,
      endLine: 90,
      content: `${signature}\n${bodyLine}\n${filler}\n}`,
      docstring: `Handles ${id}`,
      language,
    };
  }

  it("compresses lower-ranked multilingual chunks with reversible chunk refs", () => {
    const results: SearchResult[] = [
      makeLargeResult(
        "authController",
        "typescript",
        "src/auth/controller.ts",
        "export async function authController(req: Request) {",
        "  const token = req.headers.get('authorization');",
        1
      ),
      makeLargeResult(
        "verify_token",
        "python",
        "services/auth.py",
        "def verify_token(token: str):",
        "  raise ValueError('unauthorized token')",
        0.98
      ),
      makeLargeResult(
        "AuthRoute",
        "go",
        "cmd/server/auth.go",
        "func AuthRoute(router *gin.Engine) {",
        "  router.GET(\"/auth/callback\", callback)",
        0.97
      ),
      makeLargeResult(
        "check_session",
        "rust",
        "crates/auth/src/lib.rs",
        "pub fn check_session(token: &str) -> Result<(), AuthError> {",
        "  panic!(\"invalid auth token\")",
        0.96
      ),
    ];

    const ctx = assembleContext(results, 100_000, {
      scoreFloorRatio: 0,
      query: "auth token route",
      compressionRank: 1,
      contextCompressionEnabled: true,
      contextCompressionPreserveTopChunks: 1,
      contextCompressionMinChunkTokens: 1,
      contextCompressionTargetRatio: 0.95,
    });

    expect(ctx.text).toContain("export async function authController");
    expect(ctx.text).toContain("chunkId `verify_token`");
    expect(ctx.text).toContain("chunkId `AuthRoute`");
    expect(ctx.text).toContain("chunkId `check_session`");
    expect(ctx.text).toContain("L10: def verify_token");
    expect(ctx.text).toContain('"/auth/callback"');
    expect(ctx.compression?.compressedChunks).toBeGreaterThanOrEqual(3);
    expect(ctx.compression?.originalRefs.map((ref) => ref.chunkId)).toEqual([
      "verify_token",
      "AuthRoute",
      "check_session",
    ]);
    expect(ctx.compression?.tokensSaved).toBeGreaterThan(0);
  });

  it("can disable compression even when compressionRank is set", () => {
    const results = [
      makeLargeResult(
        "full_one",
        "typescript",
        "src/full.ts",
        "export function full_one() {",
        "  return '/auth/full';",
        1
      ),
      makeLargeResult(
        "full_two",
        "python",
        "src/full.py",
        "def full_two():",
        "  return '/auth/full'",
        0.99
      ),
    ];

    const ctx = assembleContext(results, 100_000, {
      scoreFloorRatio: 0,
      compressionRank: 1,
      contextCompressionEnabled: false,
      contextCompressionMinChunkTokens: 1,
    });

    expect(ctx.text).toContain("```python");
    expect(ctx.text).toContain("def full_two");
    expect(ctx.text).not.toContain("chunkId `full_two`");
    expect(ctx.compression?.compressedChunks).toBe(0);
  });

  it("lets route compressionRank override global preserved chunk count", () => {
    const results: SearchResult[] = [
      makeLargeResult("primary", "typescript", "src/primary.ts", "export function primary() {", "  return '/auth/primary';", 1),
      makeLargeResult("secondary", "typescript", "src/secondary.ts", "export function secondary() {", "  return '/auth/secondary';", 0.99),
      makeLargeResult("third", "typescript", "src/third.ts", "export function third() {", "  return '/auth/third';", 0.98),
    ];

    const ctx = assembleContext(results, 100_000, {
      scoreFloorRatio: 0,
      query: "auth route",
      compressionRank: 1,
      contextCompressionEnabled: true,
      contextCompressionPreserveTopChunks: 3,
      contextCompressionMinChunkTokens: 1,
      contextCompressionTargetRatio: 0.95,
    });

    expect(ctx.text).toContain("export function primary");
    expect(ctx.text).toContain("chunkId `secondary`");
    expect(ctx.text).toContain("chunkId `third`");
    expect(ctx.compression?.originalRefs.map((ref) => ref.chunkId)).toEqual(["secondary", "third"]);
  });
});

describe("assembleContext — directive header", () => {
  it("includes directive header by default", () => {
    const results = [makeResult("a", 1.0)];
    const ctx = assembleContext(results, 100_000);
    expect(ctx.text).toContain("Answer from this context first. Only fetch files NOT listed above.");
    expect(ctx.text).toContain("> Files included:");
  });

  it("omits directive header when disabled", () => {
    const results = [makeResult("a", 1.0)];
    const ctx = assembleContext(results, 100_000, { directiveHeader: false });
    expect(ctx.text).not.toContain("Do not attempt to read files");
    expect(ctx.text).toContain("## Relevant codebase context");
  });
});

describe("assembleContext — summary section", () => {
  it("includes chunk content without summary line", () => {
    const results = [
      makeResult("createServer", 1.0),
      makeResult("handleRequest", 0.8),
    ];
    const ctx = assembleContext(results, 100_000, { scoreFloorRatio: 0 });
    expect(ctx.text).not.toContain("**Found:**");
    expect(ctx.text).toContain("createServer");
    expect(ctx.text).toContain("handleRequest");
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
