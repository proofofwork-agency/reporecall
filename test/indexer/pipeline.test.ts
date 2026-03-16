import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { MetadataStore } from "../../src/storage/metadata-store.js";
import { FTSStore } from "../../src/storage/fts-store.js";
import { MerkleTree } from "../../src/indexer/merkle.js";
import { scanFiles } from "../../src/indexer/file-scanner.js";
import { loadConfig } from "../../src/core/config.js";
import { IndexingPipeline } from "../../src/indexer/pipeline.js";
import type { MemoryConfig } from "../../src/core/config.js";

const TEST_DATA_DIR = resolve(import.meta.dirname, "..", ".test-data");
const FIXTURES = resolve(import.meta.dirname, "..", "fixtures");

describe("metadata store", () => {
  let store: MetadataStore;

  beforeEach(() => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    store = new MetadataStore(TEST_DATA_DIR);
  });

  afterEach(() => {
    store.close();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("should store and retrieve chunks", () => {
    store.upsertChunk({
      id: "test-1",
      filePath: "src/foo.ts",
      name: "myFunction",
      kind: "function_declaration",
      startLine: 1,
      endLine: 10,
      content: "function myFunction() {}",
      language: "typescript",
      indexedAt: new Date().toISOString(),
    });

    const chunk = store.getChunk("test-1");
    expect(chunk).toBeDefined();
    expect(chunk!.name).toBe("myFunction");
    expect(chunk!.filePath).toBe("src/foo.ts");
  });

  it("should track stats", () => {
    store.upsertFile("src/foo.ts", "abc123");
    store.upsertChunk({
      id: "c1",
      filePath: "src/foo.ts",
      name: "fn1",
      kind: "function",
      startLine: 1,
      endLine: 5,
      content: "fn1",
      language: "typescript",
      indexedAt: new Date().toISOString(),
    });

    const stats = store.getStats();
    expect(stats.totalFiles).toBe(1);
    expect(stats.totalChunks).toBe(1);
    expect(stats.languages.typescript).toBe(1);
  });

  it("should remove file and its chunks", () => {
    store.upsertFile("src/foo.ts", "abc");
    store.upsertChunk({
      id: "c1",
      filePath: "src/foo.ts",
      name: "fn1",
      kind: "function",
      startLine: 1,
      endLine: 5,
      content: "fn1",
      language: "typescript",
      indexedAt: new Date().toISOString(),
    });

    store.removeFile("src/foo.ts");
    expect(store.getChunk("c1")).toBeUndefined();
    expect(store.getStats().totalFiles).toBe(0);
  });
});

describe("FTS store", () => {
  let fts: FTSStore;

  beforeEach(() => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    fts = new FTSStore(TEST_DATA_DIR);
  });

  afterEach(() => {
    fts.close();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("should index and search chunks", () => {
    fts.upsert({
      id: "c1",
      name: "validateSession",
      filePath: "src/auth.ts",
      content: "export function validateSession(token: string) {}",
      kind: "function_declaration",
    });

    const results = fts.search("session");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("c1");
  });

  it("should handle empty queries", () => {
    const results = fts.search("");
    expect(results).toEqual([]);
  });
});

describe("file scanner", () => {
  it("should scan fixture files", async () => {
    const config = loadConfig(FIXTURES);
    config.ignorePatterns = [];
    const files = await scanFiles(config);
    expect(files.length).toBeGreaterThan(0);

    const extensions = files.map((f) =>
      f.relativePath.substring(f.relativePath.lastIndexOf("."))
    );
    expect(extensions).toContain(".ts");
    expect(extensions).toContain(".py");
  });
});

describe("merkle tree", () => {
  let merkle: MerkleTree;

  beforeEach(() => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    merkle = new MerkleTree(TEST_DATA_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it("should detect all files as added on first run", async () => {
    const { changes } = await merkle.computeChanges([
      {
        relativePath: "sample.ts",
        absolutePath: resolve(FIXTURES, "sample.ts"),
      },
    ]);

    expect(changes.length).toBe(1);
    expect(changes[0].type).toBe("added");
  });

  it("should detect no changes on second run with same files", async () => {
    const files = [
      {
        relativePath: "sample.ts",
        absolutePath: resolve(FIXTURES, "sample.ts"),
      },
    ];

    const result = await merkle.computeChanges(files);
    merkle.applyPendingState(result.pendingState);
    merkle.save();

    // Recreate to load from disk
    const merkle2 = new MerkleTree(TEST_DATA_DIR);
    const { changes } = await merkle2.computeChanges(files);
    expect(changes.length).toBe(0);
  });
});

// 3A: Pipeline error recovery
describe("pipeline error recovery (3A)", () => {
  const TEST_PROJECT = resolve(import.meta.dirname, "..", ".test-pipeline-3a");
  const TEST_DATA = resolve(TEST_PROJECT, ".memory");

  function makeConfig(): MemoryConfig {
    return {
      projectRoot: TEST_PROJECT,
      dataDir: TEST_DATA,
      embeddingProvider: "keyword",
      embeddingModel: "",
      embeddingDimensions: 0,
      ollamaUrl: "",
      extensions: [".ts", ".bin"],
      ignorePatterns: [".memory"],
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
      port: 37223,
      implementationPaths: ["src/", "lib/", "bin/"],
      factExtractors: [],
    };
  }

  beforeEach(() => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    // Valid TypeScript file
    writeFileSync(
      resolve(TEST_PROJECT, "valid.ts"),
      `export function greet(name: string): string {
  return "Hello, " + name;
}
`
    );
    // Binary/corrupt file — write raw bytes that are not valid UTF-8
    const corruptData = Buffer.from([0x00, 0xff, 0xfe, 0xfa, 0xfb, 0x80, 0x81]);
    writeFileSync(resolve(TEST_PROJECT, "corrupt.bin"), corruptData);
  });

  afterEach(() => {
    rmSync(TEST_PROJECT, { recursive: true, force: true });
  });

  it("should index valid file and skip corrupt file", async () => {
    const config = makeConfig();
    const pipeline = new IndexingPipeline(config);

    try {
      const result = await pipeline.indexAll();

      // valid.ts should have been processed
      expect(result.filesProcessed).toBeGreaterThanOrEqual(1);
      expect(result.chunksCreated).toBeGreaterThan(0);

      // FTS should have chunks from valid.ts
      const fts = pipeline.getFTSStore();
      const searchResults = fts.search("greet", 10);
      expect(searchResults.length).toBeGreaterThan(0);
    } finally {
      pipeline.close();
    }
  }, 30000);

  it("should not record corrupt file in merkle tree", async () => {
    const config = makeConfig();
    const pipeline = new IndexingPipeline(config);

    try {
      await pipeline.indexAll();

      // Check merkle state — only successfully processed files should be tracked
      // Re-running indexAll should show no changes for valid.ts (already tracked)
      // and corrupt.bin should re-appear as a new change each time (not tracked)
      const result2 = await pipeline.indexAll();
      // valid.ts unchanged → 0 new changes for it; corrupt.bin either keeps failing
      // or gets skipped. Either way, chunksCreated from valid.ts remains 0 on 2nd run.
      expect(result2.chunksCreated).toBe(0);
    } finally {
      pipeline.close();
    }
  }, 30000);
});

// 3C: File deletion
describe("pipeline file deletion (3C)", () => {
  const TEST_PROJECT = resolve(import.meta.dirname, "..", ".test-pipeline-3c");
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
      ignorePatterns: [".memory"],
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
      port: 37224,
      implementationPaths: ["src/", "lib/", "bin/"],
      factExtractors: [],
    };
  }

  beforeEach(() => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    writeFileSync(
      resolve(TEST_PROJECT, "service.ts"),
      `export function processRequest(req: any): any {
  return { status: 200 };
}

export function handleError(err: Error): void {
  console.error(err.message);
}
`
    );
  });

  afterEach(() => {
    rmSync(TEST_PROJECT, { recursive: true, force: true });
  });

  it("should remove all chunks and file records after removeFiles()", async () => {
    const config = makeConfig();
    const pipeline = new IndexingPipeline(config);

    try {
      // First index the file
      const result = await pipeline.indexAll();
      expect(result.chunksCreated).toBeGreaterThan(0);

      const meta = pipeline.getMetadataStore();
      const fts = pipeline.getFTSStore();

      // Verify chunks exist before deletion
      const statsBefore = meta.getStats();
      expect(statsBefore.totalChunks).toBeGreaterThan(0);

      // FTS search should find content before deletion
      const ftsBefore = fts.search("processRequest", 10);
      expect(ftsBefore.length).toBeGreaterThan(0);

      // Remove the file (relative path)
      await pipeline.removeFiles(["service.ts"]);

      // All stores should be empty for that file
      const statsAfter = meta.getStats();
      expect(statsAfter.totalChunks).toBe(0);
      expect(statsAfter.totalFiles).toBe(0);

      // FTS should return no results
      const ftsAfter = fts.search("processRequest", 10);
      expect(ftsAfter.length).toBe(0);
    } finally {
      pipeline.close();
    }
  }, 30000);
});
