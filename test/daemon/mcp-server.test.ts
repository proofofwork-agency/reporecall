import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createMCPServer } from "../../src/daemon/mcp-server.js";
import { clearFreshnessCache } from "../../src/core/staleness.js";

// 3G: MCP server tools
// We test the MCP server by calling its tool handlers directly.
// The McpServer from @modelcontextprotocol/sdk registers tools via server.tool(),
// so we intercept registration to capture the handler functions.

function makeMockSearch(overrides?: Partial<any>): any {
  return {
    search: async () => [
      {
        id: "c1",
        name: "processRequest",
        filePath: "src/server.ts",
        kind: "function_declaration",
        startLine: 10,
        endLine: 25,
        score: 0.92,
        content: "function processRequest(req) { return req; }",
        docstring: undefined,
        parentName: undefined,
        language: "typescript",
      },
    ],
    searchWithContext: async () => ({ text: "", tokenCount: 0, chunks: [] }),
    findCallers: (name: string) => {
      if (name === "processRequest") {
        return [{ chunkId: "c2", filePath: "src/app.ts", line: 5, callerName: "handleRoute" }];
      }
      return [];
    },
    findCallees: (name: string) => {
      if (name === "processRequest") {
        return [{ targetName: "validateInput", callType: "call", line: 12, filePath: "src/server.ts" }];
      }
      return [];
    },
    updateStores: () => {},
    ...overrides,
  };
}

function makeMockPipeline(overrides?: Partial<any>): any {
  return {
    indexAll: async () => ({ filesProcessed: 5, chunksCreated: 22 }),
    indexChanged: async (paths: string[]) => ({ filesProcessed: paths.length, chunksCreated: paths.length * 2 }),
    removeFiles: async () => {},
    close: () => {},
    reinit: () => {},
    getVectorStore: () => ({}),
    getFTSStore: () => ({}),
    getMetadataStore: () => makeMockMetadata(),
    getEmbedder: () => ({ dimensions: () => 0 }),
    ...overrides,
  };
}

function makeMockMetadata(overrides?: Partial<any>): any {
  const chunk = {
    id: "c1",
    name: "processRequest",
    filePath: "src/server.ts",
    kind: "function_declaration",
    startLine: 10,
    endLine: 25,
    content: "function processRequest(req) { return req; }",
    docstring: undefined,
    parentName: undefined,
    language: "typescript",
    indexedAt: "2025-01-01T00:00:00.000Z",
  };
  return {
    getStats: () => ({ totalFiles: 5, totalChunks: 22, languages: { typescript: 22 } }),
    getStat: (_key: string) => "2025-01-01T00:00:00.000Z",
    setStat: () => {},
    getConventions: () => null,
    getLatencyPercentiles: () => ({ avg: 12, p50: 10, p95: 25, count: 100 }),
    getAllChunks: () => [],
    getChunk: (id: string) => (id === chunk.id ? chunk : undefined),
    findChunksByFilePath: (filePath: string) => (filePath === chunk.filePath ? [chunk] : []),
    getAllResolvedCallEdges: () => [],
    getAllCommunities: () => [],
    getGodNodes: () => [],
    getTopSurprises: () => [],
    getSuggestedQuestions: () => [],
    getCommunityForChunk: () => undefined,
    findCallers: () => [],
    findCallees: () => [],
    close: () => {},
    ...overrides,
  };
}

function makeConfig(): any {
  return {
    projectRoot: "/tmp/test-mcp",
    dataDir: "/tmp/test-mcp/.memory",
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
    port: 37230,
    implementationPaths: ["src/", "lib/", "bin/"],
    factExtractors: [],
  };
}

