import { describe, it, expect } from "vitest";
import { handleSessionStart } from "../../src/hooks/session-start.js";
import { handlePromptContext } from "../../src/hooks/prompt-context.js";

// 3H: Hook handlers

function makeAssembledContext(text = "## src/app.ts\nfunction main() {}", tokenCount = 50) {
  return {
    text,
    tokenCount,
    chunks: [
      {
        id: "c1",
        filePath: "src/app.ts",
        name: "main",
        kind: "function_declaration",
        startLine: 1,
        endLine: 5,
        content: "function main() {}",
        language: "typescript",
        score: 0.85,
      },
    ],
  };
}

function makeSearch(contextText = "## src/app.ts\nfunction main() {}"): any {
  return {
    search: async () => [],
    searchWithContext: async () => makeAssembledContext(contextText),
    findCallers: () => [],
    findCallees: () => [],
    updateStores: () => {},
  };
}

function makeConfig(overrides?: Partial<any>): any {
  return {
    projectRoot: "/tmp/test-hooks",
    dataDir: "/tmp/test-hooks/.memory",
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
    port: 37231,
    implementationPaths: ["src/", "lib/", "bin/"],
    factExtractors: [],
    ...overrides,
  };
}

function makeMetadata(conventions?: any): any {
  return {
    getConventions: () => conventions ?? null,
    close: () => {},
  };
}

describe("handleSessionStart (3H)", () => {
  it("should return conventions-only context (no code search)", async () => {
    const search = makeSearch("## src/app.ts\nfunction main() {}");
    const config = makeConfig();

    const context = await handleSessionStart(search, config);

    expect(context).toHaveProperty("text");
    expect(context).toHaveProperty("tokenCount");
    expect(context).toHaveProperty("chunks");
    expect(context.text).toContain("Reporecall");
    expect(context.chunks).toHaveLength(0);
  });

  it("should prepend conventions summary when metadata with conventions is provided", async () => {
    const search = makeSearch("## src/app.ts\nfunction main() {}");
    const config = makeConfig();
    const conventions = {
      namingStyle: { functions: "camelCase", classes: "PascalCase" },
      docstringCoverage: 75,
      averageFunctionLength: 12,
      medianFunctionLength: 10,
      totalFunctions: 20,
      totalClasses: 5,
      languageDistribution: { typescript: 25 },
      topCallTargets: ["processRequest", "validateInput"],
    };
    const metadata = makeMetadata(conventions);

    const context = await handleSessionStart(search, config, metadata);

    // Conventions summary should be present
    expect(context.text).toContain("Codebase Conventions");
    expect(context.text).toContain("camelCase");
    expect(context.text).toContain("PascalCase");
    expect(context.text).toContain("75%");
    // No code search results in session-start (lazy model)
    expect(context.chunks).toHaveLength(0);
  });

  it("should return context without conventions block when metadata has no conventions", async () => {
    const search = makeSearch("## src/app.ts\nfunction main() {}");
    const config = makeConfig();
    const metadata = makeMetadata(null);

    const context = await handleSessionStart(search, config, metadata);

    // No conventions section when metadata returns null
    expect(context.text).not.toContain("Codebase Conventions");
    expect(context.text).toContain("Reporecall");
  });

  it("should return context without prepend when no metadata argument passed", async () => {
    const search = makeSearch("## src/app.ts\nfunction main() {}");
    const config = makeConfig();

    // No metadata argument
    const context = await handleSessionStart(search, config);

    expect(context.text).not.toContain("Codebase Conventions");
    expect(context.text).toContain("Reporecall");
  });
});

describe("handlePromptContext (3H)", () => {
  it("should return null for empty query", async () => {
    const search = makeSearch();
    const config = makeConfig();

    const result = await handlePromptContext("", search, config);
    expect(result).toBeNull();
  });

  it("should return null for whitespace-only query", async () => {
    const search = makeSearch();
    const config = makeConfig();

    const result = await handlePromptContext("   ", search, config);
    expect(result).toBeNull();
  });

  it("should call searchWithContext for non-empty query", async () => {
    let capturedQuery: string | undefined;
    let capturedBudget: number | undefined;

    const search: any = {
      search: async () => [],
      searchWithContext: async (query: string, budget: number) => {
        capturedQuery = query;
        capturedBudget = budget;
        return makeAssembledContext(`## search result for: ${query}`);
      },
      findCallers: () => [],
      findCallees: () => [],
      updateStores: () => {},
    };

    const config = makeConfig({ contextBudget: 5000 });
    const result = await handlePromptContext("how does auth work", search, config);

    expect(result).not.toBeNull();
    expect(capturedQuery).toBe("how does auth work");
    expect(capturedBudget).toBe(5000);
    expect(result!.text).toContain("auth work");
  });

  it("should pass activeFiles to searchWithContext", async () => {
    let capturedActiveFiles: string[] | undefined;

    const search: any = {
      search: async () => [],
      searchWithContext: async (
        _query: string,
        _budget: number,
        activeFiles?: string[]
      ) => {
        capturedActiveFiles = activeFiles;
        return makeAssembledContext("result");
      },
      findCallers: () => [],
      findCallees: () => [],
      updateStores: () => {},
    };

    const config = makeConfig();
    const activeFiles = ["src/auth.ts", "src/utils.ts"];
    await handlePromptContext("validate token", search, config, activeFiles);

    expect(capturedActiveFiles).toEqual(activeFiles);
  });

  it("should return assembled context with text and chunks", async () => {
    const search = makeSearch("## src/auth.ts\nfunction validateToken() {}");
    const config = makeConfig();

    const result = await handlePromptContext("validate token", search, config);

    expect(result).not.toBeNull();
    expect(result!.text).toContain("validateToken");
    expect(result!.chunks.length).toBeGreaterThan(0);
  });
});
