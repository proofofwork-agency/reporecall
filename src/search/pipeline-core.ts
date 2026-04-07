/**
 * Retrieval pipeline core — extracted from HybridSearch.
 *
 * Contains the low-level retrieval, fusion, expansion, and hydration
 * stages that turn a text query into a ranked list of SearchResult[].
 */

import type { MemoryConfig } from "../core/config.js";
import type { EmbeddingProvider, EmbeddingVector } from "../indexer/types.js";
import type { VectorStore } from "../storage/vector-store.js";
import type { FTSStore } from "../storage/fts-store.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import { reciprocalRankFusion } from "./ranker.js";
import {
  expandQueryTerms,
} from "./utils.js";
import { getLogger } from "../core/logger.js";
import { LocalReranker } from "./reranker.js";
import type { SearchResult, SearchOptions } from "./types.js";
import type { ReadWriteLock } from "../core/rwlock.js";
import { classifyIntent } from "./intent.js";
import type { StoredChunk } from "../storage/types.js";

// ── Scoring constants ────────────────────────────────────────────────
export const IMPL_BOOST = 1.25;
export const COMMUNITY_SAME_BOOST = 1.10;
export const DOC_PENALTY = 0.45;
export const DOC_PENALTY_NO_IMPL = 0.8;
export const TERM_MATCH_BOOST = 1.15;

// ── Scoring maps ─────────────────────────────────────────────────────
export interface ScoringMaps {
  chunkDates: Map<string, string>;
  chunkFilePaths: Map<string, string>;
  chunkKinds: Map<string, string>;
  chunkNames: Map<string, string>;
  chunkParents: Map<string, { parentName?: string; filePath: string }>;
  chunkLineRanges: Map<string, { startLine: number; endLine: number }>;
}

// ── Pipeline configuration ───────────────────────────────────────────
export interface RetrievalPipelineConfig {
  embedder: EmbeddingProvider;
  vectorStore: VectorStore;
  ftsStore: FTSStore;
  metadata: MetadataStore;
  config: MemoryConfig;
  lock?: ReadWriteLock;
}

// ── LRU cache size ───────────────────────────────────────────────────
const EMBED_CACHE_MAX = 50;

/**
 * Encapsulates the low-level retrieval pipeline: vector search, keyword
 * search, reciprocal-rank fusion, graph/sibling expansion, reranking,
 * and hydration.
 */
export class RetrievalPipeline {
  private embedder: EmbeddingProvider;
  private vectors: VectorStore;
  private fts: FTSStore;
  private metadata: MetadataStore;
  private config: MemoryConfig;
  private reranker: LocalReranker | null = null;
  private queryEmbedCache = new Map<string, EmbeddingVector>();

  constructor(opts: RetrievalPipelineConfig) {
    this.embedder = opts.embedder;
    this.vectors = opts.vectorStore;
    this.fts = opts.ftsStore;
    this.metadata = opts.metadata;
    this.config = opts.config;
  }

  // ── Store hot-swap (used after re-index) ─────────────────────────
  updateStores(
    vectors: VectorStore,
    fts: FTSStore,
    metadata: MetadataStore
  ): void {
    this.vectors = vectors;
    this.fts = fts;
    this.metadata = metadata;
  }

  // ── Accessors (for callers that need the underlying stores) ──────
  getMetadata(): MetadataStore {
    return this.metadata;
  }

  getEmbedder(): EmbeddingProvider {
    return this.embedder;
  }

  getConfig(): MemoryConfig {
    return this.config;
  }

  // ── Retrieve ─────────────────────────────────────────────────────
  async retrieve(
    query: string,
    isKeywordMode: boolean
  ): Promise<{
    vectorResults: Array<{ id: string; score: number }>;
    keywordResults: Array<{ id: string; rank: number }>;
  }> {
    const [vectorResults, keywordResults] = await Promise.all([
      isKeywordMode ? Promise.resolve([]) : this.vectorSearch(query, 50),
      this.keywordSearch(query, 50),
    ]);
    return { vectorResults, keywordResults };
  }

  // ── Vector search (with LRU embedding cache) ────────────────────
  async vectorSearch(
    query: string,
    limit: number
  ): Promise<Array<{ id: string; score: number }>> {
    try {
      let queryVector = this.queryEmbedCache.get(query);
      if (queryVector) {
        // LRU: refresh insertion order on hit
        this.queryEmbedCache.delete(query);
        this.queryEmbedCache.set(query, queryVector);
      } else {
        const embedResults = await this.embedder.embed([query]);
        queryVector = embedResults[0];
        if (!queryVector) return [];

        if (this.queryEmbedCache.size >= EMBED_CACHE_MAX) {
          const oldest = this.queryEmbedCache.keys().next().value;
          if (oldest !== undefined) this.queryEmbedCache.delete(oldest);
        }
        this.queryEmbedCache.set(query, queryVector);
      }
      return this.vectors.search(queryVector, limit);
    } catch (err) {
      getLogger().warn(`Vector search failed: ${err}`);
      return [];
    }
  }

