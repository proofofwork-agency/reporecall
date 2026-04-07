import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "path";
import { mkdirSync, readFileSync, rmSync } from "fs";
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

  it("uses direct file-backed target resolution for exact implementation lookups even without a seed", async () => {
    const now = new Date().toISOString();
    const endpointChunk = {
      id: "serve",
      filePath: "supabase/functions/generate-image/index.ts",
      name: "serve_handler",
      kind: "function_declaration",
      startLine: 1,
      endLine: 50,
      content: "export const serve_handler = () => {};",
      language: "typescript",
      indexedAt: now,
    };
    const distractor = {
      id: "controller",
      filePath: "supabase/functions/storyboard-controller/index.ts",
      name: "generate_image",
      kind: "method_definition",
      startLine: 10,
      endLine: 80,
      content: "function generate_image() {}",
      language: "typescript",
      indexedAt: now,
    };

    const metadata: any = {
      ...createMockMetadataStore([endpointChunk, distractor]),
      findChunksByFilePath: (filePath: string) =>
        [endpointChunk, distractor].filter((chunk) => chunk.filePath === filePath),
      resolveTargetAliases: (normalizedAliases: string[]) =>
        normalizedAliases.includes("generate image")
          ? [{
              target: {
                id: "endpoint:supabase/functions/generate-image/index.ts",
                kind: "endpoint",
                canonicalName: "generate-image",
                normalizedName: "generate image",
                filePath: "supabase/functions/generate-image/index.ts",
                ownerChunkId: "serve",
                subsystem: "functions",
                confidence: 0.98,
              },
              alias: "generate-image",
              normalizedAlias: "generate image",
              source: "slug",
              weight: 0.96,
            }]
          : [],
    };

    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const search = new HybridSearch(
      createMockEmbedder(0) as any,
      createMockVectorStore([]) as any,
      createMockFTSStore([{ id: "controller", rank: -10 }]) as any,
      metadata,
      createConfig({ embeddingProvider: "keyword" })
    );

    const context = await search.searchWithContext("where is generate-image implemented", 800);

    expect(context.chunks[0]?.filePath).toBe("supabase/functions/generate-image/index.ts");
    expect(context.text).toContain("supabase/functions/generate-image/index.ts");
    expect(context.text).not.toContain("supabase/functions/storyboard-controller/index.ts");
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
            startLine: c!.startLine,
            endLine: c!.endLine,
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

  it("builds a diverse broad-workflow bundle instead of collapsing to generic flow files", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const mockEmbedder = {
      embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      dimensions: () => 4,
      isEnabled: () => true,
    };
    const mockVectorStore = {
      search: async () => [
        { id: "generic-flow", score: 0.95 },
        { id: "use-auth", score: 0.9 },
        { id: "auth-callback", score: 0.88 },
        { id: "auth-page", score: 0.86 },
        { id: "auth-api", score: 0.84 },
        { id: "shared-errors", score: 0.82 },
      ],
      upsert: async () => {},
      removeByFile: async () => {},
      count: async () => 6,
    };
    const mockFTS = {
      search: () => [
        { id: "generic-flow", rank: -10 },
        { id: "use-auth", rank: -9 },
        { id: "auth-callback", rank: -8 },
        { id: "auth-page", rank: -7 },
        { id: "auth-api", rank: -6 },
        { id: "shared-errors", rank: -5 },
      ],
      upsert: () => {},
      removeByFile: () => {},
      close: () => {},
    };
    const chunks = [
      { id: "generic-flow", filePath: "src/lib/flow/flowService.ts", name: "flowService", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function flowService() {}", language: "typescript", indexedAt: now },
      { id: "auth-page", filePath: "src/pages/Auth.tsx", name: "AuthPage", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function AuthPage() {}", language: "typescript", indexedAt: now },
      { id: "use-auth", filePath: "src/hooks/useAuth.tsx", name: "useAuth", kind: "function_declaration", startLine: 1, endLine: 30, content: "export function useAuth() {}", language: "typescript", indexedAt: now },
      { id: "auth-callback", filePath: "src/pages/AuthCallback.tsx", name: "AuthCallback", kind: "function_declaration", startLine: 1, endLine: 25, content: "export function AuthCallback() {}", language: "typescript", indexedAt: now },
      { id: "auth-api", filePath: "supabase/functions/auth/index.ts", name: "authenticateRequest", kind: "function_declaration", startLine: 1, endLine: 25, content: "export function authenticateRequest() {}", language: "typescript", indexedAt: now },
      { id: "shared-errors", filePath: "src/lib/errors/index.ts", name: "AuthError", kind: "class_declaration", startLine: 1, endLine: 20, content: "export class AuthError extends Error {}", language: "typescript", indexedAt: now },
    ];
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const mockMetadata = {
      getChunkScoringInfo: (ids: string[]) =>
        ids
          .map((id) => chunkMap.get(id))
          .filter(Boolean)
          .map((chunk) => ({
            id: chunk!.id,
            filePath: chunk!.filePath,
            name: chunk!.name,
            kind: chunk!.kind,
            parentName: undefined,
            startLine: chunk!.startLine,
            endLine: chunk!.endLine,
            indexedAt: chunk!.indexedAt,
            fileMtime: undefined,
          })),
      getChunksByIds: (ids: string[]) =>
        ids.map((id) => chunkMap.get(id)).filter(Boolean),
      findCallers: () => [],
      findCallees: () => [],
      findChunksByNames: () => [],
      findSiblings: () => [],
      getTopCallTargets: () => [],
      close: () => {},
    };

    const search = new HybridSearch(
      mockEmbedder as any,
      mockVectorStore as any,
      mockFTS as any,
      mockMetadata as any,
      createConfig({ embeddingProvider: "local" })
    );

    const context = await search.searchWithContext(
      "add logging to every step in the authentication flow",
      4000
    );
    const names = context.chunks.map((chunk) => chunk.name);
    const diagnostics = search.getLastBroadSelectionDiagnostics();

    expect(diagnostics?.broadMode).toBe("workflow");
    expect(diagnostics?.dominantFamily).toBe("auth");
    if (diagnostics?.deliveryMode === "summary_only") {
      expect(context.chunks).toHaveLength(0);
      expect(diagnostics.deferredReason).toBeTruthy();
    } else {
      expect(names).toContain("AuthCallback");
      expect(names).toContain("authenticateRequest");
      expect(names).not.toEqual(["flowService"]);
      expect(names.filter((name) => name === "flowService").length).toBeLessThanOrEqual(1);
    }
  });

  it("uses typed file targets for broad workflow queries without a concept family", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const mockEmbedder = {
      embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      dimensions: () => 4,
      isEnabled: () => true,
    };
    const chunks = [
      { id: "mcp-cli", filePath: "src/cli/mcp.ts", name: "mcpCommand", kind: "function_declaration", startLine: 1, endLine: 30, content: "export function mcpCommand() {}", language: "typescript", indexedAt: now },
      { id: "mcp-server", filePath: "src/daemon/mcp-server.ts", name: "createMCPServer", kind: "function_declaration", startLine: 1, endLine: 40, content: "export function createMCPServer() {}", language: "typescript", indexedAt: now },
      { id: "serve", filePath: "src/cli/serve.ts", name: "serveCommand", kind: "function_declaration", startLine: 1, endLine: 30, content: "export function serveCommand() {}", language: "typescript", indexedAt: now },
      { id: "logger", filePath: "src/core/logger.ts", name: "getLogger", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function getLogger() {}", language: "typescript", indexedAt: now },
      { id: "prompt-context", filePath: "src/hooks/prompt-context.ts", name: "handlePromptContextDetailed", kind: "function_declaration", startLine: 1, endLine: 40, content: "export function handlePromptContextDetailed() {}", language: "typescript", indexedAt: now },
    ];
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const byPath = new Map<string, any[]>();
    for (const chunk of chunks) {
      const existing = byPath.get(chunk.filePath) ?? [];
      existing.push(chunk);
      byPath.set(chunk.filePath, existing);
    }

    const mockMetadata = {
      getChunkScoringInfo: (ids: string[]) =>
        ids.map((id) => chunkMap.get(id)).filter(Boolean).map((chunk) => ({
          id: chunk.id,
          filePath: chunk.filePath,
          name: chunk.name,
          kind: chunk.kind,
          parentName: undefined,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          indexedAt: chunk.indexedAt,
          fileMtime: undefined,
        })),
      getChunksByIds: (ids: string[]) => ids.map((id) => chunkMap.get(id)).filter(Boolean),
      findChunksByFilePath: (filePath: string) => byPath.get(filePath) ?? [],
      resolveTargetAliases: (aliases: string[], _limit?: number, kinds?: string[]) => {
        if (kinds && !kinds.includes("file_module")) return [];
        if (!aliases.some((alias) => alias === "mcp" || alias === "stdio" || alias === "hook")) return [];
        return [
          {
            target: { id: "file_module:src/cli/mcp.ts", kind: "file_module", canonicalName: "mcp", normalizedName: "mcp", filePath: "src/cli/mcp.ts", ownerChunkId: "mcp-cli", subsystem: "cli", confidence: 0.95 },
            alias: "mcp",
            normalizedAlias: "mcp",
            source: "file_path",
            weight: 0.96,
          },
          {
            target: { id: "file_module:src/daemon/mcp-server.ts", kind: "file_module", canonicalName: "mcp-server", normalizedName: "mcp server", filePath: "src/daemon/mcp-server.ts", ownerChunkId: "mcp-server", subsystem: "daemon", confidence: 0.95 },
            alias: "mcp",
            normalizedAlias: "mcp",
            source: "file_path",
            weight: 0.94,
          },
          {
            target: { id: "file_module:src/cli/serve.ts", kind: "file_module", canonicalName: "serve", normalizedName: "serve", filePath: "src/cli/serve.ts", ownerChunkId: "serve", subsystem: "cli", confidence: 0.9 },
            alias: "stdio",
            normalizedAlias: "stdio",
            source: "derived",
            weight: 0.82,
          },
        ];
      },
      findTargetsBySubsystem: () => [],
      getImportsForFile: () => [],
      findImporterFiles: () => [],
      findCallers: () => [],
      findCallees: () => [],
      findChunksByNames: () => [],
      findSiblings: () => [],
      getTopCallTargets: () => [],
      close: () => {},
    };
    const mockVectorStore = {
      search: async () => [
        { id: "prompt-context", score: 0.98 },
        { id: "logger", score: 0.92 },
        { id: "mcp-server", score: 0.89 },
      ],
      upsert: async () => {},
      removeByFile: async () => {},
      count: async () => 3,
    };
    const mockFTS = {
      search: () => [
        { id: "prompt-context", rank: -10 },
        { id: "logger", rank: -9 },
        { id: "mcp-server", rank: -7 },
      ],
      upsert: () => {},
      removeByFile: () => {},
      close: () => {},
    };

    const search = new HybridSearch(
      mockEmbedder as any,
      mockVectorStore as any,
      mockFTS as any,
      mockMetadata as any,
      createConfig({ embeddingProvider: "local" })
    );

    const context = await search.searchWithContext(
      "trace the full MCP request flow from stdio command to tool registration",
      4000
    );
    const paths = context.chunks.map((chunk) => chunk.filePath);

    expect(paths).toContain("src/cli/mcp.ts");
    expect(paths).toContain("src/daemon/mcp-server.ts");
  });

  it("keeps exact lookup hook context focused on the resolved target file", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const mockEmbedder = {
      embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      dimensions: () => 4,
      isEnabled: () => false,
    };
    const chunks = [
      { id: "auth-callback", filePath: "src/pages/AuthCallback.tsx", name: "AuthCallback", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function AuthCallback() {}", language: "typescript", indexedAt: now },
      { id: "show-1", filePath: "src/lib/execution/workflow/starter.ts", name: "showAutoSaveToast", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function showAutoSaveToast() {}", language: "typescript", indexedAt: now },
      { id: "show-2", filePath: "src/hooks/useWatermark.ts", name: "shouldShowWatermark", kind: "function_declaration", startLine: 1, endLine: 10, content: "export function shouldShowWatermark() {}", language: "typescript", indexedAt: now },
    ];
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const mockMetadata = {
      getChunkScoringInfo: (ids: string[]) =>
        ids.map((id) => chunkMap.get(id)).filter(Boolean).map((chunk) => ({
          id: chunk.id,
          filePath: chunk.filePath,
          name: chunk.name,
          kind: chunk.kind,
          parentName: undefined,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          indexedAt: chunk.indexedAt,
          fileMtime: undefined,
        })),
      getChunksByIds: (ids: string[]) => ids.map((id) => chunkMap.get(id)).filter(Boolean),
      findChunksByNames: (names: string[]) => chunks.filter((chunk) => names.includes(chunk.name)),
      findCallers: () => [],
      findCallees: () => [],
      findSiblings: () => [],
      getTopCallTargets: () => [],
      close: () => {},
    };
    const mockVectorStore = {
      search: async () => [],
      upsert: async () => {},
      removeByFile: async () => {},
      count: async () => chunks.length,
    };
    const mockFTS = {
      search: () => [
        { id: "show-1", rank: -10 },
        { id: "show-2", rank: -9 },
        { id: "auth-callback", rank: -7 },
      ],
      upsert: () => {},
      removeByFile: () => {},
      close: () => {},
    };

    const search = new HybridSearch(
      mockEmbedder as any,
      mockVectorStore as any,
      mockFTS as any,
      mockMetadata as any,
      createConfig({ embeddingProvider: "keyword" })
    );

    const context = await search.searchWithContext("show AuthCallback", 2000);
    expect(context.chunks.map((chunk) => chunk.filePath)).toEqual(["src/pages/AuthCallback.tsx"]);
  });

  it("keeps lifecycle workflow bundles centered on shutdown orchestration instead of storage-only file modules", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const mockEmbedder = {
      embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      dimensions: () => 4,
      isEnabled: () => true,
    };
    const chunks = [
      { id: "pipeline-close", filePath: "src/indexer/pipeline.ts", name: "closeAsync", kind: "method_definition", startLine: 1, endLine: 20, content: "async closeAsync(): Promise<void> {}", language: "typescript", indexedAt: now, parentName: "IndexingPipeline" },
      { id: "pipeline-stop", filePath: "src/indexer/pipeline.ts", name: "closeAndClearMerkle", kind: "method_definition", startLine: 21, endLine: 35, content: "async closeAndClearMerkle(): Promise<void> {}", language: "typescript", indexedAt: now, parentName: "IndexingPipeline" },
      { id: "runtime-stop", filePath: "src/daemon/memory/runtime.ts", name: "stop", kind: "method_definition", startLine: 1, endLine: 20, content: "async stop(): Promise<void> {}", language: "typescript", indexedAt: now, parentName: "MemoryRuntime" },
      { id: "serve-command", filePath: "src/cli/serve.ts", name: "serveCommand", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function serveCommand() {}", language: "typescript", indexedAt: now },
      { id: "vector-store", filePath: "src/storage/vector-store.ts", name: "VectorStore", kind: "class_declaration", startLine: 1, endLine: 20, content: "export class VectorStore {}", language: "typescript", indexedAt: now },
      { id: "fts-store", filePath: "src/storage/fts-store.ts", name: "FTSStore", kind: "class_declaration", startLine: 1, endLine: 20, content: "export class FTSStore {}", language: "typescript", indexedAt: now },
      { id: "metadata-store", filePath: "src/storage/metadata-store.ts", name: "MetadataStore", kind: "class_declaration", startLine: 1, endLine: 20, content: "export class MetadataStore {}", language: "typescript", indexedAt: now },
    ];
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const byPath = new Map<string, any[]>();
    for (const chunk of chunks) {
      const existing = byPath.get(chunk.filePath) ?? [];
      existing.push(chunk);
      byPath.set(chunk.filePath, existing);
    }

    const mockMetadata = {
      getChunkScoringInfo: (ids: string[]) =>
        ids.map((id) => chunkMap.get(id)).filter(Boolean).map((chunk) => ({
          id: chunk.id,
          filePath: chunk.filePath,
          name: chunk.name,
          kind: chunk.kind,
          parentName: chunk.parentName,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          indexedAt: chunk.indexedAt,
          fileMtime: undefined,
        })),
      getChunksByIds: (ids: string[]) => ids.map((id) => chunkMap.get(id)).filter(Boolean),
      findChunksByFilePath: (filePath: string) => byPath.get(filePath) ?? [],
      findChunksByNames: (names: string[]) => chunks.filter((chunk) => names.includes(chunk.name)),
      resolveTargetAliases: (aliases: string[], _limit?: number, kinds?: string[]) => {
        if (kinds && !kinds.includes("file_module")) return [];
        if (!aliases.includes("storage")) return [];
        return [
          {
            target: { id: "file_module:src/storage/vector-store.ts", kind: "file_module", canonicalName: "VectorStore", normalizedName: "vector store", filePath: "src/storage/vector-store.ts", ownerChunkId: "vector-store", subsystem: "storage", confidence: 0.95 },
            alias: "storage",
            normalizedAlias: "storage",
            source: "file_path",
            weight: 0.98,
          },
          {
            target: { id: "file_module:src/storage/fts-store.ts", kind: "file_module", canonicalName: "FTSStore", normalizedName: "fts store", filePath: "src/storage/fts-store.ts", ownerChunkId: "fts-store", subsystem: "storage", confidence: 0.95 },
            alias: "storage",
            normalizedAlias: "storage",
            source: "file_path",
            weight: 0.96,
          },
          {
            target: { id: "file_module:src/storage/metadata-store.ts", kind: "file_module", canonicalName: "MetadataStore", normalizedName: "metadata store", filePath: "src/storage/metadata-store.ts", ownerChunkId: "metadata-store", subsystem: "storage", confidence: 0.95 },
            alias: "storage",
            normalizedAlias: "storage",
            source: "file_path",
            weight: 0.95,
          },
        ];
      },
      findTargetsBySubsystem: () => [],
      getImportsForFile: () => [],
      findImporterFiles: () => [],
      findCallers: () => [],
      findCallees: () => [],
      findSiblings: () => [],
      getTopCallTargets: () => [],
      close: () => {},
    };

    const mockVectorStore = {
      search: async () => [
        { id: "vector-store", score: 0.98 },
        { id: "fts-store", score: 0.97 },
        { id: "metadata-store", score: 0.96 },
        { id: "pipeline-close", score: 0.84 },
        { id: "runtime-stop", score: 0.83 },
        { id: "serve-command", score: 0.82 },
      ],
      upsert: async () => {},
      removeByFile: async () => {},
      count: async () => 6,
    };
    const mockFTS = {
      search: () => [
        { id: "vector-store", rank: -10 },
        { id: "fts-store", rank: -9 },
        { id: "metadata-store", rank: -8 },
        { id: "pipeline-close", rank: -7 },
        { id: "runtime-stop", rank: -6 },
        { id: "serve-command", rank: -5 },
      ],
      upsert: () => {},
      removeByFile: () => {},
      close: () => {},
    };

    const search = new HybridSearch(
      mockEmbedder as any,
      mockVectorStore as any,
      mockFTS as any,
      mockMetadata as any,
      createConfig({
        embeddingProvider: "local",
        conceptBundles: [
          {
            kind: "lifecycle",
            pattern: "\\bgraceful\\s+shutdown\\b|\\bshutdown\\b|\\bstartup\\b|\\bteardown\\b|\\bdrain\\b|\\bclose\\s+async\\b",
            symbols: ["closeAsync", "stop", "serveCommand"],
            maxChunks: 6,
          },
        ],
      })
    );

    const context = await search.searchWithContext(
      "How does the system handle graceful shutdown across all storage layers?",
      4000
    );
    const paths = context.chunks.map((chunk) => chunk.filePath);
    const diagnostics = search.getLastBroadSelectionDiagnostics();

    expect(diagnostics?.broadMode).toBe("workflow");
    expect(diagnostics?.dominantFamily).toBe("lifecycle");
    if (diagnostics?.deliveryMode === "summary_only") {
      expect(context.chunks).toHaveLength(0);
      expect(diagnostics.deferredReason).toBeTruthy();
    } else {
      expect(paths).toContain("src/indexer/pipeline.ts");
      expect(paths).toContain("src/daemon/memory/runtime.ts");
    }
  });

  it("keeps logging workflow bundles centered on hook flow before observability sidecars", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const mockEmbedder = {
      embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      dimensions: () => 4,
      isEnabled: () => true,
    };
    const chunks = [
      { id: "prompt-context", filePath: "src/hooks/prompt-context.ts", name: "handlePromptContextDetailed", kind: "function_declaration", startLine: 1, endLine: 40, content: "export function handlePromptContextDetailed() {}", language: "typescript", indexedAt: now },
      { id: "session-start", filePath: "src/hooks/session-start.ts", name: "handleSessionStart", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function handleSessionStart() {}", language: "typescript", indexedAt: now },
      { id: "daemon-server", filePath: "src/daemon/server.ts", name: "createDaemonServer", kind: "function_declaration", startLine: 1, endLine: 60, content: "export function createDaemonServer() {}", language: "typescript", indexedAt: now },
      { id: "assembler", filePath: "src/search/context-assembler.ts", name: "assembleContext", kind: "function_declaration", startLine: 1, endLine: 40, content: "export function assembleContext() {}", language: "typescript", indexedAt: now },
      { id: "hybrid", filePath: "src/search/hybrid.ts", name: "prioritizeForHookContext", kind: "method_definition", startLine: 1, endLine: 40, content: "class HybridSearch { prioritizeForHookContext() {} }", language: "typescript", indexedAt: now },
      { id: "metrics", filePath: "src/daemon/metrics.ts", name: "incrementRequest", kind: "method_definition", startLine: 1, endLine: 20, content: "incrementRequest(endpoint: string): void {}", language: "typescript", indexedAt: now, parentName: "MetricsCollector" },
      { id: "logger", filePath: "src/core/logger.ts", name: "getLogger", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function getLogger() {}", language: "typescript", indexedAt: now },
      { id: "types", filePath: "src/search/types.ts", name: "HookDebugRecord", kind: "interface_declaration", startLine: 1, endLine: 15, content: "export interface HookDebugRecord {}", language: "typescript", indexedAt: now },
    ];
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const byPath = new Map<string, any[]>();
    for (const chunk of chunks) {
      const existing = byPath.get(chunk.filePath) ?? [];
      existing.push(chunk);
      byPath.set(chunk.filePath, existing);
    }

    const mockMetadata = {
      getChunkScoringInfo: (ids: string[]) =>
        ids.map((id) => chunkMap.get(id)).filter(Boolean).map((chunk) => ({
          id: chunk.id,
          filePath: chunk.filePath,
          name: chunk.name,
          kind: chunk.kind,
          parentName: chunk.parentName,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          indexedAt: chunk.indexedAt,
          fileMtime: undefined,
        })),
      getChunksByIds: (ids: string[]) => ids.map((id) => chunkMap.get(id)).filter(Boolean),
      findChunksByFilePath: (filePath: string) => byPath.get(filePath) ?? [],
      findChunksByNames: (names: string[]) => chunks.filter((chunk) => names.includes(chunk.name)),
      resolveTargetAliases: () => [],
      findTargetsBySubsystem: () => [],
      getImportsForFile: () => [],
      findImporterFiles: () => [],
      findCallers: () => [],
      findCallees: () => [],
      findSiblings: () => [],
      getTopCallTargets: () => [],
      close: () => {},
    };

    const mockVectorStore = {
      search: async () => [
        { id: "metrics", score: 0.98 },
        { id: "logger", score: 0.96 },
        { id: "prompt-context", score: 0.92 },
        { id: "session-start", score: 0.9 },
        { id: "daemon-server", score: 0.89 },
        { id: "assembler", score: 0.87 },
        { id: "hybrid", score: 0.86 },
      ],
      upsert: async () => {},
      removeByFile: async () => {},
      count: async () => 7,
    };
    const mockFTS = {
      search: () => [
        { id: "metrics", rank: -10 },
        { id: "logger", rank: -9 },
        { id: "prompt-context", rank: -8 },
        { id: "session-start", rank: -7 },
        { id: "daemon-server", rank: -6 },
        { id: "assembler", rank: -5 },
        { id: "hybrid", rank: -4 },
      ],
      upsert: () => {},
      removeByFile: () => {},
      close: () => {},
    };

    const search = new HybridSearch(
      mockEmbedder as any,
      mockVectorStore as any,
      mockFTS as any,
      mockMetadata as any,
      createConfig({ embeddingProvider: "local" })
    );

    const context = await search.searchWithContext(
      "add logging to every step in the hook request flow",
      4000
    );
    const paths = context.chunks.map((chunk) => chunk.filePath);

    expect(paths.slice(0, 3)).toContain("src/hooks/prompt-context.ts");
    expect(paths.slice(0, 3)).toContain("src/hooks/session-start.ts");
    expect(paths.slice(0, 4)).toContain("src/daemon/server.ts");
  });

  it("builds an inventory bundle from typed auth files instead of flow noise", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const mockEmbedder = {
      embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      dimensions: () => 4,
      isEnabled: () => true,
    };
    const chunks = [
      { id: "auth-page", filePath: "src/pages/Auth.tsx", name: "Auth", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function Auth() {}", language: "typescript", indexedAt: now },
      { id: "use-auth", filePath: "src/hooks/useAuth.tsx", name: "useAuth", kind: "function_declaration", startLine: 1, endLine: 30, content: "export function useAuth() {}", language: "typescript", indexedAt: now },
      { id: "auth-callback", filePath: "src/pages/AuthCallback.tsx", name: "AuthCallback", kind: "function_declaration", startLine: 1, endLine: 25, content: "export function AuthCallback() {}", language: "typescript", indexedAt: now },
      { id: "auth-modal", filePath: "src/components/AuthModal.tsx", name: "AuthModal", kind: "function_declaration", startLine: 1, endLine: 40, content: "export function AuthModal() {}", language: "typescript", indexedAt: now },
      { id: "auth-utils", filePath: "supabase/functions/_shared/auth-utils.ts", name: "getUserFromAuth", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function getUserFromAuth() {}", language: "typescript", indexedAt: now },
      { id: "storage-noise", filePath: "src/hooks/useStorageAnalytics.ts", name: "useStorageAnalytics", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function useStorageAnalytics() {}", language: "typescript", indexedAt: now },
      { id: "flow-noise", filePath: "src/lib/flow/typeGuards.ts", name: "isArtifact", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function isArtifact() {}", language: "typescript", indexedAt: now },
    ];
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const byPath = new Map<string, any[]>();
    for (const chunk of chunks) {
      const existing = byPath.get(chunk.filePath) ?? [];
      existing.push(chunk);
      byPath.set(chunk.filePath, existing);
    }

    const mockMetadata = {
      getChunkScoringInfo: (ids: string[]) =>
        ids.map((id) => chunkMap.get(id)).filter(Boolean).map((chunk) => ({
          id: chunk.id,
          filePath: chunk.filePath,
          name: chunk.name,
          kind: chunk.kind,
          parentName: undefined,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          indexedAt: chunk.indexedAt,
          fileMtime: undefined,
        })),
      getChunksByIds: (ids: string[]) => ids.map((id) => chunkMap.get(id)).filter(Boolean),
      findChunksByFilePath: (filePath: string) => byPath.get(filePath) ?? [],
      resolveTargetAliases: (_aliases: string[], _limit?: number, kinds?: string[]) => {
        if (kinds && !kinds.includes("file_module")) return [];
        return [
          {
            target: { id: "file_module:src/pages/Auth.tsx", kind: "file_module", canonicalName: "Auth", normalizedName: "auth", filePath: "src/pages/Auth.tsx", ownerChunkId: "auth-page", subsystem: "pages", confidence: 0.92 },
            alias: "auth",
            normalizedAlias: "auth",
            source: "file_path",
            weight: 0.96,
          },
          {
            target: { id: "file_module:src/hooks/useAuth.tsx", kind: "file_module", canonicalName: "useAuth", normalizedName: "use auth", filePath: "src/hooks/useAuth.tsx", ownerChunkId: "use-auth", subsystem: "hooks", confidence: 0.92 },
            alias: "auth",
            normalizedAlias: "auth",
            source: "file_path",
            weight: 0.96,
          },
          {
            target: { id: "file_module:src/pages/AuthCallback.tsx", kind: "file_module", canonicalName: "AuthCallback", normalizedName: "auth callback", filePath: "src/pages/AuthCallback.tsx", ownerChunkId: "auth-callback", subsystem: "pages", confidence: 0.92 },
            alias: "auth",
            normalizedAlias: "auth",
            source: "file_path",
            weight: 0.94,
          },
          {
            target: { id: "file_module:src/components/AuthModal.tsx", kind: "file_module", canonicalName: "AuthModal", normalizedName: "auth modal", filePath: "src/components/AuthModal.tsx", ownerChunkId: "auth-modal", subsystem: "components", confidence: 0.9 },
            alias: "auth",
            normalizedAlias: "auth",
            source: "file_path",
            weight: 0.9,
          },
        ];
      },
      findTargetsBySubsystem: () => [],
      getImportsForFile: (filePath: string) => {
        if (filePath === "src/hooks/useAuth.tsx") {
          return [
            {
              id: 1,
              filePath,
              importedName: "useStorageAnalytics",
              sourceModule: "../hooks/useStorageAnalytics",
              resolvedPath: "src/hooks/useStorageAnalytics.ts",
              isDefault: false,
              isNamespace: false,
            },
          ];
        }
        return [];
      },
      findImporterFiles: (resolvedPath: string) =>
        resolvedPath === "src/hooks/useAuth.tsx" ? ["src/hooks/useStorageAnalytics.ts"] : [],
      findCallers: () => [],
      findCallees: () => [],
      findChunksByNames: () => [],
      findSiblings: () => [],
      getTopCallTargets: () => [],
      close: () => {},
    };
    const mockVectorStore = {
      search: async () => [
        { id: "flow-noise", score: 0.98 },
        { id: "storage-noise", score: 0.94 },
        { id: "auth-page", score: 0.85 },
        { id: "use-auth", score: 0.84 },
        { id: "auth-callback", score: 0.83 },
      ],
      upsert: async () => {},
      removeByFile: async () => {},
      count: async () => 4,
    };
    const mockFTS = {
      search: () => [
        { id: "flow-noise", rank: -10 },
        { id: "storage-noise", rank: -8 },
        { id: "auth-page", rank: -7 },
        { id: "use-auth", rank: -6 },
        { id: "auth-callback", rank: -5 },
      ],
      upsert: () => {},
      removeByFile: () => {},
      close: () => {},
    };

    const search = new HybridSearch(
      mockEmbedder as any,
      mockVectorStore as any,
      mockFTS as any,
      mockMetadata as any,
      createConfig({ embeddingProvider: "local" })
    );

    const context = await search.searchWithContext("which files implement the authentication flow", 4000);
    const paths = context.chunks.map((chunk) => chunk.filePath);
    const diagnostics = search.getLastBroadSelectionDiagnostics();

    expect(diagnostics?.broadMode).toBe("inventory");
    expect(diagnostics?.dominantFamily).toBe("auth");
    if (diagnostics?.deliveryMode === "summary_only") {
      expect(context.chunks).toHaveLength(0);
      expect(diagnostics.deferredReason).toBeTruthy();
    } else {
      expect(paths).toContain("src/pages/Auth.tsx");
      expect(paths).toContain("src/hooks/useAuth.tsx");
      expect(paths).toContain("src/pages/AuthCallback.tsx");
      expect(paths).toContain("src/components/AuthModal.tsx");
      expect(paths).not.toContain("src/lib/flow/typeGuards.ts");
      expect(paths).not.toContain("src/hooks/useStorageAnalytics.ts");
    }
  });

  it("builds an auth workflow bundle without unrelated flow noise", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const mockEmbedder = {
      embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      dimensions: () => 4,
      isEnabled: () => true,
    };
    const chunks = [
      { id: "auth-page", filePath: "src/pages/Auth.tsx", name: "Auth", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function Auth() {}", language: "typescript", indexedAt: now },
      { id: "use-auth", filePath: "src/hooks/useAuth.tsx", name: "useAuth", kind: "function_declaration", startLine: 1, endLine: 30, content: "export function useAuth() {}", language: "typescript", indexedAt: now },
      { id: "auth-callback", filePath: "src/pages/AuthCallback.tsx", name: "AuthCallback", kind: "function_declaration", startLine: 1, endLine: 25, content: "export function AuthCallback() {}", language: "typescript", indexedAt: now },
      { id: "app", filePath: "src/App.tsx", name: "App", kind: "function_declaration", startLine: 1, endLine: 30, content: "export function App() {}", language: "typescript", indexedAt: now },
      { id: "auth-utils", filePath: "supabase/functions/_shared/auth-utils.ts", name: "getUserFromAuth", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function getUserFromAuth() {}", language: "typescript", indexedAt: now },
      { id: "flow-noise", filePath: "src/lib/flow/workflowApiAnalyzer.ts", name: "analyzeWorkflowForApi", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function analyzeWorkflowForApi() {}", language: "typescript", indexedAt: now },
      { id: "flow-noise-2", filePath: "src/lib/flow/typeGuards.ts", name: "isFlowNode", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function isFlowNode() {}", language: "typescript", indexedAt: now },
    ];
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const byPath = new Map<string, any[]>();
    for (const chunk of chunks) {
      const existing = byPath.get(chunk.filePath) ?? [];
      existing.push(chunk);
      byPath.set(chunk.filePath, existing);
    }

    const mockMetadata = {
      getChunkScoringInfo: (ids: string[]) =>
        ids.map((id) => chunkMap.get(id)).filter(Boolean).map((chunk) => ({
          id: chunk.id,
          filePath: chunk.filePath,
          name: chunk.name,
          kind: chunk.kind,
          parentName: undefined,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          indexedAt: chunk.indexedAt,
          fileMtime: undefined,
        })),
      getChunksByIds: (ids: string[]) => ids.map((id) => chunkMap.get(id)).filter(Boolean),
      findChunksByFilePath: (filePath: string) => byPath.get(filePath) ?? [],
      resolveTargetAliases: (_aliases: string[], _limit?: number, kinds?: string[]) => {
        if (kinds && !kinds.includes("file_module")) return [];
        return [
          {
            target: { id: "file_module:src/pages/Auth.tsx", kind: "file_module", canonicalName: "Auth", normalizedName: "auth", filePath: "src/pages/Auth.tsx", ownerChunkId: "auth-page", subsystem: "pages", confidence: 0.92 },
            alias: "auth",
            normalizedAlias: "auth",
            source: "file_path",
            weight: 0.96,
          },
          {
            target: { id: "file_module:src/hooks/useAuth.tsx", kind: "file_module", canonicalName: "useAuth", normalizedName: "use auth", filePath: "src/hooks/useAuth.tsx", ownerChunkId: "use-auth", subsystem: "hooks", confidence: 0.92 },
            alias: "auth",
            normalizedAlias: "auth",
            source: "file_path",
            weight: 0.96,
          },
          {
            target: { id: "file_module:src/pages/AuthCallback.tsx", kind: "file_module", canonicalName: "AuthCallback", normalizedName: "auth callback", filePath: "src/pages/AuthCallback.tsx", ownerChunkId: "auth-callback", subsystem: "pages", confidence: 0.92 },
            alias: "auth",
            normalizedAlias: "auth",
            source: "file_path",
            weight: 0.94,
          },
        ];
      },
      findTargetsBySubsystem: () => [],
      getImportsForFile: () => [],
      findImporterFiles: () => [],
      findCallers: () => [],
      findCallees: () => [],
      findChunksByNames: () => [],
      findSiblings: () => [],
      getTopCallTargets: () => [],
      close: () => {},
    };
    const mockVectorStore = {
      search: async () => [
        { id: "flow-noise", score: 0.99 },
        { id: "flow-noise-2", score: 0.98 },
        { id: "auth-page", score: 0.88 },
        { id: "use-auth", score: 0.87 },
        { id: "auth-callback", score: 0.86 },
        { id: "app", score: 0.83 },
      ],
      upsert: async () => {},
      removeByFile: async () => {},
      count: async () => 4,
    };
    const mockFTS = {
      search: () => [
        { id: "flow-noise", rank: -10 },
        { id: "flow-noise-2", rank: -9 },
        { id: "auth-page", rank: -7 },
        { id: "use-auth", rank: -6 },
        { id: "auth-callback", rank: -5 },
      ],
      upsert: () => {},
      removeByFile: () => {},
      close: () => {},
    };

    const search = new HybridSearch(
      mockEmbedder as any,
      mockVectorStore as any,
      mockFTS as any,
      mockMetadata as any,
      createConfig({ embeddingProvider: "local" })
    );

    const context = await search.searchWithContext("how does auth flow work?", 4000);
    const diagnostics = search.getLastBroadSelectionDiagnostics();
    const paths = context.chunks.map((chunk) => chunk.filePath);

    expect(diagnostics?.dominantFamily).toBe("auth");
    expect(diagnostics?.deliveryMode).not.toBe("code_context");
    if (diagnostics?.deliveryMode === "summary_only") {
      expect(diagnostics.deferredReason).toBeTruthy();
      expect(context.chunks).toHaveLength(0);
      expect(diagnostics.selectedFiles.some((item) => item.filePath === "src/lib/flow/workflowApiAnalyzer.ts")).toBe(false);
      expect(diagnostics.selectedFiles.some((item) => item.filePath === "src/lib/flow/typeGuards.ts")).toBe(false);
    } else {
      expect(paths).toContain("src/pages/Auth.tsx");
      expect(paths).toContain("src/hooks/useAuth.tsx");
      expect(paths).not.toContain("src/lib/flow/workflowApiAnalyzer.ts");
      expect(paths).not.toContain("src/lib/flow/typeGuards.ts");
    }
  });

  it("prefers user-facing auth flow files over backend auth infrastructure for broad prompts", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const now = new Date().toISOString();
    const chunks = [
      { id: "auth-page", filePath: "src/pages/Auth.tsx", name: "Auth", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function Auth() { return <AuthModal />; }", language: "typescript", indexedAt: now },
      { id: "use-auth", filePath: "src/hooks/useAuth.tsx", name: "useAuth", kind: "function_declaration", startLine: 1, endLine: 30, content: "export function useAuth() { return supabase.auth.getSession(); }", language: "typescript", indexedAt: now },
      { id: "auth-callback", filePath: "src/pages/AuthCallback.tsx", name: "AuthCallback", kind: "function_declaration", startLine: 1, endLine: 25, content: "export function AuthCallback() { navigate('/projects'); }", language: "typescript", indexedAt: now },
      { id: "protected-route", filePath: "src/components/ProtectedRoute.tsx", name: "ProtectedRoute", kind: "function_declaration", startLine: 1, endLine: 25, content: "export function ProtectedRoute() { return session ? children : <Navigate to='/auth' />; }", language: "typescript", indexedAt: now },
      { id: "provider", filePath: "mcp-server/src/auth/provider.ts", name: "DutoOAuthProvider", kind: "class_declaration", startLine: 1, endLine: 60, content: "export class DutoOAuthProvider { async authorize() {} async verifyAccessToken() {} }", language: "typescript", indexedAt: now },
      { id: "consent-page", filePath: "mcp-server/src/auth/consentPage.ts", name: "buildConsentPage", kind: "function_declaration", startLine: 1, endLine: 30, content: "export function buildConsentPage() { return '<html>consent</html>'; }", language: "typescript", indexedAt: now },
      { id: "client-store", filePath: "mcp-server/src/auth/clientStore.ts", name: "SupabaseClientStore", kind: "class_declaration", startLine: 1, endLine: 40, content: "export class SupabaseClientStore { async store() {} }", language: "typescript", indexedAt: now },
    ];
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const byPath = new Map<string, any[]>();
    for (const chunk of chunks) {
      const existing = byPath.get(chunk.filePath) ?? [];
      existing.push(chunk);
      byPath.set(chunk.filePath, existing);
    }

    const mockMetadata = {
      getChunkScoringInfo: (ids: string[]) =>
        ids.map((id) => chunkMap.get(id)).filter(Boolean).map((chunk) => ({
          id: chunk.id,
          filePath: chunk.filePath,
          name: chunk.name,
          kind: chunk.kind,
          parentName: undefined,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          indexedAt: chunk.indexedAt,
          fileMtime: undefined,
        })),
      getChunksByIds: (ids: string[]) => ids.map((id) => chunkMap.get(id)).filter(Boolean),
      findChunksByFilePath: (filePath: string) => byPath.get(filePath) ?? [],
      resolveTargetAliases: (_aliases: string[], _limit?: number, kinds?: string[]) => {
        if (kinds && !kinds.includes("file_module")) return [];
        return [
          {
            target: { id: "file_module:src/pages/Auth.tsx", kind: "file_module", canonicalName: "Auth", normalizedName: "auth", filePath: "src/pages/Auth.tsx", ownerChunkId: "auth-page", subsystem: "pages", confidence: 0.95 },
            alias: "auth",
            normalizedAlias: "auth",
            source: "file_path",
            weight: 0.96,
          },
          {
            target: { id: "file_module:src/hooks/useAuth.tsx", kind: "file_module", canonicalName: "useAuth", normalizedName: "use auth", filePath: "src/hooks/useAuth.tsx", ownerChunkId: "use-auth", subsystem: "hooks", confidence: 0.94 },
            alias: "auth",
            normalizedAlias: "auth",
            source: "file_path",
            weight: 0.95,
          },
          {
            target: { id: "file_module:src/pages/AuthCallback.tsx", kind: "file_module", canonicalName: "AuthCallback", normalizedName: "auth callback", filePath: "src/pages/AuthCallback.tsx", ownerChunkId: "auth-callback", subsystem: "pages", confidence: 0.93 },
            alias: "auth callback",
            normalizedAlias: "auth callback",
            source: "file_path",
            weight: 0.94,
          },
        ];
      },
      findTargetsBySubsystem: () => [],
      getImportsForFile: () => [],
      findImporterFiles: () => [],
      findCallers: () => [],
      findCallees: () => [],
      findChunksByNames: () => [],
      findSiblings: () => [],
      getTopCallTargets: () => [],
      close: () => {},
    };

    const search = new HybridSearch(
      {
        embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
        dimensions: () => 4,
        isEnabled: () => true,
      } as any,
      {
        search: async () => [
          { id: "provider", score: 0.99 },
          { id: "consent-page", score: 0.98 },
          { id: "client-store", score: 0.97 },
          { id: "auth-page", score: 0.92 },
          { id: "use-auth", score: 0.91 },
          { id: "auth-callback", score: 0.9 },
          { id: "protected-route", score: 0.89 },
        ],
        upsert: async () => {},
        removeByFile: async () => {},
        count: async () => 7,
      } as any,
      {
        search: () => [
          { id: "provider", rank: -10 },
          { id: "client-store", rank: -9 },
          { id: "auth-page", rank: -8 },
          { id: "use-auth", rank: -7 },
          { id: "auth-callback", rank: -6 },
          { id: "protected-route", rank: -5 },
        ],
        upsert: () => {},
        removeByFile: () => {},
        close: () => {},
      } as any,
      mockMetadata as any,
      createConfig({ embeddingProvider: "local" })
    );

    const context = await search.searchWithContext("how does the auth flow work?", 4000);
    const diagnostics = search.getLastBroadSelectionDiagnostics();
    const uniquePaths = Array.from(new Set(context.chunks.map((chunk) => chunk.filePath)));
    const topThree = new Set(uniquePaths.slice(0, 3));

    expect(diagnostics?.dominantFamily).toBe("auth");
    expect(diagnostics?.deliveryMode).toBe("code_context");
    expect(topThree.has("src/pages/Auth.tsx")).toBe(true);
    expect(topThree.has("src/pages/AuthCallback.tsx")).toBe(true);
    expect(uniquePaths).not.toContain("mcp-server/src/auth/clientStore.ts");
    expect(uniquePaths).not.toContain("mcp-server/src/auth/consentPage.ts");
    expect(uniquePaths.length).toBeLessThanOrEqual(3);
  });

  it("prefers executable validators over passive declarations within a selected bug file", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const now = new Date().toISOString();
    const chunks = [
      {
        id: "edge-helper",
        filePath: "src/runtime/TaskCoordinator.ts",
        name: "isWithinScope",
        kind: "function_declaration",
        startLine: 55,
        endLine: 78,
        content: "function isWithinScope(taskId, tasks, links) { if (links.find(Boolean)) return true; return false; }",
        language: "typescript",
        indexedAt: now,
      },
      {
        id: "valid-connection",
        filePath: "src/runtime/TaskCoordinator.ts",
        name: "validateLinkCompatibility",
        kind: "arrow_function",
        startLine: 120,
        endLine: 220,
        content: "const validateLinkCompatibility = (link) => { const sourceType = getChannelType(link.source); const targetType = getChannelType(link.target); if (!checkCompatibility(sourceType, targetType)) return false; return true; }",
        language: "typescript",
        indexedAt: now,
      },
      {
        id: "types",
        filePath: "src/runtime/TaskCoordinator.ts",
        name: "PendingOperation",
        kind: "interface_declaration",
        startLine: 20,
        endLine: 40,
        content: "interface PendingOperation { open: boolean }",
        language: "typescript",
        indexedAt: now,
      },
    ];

    const featureById = new Map([
      ["edge-helper", { chunkId: "edge-helper", isPredicate: true, isValidator: false, isGuard: false, returnsBoolean: true, callsPredicateCount: 0, branchCount: 1, guardCount: 0 }],
      ["valid-connection", { chunkId: "valid-connection", isPredicate: true, isValidator: true, isGuard: true, returnsBoolean: true, callsPredicateCount: 1, branchCount: 4, guardCount: 2 }],
      ["types", { chunkId: "types", isPredicate: false, isValidator: false, isGuard: false, returnsBoolean: false, callsPredicateCount: 0, branchCount: 0, guardCount: 0 }],
    ]);

    const mockMetadata = {
      findChunksByFilePath: (filePath: string) => chunks.filter((chunk) => chunk.filePath === filePath),
      getChunkFeaturesByIds: (ids: string[]) => ids.map((id) => featureById.get(id)).filter(Boolean),
      getChunkTagsByIds: (ids: string[]) =>
        ids.flatMap((id) => {
          if (id === "valid-connection") return [{ chunkId: id, tag: "validation", weight: 1 }];
          if (id === "edge-helper") return [{ chunkId: id, tag: "validation", weight: 0.6 }];
          return [];
        }),
    };

    const { BugStrategy } = await import("../../src/search/bug-strategy.js");
    const bugStrategy = new BugStrategy({
      metadata: mockMetadata as any,
      config: createConfig({ embeddingProvider: "local" }),
      fts: { search: () => [], upsert: () => {}, removeByFile: () => {}, close: () => {} } as any,
    });

    const promoted = bugStrategy.promoteBugRepresentativeChunk(
      {
        id: "task-coordinator",
        score: 20,
        filePath: "src/runtime/TaskCoordinator.ts",
        name: "TaskCoordinator",
        kind: "function_declaration",
        startLine: 1,
        endLine: 900,
        content: "function TaskCoordinator() {}",
        language: "typescript",
      },
      {
        subjectTerms: ["links", "wrong"],
        focusTerms: ["links", "compatibility"],
        primaryTags: new Set(["validation"]),
        relatedTags: new Set(["schema"]),
        decomposition: {
          literalTerms: ["links", "wrong"],
          normalizedVariants: ["links", "compatibility"],
          semanticVariants: ["relationship"],
          implementationTerms: ["validate", "check", "guard"],
          runtimeTerms: ["return false", "throw"],
          architecturalTerms: ["controller", "service"],
          controlFlowTerms: ["guard", "predicate"],
          dataFlowTerms: ["input", "output", "type"],
          implementationHypotheses: [],
        },
      }
    );

    expect(promoted.filePath).toBe("src/runtime/TaskCoordinator.ts");
    expect(promoted.name).toBe("validateLinkCompatibility");
  });

  it("keeps production bug retrieval logic free of repo-specific names", () => {
    const hybridSource = readFileSync(resolve(process.cwd(), "src/search/hybrid.ts"), "utf8");
    const bugSource = readFileSync(resolve(process.cwd(), "src/search/bug-strategy.ts"), "utf8");

    expect(hybridSource).not.toMatch(/FlowEditor|QuickConnect|nodeConnectionSchema|documentation\/NODES/i);
    expect(bugSource).not.toMatch(/FlowEditor|QuickConnect|nodeConnectionSchema|documentation\/NODES/i);
  });

  it("builds a search inventory bundle from typed file modules instead of prompt-context neighbors", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const mockEmbedder = {
      embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
      dimensions: () => 4,
      isEnabled: () => true,
    };
    const chunks = [
      { id: "hybrid", filePath: "src/search/hybrid.ts", name: "searchWithContext", kind: "method_definition", startLine: 1, endLine: 40, content: "class HybridSearch { searchWithContext() {} }", language: "typescript", indexedAt: now },
      { id: "seed", filePath: "src/search/seed.ts", name: "resolveSeeds", kind: "function_declaration", startLine: 1, endLine: 30, content: "export function resolveSeeds() {}", language: "typescript", indexedAt: now },
      { id: "ranker", filePath: "src/search/ranker.ts", name: "reciprocalRankFusion", kind: "function_declaration", startLine: 1, endLine: 30, content: "export function reciprocalRankFusion() {}", language: "typescript", indexedAt: now },
      { id: "targets", filePath: "src/search/targets.ts", name: "resolveTargetsForQuery", kind: "function_declaration", startLine: 1, endLine: 30, content: "export function resolveTargetsForQuery() {}", language: "typescript", indexedAt: now },
      { id: "assembler", filePath: "src/search/context-assembler.ts", name: "assembleContext", kind: "function_declaration", startLine: 1, endLine: 40, content: "export function assembleContext() {}", language: "typescript", indexedAt: now },
      { id: "prompt-context", filePath: "src/hooks/prompt-context.ts", name: "handlePromptContextDetailed", kind: "function_declaration", startLine: 1, endLine: 40, content: "export function handlePromptContextDetailed() {}", language: "typescript", indexedAt: now },
      { id: "memory-search", filePath: "src/memory/search.ts", name: "search", kind: "method_definition", startLine: 1, endLine: 40, content: "class MemorySearch { search() {} }", language: "typescript", indexedAt: now },
    ];
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const byPath = new Map<string, any[]>();
    for (const chunk of chunks) {
      const existing = byPath.get(chunk.filePath) ?? [];
      existing.push(chunk);
      byPath.set(chunk.filePath, existing);
    }

    const makeTargetHit = (id: string, filePath: string, canonicalName: string) => ({
      target: { id: `file_module:${filePath}`, kind: "file_module", canonicalName, normalizedName: canonicalName.toLowerCase(), filePath, ownerChunkId: id, subsystem: "search", confidence: 0.94 },
      alias: "search",
      normalizedAlias: "search",
      source: "file_path",
      weight: 0.95,
    });

    const mockMetadata = {
      getChunkScoringInfo: (ids: string[]) =>
        ids.map((id) => chunkMap.get(id)).filter(Boolean).map((chunk) => ({
          id: chunk.id,
          filePath: chunk.filePath,
          name: chunk.name,
          kind: chunk.kind,
          parentName: undefined,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          indexedAt: chunk.indexedAt,
          fileMtime: undefined,
        })),
      getChunksByIds: (ids: string[]) => ids.map((id) => chunkMap.get(id)).filter(Boolean),
      findChunksByFilePath: (filePath: string) => byPath.get(filePath) ?? [],
      resolveTargetAliases: (_aliases: string[], _limit?: number, kinds?: string[]) => {
        if (kinds && !kinds.includes("file_module")) return [];
        return [
          makeTargetHit("hybrid", "src/search/hybrid.ts", "hybrid"),
          makeTargetHit("seed", "src/search/seed.ts", "seed"),
          makeTargetHit("ranker", "src/search/ranker.ts", "ranker"),
          makeTargetHit("targets", "src/search/targets.ts", "targets"),
          makeTargetHit("assembler", "src/search/context-assembler.ts", "context-assembler"),
        ];
      },
      findTargetsBySubsystem: () => [
        { id: "file_module:src/search/hybrid.ts", kind: "file_module", canonicalName: "hybrid", normalizedName: "hybrid", filePath: "src/search/hybrid.ts", ownerChunkId: "hybrid", subsystem: "search", confidence: 0.94 },
        { id: "file_module:src/search/seed.ts", kind: "file_module", canonicalName: "seed", normalizedName: "seed", filePath: "src/search/seed.ts", ownerChunkId: "seed", subsystem: "search", confidence: 0.94 },
        { id: "file_module:src/search/ranker.ts", kind: "file_module", canonicalName: "ranker", normalizedName: "ranker", filePath: "src/search/ranker.ts", ownerChunkId: "ranker", subsystem: "search", confidence: 0.94 },
        { id: "file_module:src/search/targets.ts", kind: "file_module", canonicalName: "targets", normalizedName: "targets", filePath: "src/search/targets.ts", ownerChunkId: "targets", subsystem: "search", confidence: 0.94 },
        { id: "file_module:src/search/context-assembler.ts", kind: "file_module", canonicalName: "context-assembler", normalizedName: "context assembler", filePath: "src/search/context-assembler.ts", ownerChunkId: "assembler", subsystem: "search", confidence: 0.94 },
      ],
      getImportsForFile: (filePath: string) => {
        if (filePath === "src/search/hybrid.ts") {
          return [
            { id: 1, filePath, importedName: "resolveSeeds", sourceModule: "./seed", resolvedPath: "src/search/seed.ts", isDefault: false, isNamespace: false },
            { id: 2, filePath, importedName: "reciprocalRankFusion", sourceModule: "./ranker", resolvedPath: "src/search/ranker.ts", isDefault: false, isNamespace: false },
            { id: 3, filePath, importedName: "assembleContext", sourceModule: "./context-assembler", resolvedPath: "src/search/context-assembler.ts", isDefault: false, isNamespace: false },
          ];
        }
        return [];
      },
      findImporterFiles: (resolvedPath: string) =>
        resolvedPath.startsWith("src/search/") ? ["src/search/hybrid.ts"] : [],
      findCallers: () => [],
      findCallees: () => [],
      findChunksByNames: () => [],
      findSiblings: () => [],
      getTopCallTargets: () => [],
      close: () => {},
    };
    const mockVectorStore = {
      search: async () => [
        { id: "prompt-context", score: 0.99 },
        { id: "memory-search", score: 0.97 },
        { id: "hybrid", score: 0.89 },
        { id: "seed", score: 0.88 },
      ],
      upsert: async () => {},
      removeByFile: async () => {},
      count: async () => 4,
    };
    const mockFTS = {
      search: () => [
        { id: "prompt-context", rank: -10 },
        { id: "memory-search", rank: -9 },
        { id: "hybrid", rank: -6 },
        { id: "seed", rank: -5 },
      ],
      upsert: () => {},
      removeByFile: () => {},
      close: () => {},
    };

    const search = new HybridSearch(
      mockEmbedder as any,
      mockVectorStore as any,
      mockFTS as any,
      mockMetadata as any,
      createConfig({ embeddingProvider: "local" })
    );

    const context = await search.searchWithContext("which files implement the full search pipeline", 4000);
    const paths = context.chunks.map((chunk) => chunk.filePath);
    const diagnostics = search.getLastBroadSelectionDiagnostics();

    expect(diagnostics?.broadMode).toBe("inventory");
    expect(diagnostics?.dominantFamily).toBe("search");
    if (diagnostics?.deliveryMode === "summary_only") {
      expect(context.chunks).toHaveLength(0);
      expect(diagnostics.deferredReason).toBeTruthy();
    } else {
      expect(paths).toContain("src/search/hybrid.ts");
      expect(paths).toContain("src/search/seed.ts");
      expect(paths).toContain("src/search/ranker.ts");
      expect(paths).not.toContain("src/hooks/prompt-context.ts");
      expect(paths).not.toContain("src/memory/search.ts");
    }
  });

  it("defers widget-heavy billing workflow bundles instead of injecting noisy code context", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const now = new Date().toISOString();
    const chunks = [
      { id: "checkout", filePath: "supabase/functions/stripe-checkout/index.ts", name: "serve_handler", kind: "arrow_function", startLine: 1, endLine: 40, content: "const serve_handler = async () => {}", language: "typescript", indexedAt: now },
      { id: "webhook", filePath: "supabase/functions/stripe-webhook/index.ts", name: "serve_handler", kind: "arrow_function", startLine: 1, endLine: 40, content: "const serve_handler = async () => {}", language: "typescript", indexedAt: now },
      { id: "subscription-card", filePath: "src/components/billing/SubscriptionCard.tsx", name: "SubscriptionCard", kind: "function_declaration", startLine: 1, endLine: 30, content: "export function SubscriptionCard() {}", language: "typescript", indexedAt: now },
      { id: "storage-card", filePath: "src/components/billing/StorageUsageCard.tsx", name: "StorageUsageCard", kind: "function_declaration", startLine: 1, endLine: 30, content: "export function StorageUsageCard() {}", language: "typescript", indexedAt: now },
      { id: "history", filePath: "src/components/billing/TransactionHistory.tsx", name: "TransactionHistory", kind: "function_declaration", startLine: 1, endLine: 30, content: "export function TransactionHistory() {}", language: "typescript", indexedAt: now },
      { id: "credit-card", filePath: "src/components/billing/CreditPackCard.tsx", name: "CreditPackCard", kind: "function_declaration", startLine: 1, endLine: 30, content: "export function CreditPackCard() {}", language: "typescript", indexedAt: now },
      { id: "types", filePath: "src/lib/editor/templates/types.ts", name: "TemplateType", kind: "interface_declaration", startLine: 1, endLine: 20, content: "export interface TemplateType {}", language: "typescript", indexedAt: now },
    ];
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const search = new HybridSearch(
      {
        embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
        dimensions: () => 4,
        isEnabled: () => true,
      } as any,
      {
        search: async () => chunks.map((chunk, index) => ({ id: chunk.id, score: 0.9 - index * 0.01 })),
        upsert: async () => {},
        removeByFile: async () => {},
        count: async () => chunks.length,
      } as any,
      {
        search: () => chunks.map((chunk, index) => ({ id: chunk.id, rank: -(10 - index) })),
        upsert: () => {},
        removeByFile: () => {},
        close: () => {},
      } as any,
      {
        getChunkScoringInfo: (ids: string[]) => ids.map((id) => chunkMap.get(id)).filter(Boolean).map((c) => ({
          id: c!.id, filePath: c!.filePath, name: c!.name, kind: c!.kind, parentName: undefined, indexedAt: c!.indexedAt, fileMtime: undefined,
        })),
        getChunksByIds: (ids: string[]) => ids.map((id) => chunkMap.get(id)).filter(Boolean),
        findCallers: () => [],
        findCallees: () => [],
        findChunksByNames: () => [],
        findSiblings: () => [],
        getTopCallTargets: () => [],
        close: () => {},
      } as any,
      createConfig({ embeddingProvider: "local" })
    );

    const context = await search.searchWithContext("trace the full billing portal and checkout flow from UI to edge function", 4000);
    const diagnostics = search.getLastBroadSelectionDiagnostics();

    expect(diagnostics?.broadMode).toBe("workflow");
    expect(diagnostics?.dominantFamily).toBe("billing");
    expect(diagnostics?.deliveryMode).toBe("summary_only");
    expect(context.chunks).toHaveLength(0);
  });

  it("defers upload workflow bundles when only one strong upload backend anchor exists", async () => {
    const { HybridSearch } = await import("../../src/search/hybrid.js");
    const now = new Date().toISOString();
    const chunks = [
      { id: "upload", filePath: "supabase/functions/upload-media/index.ts", name: "serve_handler", kind: "arrow_function", startLine: 1, endLine: 60, content: "const serve_handler = async () => {}", language: "typescript", indexedAt: now },
      { id: "signed", filePath: "src/lib/storage/getSignedMediaUrl.ts", name: "getSignedMediaUrl", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function getSignedMediaUrl() {}", language: "typescript", indexedAt: now },
      { id: "auth", filePath: "src/hooks/useAuth.tsx", name: "useAuth", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function useAuth() {}", language: "typescript", indexedAt: now },
      { id: "quick", filePath: "src/lib/flow/quickActions.ts", name: "quickAction", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function quickAction() {}", language: "typescript", indexedAt: now },
      { id: "preview", filePath: "src/components/flow/nodes/PreviewMediaNode.tsx", name: "PreviewMediaNode", kind: "function_declaration", startLine: 1, endLine: 20, content: "export function PreviewMediaNode() {}", language: "typescript", indexedAt: now },
    ];
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const search = new HybridSearch(
      {
        embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
        dimensions: () => 4,
        isEnabled: () => true,
      } as any,
      {
        search: async () => chunks.map((chunk, index) => ({ id: chunk.id, score: 0.9 - index * 0.01 })),
        upsert: async () => {},
        removeByFile: async () => {},
        count: async () => chunks.length,
      } as any,
      {
        search: () => chunks.map((chunk, index) => ({ id: chunk.id, rank: -(10 - index) })),
        upsert: () => {},
        removeByFile: () => {},
        close: () => {},
      } as any,
      {
        getChunkScoringInfo: (ids: string[]) => ids.map((id) => chunkMap.get(id)).filter(Boolean).map((c) => ({
          id: c!.id, filePath: c!.filePath, name: c!.name, kind: c!.kind, parentName: undefined, indexedAt: c!.indexedAt, fileMtime: undefined,
        })),
        getChunksByIds: (ids: string[]) => ids.map((id) => chunkMap.get(id)).filter(Boolean),
        findCallers: () => [],
        findCallees: () => [],
        findChunksByNames: () => [],
        findSiblings: () => [],
        getTopCallTargets: () => [],
        close: () => {},
      } as any,
      createConfig({ embeddingProvider: "local" })
    );

    const context = await search.searchWithContext("trace the full upload media flow from request auth to storage write", 4000);
    const diagnostics = search.getLastBroadSelectionDiagnostics();

    expect(diagnostics?.broadMode).toBe("workflow");
    expect(diagnostics?.deliveryMode).toBe("summary_only");
    expect(context.chunks).toHaveLength(0);
  });
});
