import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "path";
import { mkdirSync, rmSync, copyFileSync } from "fs";
import { IndexingPipeline } from "../../src/indexer/pipeline.js";
import type { MemoryConfig } from "../../src/core/config.js";

/**
 * End-to-end multi-language pipeline test.
 *
 * Tests the FULL Reporecall pipeline for every supported language:
 *   Parse → Chunk → Index (SQLite + FTS) → Search → Retrieve
 *
 * Each language fixture is indexed via IndexingPipeline, then searched
 * by FTS to verify chunks are actually retrievable — not just parseable.
 */

const FIXTURES = resolve(import.meta.dirname, "..", "fixtures");
const TEST_PROJECT = resolve(import.meta.dirname, "..", ".test-multilang-pipeline");
const TEST_DATA = resolve(TEST_PROJECT, ".memory");

// All fixture files mapped to a search term that MUST appear in results
const LANGUAGE_FIXTURES: Array<{
  file: string;
  extension: string;
  language: string;
  searchTerm: string;
  expectedChunkName: string;
}> = [
  { file: "sample.ts", extension: ".ts", language: "typescript", searchTerm: "validateSession", expectedChunkName: "validateSession" },
  { file: "sample.tsx", extension: ".tsx", language: "tsx", searchTerm: "formatLabel", expectedChunkName: "formatLabel" },
  { file: "sample.js", extension: ".js", language: "javascript", searchTerm: "calculateTotal", expectedChunkName: "calculateTotal" },
  { file: "sample.py", extension: ".py", language: "python", searchTerm: "create_tables", expectedChunkName: "create_tables" },
  { file: "sample.go", extension: ".go", language: "go", searchTerm: "NewConfig", expectedChunkName: "NewConfig" },
  { file: "sample.rs", extension: ".rs", language: "rust", searchTerm: "distance", expectedChunkName: "distance" },
  { file: "sample.java", extension: ".java", language: "java", searchTerm: "UserAccount", expectedChunkName: "UserAccount" },
  { file: "sample.rb", extension: ".rb", language: "ruby", searchTerm: "HttpClient", expectedChunkName: "HttpClient" },
  { file: "sample.c", extension: ".c", language: "c", searchTerm: "list_append", expectedChunkName: "list_append" },
  { file: "sample.cpp", extension: ".cpp", language: "cpp", searchTerm: "Canvas", expectedChunkName: "Canvas" },
  { file: "sample.cs", extension: ".cs", language: "csharp", searchTerm: "TaskItem", expectedChunkName: "TaskItem" },
  { file: "sample.php", extension: ".php", language: "php", searchTerm: "Article", expectedChunkName: "Article" },
  { file: "sample.swift", extension: ".swift", language: "swift", searchTerm: "WeatherStation", expectedChunkName: "WeatherStation" },
  { file: "sample.kt", extension: ".kt", language: "kotlin", searchTerm: "EmailValidator", expectedChunkName: "EmailValidator" },
  { file: "sample.scala", extension: ".scala", language: "scala", searchTerm: "EventBus", expectedChunkName: "EventBus" },
  { file: "sample.zig", extension: ".zig", language: "zig", searchTerm: "fibonacci", expectedChunkName: "fibonacci" },
  { file: "sample.sh", extension: ".sh", language: "bash", searchTerm: "deploy", expectedChunkName: "deploy" },
  { file: "sample.lua", extension: ".lua", language: "lua", searchTerm: "vec_add", expectedChunkName: "vec_add" },
  { file: "sample.html", extension: ".html", language: "html", searchTerm: "Welcome", expectedChunkName: "" },
  { file: "sample.vue", extension: ".vue", language: "vue", searchTerm: "counter", expectedChunkName: "" },
  { file: "sample.css", extension: ".css", language: "css", searchTerm: "container", expectedChunkName: "" },
  { file: "sample.toml", extension: ".toml", language: "toml", searchTerm: "database", expectedChunkName: "" },
];

function makeConfig(extensions: string[]): MemoryConfig {
  return {
    projectRoot: TEST_PROJECT,
    dataDir: TEST_DATA,
    embeddingProvider: "keyword",
    embeddingModel: "",
    embeddingDimensions: 0,
    ollamaUrl: "",
    extensions,
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
    port: 37229,
    implementationPaths: [],
    factExtractors: [],
  };
}

