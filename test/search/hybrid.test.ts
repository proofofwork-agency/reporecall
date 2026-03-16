import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "path";
import { mkdirSync, rmSync } from "fs";
import { reciprocalRankFusion } from "../../src/search/ranker.js";
import { assembleContext } from "../../src/search/context-assembler.js";
import { MetadataStore } from "../../src/storage/metadata-store.js";
import { FTSStore } from "../../src/storage/fts-store.js";
import { NullEmbedder } from "../../src/indexer/null-embedder.js";
import type { SearchResult } from "../../src/search/types.js";

describe("ranker", () => {
  it("should fuse vector and keyword rankings", () => {
    const vectorResults = [
      { id: "a", score: 0.95 },
      { id: "b", score: 0.85 },
      { id: "c", score: 0.75 },
    ];

    const keywordResults = [
      { id: "b", rank: -10 },
      { id: "d", rank: -8 },
      { id: "a", rank: -5 },
    ];

    const ranked = reciprocalRankFusion(vectorResults, keywordResults, {
      vectorWeight: 0.5,
      keywordWeight: 0.3,
      recencyWeight: 0.0,
      k: 60,
    });

    // Both a and b appear in both lists, should score higher
    const ids = ranked.map((r) => r.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");

    // Items in both lists should have higher scores than items in only one
    const aScore = ranked.find((r) => r.id === "a")!.score;
    const dScore = ranked.find((r) => r.id === "d")!.score;
    expect(aScore).toBeGreaterThan(dScore);
  });

  it("should apply recency boost", () => {
    const vectorResults = [
      { id: "old", score: 0.9 },
      { id: "new", score: 0.8 },
    ];

    const now = new Date().toISOString();
    const ninetyDaysAgo = new Date(
      Date.now() - 91 * 24 * 60 * 60 * 1000
    ).toISOString();

    const ranked = reciprocalRankFusion(vectorResults, [], {
      vectorWeight: 0.3,
      keywordWeight: 0.0,
      recencyWeight: 0.7,
      k: 60,
      chunkDates: new Map([
        ["old", ninetyDaysAgo],
        ["new", now],
      ]),
    });

    // New item should rank higher due to recency
    expect(ranked[0].id).toBe("new");
  });

  it("should boost code chunks over file chunks", () => {
    // doc chunk ranked higher by keyword search
    const keywordResults = [
      { id: "doc", rank: -10 },
      { id: "code", rank: -5 },
    ];

    const ranked = reciprocalRankFusion([], keywordResults, {
      vectorWeight: 0.0,
      keywordWeight: 1.0,
      recencyWeight: 0.0,
      k: 60,
      chunkKinds: new Map([
        ["doc", "file"],
        ["code", "function_declaration"],
      ]),
      codeBoostFactor: 2.0,
    });

    // Code chunk should outrank doc chunk despite lower keyword rank
    expect(ranked[0].id).toBe("code");
  });

  it("should not change ordering when codeBoostFactor is 1.0", () => {
    const keywordResults = [
      { id: "doc", rank: -10 },
      { id: "code", rank: -5 },
    ];

    const ranked = reciprocalRankFusion([], keywordResults, {
      vectorWeight: 0.0,
      keywordWeight: 1.0,
      recencyWeight: 0.0,
      k: 60,
      chunkKinds: new Map([
        ["doc", "file"],
        ["code", "function_declaration"],
      ]),
      codeBoostFactor: 1.0,
    });

    // Original order preserved — doc ranked first by keyword
    expect(ranked[0].id).toBe("doc");
  });
});

describe("context-assembler", () => {
  it("should assemble context within token budget", () => {
    const results: SearchResult[] = [
      {
        id: "1",
        score: 0.9,
        filePath: "src/auth.ts",
        name: "validateSession",
        kind: "function_declaration",
        startLine: 1,
        endLine: 10,
        content: "export function validateSession() { return true; }",
        language: "typescript",
      },
      {
        id: "2",
        score: 0.8,
        filePath: "src/db.ts",
        name: "connect",
        kind: "function_declaration",
        startLine: 5,
        endLine: 15,
        content: "export function connect() { /* long content */ }",
        language: "typescript",
      },
    ];

    const assembled = assembleContext(results, 1000);

    expect(assembled.text).toContain("validateSession");
    expect(assembled.tokenCount).toBeLessThanOrEqual(1000);
    expect(assembled.chunks.length).toBeGreaterThan(0);
  });

  it("should group chunks by file", () => {
    const results: SearchResult[] = [
      {
        id: "1",
        score: 0.9,
        filePath: "src/auth.ts",
        name: "fn1",
        kind: "function",
        startLine: 1,
        endLine: 5,
        content: "function fn1() {}",
        language: "typescript",
      },
      {
        id: "2",
        score: 0.85,
        filePath: "src/auth.ts",
        name: "fn2",
        kind: "function",
        startLine: 10,
        endLine: 15,
        content: "function fn2() {}",
        language: "typescript",
      },
    ];

    const assembled = assembleContext(results, 2000);

    // Should have single file header for grouped chunks
    const headerCount = (assembled.text.match(/### src\/auth\.ts/g) || [])
      .length;
    expect(headerCount).toBe(1);
  });
});

describe("HybridSearch", () => {
  // Minimal mocks
  function createMockEmbedder(dims = 384) {
    return {
      embed: async (texts: string[]) => texts.map(() => new Array(dims).fill(0.1)),
      dimensions: () => dims,
      isEnabled: () => dims > 0,
    };
  }

  function createMockVectorStore(results: Array<{ id: string; score: number }> = []) {
    return {
      search: async () => results,
      upsert: async () => {},
      removeByFile: async () => {},
      count: async () => results.length,
    };
  }

  function createMockFTSStore(results: Array<{ id: string; rank: number }> = []) {
    return {
      search: () => results,
      upsert: () => {},
      removeByFile: () => {},
      close: () => {},
    };
  }

  function createMockMetadataStore(chunks: Array<{
    id: string;
    filePath: string;
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    content: string;
    language: string;
    indexedAt: string;
    docstring?: string;
    parentName?: string;
  }> = []) {
    const chunkMap = new Map(chunks.map(c => [c.id, c]));
    return {
      getChunkScoringInfo: (ids: string[]) => ids.map(id => chunkMap.get(id)).filter(Boolean).map(c => ({
        id: c.id, filePath: c.filePath, name: c.name, kind: c.kind,
        parentName: c.parentName, indexedAt: c.indexedAt, fileMtime: undefined,
      })),
      getChunksByIds: (ids: string[]) => ids.map(id => chunkMap.get(id)).filter(Boolean),
      findCallers: () => [],
      findCallees: () => [],
      findChunksByNames: () => [],
      findSiblings: () => [],
      getTopCallTargets: () => [],
      close: () => {},
    };
  }

  function createConfig(overrides?: Partial<any>): any {
    return {
      projectRoot: "/tmp/test",
      dataDir: "/tmp/test/.memory",
      embeddingProvider: "local",
      embeddingModel: "test",
      embeddingDimensions: 384,
      ollamaUrl: "",
      extensions: [".ts"],
      ignorePatterns: [],
      maxFileSize: 100000,
      batchSize: 32,
      contextBudget: 8000,
      sessionBudget: 2000,
      searchWeights: { vector: 0.5, keyword: 0.3, recency: 0.2 },
      rrfK: 60,
      graphExpansion: false,
      graphDiscountFactor: 0.6,
      siblingExpansion: false,
      siblingDiscountFactor: 0.4,
      reranking: false,
      rerankingModel: "",
      rerankTopK: 25,
      codeBoostFactor: 1.5,
      testPenaltyFactor: 0.3,
      anonymousPenaltyFactor: 0.5,
      debounceMs: 2000,
      port: 37222,
      implementationPaths: ["src/", "lib/", "bin/"],
      factExtractors: [],
      ...overrides,
    };
  }

  it("should return results from vector and keyword search", async () => {
    const now = new Date().toISOString();
    const chunks = [
      { id: "a", filePath: "src/a.ts", name: "fnA", kind: "function_declaration", startLine: 1, endLine: 10, content: "function fnA() {}", language: "typescript", indexedAt: now },
      { id: "b", filePath: "src/b.ts", name: "fnB", kind: "function_declaration", startLine: 1, endLine: 5, content: "function fnB() {}", language: "typescript", indexedAt: now },
    ];

    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const search = new HybridSearch(
      createMockEmbedder() as any,
      createMockVectorStore([{ id: "a", score: 0.9 }]) as any,
      createMockFTSStore([{ id: "b", rank: -5 }]) as any,
      createMockMetadataStore(chunks) as any,
      createConfig()
    );

    const results = await search.search("test query");
    expect(results.length).toBeGreaterThan(0);
    const ids = results.map(r => r.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });

  it("should work in keyword-only mode", async () => {
    const now = new Date().toISOString();
    const chunks = [
      { id: "x", filePath: "src/x.ts", name: "fnX", kind: "function_declaration", startLine: 1, endLine: 10, content: "function fnX() {}", language: "typescript", indexedAt: now },
    ];

    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const search = new HybridSearch(
      createMockEmbedder(0) as any,
      createMockVectorStore([]) as any,
      createMockFTSStore([{ id: "x", rank: -5 }]) as any,
      createMockMetadataStore(chunks) as any,
      createConfig({ embeddingProvider: "keyword" })
    );

    const results = await search.search("test query");
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("x");
  });

  it("should assemble context within token budget", async () => {
    const now = new Date().toISOString();
    const chunks = [
      { id: "a", filePath: "src/a.ts", name: "fnA", kind: "function_declaration", startLine: 1, endLine: 10, content: "function fnA() { return 1; }", language: "typescript", indexedAt: now },
    ];

    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const search = new HybridSearch(
      createMockEmbedder() as any,
      createMockVectorStore([{ id: "a", score: 0.9 }]) as any,
      createMockFTSStore([]) as any,
      createMockMetadataStore(chunks) as any,
      createConfig()
    );

    const context = await search.searchWithContext("test query", 500);
    expect(context.text).toContain("fnA");
    expect(context.tokenCount).toBeLessThanOrEqual(500);
  });

  it("should prioritize implementation chunks and extract direct facts with configured extractors", async () => {
    const now = new Date().toISOString();
    const chunks = [
      {
        id: "doc",
        filePath: "README.md",
        name: "overview",
        kind: "file",
        startLine: 1,
        endLine: 20,
        content: "This project exposes MCP tools for Claude Code.",
        language: "markdown",
        indexedAt: now,
      },
      {
        id: "mcp",
        filePath: "src/daemon/mcp-server.ts",
        name: "createMCPServer",
        kind: "function_declaration",
        startLine: 1,
        endLine: 40,
        content:
          'server.registerTool("search_code", {});\nserver.registerTool("find_callees", {});',
        language: "typescript",
        indexedAt: now,
      },
    ];

    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const search = new HybridSearch(
      createMockEmbedder() as any,
      createMockVectorStore([
        { id: "doc", score: 0.95 },
        { id: "mcp", score: 0.8 },
      ]) as any,
      createMockFTSStore([
        { id: "doc", rank: -10 },
        { id: "mcp", rank: -8 },
      ]) as any,
      createMockMetadataStore(chunks) as any,
      createConfig({
        maxContextChunks: 5,
        factExtractors: [
          { keyword: "tool", pattern: 'registerTool\\(\\s*["\']([^"\']+)["\']', label: "Exposed tools" },
        ],
      })
    );

    const context = await search.searchWithContext("What MCP tools are exposed?", 2000);
    expect(context.chunks[0].filePath).toBe("src/daemon/mcp-server.ts");
    expect(context.text).toContain("## Direct facts");
    expect(context.text).toContain("search_code, find_callees");
  });

  it("should use configurable implementationPaths", async () => {
    const now = new Date().toISOString();
    const chunks = [
      {
        id: "custom",
        filePath: "app/services/auth.ts",
        name: "auth",
        kind: "function_declaration",
        startLine: 1,
        endLine: 10,
        content: "function auth() {}",
        language: "typescript",
        indexedAt: now,
      },
    ];

    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const search = new HybridSearch(
      createMockEmbedder() as any,
      createMockVectorStore([{ id: "custom", score: 0.9 }]) as any,
      createMockFTSStore([]) as any,
      createMockMetadataStore(chunks) as any,
      createConfig({ implementationPaths: ["app/"] })
    );

    const context = await search.searchWithContext("auth", 2000);
    // Should be treated as implementation chunk due to custom path
    expect(context.chunks.length).toBeGreaterThan(0);
    expect(context.chunks[0].filePath).toBe("app/services/auth.ts");
  });
});

// 3D: HybridSearch integration with real stores (keyword mode)
describe("HybridSearch integration with real stores (3D)", () => {
  const TEST_DATA_DIR = resolve(import.meta.dirname, "..", ".test-data-hybrid-3d");
  let metadata: MetadataStore;
  let fts: FTSStore;

  const now = new Date().toISOString();
  const fixtureChunks = [
    {
      id: "real-a",
      filePath: "src/auth.ts",
      name: "authenticateUser",
      kind: "function_declaration",
      startLine: 1,
      endLine: 15,
      content: "export function authenticateUser(token: string): boolean { return verify(token); }",
      language: "typescript",
      indexedAt: now,
    },
    {
      id: "real-b",
      filePath: "src/db.ts",
      name: "connectDatabase",
      kind: "function_declaration",
      startLine: 1,
      endLine: 10,
      content: "export function connectDatabase(url: string): Connection { return new Connection(url); }",
      language: "typescript",
      indexedAt: now,
    },
    {
      id: "real-c",
      filePath: "src/utils.ts",
      name: "formatDate",
      kind: "function_declaration",
      startLine: 1,
      endLine: 5,
      content: "export function formatDate(d: Date): string { return d.toISOString(); }",
      language: "typescript",
      indexedAt: now,
    },
  ];

  beforeEach(() => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    metadata = new MetadataStore(TEST_DATA_DIR);
    fts = new FTSStore(TEST_DATA_DIR);

    // Seed stores with fixture chunks
    for (const chunk of fixtureChunks) {
      metadata.upsertChunk(chunk);
      fts.upsert({
        id: chunk.id,
        name: chunk.name,
        filePath: chunk.filePath,
        content: chunk.content,
        kind: chunk.kind,
      });
    }
  });

  afterEach(() => {
    metadata.close();
    fts.close();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("should return correct results from keyword search using real stores", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");

    const nullEmbedder = new NullEmbedder();
    const mockVectorStore = {
      search: async () => [],
      upsert: async () => {},
      removeByFile: async () => {},
      removeByFiles: async () => {},
      count: async () => 0,
    };

    const config: any = {
      projectRoot: "/tmp/test",
      dataDir: TEST_DATA_DIR,
      embeddingProvider: "keyword",
      embeddingModel: "",
      embeddingDimensions: 0,
      ollamaUrl: "",
      extensions: [".ts"],
      ignorePatterns: [],
      maxFileSize: 100000,
      batchSize: 32,
      contextBudget: 8000,
      sessionBudget: 2000,
      searchWeights: { vector: 0, keyword: 0.7, recency: 0.3 },
      rrfK: 60,
      graphExpansion: false,
      graphDiscountFactor: 0.6,
      siblingExpansion: false,
      siblingDiscountFactor: 0.4,
      reranking: false,
      rerankingModel: "",
      rerankTopK: 25,
      codeBoostFactor: 1.5,
      testPenaltyFactor: 0.3,
      anonymousPenaltyFactor: 0.5,
      debounceMs: 2000,
      port: 37226,
      implementationPaths: ["src/", "lib/", "bin/"],
      factExtractors: [],
    };

    const search = new HybridSearch(
      nullEmbedder as any,
      mockVectorStore as any,
      fts as any,
      metadata as any,
      config
    );

    // Search for authenticateUser — should be the top result
    const results = await search.search("authenticateUser");
    expect(results.length).toBeGreaterThan(0);

    const ids = results.map((r) => r.id);
    expect(ids).toContain("real-a");

    // The result for real-a should have content hydrated from metadata
    const authResult = results.find((r) => r.id === "real-a");
    expect(authResult).toBeDefined();
    expect(authResult!.name).toBe("authenticateUser");
    expect(authResult!.filePath).toBe("src/auth.ts");
  });

  it("should find database-related chunks when querying connectDatabase", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");

    const nullEmbedder = new NullEmbedder();
    const mockVectorStore = {
      search: async () => [],
      upsert: async () => {},
      removeByFile: async () => {},
      removeByFiles: async () => {},
      count: async () => 0,
    };

    const config: any = {
      projectRoot: "/tmp/test",
      dataDir: TEST_DATA_DIR,
      embeddingProvider: "keyword",
      embeddingModel: "",
      embeddingDimensions: 0,
      ollamaUrl: "",
      extensions: [".ts"],
      ignorePatterns: [],
      maxFileSize: 100000,
      batchSize: 32,
      contextBudget: 8000,
      sessionBudget: 2000,
      searchWeights: { vector: 0, keyword: 0.7, recency: 0.3 },
      rrfK: 60,
      graphExpansion: false,
      graphDiscountFactor: 0.6,
      siblingExpansion: false,
      siblingDiscountFactor: 0.4,
      reranking: false,
      rerankingModel: "",
      rerankTopK: 25,
      codeBoostFactor: 1.5,
      testPenaltyFactor: 0.3,
      anonymousPenaltyFactor: 0.5,
      debounceMs: 2000,
      port: 37226,
      implementationPaths: ["src/", "lib/", "bin/"],
      factExtractors: [],
    };

    const search = new HybridSearch(
      nullEmbedder as any,
      mockVectorStore as any,
      fts as any,
      metadata as any,
      config
    );

    const results = await search.search("connectDatabase");
    expect(results.length).toBeGreaterThan(0);
    const ids = results.map((r) => r.id);
    expect(ids).toContain("real-b");
  });
});

// 3E: Graph and sibling expansion paths
describe("HybridSearch graph and sibling expansion (3E)", () => {
  function createConfig(overrides?: Partial<any>): any {
    return {
      projectRoot: "/tmp/test",
      dataDir: "/tmp/test/.memory",
      embeddingProvider: "local",
      embeddingModel: "test",
      embeddingDimensions: 4,
      ollamaUrl: "",
      extensions: [".ts"],
      ignorePatterns: [],
      maxFileSize: 100000,
      batchSize: 32,
      contextBudget: 8000,
      sessionBudget: 2000,
      searchWeights: { vector: 0.5, keyword: 0.3, recency: 0.2 },
      rrfK: 60,
      graphExpansion: false,
      graphDiscountFactor: 0.6,
      siblingExpansion: false,
      siblingDiscountFactor: 0.4,
      reranking: false,
      rerankingModel: "",
      rerankTopK: 25,
      codeBoostFactor: 1.5,
      testPenaltyFactor: 0.3,
      anonymousPenaltyFactor: 0.5,
      debounceMs: 2000,
      port: 37222,
      implementationPaths: ["src/", "lib/", "bin/"],
      factExtractors: [],
      ...overrides,
    };
  }

  const now = new Date().toISOString();

  it("should include caller chunks when graphExpansion is enabled", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");

    const primaryChunk = {
      id: "primary",
      filePath: "src/main.ts",
      name: "processData",
      kind: "function_declaration",
      startLine: 1,
      endLine: 20,
      content: "function processData() {}",
      language: "typescript",
      indexedAt: now,
    };
    const callerChunk = {
      id: "caller-chunk",
      filePath: "src/main.ts",
      name: "runPipeline",
      kind: "function_declaration",
      startLine: 25,
      endLine: 40,
      content: "function runPipeline() { processData(); }",
      language: "typescript",
      indexedAt: now,
    };
    const calleeChunk = {
      id: "callee-chunk",
      filePath: "src/main.ts",
      name: "helperFn",
      kind: "function_declaration",
      startLine: 45,
      endLine: 55,
      content: "function helperFn() {}",
      language: "typescript",
      indexedAt: now,
    };

    const chunkMap = new Map([
      [primaryChunk.id, primaryChunk],
      [callerChunk.id, callerChunk],
      [calleeChunk.id, calleeChunk],
    ]);

    const mockMetadata = {
      getChunkScoringInfo: (ids: string[]) =>
        ids
          .map((id) => chunkMap.get(id))
          .filter(Boolean)
          .map((c) => ({
            id: c!.id,
            filePath: c!.filePath,
            name: c!.name,
            kind: c!.kind,
            parentName: undefined,
            indexedAt: c!.indexedAt,
            fileMtime: undefined,
          })),
      getChunksByIds: (ids: string[]) =>
        ids.map((id) => chunkMap.get(id)).filter(Boolean),
      findCallers: (name: string) => {
        if (name === "processData") {
          return [{ chunkId: "caller-chunk", callerName: "runPipeline", filePath: "src/main.ts", line: 30 }];
        }
        return [];
      },
      findCallees: (name: string) => {
        if (name === "processData") {
          return [{ targetName: "helperFn", callType: "call", line: 10, filePath: "src/main.ts" }];
        }
        return [];
      },
      findChunksByNames: (names: string[]) => {
        return names
          .map((n) => [...chunkMap.values()].find((c) => c.name === n))
          .filter(Boolean);
      },
      findSiblings: () => [],
      getTopCallTargets: () => [],
      close: () => {},
    };

    const mockEmbedder = {
      embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      dimensions: () => 4,
      isEnabled: () => true,
    };
    const mockVectorStore = {
      search: async () => [{ id: "primary", score: 0.9 }],
      upsert: async () => {},
      removeByFile: async () => {},
      removeByFiles: async () => {},
      count: async () => 1,
    };
    const mockFTS = {
      search: () => [],
      upsert: () => {},
      removeByFile: () => {},
      close: () => {},
    };

    const search = new HybridSearch(
      mockEmbedder as any,
      mockVectorStore as any,
      mockFTS as any,
      mockMetadata as any,
      createConfig({ graphExpansion: true })
    );

    const results = await search.search("processData");
    const resultIds = results.map((r) => r.id);

    // Primary result should be present
    expect(resultIds).toContain("primary");
    // Caller should be discovered via graph expansion
    expect(resultIds).toContain("caller-chunk");
  });

  it("should include sibling chunks when siblingExpansion is enabled", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");

    const primaryChunk = {
      id: "method-a",
      filePath: "src/service.ts",
      name: "methodA",
      kind: "method_definition",
      startLine: 5,
      endLine: 15,
      content: "methodA() { return 1; }",
      language: "typescript",
      indexedAt: now,
      parentName: "MyService",
    };
    const siblingChunk = {
      id: "method-b",
      filePath: "src/service.ts",
      name: "methodB",
      kind: "method_definition",
      startLine: 20,
      endLine: 30,
      content: "methodB() { return 2; }",
      language: "typescript",
      indexedAt: now,
      parentName: "MyService",
    };

    const chunkMap = new Map([
      [primaryChunk.id, primaryChunk],
      [siblingChunk.id, siblingChunk],
    ]);

    const mockMetadata = {
      getChunkScoringInfo: (ids: string[]) =>
        ids
          .map((id) => chunkMap.get(id))
          .filter(Boolean)
          .map((c) => ({
            id: c!.id,
            filePath: c!.filePath,
            name: c!.name,
            kind: c!.kind,
            parentName: (c as any).parentName,
            indexedAt: c!.indexedAt,
            fileMtime: undefined,
          })),
      getChunksByIds: (ids: string[]) =>
        ids.map((id) => chunkMap.get(id)).filter(Boolean),
      findCallers: () => [],
      findCallees: () => [],
      findChunksByNames: () => [],
      findSiblings: (parentName: string, filePath: string, excludeId: string) => {
        if (parentName === "MyService" && filePath === "src/service.ts") {
          return [siblingChunk].filter((c) => c.id !== excludeId);
        }
        return [];
      },
      getTopCallTargets: () => [],
      close: () => {},
    };

    const mockEmbedder = {
      embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      dimensions: () => 4,
      isEnabled: () => true,
    };
    const mockVectorStore = {
      search: async () => [{ id: "method-a", score: 0.9 }],
      upsert: async () => {},
      removeByFile: async () => {},
      removeByFiles: async () => {},
      count: async () => 1,
    };
    const mockFTS = {
      search: () => [],
      upsert: () => {},
      removeByFile: () => {},
      close: () => {},
    };

    const search = new HybridSearch(
      mockEmbedder as any,
      mockVectorStore as any,
      mockFTS as any,
      mockMetadata as any,
      createConfig({ siblingExpansion: true })
    );

    const results = await search.search("methodA");
    const resultIds = results.map((r) => r.id);

    // Primary result
    expect(resultIds).toContain("method-a");
    // Sibling should appear via sibling expansion
    expect(resultIds).toContain("method-b");
  });
});