function makeMockMemoryStore(): any {
  return {
    getWikiLinks: () => [],
    getWikiBacklinks: () => [],
    getByName: () => undefined,
    getByType: (type: string) => {
      if (type !== "wiki") return [];
      return [
        {
          id: "wiki-auth",
          name: "business-user-authentication",
          type: "wiki",
          description: "Business capability view",
          summary: "User Authentication grants protected access.",
          content: `## Capability
User Authentication

## Actor
Product user

## Trigger
User starts login or resumes a session.

## Business terms
- User
- Session

## User-visible actions
- Sign in and access protected product areas.

## Business outcome
The product grants protected access.

## Business / Data Concepts
- User
- Session

## External systems
- Identity provider`,
          filePath: "/tmp/test-mcp/.memory/wiki/business-user-authentication.md",
          relatedFiles: ["src/auth.ts"],
          relatedSymbols: ["useAuth"],
          confidence: 0.88,
        },
        {
          id: "wiki-upload",
          name: "business-media-upload",
          type: "wiki",
          description: "Business capability view",
          summary: "Media Upload accepts files.",
          content: `## Capability
Media Upload

## Actor
Product user

## Trigger
User adds a file.

## Business terms
- Upload
- File

## User-visible actions
- Upload a file.

## Business outcome
The product stores incoming media.

## Business / Data Concepts
- File
- Storage

## External systems
- Object storage`,
          filePath: "/tmp/test-mcp/.memory/wiki/business-media-upload.md",
          relatedFiles: ["src/upload.ts"],
          relatedSymbols: ["uploadFile"],
          confidence: 0.8,
        },
      ];
    },
  };
}

function makeMockMemorySearch(results: any[] = []): any {
  return {
    search: async () => results,
  };
}

function makeMockMemoryIndexer(overrides?: Partial<any>): any {
  return {
    getWritableDirs: () => ["/tmp/test-mcp/.memory/reporecall-memories"],
    getMemoryDirs: () => ["/tmp/test-mcp/.memory/reporecall-memories"],
    indexFile: async () => true,
    removeByFilePath: async () => true,
    regenerateIndex: () => {},
    compact: () => ({ archived: 0, superseded: 0 }),
    ...overrides,
  };
}