  // ── Keyword (FTS) search ─────────────────────────────────────────
  async keywordSearch(
    query: string,
    limit: number
  ): Promise<Array<{ id: string; rank: number }>> {
    try {
      return this.fts.search(query, limit);
    } catch (err) {
      getLogger().warn(`Keyword search failed: ${err}`);
      return [];
    }
  }

  // ── Build scoring maps for a set of result IDs ──────────────────
  buildScoringMaps(
    vectorResults: Array<{ id: string; score: number }>,
    keywordResults: Array<{ id: string; rank: number }>
  ): ScoringMaps {
    const allIds = new Set([
      ...vectorResults.map((r) => r.id),
      ...keywordResults.map((r) => r.id),
    ]);
    const scoringInfo = this.metadata.getChunkScoringInfo(Array.from(allIds));

    return {
      chunkDates: new Map(scoringInfo.map((c) => [c.id, c.fileMtime ?? c.indexedAt])),
      chunkFilePaths: new Map(scoringInfo.map((c) => [c.id, c.filePath])),
      chunkKinds: new Map(scoringInfo.map((c) => [c.id, c.kind])),
      chunkNames: new Map(scoringInfo.map((c) => [c.id, c.name])),
      chunkParents: new Map(
        scoringInfo.map((c) => [c.id, { parentName: c.parentName, filePath: c.filePath }])
      ),
      chunkLineRanges: new Map(
        scoringInfo.map((c) => [c.id, { startLine: c.startLine, endLine: c.endLine }])
      ),
    };
  }

  // ── Resolve weights (vector / keyword / recency) ────────────────
  resolveWeights(
    options: SearchOptions | undefined,
    isKeywordMode: boolean
  ): { vectorWeight: number; keywordWeight: number; recencyWeight: number } {
    return {
      vectorWeight: isKeywordMode
        ? 0
        : (options?.vectorWeight ?? this.config.searchWeights.vector),
      keywordWeight: options?.keywordWeight ?? this.config.searchWeights.keyword,
      recencyWeight: options?.recencyWeight ?? this.config.searchWeights.recency,
    };
  }

  // ── Reciprocal rank fusion ──────────────────────────────────────
  fuseResults(
    query: string,
    vectorResults: Array<{ id: string; score: number }>,
    keywordResults: Array<{ id: string; rank: number }>,
    weights: { vectorWeight: number; keywordWeight: number; recencyWeight: number },
    maps: ScoringMaps,
    options?: SearchOptions
  ): Array<{ id: string; score: number }> {
    const activeFilesSet = options?.activeFiles
      ? new Set(options.activeFiles)
      : undefined;

    const queryTerms = query.split(/\s+/).filter((t) => t.length >= 2);
    const intent = classifyIntent(query);
    const expandedTerms = expandQueryTerms(query);
    const broadQuery = intent.queryMode === "architecture" || intent.queryMode === "change";

    return reciprocalRankFusion(vectorResults, keywordResults, {
      vectorWeight: weights.vectorWeight,
      keywordWeight: weights.keywordWeight,
      recencyWeight: weights.recencyWeight,
      k: this.config.rrfK,
      chunkDates: maps.chunkDates,
      activeFiles: activeFilesSet,
      chunkFilePaths: maps.chunkFilePaths,
      chunkKinds: maps.chunkKinds,
      codeBoostFactor: this.config.codeBoostFactor,
      chunkNames: maps.chunkNames,
      testPenaltyFactor: this.config.testPenaltyFactor,
      anonymousPenaltyFactor: this.config.anonymousPenaltyFactor,
      queryTerms,
      expandedQueryTerms: expandedTerms,
      broadQuery,
      chunkLineRanges: maps.chunkLineRanges,
    });
  }

