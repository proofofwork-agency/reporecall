import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { IndexingPipeline } from "../../src/indexer/pipeline.js";
import type { MemoryConfig } from "../../src/core/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory that is cleaned up by the caller. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pipeline-edge-"));
}

/**
 * Build a minimal MemoryConfig that uses keyword-only mode (no real embedding
 * provider required) and points at the given project root and data directory.
 */
function makeConfig(projectRoot: string, dataDir: string): MemoryConfig {
  return {
    projectRoot,
    dataDir,
    embeddingProvider: "keyword",
    embeddingModel: "",
    embeddingDimensions: 0,
    ollamaUrl: "",
    extensions: [".ts", ".js"],
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
    port: 37230,
    implementationPaths: ["src/", "lib/", "bin/"],
    factExtractors: [],
  };
}

// ---------------------------------------------------------------------------
// Edge case 1: Empty repository
// ---------------------------------------------------------------------------

describe("pipeline — empty repository", () => {
  let projectDir: string;
  let dataDir: string;
  let pipeline: IndexingPipeline;

  beforeEach(() => {
    projectDir = makeTempDir();
    dataDir = resolve(projectDir, ".memory");
  });

  afterEach(() => {
    pipeline?.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns 0 filesProcessed and 0 chunksCreated for a completely empty directory", async () => {
    const config = makeConfig(projectDir, dataDir);
    pipeline = new IndexingPipeline(config);

    const result = await pipeline.indexAll();

    expect(result.filesProcessed).toBe(0);
    expect(result.chunksCreated).toBe(0);
  }, 30000);

  it("leaves the metadata store empty after indexing an empty directory", async () => {
    const config = makeConfig(projectDir, dataDir);
    pipeline = new IndexingPipeline(config);

    await pipeline.indexAll();

    const stats = pipeline.getMetadataStore().getStats();
    expect(stats.totalFiles).toBe(0);
    expect(stats.totalChunks).toBe(0);
  }, 30000);

  it("leaves the FTS store returning no results after indexing an empty directory", async () => {
    const config = makeConfig(projectDir, dataDir);
    pipeline = new IndexingPipeline(config);

    await pipeline.indexAll();

    const ftsResults = pipeline.getFTSStore().search("anything", 10);
    expect(ftsResults).toHaveLength(0);
  }, 30000);

  it("returns 0 chunksCreated on a second indexAll call against an empty directory", async () => {
    const config = makeConfig(projectDir, dataDir);
    pipeline = new IndexingPipeline(config);

    await pipeline.indexAll();
    const second = await pipeline.indexAll();

    expect(second.chunksCreated).toBe(0);
  }, 30000);

  it("handles a directory that contains only ignored files", async () => {
    // Place a file inside the ignored .memory directory — it should be skipped
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(resolve(dataDir, "internal.ts"), 'export const x = 1;\n', "utf-8");

    const config = makeConfig(projectDir, dataDir);
    pipeline = new IndexingPipeline(config);

    const result = await pipeline.indexAll();

    expect(result.filesProcessed).toBe(0);
    expect(result.chunksCreated).toBe(0);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Edge case 2: Path traversal blocked
// ---------------------------------------------------------------------------

describe("pipeline — path traversal blocked in indexChanged", () => {
  let projectDir: string;
  let outsideDir: string;
  let dataDir: string;
  let pipeline: IndexingPipeline;

  beforeEach(() => {
    projectDir = makeTempDir();
    outsideDir = makeTempDir(); // a completely separate temp directory
    dataDir = resolve(projectDir, ".memory");
  });

  afterEach(() => {
    pipeline?.close();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("does not index a file whose absolute path resolves outside the project root", async () => {
    // Write a real TypeScript file outside the project root
    const outsideFile = resolve(outsideDir, "secret.ts");
    writeFileSync(outsideFile, 'export const secret = "do not index";\n', "utf-8");

    const config = makeConfig(projectDir, dataDir);
    pipeline = new IndexingPipeline(config);

    // Pass the absolute path directly — pipeline must block it
    const result = await pipeline.indexChanged([outsideFile]);

    expect(result.filesProcessed).toBe(0);
    expect(result.chunksCreated).toBe(0);
  }, 30000);

  it("does not store any chunks for a blocked traversal path", async () => {
    const outsideFile = resolve(outsideDir, "evil.ts");
    writeFileSync(outsideFile, 'export function evil() { return 42; }\n', "utf-8");

    const config = makeConfig(projectDir, dataDir);
    pipeline = new IndexingPipeline(config);

    await pipeline.indexChanged([outsideFile]);

    const stats = pipeline.getMetadataStore().getStats();
    expect(stats.totalChunks).toBe(0);
    expect(stats.totalFiles).toBe(0);
  }, 30000);

  it("blocks a path constructed with .. segments that escape the project root", async () => {
    // Construct a relative path that walks out of the project root
    const traversalPath = resolve(projectDir, "..", "outside-escape.ts");

    // Write the file at that location (it will land in the parent temp dir)
    writeFileSync(traversalPath, 'export const x = 1;\n', "utf-8");

    const config = makeConfig(projectDir, dataDir);
    pipeline = new IndexingPipeline(config);

    const result = await pipeline.indexChanged([traversalPath]);

    expect(result.filesProcessed).toBe(0);

    // Clean up the stray file
    try { rmSync(traversalPath, { force: true }); } catch { /* ignore */ }
  }, 30000);

  it("still processes a legitimate in-project file when a traversal path is also given", async () => {
    // Create a valid file inside the project
    const validFile = resolve(projectDir, "legit.ts");
    writeFileSync(
      validFile,
      `export function greet(name: string): string {
  return "Hello, " + name;
}
`,
      "utf-8"
    );

    // And an outside file that should be blocked
    const outsideFile = resolve(outsideDir, "blocked.ts");
    writeFileSync(outsideFile, 'export const blocked = true;\n', "utf-8");

    const config = makeConfig(projectDir, dataDir);
    pipeline = new IndexingPipeline(config);

    const result = await pipeline.indexChanged([outsideFile, validFile]);

    // Only the legitimate file should have been processed
    expect(result.filesProcessed).toBe(1);
    expect(result.chunksCreated).toBeGreaterThan(0);

    // FTS should contain results for the legitimate file but not the blocked one
    const ftsLegit = pipeline.getFTSStore().search("greet", 10);
    expect(ftsLegit.length).toBeGreaterThan(0);

    const ftsBlocked = pipeline.getFTSStore().search("blocked", 10);
    expect(ftsBlocked).toHaveLength(0);
  }, 30000);

  it("returns 0 processed files when all given paths are outside the root", async () => {
    const outside1 = resolve(outsideDir, "one.ts");
    const outside2 = resolve(outsideDir, "two.ts");
    writeFileSync(outside1, 'export const one = 1;\n', "utf-8");
    writeFileSync(outside2, 'export const two = 2;\n', "utf-8");

    const config = makeConfig(projectDir, dataDir);
    pipeline = new IndexingPipeline(config);

    const result = await pipeline.indexChanged([outside1, outside2]);

    expect(result.filesProcessed).toBe(0);
    expect(result.chunksCreated).toBe(0);
  }, 30000);
});
