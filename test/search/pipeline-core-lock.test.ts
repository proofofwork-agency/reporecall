import { describe, it, expect } from "vitest";
import { RetrievalPipeline } from "../../src/search/pipeline-core.js";
import { ReadWriteLock } from "../../src/core/rwlock.js";
import type { MemoryConfig } from "../../src/core/config.js";
import type { EmbeddingProvider, EmbeddingVector } from "../../src/indexer/types.js";
import type { VectorStore } from "../../src/storage/vector-store.js";
import type { FTSStore } from "../../src/storage/fts-store.js";
import type { MetadataStore } from "../../src/storage/metadata-store.js";

function makeConfig(): MemoryConfig {
  return {
    projectRoot: "/tmp",
    dataDir: "/tmp/.memory",
    embeddingProvider: "local",
    embeddingModel: "test",
    embeddingDimensions: 384,
    ollamaUrl: "http://localhost:11434",
    extensions: [".ts"],
    ignorePatterns: [],
    maxFileSize: 100000,
    batchSize: 32,
    contextBudget: 0,
    maxContextChunks: 0,
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
    shutdownTimeoutMs: 10000,
    port: 37222,
    implementationPaths: ["src/"],
    factExtractors: [],
    conceptBundles: [],
    memory: false,
    memoryBudget: 500,
    memoryDirs: [],
    memoryWatch: false,
    memoryCodeFloorRatio: 0.8,
    memoryHotBudget: 120,
    memoryWorkingBudget: 80,
    memoryEpisodeBudget: 150,
    memoryArchiveDays: 30,
    memoryCompactionHours: 6,
    memoryWritableDir: ".memory/mem",
    memoryAutoCreate: false,
    memoryFactPromotionThreshold: 3,
    memoryWorkingHistoryLimit: 1,
    wikiBudget: 400,
    wikiMaxPages: 3,
    capabilityEvidence: false,
    genericCapabilityHydration: false,
    contextCompressionEnabled: false,
    contextCompressionMode: "off",
    contextCompressionPreserveTopChunks: 1,
    contextCompressionMinChunkTokens: 100,
    contextCompressionTargetRatio: 0.75,
  };
}

function makeFakeEmbedder(): EmbeddingProvider {
  return {
    embed: async (_texts: string[]): Promise<EmbeddingVector[]> => {
      await new Promise((r) => setTimeout(r, 1));
      [[0.1, 0.2, 0.3]];
      return [[0.1, 0.2, 0.3]];
    },
    dimensions: () => 384,
    isEnabled: () => true,
  };
}

function makeFakeVectorStore(prefix: string): VectorStore {
  return {
    search: async (_vec: EmbeddingVector, _limit: number) => {
      await new Promise((r) => setTimeout(r, 1));
      return [
        { id: `${prefix}-v1`, score: 0.9 },
        { id: `${prefix}-v2`, score: 0.7 },
      ];
    },
  } as unknown as VectorStore;
}

function makeFakeFtsStore(prefix: string): FTSStore {
  return {
    search: (_q: string, _limit: number) => [
      { id: `${prefix}-f1`, rank: 1 },
      { id: `${prefix}-f2`, rank: 2 },
    ],
  } as unknown as FTSStore;
}

function makeFakeMetadata(): MetadataStore {
  return {
    getChunkScoringInfo: () => [],
  } as unknown as MetadataStore;
}

describe("RetrievalPipeline ReadWriteLock wiring", () => {
  // regression: updateStores is async and guarded by the write lock; retrieve
  // is guarded by the read lock — concurrent calls must interleave safely
  it("updateStores returns a Promise", () => {
    const pipeline = new RetrievalPipeline({
      embedder: makeFakeEmbedder(),
      vectorStore: makeFakeVectorStore("init"),
      ftsStore: makeFakeFtsStore("init"),
      metadata: makeFakeMetadata(),
      config: makeConfig(),
      lock: new ReadWriteLock(),
    });

    const result = pipeline.updateStores(
      makeFakeVectorStore("new"),
      makeFakeFtsStore("new"),
      makeFakeMetadata()
    );
    expect(result).toBeInstanceOf(Promise);
  });

  it("concurrent retrieve calls do not throw during an updateStores", async () => {
    const lock = new ReadWriteLock();
    const pipeline = new RetrievalPipeline({
      embedder: makeFakeEmbedder(),
      vectorStore: makeFakeVectorStore("init"),
      ftsStore: makeFakeFtsStore("init"),
      metadata: makeFakeMetadata(),
      config: makeConfig(),
      lock,
    });

    // Kick off an updateStores (write lock) concurrently with many retrieves (read lock)
    const update = pipeline.updateStores(
      makeFakeVectorStore("new"),
      makeFakeFtsStore("new"),
      makeFakeMetadata()
    );

    const retrieves: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      retrieves.push(pipeline.retrieve(`query-${i}`, false));
    }

    const results = await Promise.all([
      update.then(() => "update-ok"),
      ...retrieves.map((p) =>
        p.then(
          () => "retrieve-ok",
          () => "retrieve-failed"
        )
      ),
    ]);

    expect(results[0]).toBe("update-ok");
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe("retrieve-ok");
    }
  });

  it("retrieve returns consistent results from a single store snapshot", async () => {
    const lock = new ReadWriteLock();
    const pipeline = new RetrievalPipeline({
      embedder: makeFakeEmbedder(),
      vectorStore: makeFakeVectorStore("snap"),
      ftsStore: makeFakeFtsStore("snap"),
      metadata: makeFakeMetadata(),
      config: makeConfig(),
      lock,
    });

    const result = await pipeline.retrieve("test query", false);
    expect(result.vectorResults).toHaveLength(2);
    expect(result.keywordResults).toHaveLength(2);
    expect(result.vectorResults[0].id).toBe("snap-v1");
  });

  it("completes without deadlock under interleaved read/write load", async () => {
    const lock = new ReadWriteLock();
    const pipeline = new RetrievalPipeline({
      embedder: makeFakeEmbedder(),
      vectorStore: makeFakeVectorStore("init"),
      ftsStore: makeFakeFtsStore("init"),
      metadata: makeFakeMetadata(),
      config: makeConfig(),
      lock,
    });

    const ops: Promise<string>[] = [];
    for (let i = 0; i < 50; i++) {
      if (i % 10 === 5) {
        ops.push(
          pipeline
            .updateStores(
              makeFakeVectorStore(`gen-${i}`),
              makeFakeFtsStore(`gen-${i}`),
              makeFakeMetadata()
            )
            .then(() => `write-${i}`)
        );
      } else {
        ops.push(
          pipeline.retrieve(`q-${i}`, false).then(
            () => `read-${i}`,
            () => `read-${i}-err`
          )
        );
      }
    }

    const results = await Promise.all(ops);
    // Every op must resolve (no deadlock / hang)
    expect(results).toHaveLength(50);
    for (const r of results) {
      expect(r).toBeDefined();
    }
  });

  it("works without a lock (backward-compatible path)", async () => {
    const pipeline = new RetrievalPipeline({
      embedder: makeFakeEmbedder(),
      vectorStore: makeFakeVectorStore("nolock"),
      ftsStore: makeFakeFtsStore("nolock"),
      metadata: makeFakeMetadata(),
      config: makeConfig(),
    });

    const result = await pipeline.retrieve("no lock", false);
    expect(result.vectorResults[0].id).toBe("nolock-v1");

    await pipeline.updateStores(
      makeFakeVectorStore("swapped"),
      makeFakeFtsStore("swapped"),
      makeFakeMetadata()
    );
  });
});