  // ── Call-graph expansion ────────────────────────────────────────
  expandGraph(
    ranked: Array<{ id: string; score: number }>,
    maps: ScoringMaps,
    options?: SearchOptions
  ): void {
    const doGraphExpansion =
      options?.graphExpansion ?? this.config.graphExpansion;

    if (!doGraphExpansion) return;

    const rankedIds = new Set(ranked.map((r) => r.id));
    const topN = options?.graphTopN ?? 10;
    const top10 = ranked.slice(0, topN);
    const discoveredNames = new Set<string>();
    const nameScoreMap = new Map<string, number>();

    for (const item of top10) {
      const name = maps.chunkNames.get(item.id);
      if (!name) continue;

      const callers = this.metadata.findCallers(name, 5);
      const callees = this.metadata.findCallees(name, 5);

      for (const caller of callers) {
        if (!rankedIds.has(caller.chunkId)) {
          discoveredNames.add(caller.callerName);
          ranked.push({
            id: caller.chunkId,
            score: item.score * this.config.graphDiscountFactor,
          });
          rankedIds.add(caller.chunkId);
        }
      }

      for (const callee of callees) {
        discoveredNames.add(callee.targetName);
        const existing = nameScoreMap.get(callee.targetName) ?? 0;
        nameScoreMap.set(callee.targetName, Math.max(existing, item.score));
      }
    }

    if (discoveredNames.size > 0) {
      const calleeChunks = this.metadata.findChunksByNames(
        Array.from(discoveredNames)
      );
      for (const chunk of calleeChunks) {
        if (!rankedIds.has(chunk.id)) {
          const triggerScore = nameScoreMap.get(chunk.name) ?? top10[0]?.score ?? 0;
          ranked.push({
            id: chunk.id,
            score: triggerScore * this.config.graphDiscountFactor,
          });
          rankedIds.add(chunk.id);
          maps.chunkParents.set(chunk.id, {
            parentName: chunk.parentName,
            filePath: chunk.filePath,
          });
        }
      }
    }

    ranked.sort((a, b) => b.score - a.score);
  }

  // ── Sibling expansion ──────────────────────────────────────────
  expandSiblings(
    ranked: Array<{ id: string; score: number }>,
    maps: ScoringMaps,
    options?: SearchOptions
  ): void {
    const doSiblingExpansion =
      options?.siblingExpansion ?? this.config.siblingExpansion;

    if (!doSiblingExpansion) return;

    const rankedIds = new Set(ranked.map((r) => r.id));
    const top5 = ranked.slice(0, 5);

    for (const item of top5) {
      const parent = maps.chunkParents.get(item.id);
      if (!parent?.parentName) continue;

      const siblings = this.metadata.findSiblings(
        parent.parentName,
        parent.filePath,
        item.id,
        5
      );

      for (const sibling of siblings) {
        if (!rankedIds.has(sibling.id)) {
          ranked.push({
            id: sibling.id,
            score: item.score * this.config.siblingDiscountFactor,
          });
          rankedIds.add(sibling.id);
        }
      }
    }

    ranked.sort((a, b) => b.score - a.score);
  }

  // ── Rerank (cross-encoder) or hydrate (plain fetch) ─────────────
  async rerankOrHydrate(
    query: string,
    ranked: Array<{ id: string; score: number }>,
    limit: number,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const doReranking =
      this.embedder.isEnabled() &&
      (options?.rerank ?? this.config.reranking);

    if (doReranking) {
      const log = getLogger();
      const rerankTopK = this.config.rerankTopK;
      const topForReranking = ranked.slice(0, rerankTopK).map((r) => r.id);
      const rerankChunks = this.metadata.getChunksByIds(topForReranking);
      const rerankMap = new Map(rerankChunks.map((c) => [c.id, c]));

      const candidates: SearchResult[] = [];
      for (const r of ranked.slice(0, rerankTopK)) {
        const chunk = rerankMap.get(r.id);
        if (!chunk) {
          log.debug(`Filtered stale chunk from reranking: ${r.id}`);
          continue;
        }
        candidates.push({
          id: r.id,
          score: r.score,
          filePath: chunk.filePath,
          name: chunk.name,
          kind: chunk.kind,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
          docstring: chunk.docstring,
          parentName: chunk.parentName,
          language: chunk.language ?? "",
        });
      }

      if (!this.reranker) {
        this.reranker = new LocalReranker(this.config.rerankingModel);
      }

      return this.reranker.rerank(query, candidates, limit);
    }

    // Hydrate top results with full content
    const log = getLogger();
    const topIds = ranked.slice(0, limit).map((r) => r.id);
    const fullChunks = this.metadata.getChunksByIds(topIds);
    const chunkMap = new Map(fullChunks.map((c) => [c.id, c]));

    const results: SearchResult[] = [];
    for (const r of ranked.slice(0, limit)) {
      const chunk = chunkMap.get(r.id);
      if (!chunk) {
        log.debug(`Filtered stale chunk from hydration: ${r.id}`);
        continue;
      }
      results.push({
        id: r.id,
        score: r.score,
        filePath: chunk.filePath,
        name: chunk.name,
        kind: chunk.kind,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        docstring: chunk.docstring,
        parentName: chunk.parentName,
        language: chunk.language ?? "",
      });
    }
    return results;
  }

  // ── Convert a StoredChunk to a SearchResult ─────────────────────
  chunkToSearchResult(chunk: StoredChunk, score: number): SearchResult {
    return {
      id: chunk.id,
      score,
      filePath: chunk.filePath,
      name: chunk.name,
      kind: chunk.kind,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
      docstring: chunk.docstring,
      parentName: chunk.parentName,
      language: chunk.language ?? "",
    };
  }
}