describe("multi-language full pipeline (index → search → retrieve)", () => {
  beforeEach(() => {
    mkdirSync(TEST_PROJECT, { recursive: true });
    // Copy all fixture files into the test project
    for (const fixture of LANGUAGE_FIXTURES) {
      copyFileSync(
        resolve(FIXTURES, fixture.file),
        resolve(TEST_PROJECT, fixture.file)
      );
    }
  });

  afterEach(() => {
    rmSync(TEST_PROJECT, { recursive: true, force: true });
  });

  it("should index all 22 languages and produce chunks", async () => {
    const allExtensions = [...new Set(LANGUAGE_FIXTURES.map((f) => f.extension))];
    const config = makeConfig(allExtensions);
    const pipeline = new IndexingPipeline(config);

    try {
      const result = await pipeline.indexAll();

      expect(result.filesProcessed).toBe(LANGUAGE_FIXTURES.length);
      expect(result.chunksCreated).toBeGreaterThan(LANGUAGE_FIXTURES.length);

      // Verify metadata store has chunks for every language
      const metadata = pipeline.getMetadataStore();
      const stats = metadata.getStats();
      expect(stats.totalFiles).toBe(LANGUAGE_FIXTURES.length);
      expect(stats.totalChunks).toBeGreaterThan(LANGUAGE_FIXTURES.length);

      // Verify language distribution — each language should have at least 1 chunk
      const languages = stats.languages;
      const expectedLanguages = [...new Set(LANGUAGE_FIXTURES.map((f) => f.language))];
      for (const lang of expectedLanguages) {
        expect(languages[lang], `no chunks indexed for language: ${lang}`).toBeGreaterThan(0);
      }
    } finally {
      pipeline.close();
    }
  }, 30000);

  // Test each language individually for FTS search
  for (const fixture of LANGUAGE_FIXTURES) {
    it(`should index and search ${fixture.language} (${fixture.file})`, async () => {
      const config = makeConfig([fixture.extension]);
      const pipeline = new IndexingPipeline(config);

      try {
        const result = await pipeline.indexAll();
        expect(result.filesProcessed).toBe(1);
        expect(result.chunksCreated).toBeGreaterThan(0);

        // FTS search for the target term
        const fts = pipeline.getFTSStore();
        const ftsResults = fts.search(fixture.searchTerm, 10);

        expect(
          ftsResults.length,
          `FTS search for "${fixture.searchTerm}" in ${fixture.language} returned no results`
        ).toBeGreaterThan(0);

        // Verify the result is from our fixture file
        const metadata = pipeline.getMetadataStore();
        const chunk = metadata.getChunk(ftsResults[0].id);
        expect(chunk, `chunk not found in metadata store for ${fixture.language}`).toBeDefined();
        expect(chunk!.filePath).toBe(fixture.file);
        expect(chunk!.language).toBe(fixture.language);
        expect(chunk!.content.length).toBeGreaterThan(0);

        // For languages with named chunks, verify the name
        if (fixture.expectedChunkName) {
          const matchingChunks = ftsResults.map((r) => metadata.getChunk(r.id)).filter(Boolean);
          const names = matchingChunks.map((c) => c!.name);
          expect(
            names.some((n) => n.includes(fixture.expectedChunkName)),
            `expected chunk name containing "${fixture.expectedChunkName}" in ${fixture.language}, got: ${JSON.stringify(names)}`
          ).toBe(true);
        }
      } finally {
        pipeline.close();
      }
    }, 15000);
  }

  it("should retrieve full content for chunks from all languages", async () => {
    const allExtensions = [...new Set(LANGUAGE_FIXTURES.map((f) => f.extension))];
    const config = makeConfig(allExtensions);
    const pipeline = new IndexingPipeline(config);

    try {
      await pipeline.indexAll();
      const metadata = pipeline.getMetadataStore();
      const fts = pipeline.getFTSStore();

      // For each language, search and verify we can hydrate full chunk content
      for (const fixture of LANGUAGE_FIXTURES) {
        const ftsResults = fts.search(fixture.searchTerm, 5);
        if (ftsResults.length === 0) continue;

        const chunk = metadata.getChunk(ftsResults[0].id);
        expect(chunk, `${fixture.language}: chunk hydration failed`).toBeDefined();
        expect(chunk!.content.length, `${fixture.language}: empty content`).toBeGreaterThan(0);
        expect(chunk!.startLine, `${fixture.language}: invalid startLine`).toBeGreaterThan(0);
        expect(chunk!.endLine, `${fixture.language}: endLine < startLine`).toBeGreaterThanOrEqual(chunk!.startLine);
      }
    } finally {
      pipeline.close();
    }
  }, 30000);
});
