import { describe, it, expect } from "vitest";
import { createMCPServer } from "../../src/daemon/mcp-server.js";

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
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].name).toBe("processRequest");
    expect(parsed[0].id).toBe("c1");
    expect(parsed[0].filePath).toBe("src/server.ts");
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
  });

  it("read_code_chunk returns original source by chunk id", async () => {
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig()
    );
    const handler = handlers.get("read_code_chunk");
    expect(handler).toBeDefined();

    const result = await handler!({ chunkId: "c1" });
    expect(result.content).toHaveLength(1);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe("c1");
    expect(parsed.content).toContain("function processRequest");
    expect(parsed.startLine).toBe(10);
  });

  it("read_code_chunk returns original source by file and line range", async () => {
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig()
    );
    const handler = handlers.get("read_code_chunk");
    expect(handler).toBeDefined();

    const result = await handler!({ filePath: "src/server.ts", startLine: 12, endLine: 13 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe("c1");
    expect(parsed.filePath).toBe("src/server.ts");
  });

  it("index_codebase with no paths calls indexAll", async () => {
    let indexAllCalled = false;
    const pipeline = makeMockPipeline({
      indexAll: async () => {
        indexAllCalled = true;
        return { filesProcessed: 5, chunksCreated: 22 };
      },
    });

    const handlers = await captureToolHandlers(
      makeMockSearch(),
      pipeline,
      makeMockMetadata(),
      makeConfig()
    );
    const handler = handlers.get("index_codebase");
    expect(handler).toBeDefined();

    const result = await handler!({ paths: undefined });
    expect(indexAllCalled).toBe(true);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.filesProcessed).toBe(5);
    expect(parsed.chunksCreated).toBe(22);
  });

  it("index_codebase with paths calls indexChanged", async () => {
    let capturedPaths: string[] | undefined;
    const pipeline = makeMockPipeline({
      indexChanged: async (paths: string[]) => {
        capturedPaths = paths;
        return { filesProcessed: paths.length, chunksCreated: paths.length * 2 };
      },
    });

    const handlers = await captureToolHandlers(
      makeMockSearch(),
      pipeline,
      makeMockMetadata(),
      makeConfig()
    );
    const handler = handlers.get("index_codebase");
    expect(handler).toBeDefined();

    await handler!({ paths: ["src/server.ts", "src/app.ts"] });
    expect(capturedPaths).toEqual(["src/server.ts", "src/app.ts"]);
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

  it("get_lens_data returns bounded Lens JSON without triggering indexing", async () => {
    let indexAllCalled = false;
    const pipeline = makeMockPipeline({
      indexAll: async () => {
        indexAllCalled = true;
        return { filesProcessed: 1, chunksCreated: 1 };
      },
    });
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      pipeline,
      makeMockMetadata(),
      makeConfig(),
      { memoryStore: makeMockMemoryStore() }
    );
    const handler = handlers.get("get_lens_data");
    expect(handler).toBeDefined();

    const result = await handler!({
      includeWikiContent: false,
      includeBusinessPages: false,
      includeGraph: false,
    });

    expect(indexAllCalled).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.meta.projectName).toBe("test-mcp");
    expect(parsed.wikiPages[0].content).toBe("");
    expect(parsed.businessPages).toEqual([]);
    expect(parsed.productAreas).toEqual([]);
    expect(parsed.communities).toEqual([]);
    expect(parsed.wikiGraphNodes).toEqual([]);
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

  it("list_product_areas returns business-facing aggregates from wiki memory", async () => {
    const memoryStore = makeMockMemoryStore();
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig(),
      { memoryStore }
    );
    const handler = handlers.get("list_product_areas");
    expect(handler).toBeDefined();

    const result = await handler!({ limit: 10 });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.businessPageCount).toBe(2);
    expect(parsed.productAreas.map((area: any) => area.name)).toContain("Product Area: Authentication");
  });

  it("list_product_areas hides unsafe fallback areas unless diagnostics are requested", async () => {
    const base = makeMockMemoryStore();
    const memoryStore = {
      ...base,
      getByType: (type: string) => [
        ...base.getByType(type),
        {
          id: "wiki-technical-helper",
          name: "business-shared-retry-helper",
          type: "wiki",
          description: "Business capability view",
          summary: "Backend helper coordinates retry work.",
          content: `## Capability
Backend: WithRetry, ProcessRequest

## Actor
Product user

## Trigger
A request enters this capability.

## Business outcome
The product completes the capability.`,
          filePath: "/tmp/test-mcp/.memory/wiki/business-shared-retry-helper.md",
          relatedFiles: ["src/retry.ts"],
          relatedSymbols: ["WithRetry", "ProcessRequest"],
          confidence: 0.61,
        },
      ],
    };
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig(),
      { memoryStore }
    );
    const handler = handlers.get("list_product_areas");
    expect(handler).toBeDefined();

    const safeResult = await handler!({ limit: 20 });
    const safeParsed = JSON.parse(safeResult.content[0].text);
    expect(safeParsed.productAreas.every((area: any) => area.presentationSafe)).toBe(true);
    expect(safeParsed.safeTotal).toBe(safeParsed.count);

    const diagnosticResult = await handler!({ limit: 20, includeUnsafe: true });
    const diagnosticParsed = JSON.parse(diagnosticResult.content[0].text);
    expect(diagnosticParsed.productAreas.some((area: any) => area.presentationSafe === false)).toBe(true);
  });

  it("business_context_query returns matching product areas and pages", async () => {
    const memoryStore = makeMockMemoryStore();
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig(),
      { memoryStore }
    );
    const handler = handlers.get("business_context_query");
    expect(handler).toBeDefined();

    const result = await handler!({ query: "authentication session login", limit: 3 });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.query).toBe("authentication session login");
    expect(parsed.productAreas[0].name).toBe("Product Area: Authentication");
    expect(parsed.businessPages[0].name).toBe("business-user-authentication");
    expect(parsed.businessPages[0].supportingFiles).toContain("src/auth.ts");
  });

  it("wiki_read returns replacement suggestions for stale generated slugs", async () => {
    const base = makeMockMemoryStore();
    const memoryStore = {
      ...base,
      getByName: () => undefined,
      getByType: (type: string) => {
        if (type !== "wiki") return [];
        return [
          {
            id: "wiki-area",
            name: "product-area-analytics",
            type: "wiki",
            description: "Analytics groups dashboard reporting capabilities.",
            summary: "Analytics covers dashboard reporting and metric review.",
            content: "Dashboard charts and reports help users review metrics.",
            filePath: "/tmp/test-mcp/.memory/wiki/product-area-analytics.md",
            relatedFiles: [],
            relatedSymbols: [],
            confidence: 0.86,
          },
          {
            id: "wiki-upload",
            name: "business-upload",
            type: "wiki",
            description: "Upload accepts files.",
            summary: "Upload accepts incoming files.",
            content: "File intake and storage.",
            filePath: "/tmp/test-mcp/.memory/wiki/business-upload.md",
            relatedFiles: [],
            relatedSymbols: [],
            confidence: 0.8,
          },
        ];
      },
    };
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig(),
      {
        memoryStore,
        memorySearch: { search: async () => [] },
        memoryIndexer: { getWritableDirs: () => ["/tmp/test-mcp/.memory"] },
      }
    );
    const handler = handlers.get("wiki_read");
    expect(handler).toBeDefined();

    const result = await handler!({ name: "business-analytics-dashboard" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.status).toBe("not_found");
    expect(parsed.suggestions[0].name).toBe("product-area-analytics");
    expect(parsed.suggestions[0].matchedTerms).toContain("dashboard");
  });

  it("clear_index with confirm=false returns abort message", async () => {
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig()
    );
    const handler = handlers.get("clear_index");
    expect(handler).toBeDefined();

    const result = await handler!({ confirm: false });
    expect(result.content[0].text).toContain("Aborted");
  });

  it("find_callers returns callers of a function", async () => {
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig()
    );
    const handler = handlers.get("find_callers");
    expect(handler).toBeDefined();

    const result = await handler!({ functionName: "processRequest", limit: 10 });
    const parsed = JSON.parse(result.content[0].text);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].callerName).toBe("handleRoute");
  });

  it("find_callees returns callees of a function", async () => {
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig()
    );
    const handler = handlers.get("find_callees");
    expect(handler).toBeDefined();

    const result = await handler!({ functionName: "processRequest", limit: 10 });
    const parsed = JSON.parse(result.content[0].text);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].targetName).toBe("validateInput");
  });

  it("get_symbol returns matching chunks by name", async () => {
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
    const handler = handlers.get("get_symbol");
    expect(handler).toBeDefined();

    const result = await handler!({ name: "processRequest" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.symbol).toBe("processRequest");
    expect(parsed.count).toBe(1);
    expect(parsed.matches[0].name).toBe("processRequest");
    expect(parsed.matches[0].filePath).toBe("src/server.ts");
    expect(parsed.matches[0].kind).toBe("function_declaration");
  });

  it("get_symbol returns empty matches for unknown symbol", async () => {
    const metadata = makeMockMetadata({
      findChunksByNames: () => [],
    });

    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      metadata,
      makeConfig()
    );
    const handler = handlers.get("get_symbol");
    expect(handler).toBeDefined();

    const result = await handler!({ name: "nonexistent" });
    const parsed = JSON.parse(result.content[0].text);

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

  it("get_imports returns import records for a known file", async () => {
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
    const handler = handlers.get("get_imports");
    expect(handler).toBeDefined();

    const result = await handler!({ filePath: "src/server.ts" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

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

  it("get_imports returns empty imports for a file with no imports", async () => {
    const metadata = makeMockMetadata({
      getImportsForFile: () => [],
    });

    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      metadata,
      makeConfig()
    );
    const handler = handlers.get("get_imports");
    expect(handler).toBeDefined();

    const result = await handler!({ filePath: "src/empty.ts" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.filePath).toBe("src/empty.ts");
    expect(parsed.count).toBe(0);
    expect(parsed.imports).toEqual([]);
  });

  it("get_imports rejects a path outside the project root", async () => {
    const handlers = await captureToolHandlers(
      makeMockSearch(),
      makeMockPipeline(),
      makeMockMetadata(),
      makeConfig()
    );
    const handler = handlers.get("get_imports");
    expect(handler).toBeDefined();

    const result = await handler!({ filePath: "../../etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error");
  });

  it("resolve_seed returns bestSeed and candidates for a known symbol", async () => {
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
    const handler = handlers.get("resolve_seed");
    expect(handler).toBeDefined();

    const result = await handler!({ query: "processRequest" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);

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

  it("resolve_seed returns null bestSeed for an unknown symbol", async () => {
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
    const handler = handlers.get("resolve_seed");
    expect(handler).toBeDefined();

    const result = await handler!({ query: "completelyUnknownSymbolXYZ" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.bestSeed).toBeNull();
    expect(parsed.count).toBe(0);
    expect(parsed.candidates).toEqual([]);
  });

  it("build_stack_tree includes coverage in response", async () => {
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
    const handler = handlers.get("build_stack_tree");
    expect(handler).toBeDefined();

    const result = await handler!({ seed: "myFunc" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toHaveProperty("coverage");
    expect(parsed.coverage).toHaveProperty("utilization");
    expect(parsed.coverage).toHaveProperty("balance");
    expect(parsed.coverage).toHaveProperty("overall");
  });
});
