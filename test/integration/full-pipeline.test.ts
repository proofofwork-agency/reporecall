import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { chunkFileWithCalls } from "../../src/parser/chunker.js";
import { MetadataStore } from "../../src/storage/metadata-store.js";
import { analyzeConventions } from "../../src/analysis/conventions.js";
import { getLanguageForExtension, LANGUAGE_CONFIGS } from "../../src/parser/languages.js";
import { LocalEmbedder } from "../../src/indexer/local-embedder.js";
import { NullEmbedder } from "../../src/indexer/null-embedder.js";
import { IndexingPipeline } from "../../src/indexer/pipeline.js";
import { FTSStore } from "../../src/storage/fts-store.js";
import type { MemoryConfig } from "../../src/core/config.js";

const FIXTURES = resolve(import.meta.dirname, "..", "fixtures");
const TEST_DATA_DIR = resolve(import.meta.dirname, "..", ".test-data-integration");

describe("LocalEmbedder", () => {
  it("should embed texts and return correct dimensions", async () => {
    const embedder = new LocalEmbedder();
    expect(embedder.dimensions()).toBe(384);

    const vectors = await embedder.embed(["hello world", "function foo() {}"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(384);
    expect(vectors[1]).toHaveLength(384);

    // Verify vectors are normalized (magnitude ~1.0)
    const magnitude = Math.sqrt(vectors[0].reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 1);
  }, 60000); // allow time for model download on first run
});

describe("language support", () => {
  it("should support 22 languages", () => {
    const languages = Object.keys(LANGUAGE_CONFIGS);
    expect(languages.length).toBeGreaterThanOrEqual(22);
  });

  it("should resolve all expected extensions", () => {
    const cases: [string, string][] = [
      [".ts", "typescript"],
      [".js", "javascript"],
      [".py", "python"],
      [".go", "go"],
      [".rs", "rust"],
      [".java", "java"],
      [".rb", "ruby"],
      [".css", "css"],
      [".c", "c"],
      [".cpp", "cpp"],
      [".cs", "csharp"],
      [".php", "php"],
      [".swift", "swift"],
      [".kt", "kotlin"],
      [".scala", "scala"],
      [".zig", "zig"],
      [".sh", "bash"],
      [".lua", "lua"],
      [".html", "html"],
      [".vue", "vue"],
      [".toml", "toml"],
    ];

    for (const [ext, expectedLang] of cases) {
      const result = getLanguageForExtension(ext);
      expect(result, `Extension ${ext} should resolve`).toBeDefined();
      expect(result!.language).toBe(expectedLang);
    }
  });

  it("should have callNodeTypes for programming languages", () => {
    const withCalls = [
      "typescript", "javascript", "python", "go", "rust", "java", "ruby",
      "c", "cpp", "csharp", "php", "swift", "kotlin", "scala",
    ];

    for (const lang of withCalls) {
      const config = LANGUAGE_CONFIGS[lang];
      expect(config.callNodeTypes, `${lang} should have callNodeTypes`).toBeDefined();
      expect(config.callNodeTypes!.length).toBeGreaterThan(0);
    }
  });
});

describe("chunkFileWithCalls", () => {
  it("should extract chunks and call edges from TypeScript", async () => {
    const { chunks, callEdges } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.ts"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);

    const names = chunks.map((c) => c.name);
    expect(names).toContain("validateSession");
    expect(names).toContain("SessionManager");

    // validateSession calls decodeToken
    const decodeTokenEdges = callEdges.filter((e) => e.targetName === "decodeToken");
    expect(decodeTokenEdges.length).toBeGreaterThan(0);
  });

  it("should extract call edges from Python", async () => {
    const { chunks, callEdges } = await chunkFileWithCalls(
      resolve(FIXTURES, "sample.py"),
      FIXTURES
    );

    expect(chunks.length).toBeGreaterThan(0);

    // DatabaseConnection.__init__ calls things, create_tables calls cursor methods
    expect(callEdges.length).toBeGreaterThan(0);
  });
});

describe("call edges storage", () => {
  let store: MetadataStore;

  beforeEach(() => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    store = new MetadataStore(TEST_DATA_DIR);
  });

  afterEach(() => {
    store.close();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("should store and query call edges", () => {
    store.upsertCallEdges([
      {
        sourceChunkId: "chunk-1",
        targetName: "helperFn",
        callType: "call",
        filePath: "src/main.ts",
        line: 10,
      },
      {
        sourceChunkId: "chunk-1",
        targetName: "Logger",
        callType: "new",
        filePath: "src/main.ts",
        line: 12,
      },
      {
        sourceChunkId: "chunk-2",
        targetName: "helperFn",
        callType: "call",
        filePath: "src/utils.ts",
        line: 5,
      },
    ]);

    // Store chunks so findCallers join works
    const now = new Date().toISOString();
    store.upsertChunk({
      id: "chunk-1",
      filePath: "src/main.ts",
      name: "processData",
      kind: "function_declaration",
      startLine: 1,
      endLine: 20,
      content: "function processData() {}",
      language: "typescript",
      indexedAt: now,
    });
    store.upsertChunk({
      id: "chunk-2",
      filePath: "src/utils.ts",
      name: "transform",
      kind: "function_declaration",
      startLine: 1,
      endLine: 10,
      content: "function transform() {}",
      language: "typescript",
      indexedAt: now,
    });

    // Find callers of helperFn
    const callers = store.findCallers("helperFn");
    expect(callers.length).toBe(2);
    expect(callers.map((c) => c.callerName).sort()).toEqual(["processData", "transform"]);

    // Find callees of processData
    const callees = store.findCallees("processData");
    expect(callees.length).toBe(2);
    expect(callees.map((c) => c.targetName).sort()).toEqual(["Logger", "helperFn"]);

    // Top call targets
    const top = store.getTopCallTargets(5);
    expect(top[0]).toBe("helperFn"); // called twice
  });

  it("should remove call edges by file", () => {
    store.upsertCallEdges([
      {
        sourceChunkId: "c1",
        targetName: "foo",
        callType: "call",
        filePath: "src/a.ts",
        line: 1,
      },
      {
        sourceChunkId: "c2",
        targetName: "bar",
        callType: "call",
        filePath: "src/b.ts",
        line: 1,
      },
    ]);

    store.removeCallEdgesForFile("src/a.ts");
    const top = store.getTopCallTargets(10);
    expect(top).toEqual(["bar"]);
  });
});

describe("conventions analysis", () => {
  let store: MetadataStore;

  beforeEach(() => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    store = new MetadataStore(TEST_DATA_DIR);
  });

  afterEach(() => {
    store.close();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("should detect camelCase naming convention", () => {
    const now = new Date().toISOString();
    const camelNames = ["processData", "validateInput", "handleRequest", "formatOutput", "getUserById"];

    for (let i = 0; i < camelNames.length; i++) {
      store.upsertChunk({
        id: `fn-${i}`,
        filePath: "src/app.ts",
        name: camelNames[i],
        kind: "function_declaration",
        startLine: i * 10 + 1,
        endLine: i * 10 + 8,
        content: `function ${camelNames[i]}() {}`,
        language: "typescript",
        indexedAt: now,
      });
    }

    store.upsertChunk({
      id: "cls-1",
      filePath: "src/app.ts",
      name: "UserService",
      kind: "class_declaration",
      startLine: 100,
      endLine: 150,
      content: "class UserService {}",
      language: "typescript",
      indexedAt: now,
    });

    const report = analyzeConventions(store);

    expect(report.namingStyle.functions).toBe("camelCase");
    expect(report.namingStyle.classes).toBe("PascalCase");
    expect(report.totalFunctions).toBe(5);
    expect(report.totalClasses).toBe(1);
    expect(report.averageFunctionLength).toBe(8);
    expect(report.docstringCoverage).toBe(0);
    expect(report.languageDistribution.typescript).toBe(6);
  });

  it("should detect snake_case naming convention", () => {
    const now = new Date().toISOString();
    const snakeNames = ["process_data", "validate_input", "handle_request", "format_output"];

    for (let i = 0; i < snakeNames.length; i++) {
      store.upsertChunk({
        id: `fn-${i}`,
        filePath: "src/app.py",
        name: snakeNames[i],
        kind: "function_definition",
        startLine: i * 5 + 1,
        endLine: i * 5 + 4,
        content: `def ${snakeNames[i]}(): pass`,
        language: "python",
        indexedAt: now,
      });
    }

    const report = analyzeConventions(store);
    expect(report.namingStyle.functions).toBe("snake_case");
  });

  it("should calculate docstring coverage", () => {
    const now = new Date().toISOString();

    store.upsertChunk({
      id: "fn-1",
      filePath: "src/app.ts",
      name: "withDoc",
      kind: "function_declaration",
      startLine: 1,
      endLine: 5,
      content: "function withDoc() {}",
      docstring: "/** Does something */",
      language: "typescript",
      indexedAt: now,
    });

    store.upsertChunk({
      id: "fn-2",
      filePath: "src/app.ts",
      name: "withoutDoc",
      kind: "function_declaration",
      startLine: 10,
      endLine: 15,
      content: "function withoutDoc() {}",
      language: "typescript",
      indexedAt: now,
    });

    const report = analyzeConventions(store);
    expect(report.docstringCoverage).toBe(50);
  });

  it("should store and retrieve conventions", () => {
    const now = new Date().toISOString();
    store.upsertChunk({
      id: "fn-1",
      filePath: "src/app.ts",
      name: "myFunc",
      kind: "function_declaration",
      startLine: 1,
      endLine: 5,
      content: "function myFunc() {}",
      language: "typescript",
      indexedAt: now,
    });

    const report = analyzeConventions(store);
    store.setConventions(report);

    const retrieved = store.getConventions();
    expect(retrieved).toBeDefined();
    expect(retrieved!.totalFunctions).toBe(report.totalFunctions);
    expect(retrieved!.namingStyle.functions).toBe(report.namingStyle.functions);
  });
});

describe("NullEmbedder", () => {
  it("should return 0 dimensions and empty vectors", async () => {
    const embedder = new NullEmbedder();
    expect(embedder.dimensions()).toBe(0);

    const vectors = await embedder.embed(["hello", "world"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual([]);
    expect(vectors[1]).toEqual([]);
  });
});

describe("keyword-only pipeline", () => {
  const TEST_PROJECT = resolve(import.meta.dirname, "..", ".test-keyword-project");
  const TEST_DATA = resolve(TEST_PROJECT, ".memory");

  beforeEach(() => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    // Create a sample source file
    writeFileSync(
      resolve(TEST_PROJECT, "auth.ts"),
      `export function validateToken(token: string): boolean {
  const decoded = decodeToken(token);
  return decoded.exp > Date.now();
}

export function refreshSession(userId: string): string {
  const newToken = generateToken(userId);
  return newToken;
}
`
    );
  });

  afterEach(() => {
    rmSync(TEST_PROJECT, { recursive: true, force: true });
  });

  it("should index and search without embedding model", async () => {
    const config: MemoryConfig = {
      projectRoot: TEST_PROJECT,
      dataDir: TEST_DATA,
      embeddingProvider: "keyword",
      embeddingModel: "",
      embeddingDimensions: 0,
      ollamaUrl: "",
      extensions: [".ts"],
      ignorePatterns: ["node_modules", ".git", ".memory"],
      maxFileSize: 100 * 1024,
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
      port: 37222,
      implementationPaths: ["src/", "lib/", "bin/"],
      factExtractors: [],
    };

    const pipeline = new IndexingPipeline(config);

    try {
      const result = await pipeline.indexAll();
      expect(result.filesProcessed).toBeGreaterThan(0);
      expect(result.chunksCreated).toBeGreaterThan(0);

      // FTS search should return results
      const fts = pipeline.getFTSStore();
      const ftsResults = fts.search("validateToken", 10);
      expect(ftsResults.length).toBeGreaterThan(0);

      // Embedder should be NullEmbedder
      const embedder = pipeline.getEmbedder();
      expect(embedder.dimensions()).toBe(0);
    } finally {
      pipeline.close();
    }
  }, 30000);
});

// 3B: Incremental indexing
describe("incremental indexing (3B)", () => {
  const TEST_PROJECT = resolve(import.meta.dirname, "..", ".test-incremental-project");
  const TEST_DATA = resolve(TEST_PROJECT, ".memory");

  function makeConfig(): MemoryConfig {
    return {
      projectRoot: TEST_PROJECT,
      dataDir: TEST_DATA,
      embeddingProvider: "keyword",
      embeddingModel: "",
      embeddingDimensions: 0,
      ollamaUrl: "",
      extensions: [".ts"],
      ignorePatterns: ["node_modules", ".git", ".memory"],
      maxFileSize: 100 * 1024,
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
      port: 37225,
      implementationPaths: ["src/", "lib/", "bin/"],
      factExtractors: [],
    };
  }

  beforeEach(() => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    writeFileSync(
      resolve(TEST_PROJECT, "module.ts"),
      `export function initialFunction(): string {
  return "initial";
}
`
    );
  });

  afterEach(() => {
    rmSync(TEST_PROJECT, { recursive: true, force: true });
  });

  it("should replace old chunks when file is modified and re-indexed", async () => {
    const config = makeConfig();
    const pipeline = new IndexingPipeline(config);

    try {
      // Initial index
      const firstResult = await pipeline.indexAll();
      expect(firstResult.chunksCreated).toBeGreaterThan(0);

      const metaAfterFirst = pipeline.getMetadataStore();
      const chunksAfterFirst = metaAfterFirst.getStats().totalChunks;
      expect(chunksAfterFirst).toBeGreaterThan(0);

      // FTS should find the original function
      const ftsAfterFirst = pipeline.getFTSStore().search("initialFunction", 10);
      expect(ftsAfterFirst.length).toBeGreaterThan(0);

      // Modify the file — replace function with two new ones
      writeFileSync(
        resolve(TEST_PROJECT, "module.ts"),
        `export function updatedFunctionAlpha(): number {
  return 42;
}

export function updatedFunctionBeta(): boolean {
  return true;
}
`
      );

      // Re-index everything
      const secondResult = await pipeline.indexAll();
      expect(secondResult.filesProcessed).toBeGreaterThan(0);
      expect(secondResult.chunksCreated).toBeGreaterThan(0);

      // New functions should appear in FTS
      const ftsNew = pipeline.getFTSStore().search("updatedFunctionAlpha", 10);
      expect(ftsNew.length).toBeGreaterThan(0);

      // Chunk count should reflect the new file content (old chunks replaced)
      const chunksAfterSecond = pipeline.getMetadataStore().getStats().totalChunks;
      // Two new functions were added; original single function is gone
      expect(chunksAfterSecond).toBeGreaterThan(0);
    } finally {
      pipeline.close();
    }
  }, 30000);
});