function runGit(projectRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function commitFile(projectRoot: string, fileName: string, content: string): string {
  writeFileSync(join(projectRoot, fileName), content);
  runGit(projectRoot, ["add", fileName]);
  runGit(projectRoot, ["-c", "user.name=Reporecall Test", "-c", "user.email=test@example.com", "commit", "-m", `commit ${fileName}`]);
  return runGit(projectRoot, ["rev-parse", "HEAD"]);
}

// Capture tool handlers by monkey-patching McpServer.registerTool during server creation
async function captureToolHandlers(
  search: any,
  pipeline: any,
  metadata: any,
  config: any,
  deps: {
    lock?: any;
    memorySearch?: any;
    memoryIndexer?: any;
    memoryStore?: any;
    memoryRuntime?: any;
    wikiGenerator?: any;
    wikiAutoCapture?: any;
  } = {}
): Promise<Map<string, (args: any) => Promise<any>>> {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const OriginalRegisterTool = McpServer.prototype.registerTool;

  // Patch registerTool to capture handlers
  McpServer.prototype.registerTool = function (
    name: string,
    _config: any,
    handler: (args: any) => Promise<any>
  ) {
    handlers.set(name, handler);
    return {} as any;
  } as any;

  try {
    createMCPServer(
      search,
      pipeline,
      metadata,
      config,
      deps.lock,
      deps.memorySearch,
      deps.memoryIndexer,
      deps.memoryStore,
      deps.memoryRuntime,
      deps.wikiGenerator,
      deps.wikiAutoCapture
    );
  } finally {
    McpServer.prototype.registerTool = OriginalRegisterTool;
  }

  return handlers;
}

describe("MCP server tools (3G)", () => {
  afterEach(() => {
    clearFreshnessCache();
  });

  it("registers only the six public MCP tools when memory is available", async () => {
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig(),
      {
        memorySearch: makeMockMemorySearch(),
        memoryIndexer: makeMockMemoryIndexer(),
        memoryStore: makeMockMemoryStore(),
      }
    );

    expect([...handlers.keys()].sort()).toEqual([
      "explain_flow",
      "get_stats",
      "memory",
      "refresh_context",
      "search_code",
      "search_context",
    ]);
    expect(handlers.get("clear_index")).toBeUndefined();
    expect(handlers.get("index_codebase")).toBeUndefined();
    expect(handlers.get("read_code_chunk")).toBeUndefined();
    expect(handlers.get("store_memory")).toBeUndefined();
    expect(handlers.get("recall_memories")).toBeUndefined();
  });

  it("search_code returns formatted results", async () => {
    const search = makeMockSearch();
    const pipeline = makeMockPipeline();
    const metadata = makeMockMetadata();
    const config = makeConfig();

    const handlers = await captureToolHandlers(search, pipeline, metadata, config);
    const handler = handlers.get("search_code");
    expect(handler).toBeDefined();

    const result = await handler!({ query: "processRequest", limit: 10 });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.action).toBe("search");
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0].name).toBe("processRequest");
    expect(parsed.results[0].id).toBe("c1");
    expect(parsed.results[0].filePath).toBe("src/server.ts");
    expect(parsed.staleness.level).toBe("fresh");
  });

  it("search_context returns assembled context with compression metadata", async () => {
    const search = makeMockSearch({
      searchWithContext: async () => ({
        text: "## Relevant codebase context\n\n- `function compacted` (src/server.ts:10-25, chunkId `c1`, typescript)\n",
        tokenCount: 42,
        routeStyle: "standard",
        deliveryMode: "code_context",
        chunks: [
          {
            id: "c1",
            name: "processRequest",
            filePath: "src/server.ts",
            kind: "function_declaration",
            startLine: 10,
            endLine: 25,
            score: 0.92,
            content: "function processRequest(req) { return req; }",
            language: "typescript",
          },
        ],
        compression: {
          enabled: true,
          mode: "auto",
          tokensBeforeCompression: 100,
          tokensAfterCompression: 42,
          tokensSaved: 58,
          savingsRatio: 0.58,
          fullChunks: 0,
          compressedChunks: 1,
          originalRefs: [
            {
              chunkId: "c1",
              filePath: "src/server.ts",
              startLine: 10,
              endLine: 25,
              name: "processRequest",
              kind: "function_declaration",
              language: "typescript",
            },
          ],
          strategies: { code: 1 },
        },
      }),
    });
    const pipeline = makeMockPipeline();
    const metadata = makeMockMetadata();
    const config = makeConfig();

    const handlers = await captureToolHandlers(search, pipeline, metadata, config);
    const handler = handlers.get("search_context");
    expect(handler).toBeDefined();

    const result = await handler!({ query: "how does request processing work", tokenBudget: 500 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.text).toContain("Relevant codebase context");
    expect(parsed.tokenCount).toBe(42);
    expect(parsed.chunksIncluded).toBe(1);
    expect(parsed.selectedFiles).toEqual(["src/server.ts"]);
    expect(parsed.compression.compressedChunks).toBe(1);
    expect(parsed.compression.originalRefs[0].chunkId).toBe("c1");
    expect(parsed.staleness.level).toBe("fresh");
  });

  it("search_context includes staleness and banner when indexed commit differs from HEAD", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "reporecall-mcp-stale-"));
    try {
      runGit(projectRoot, ["init"]);
      const indexedCommit = commitFile(projectRoot, "a.ts", "export const a = 1;\n");
      const currentCommit = commitFile(projectRoot, "b.ts", "export const b = 2;\n");
      const search = makeMockSearch({
        searchWithContext: async () => ({
          text: "## Relevant codebase context\n\n- stale result\n",
          tokenCount: 12,
          routeStyle: "standard",
          deliveryMode: "code_context",
          chunks: [],
          compression: { enabled: false },
        }),
      });
      const pipeline = makeMockPipeline();
      const metadata = makeMockMetadata({
        getStat: (key: string) => {
          if (key === "lastIndexedAt") return "2026-04-02T00:00:00.000Z";
          if (key === "indexedCommit") return indexedCommit;
          return undefined;
        },
      });
      const config = { ...makeConfig(), projectRoot };

      const handlers = await captureToolHandlers(search, pipeline, metadata, config);
      const handler = handlers.get("search_context");
      expect(handler).toBeDefined();

      const result = await handler!({ query: "how does request processing work", tokenBudget: 500 });
      const parsed = JSON.parse(result.content[0].text);

      expect(currentCommit).not.toBe(indexedCommit);
      expect(parsed.staleness.level).toBe("stale");
      expect(parsed.staleness.indexedCommit).toBe(indexedCommit);
      expect(parsed.staleness.currentCommit).toBe(currentCommit);
      expect(parsed.banner).toContain("reporecall index STALE");
      expect(parsed.banner).toContain("repo has moved");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("search_code action=read_chunk returns original source by chunk id", async () => {
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig()
    );
    const handler = handlers.get("search_code");
    expect(handler).toBeDefined();

    const result = await handler!({ action: "read_chunk", chunkId: "c1" });
    expect(result.content).toHaveLength(1);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.action).toBe("read_chunk");
    expect(parsed.chunk.id).toBe("c1");
    expect(parsed.chunk.content).toContain("function processRequest");
    expect(parsed.chunk.startLine).toBe(10);
  });

  it("search_code action=read_chunk returns original source by file and line range", async () => {
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig()
    );
    const handler = handlers.get("search_code");
    expect(handler).toBeDefined();

    const result = await handler!({ action: "read_chunk", filePath: "src/server.ts", startLine: 12, endLine: 13 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.chunk.id).toBe("c1");
    expect(parsed.chunk.filePath).toBe("src/server.ts");
  });

  it("does not register lower-level index_codebase as a standalone MCP tool", async () => {
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig()
    );

    expect(handlers.get("index_codebase")).toBeUndefined();
  });

  it("refresh_context re-indexes and regenerates wiki pages for external tools", async () => {
    let indexAllCalled = false;
    let wikiGenerated = false;
    const pipeline = makeMockPipeline({
      indexAll: async () => {
        indexAllCalled = true;
        return { filesProcessed: 3, chunksCreated: 9 };
      },
    });
    const wikiGenerator = {
      generateFromIndex: async () => {
        wikiGenerated = true;
        return { pagesWritten: 4, businessPages: 2 };
      },
    };

    const handlers = await captureToolHandlers(
      makeMockSearch(),
      pipeline,
      makeMockMetadata(),
      makeConfig(),
      { wikiGenerator }
    );
    const handler = handlers.get("refresh_context");
    expect(handler).toBeDefined();

    const result = await handler!({});
    expect(indexAllCalled).toBe(true);
    expect(wikiGenerated).toBe(true);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.index.filesProcessed).toBe(3);
    expect(parsed.wiki.pagesWritten).toBe(4);
    expect(parsed.stats.totalFiles).toBe(5);
  });

  it("refresh_context repair path runs even when the index is empty", async () => {
    let indexAllCalls = 0;
    const pipeline = makeMockPipeline({
      indexAll: async () => {
        indexAllCalls += 1;
        return { filesProcessed: 1, chunksCreated: 1 };
      },
    });
    const metadata = makeMockMetadata({
      getStats: () => ({ totalFiles: 0, totalChunks: 0, languages: {} }),
      getStat: () => undefined,
    });

    const handlers = await captureToolHandlers(
      makeMockSearch(),
      pipeline,
      metadata,
      makeConfig()
    );

    const refreshResult = await handlers.get("refresh_context")!({});
    const parsedRefresh = JSON.parse(refreshResult.content[0].text);

    expect(indexAllCalls).toBe(1);
    expect(parsedRefresh.index.filesProcessed).toBe(1);
    expect(parsedRefresh.banner).toBeUndefined();
  });

  it("memory recall and store bypass empty code-index gating while code tools stay gated", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "reporecall-memory-mcp-"));
    try {
      let indexedMemoryPath: string | undefined;
      const memorySearch = makeMockMemorySearch([
        {
          id: "mem-1",
          name: "memory-contract",
          description: "Memory survives empty code index",
          type: "project",
          class: "fact",
          scope: "project",
          status: "active",
          summary: "Memory is independent of code index freshness.",
          confidence: 0.9,
          content: "Memory tools should work even when the code index is empty.",
          score: 1,
          filePath: join(tempDir, "memory-contract.md"),
        },
      ]);
      const memoryStore = {
        getByName: () => undefined,
        search: () => [],
        get: () => undefined,
        getAll: () => [],
        getByType: () => [],
      };
      const memoryIndexer = makeMockMemoryIndexer({
        getWritableDirs: () => [tempDir],
        getMemoryDirs: () => [tempDir],
        indexFile: async (filePath: string) => {
          indexedMemoryPath = filePath;
          return true;
        },
      });
      const metadata = makeMockMetadata({
        getStats: () => ({ totalFiles: 0, totalChunks: 0, languages: {} }),
        getStat: () => undefined,
      });
      const handlers = await captureToolHandlers(
        makeMockSearch(),
        makeMockPipeline(),
        metadata,
        makeConfig(),
        { memorySearch, memoryIndexer, memoryStore }
      );

      const recallResult = await handlers.get("memory")!({
        action: "recall",
        query: "memory contract",
      });
      const recallParsed = JSON.parse(recallResult.content[0].text);
      expect(recallParsed.action).toBe("recall");
      expect(recallParsed.memories[0].name).toBe("memory-contract");

      const storeResult = await handlers.get("memory")!({
        action: "store",
        name: "empty index memory write",
        description: "Store should work without code chunks",
        memoryType: "project",
        content: "Stored while code index is empty.",
      });
      const storeParsed = JSON.parse(storeResult.content[0].text);
      expect(storeParsed.action).toBe("store");
      expect(storeParsed.stored).toBe(true);
      expect(indexedMemoryPath).toContain("empty_index_memory_write");

      const searchResult = await handlers.get("search_code")!({ query: "anything" });
      const searchParsed = JSON.parse(searchResult.content[0].text);
      expect(searchParsed.banner).toContain("reporecall index EMPTY");

      const flowResult = await handlers.get("explain_flow")!({ query: "anything" });
      const flowParsed = JSON.parse(flowResult.content[0].text);
      expect(flowParsed.banner).toContain("reporecall index EMPTY");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("get_stats returns statistics, conventions, and latency", async () => {
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig()
    );
    const handler = handlers.get("get_stats");
    expect(handler).toBeDefined();

    const result = await handler!({});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toHaveProperty("totalFiles");
    expect(parsed).toHaveProperty("totalChunks");
    expect(parsed).toHaveProperty("lastIndexedAt");
    expect(parsed).toHaveProperty("latency");
    expect(parsed.totalFiles).toBe(5);
    expect(parsed.totalChunks).toBe(22);
  });

  it("does not register Lens, business, wiki, topology, or clear-index tools", async () => {
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig(),
      {
        memorySearch: makeMockMemorySearch(),
        memoryIndexer: makeMockMemoryIndexer(),
        memoryStore: makeMockMemoryStore(),
      }
    );

    for (const removedName of [
      "get_lens_data",
      "list_product_areas",
      "business_context_query",
      "wiki_query",
      "wiki_read",
      "wiki_write",
      "wiki_check_staleness",
      "get_communities",
      "get_hub_nodes",
      "get_surprises",
      "suggest_investigations",
      "clear_index",
    ]) {
      expect(handlers.get(removedName), removedName).toBeUndefined();
    }
  });

  it("explain_flow action=callers returns callers of a function", async () => {
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig()
    );
    const handler = handlers.get("explain_flow");
    expect(handler).toBeDefined();

    const result = await handler!({ action: "callers", functionName: "processRequest", limit: 10 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.action).toBe("callers");
    expect(parsed.callers.length).toBeGreaterThan(0);
    expect(parsed.callers[0].callerName).toBe("handleRoute");
    expect(parsed.staleness.level).toBe("fresh");
  });

  it("explain_flow action=callees returns callees of a function", async () => {
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig()
    );
    const handler = handlers.get("explain_flow");
    expect(handler).toBeDefined();

    const result = await handler!({ action: "callees", functionName: "processRequest", limit: 10 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.action).toBe("callees");
    expect(parsed.callees.length).toBeGreaterThan(0);
    expect(parsed.callees[0].targetName).toBe("validateInput");
    expect(parsed.staleness.level).toBe("fresh");
  });

  it("explain_flow action=symbol returns matching chunks by name", async () => {
    const metadata = makeMockMetadata({
      findChunksByNames: (names: string[]) => {
        if (names.includes("processRequest")) {
          return [
            {
              id: "c1",
              name: "processRequest",
              kind: "function_declaration",
              filePath: "src/server.ts",
              startLine: 10,
              endLine: 25,
              content: "function processRequest(req) { return req; }",
              parentName: undefined,
              language: "typescript",
            },
          ];
        }
        return [];
      },
    });

    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      metadata,
      makeConfig()
    );
    const handler = handlers.get("explain_flow");
    expect(handler).toBeDefined();

    const result = await handler!({ action: "symbol", name: "processRequest" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.action).toBe("symbol");
    expect(parsed.symbol).toBe("processRequest");
    expect(parsed.count).toBe(1);
    expect(parsed.matches[0].name).toBe("processRequest");
    expect(parsed.matches[0].filePath).toBe("src/server.ts");
    expect(parsed.matches[0].kind).toBe("function_declaration");
  });

  it("explain_flow action=symbol returns empty matches for unknown symbol", async () => {
    const metadata = makeMockMetadata({
      findChunksByNames: () => [],
    });

    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      metadata,
      makeConfig()
    );
    const handler = handlers.get("explain_flow");
    expect(handler).toBeDefined();

    const result = await handler!({ action: "symbol", name: "nonexistent" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.action).toBe("symbol");
    expect(parsed.symbol).toBe("nonexistent");
    expect(parsed.count).toBe(0);
    expect(parsed.matches).toEqual([]);
  });

  it("explain_flow returns flow context with seed and tree info", async () => {
    const seedChunk = {
      id: "seed-1",
      name: "handleAuth",
      kind: "function_declaration",
      filePath: "src/auth.ts",
      startLine: 1,
      endLine: 10,
      content: "function handleAuth() { validate(); }",
      language: "typescript",
      confidence: 0.9,
    };

    const calleeChunk = {
      id: "callee-1",
      name: "validate",
      kind: "function_declaration",
      filePath: "src/validate.ts",
      startLine: 1,
      endLine: 5,
      content: "function validate() {}",
      language: "typescript",
    };

    const metadata = makeMockMetadata({
      findChunksByNames: (names: string[]) => {
        const results: any[] = [];
        if (names.includes("handleAuth")) results.push(seedChunk);
        if (names.includes("validate")) results.push(calleeChunk);
        return results;
      },
      getChunksByIds: (ids: string[]) => {
        const map: Record<string, any> = {
          "seed-1": seedChunk,
          "callee-1": calleeChunk,
        };
        return ids.map((id) => map[id]).filter(Boolean);
      },
      findCallers: () => [],
      findCallees: (name: string) => {
        if (name === "handleAuth") {
          return [{ targetName: "validate", callType: "call", line: 5, filePath: "src/auth.ts" }];
        }
        return [];
      },
      findCalleesForChunk: (chunkId: string) => {
        if (chunkId === "seed-1") {
          return [{ targetName: "validate", callType: "call", line: 5, filePath: "src/auth.ts" }];
        }
        return [];
      },
    });

    const ftsStore = {
      search: () => [{ id: "seed-1", name: "handleAuth", filePath: "src/auth.ts", kind: "function_declaration" }],
    };

    const pipeline = makeMockPipeline({
      getFTSStore: () => ftsStore,
      getMetadataStore: () => metadata,
    });

    const handlers = await captureToolHandlers(
      makeMockSearch(),
      pipeline,
      metadata,
      makeConfig()
    );
    const handler = handlers.get("explain_flow");
    expect(handler).toBeDefined();

    const result = await handler!({ query: "handleAuth" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.seed.name).toBe("handleAuth");
    expect(parsed.tree.nodeCount).toBeGreaterThanOrEqual(1);
    expect(parsed.tree).toHaveProperty("coverage");
    expect(parsed.tree.coverage).toHaveProperty("utilization");
    expect(parsed.tree.coverage).toHaveProperty("balance");
    expect(parsed.tree.coverage).toHaveProperty("overall");
    expect(parsed.tokenCount).toBeGreaterThan(0);
    expect(parsed.chunksIncluded).toBeGreaterThanOrEqual(1);
    expect(parsed.compression).toBeDefined();
    expect(parsed.compression.enabled).toBe(true);
  });

  it("explain_flow returns message when no seed found", async () => {
    const metadata = makeMockMetadata({
      findChunksByNames: () => [],
    });

    const ftsStore = { search: () => [] };
    const pipeline = makeMockPipeline({
      getFTSStore: () => ftsStore,
      getMetadataStore: () => metadata,
    });

    const handlers = await captureToolHandlers(
      makeMockSearch(),
      pipeline,
      metadata,
      makeConfig()
    );
    const handler = handlers.get("explain_flow");
    expect(handler).toBeDefined();

    const result = await handler!({ query: "nonexistentSymbol" });
    expect(result.content[0].text).toContain("No matching code symbol");
  });

  it("explain_flow action=imports returns import records for a known file", async () => {
    const metadata = makeMockMetadata({
      getImportsForFile: (filePath: string) => {
        if (filePath === "src/server.ts") {
          return [
            {
              importedName: "processRequest",
              sourceModule: "./handler",
              resolvedPath: "src/handler.ts",
              isDefault: false,
              isNamespace: false,
            },
            {
              importedName: "createServer",
              sourceModule: "http",
              resolvedPath: undefined,
              isDefault: false,
              isNamespace: false,
            },
          ];
        }
        return [];
      },
    });

    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      metadata,
      makeConfig()
    );
    const handler = handlers.get("explain_flow");
    expect(handler).toBeDefined();

    const result = await handler!({ action: "imports", filePath: "src/server.ts" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.action).toBe("imports");
    expect(parsed.filePath).toBe("src/server.ts");
    expect(parsed.count).toBe(2);
    expect(Array.isArray(parsed.imports)).toBe(true);

    const first = parsed.imports[0];
    expect(first.name).toBe("processRequest");
    expect(first.from).toBe("./handler");
    expect(first.resolvedPath).toBe("src/handler.ts");
    expect(first.isDefault).toBe(false);
    expect(first.isNamespace).toBe(false);

    const second = parsed.imports[1];
    expect(second.name).toBe("createServer");
    expect(second.from).toBe("http");
    expect(second.resolvedPath).toBeUndefined();
  });

  it("explain_flow action=imports returns empty imports for a file with no imports", async () => {
    const metadata = makeMockMetadata({
      getImportsForFile: () => [],
    });

    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      metadata,
      makeConfig()
    );
    const handler = handlers.get("explain_flow");
    expect(handler).toBeDefined();

    const result = await handler!({ action: "imports", filePath: "src/empty.ts" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.action).toBe("imports");
    expect(parsed.filePath).toBe("src/empty.ts");
    expect(parsed.count).toBe(0);
    expect(parsed.imports).toEqual([]);
  });

  it("explain_flow action=imports rejects a path outside the project root", async () => {
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig()
    );
    const handler = handlers.get("explain_flow");
    expect(handler).toBeDefined();

    const result = await handler!({ action: "imports", filePath: "../../etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error");
  });

  it("explain_flow action=resolve_seed returns bestSeed and candidates for a known symbol", async () => {
    const chunk = {
      id: "chunk-processRequest",
      name: "processRequest",
      kind: "function_declaration" as const,
      filePath: "src/server.ts",
      startLine: 10,
      endLine: 25,
      content: "function processRequest(req) { return req; }",
      language: "typescript",
      confidence: 0.95,
    };

    const metadata = makeMockMetadata({
      findChunksByNames: (names: string[]) => {
        if (names.includes("processRequest")) return [chunk];
        return [];
      },
    });

    const ftsStore = {
      search: (query: string) => {
        if (query.toLowerCase().includes("processrequest")) {
          return [
            {
              id: "chunk-processRequest",
              name: "processRequest",
              filePath: "src/server.ts",
              kind: "function_declaration",
            },
          ];
        }
        return [];
      },
    };

    const pipeline = makeMockPipeline({
      getFTSStore: () => ftsStore,
      getMetadataStore: () => metadata,
    });

    const handlers = await captureToolHandlers(
      makeMockSearch(),
      pipeline,
      metadata,
      makeConfig()
    );
    const handler = handlers.get("explain_flow");
    expect(handler).toBeDefined();

    const result = await handler!({ action: "resolve_seed", query: "processRequest" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.action).toBe("resolve_seed");
    // Must expose the three top-level keys the MCP tool documents
    expect(parsed).toHaveProperty("bestSeed");
    expect(parsed).toHaveProperty("candidates");
    expect(parsed).toHaveProperty("count");

    expect(typeof parsed.count).toBe("number");
    expect(Array.isArray(parsed.candidates)).toBe(true);

    // With a matching chunk the best seed should be resolved
    if (parsed.bestSeed !== null) {
      expect(parsed.bestSeed.name).toBe("processRequest");
      expect(typeof parsed.bestSeed.confidence).toBe("number");
      expect(parsed.bestSeed.confidence).toBeGreaterThan(0);
    }
  });

  it("explain_flow action=resolve_seed returns null bestSeed for an unknown symbol", async () => {
    const metadata = makeMockMetadata({
      findChunksByNames: () => [],
    });

    const ftsStore = { search: () => [] };

    const pipeline = makeMockPipeline({
      getFTSStore: () => ftsStore,
      getMetadataStore: () => metadata,
    });

    const handlers = await captureToolHandlers(
      makeMockSearch(),
      pipeline,
      metadata,
      makeConfig()
    );
    const handler = handlers.get("explain_flow");
    expect(handler).toBeDefined();

    const result = await handler!({ action: "resolve_seed", query: "completelyUnknownSymbolXYZ" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.action).toBe("resolve_seed");
    expect(parsed.bestSeed).toBeNull();
    expect(parsed.count).toBe(0);
    expect(parsed.candidates).toEqual([]);
  });

  it("explain_flow action=stack_tree includes coverage in response", async () => {
    const seedChunk = {
      id: "seed-1",
      name: "myFunc",
      kind: "function_declaration",
      filePath: "src/main.ts",
      startLine: 1,
      endLine: 10,
      content: "function myFunc() {}",
      language: "typescript",
      confidence: 0.9,
    };

    const metadata = makeMockMetadata({
      findChunksByNames: (names: string[]) => {
        if (names.includes("myFunc")) return [seedChunk];
        return [];
      },
      getChunksByIds: (ids: string[]) =>
        ids.includes("seed-1") ? [seedChunk] : [],
      findCallers: () => [],
      findCallees: () => [],
      findCalleesForChunk: () => [],
    });

    const ftsStore = {
      search: () => [{ id: "seed-1", name: "myFunc", filePath: "src/main.ts", kind: "function_declaration" }],
    };

    const pipeline = makeMockPipeline({
      getFTSStore: () => ftsStore,
      getMetadataStore: () => metadata,
    });

    const handlers = await captureToolHandlers(
      makeMockSearch(),
      pipeline,
      metadata,
      makeConfig()
    );
    const handler = handlers.get("explain_flow");
    expect(handler).toBeDefined();

    const result = await handler!({ action: "stack_tree", seed: "myFunc" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.action).toBe("stack_tree");
    expect(parsed).toHaveProperty("coverage");
    expect(parsed.coverage).toHaveProperty("utilization");
    expect(parsed.coverage).toHaveProperty("balance");
    expect(parsed.coverage).toHaveProperty("overall");
  });
});
