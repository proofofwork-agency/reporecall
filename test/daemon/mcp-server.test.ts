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
  return {
    getStats: () => ({ totalFiles: 5, totalChunks: 22, languages: { typescript: 22 } }),
    getStat: (_key: string) => "2025-01-01T00:00:00.000Z",
    setStat: () => {},
    getConventions: () => null,
    getLatencyPercentiles: () => ({ avg: 12, p50: 10, p95: 25, count: 100 }),
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

// Capture tool handlers by monkey-patching McpServer.registerTool during server creation
async function captureToolHandlers(
  search: any,
  pipeline: any,
  metadata: any,
  config: any
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
    createMCPServer(search, pipeline, metadata, config);
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
    expect(parsed[0].filePath).toBe("src/server.ts");
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
});
