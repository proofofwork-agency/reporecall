import type { MemoryConfig } from "../core/config.js";
import type { EmbeddingProvider } from "../indexer/types.js";
import type { VectorStore } from "../storage/vector-store.js";
import type { FTSStore } from "../storage/fts-store.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import { reciprocalRankFusion } from "./ranker.js";
import {
  assembleConceptContext,
  assembleContext,
  type ConceptContextKind,
} from "./context-assembler.js";
import { getLogger } from "../core/logger.js";
import { LocalReranker } from "./reranker.js";
import type { SearchResult, SearchOptions, AssembledContext } from "./types.js";
import type { ReadWriteLock } from "../core/rwlock.js";
import { resolveSeeds } from "./seed.js";
import type { StoredChunk } from "../storage/types.js";

const IMPL_BOOST = 1.25;
const TEST_PENALTY = 0.35;
const DOC_PENALTY = 0.45;
const DOC_PENALTY_NO_IMPL = 0.8;
const TERM_MATCH_BOOST = 1.15;
const CONCEPT_BOOST = 0.9;

const AST_CONCEPT_RE = /\b(ast|tree[- ]?sitter)\b/i;
const CALL_GRAPH_CONCEPT_RE =
  /\bcall\s+graph\b|\bwho\s+calls\b|\bcalled\s+by\b|\bcaller(?:s)?\b|\bcallee(?:s)?\b/i;
const SEARCH_PIPELINE_CONCEPT_RE =
  /\bsearch\s+pipeline\b|\bretrieval\s+pipeline\b|\bintent\s+classification\s+route\b|\bhybrid\s+search\b|\bsearch\s+routing\b|\bquery\s+routing\b|\broute\s+selection\b/i;

const AST_CONCEPT_SYMBOLS = [
  "initTreeSitter",
  "createParser",
  "chunkFileWithCalls",
  "walkForExtractables",
  "extractName",
];

const CALL_GRAPH_CONCEPT_SYMBOLS = [
  "extractCallEdges",
  "extractCalleeInfo",
  "extractReceiver",
  "graphCommand",
  "buildStackTree",
];

const SEARCH_PIPELINE_CONCEPT_SYMBOLS = [
  "classifyIntent",
  "deriveRoute",
  "handlePromptContextDetailed",
  "searchWithContext",
  "search",
  "resolveSeeds",
];

const CONCEPT_MAX_CHUNKS: Record<ConceptContextKind, number> = {
  ast: 4,
  call_graph: 4,
  search_pipeline: 5,
};

interface ScoringMaps {
  chunkDates: Map<string, string>;
  chunkFilePaths: Map<string, string>;
  chunkKinds: Map<string, string>;
  chunkNames: Map<string, string>;
  chunkParents: Map<string, { parentName?: string; filePath: string }>;
}

export class HybridSearch {
  private embedder: EmbeddingProvider;
  private vectors: VectorStore;
  private fts: FTSStore;
  private metadata: MetadataStore;
  private config: MemoryConfig;
  private reranker: LocalReranker | null = null;
  private lock: ReadWriteLock | undefined;

  constructor(
    embedder: EmbeddingProvider,
    vectors: VectorStore,
    fts: FTSStore,
    metadata: MetadataStore,
    config: MemoryConfig,
    lock?: ReadWriteLock
  ) {
    this.embedder = embedder;
    this.vectors = vectors;
    this.fts = fts;
    this.metadata = metadata;
    this.config = config;
    this.lock = lock;
  }

  updateStores(
    vectors: VectorStore,
    fts: FTSStore,
    metadata: MetadataStore
  ): void {
    this.vectors = vectors;
    this.fts = fts;
    this.metadata = metadata;
  }

  async search(
    query: string,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const doSearch = async (): Promise<SearchResult[]> => {
      const limit = options?.limit ?? 20;
      const isKeywordMode = !this.embedder.isEnabled();

      const log = getLogger();
      const weights = this.resolveWeights(options, isKeywordMode);
      const { vectorResults, keywordResults } = await this.retrieve(query, isKeywordMode);

      log.debug({
        query: query.slice(0, 100),
        isKeywordMode,
        vectorResultCount: vectorResults.length,
        keywordResultCount: keywordResults.length,
      }, "retrieval complete");

      if (options?.signal?.aborted) return [];

      const scoringMaps = this.buildScoringMaps(vectorResults, keywordResults);
      const ranked = this.fuseResults(query, vectorResults, keywordResults, weights, scoringMaps, options);

      log.debug({
        fusedResultCount: ranked.length,
        topScore: ranked[0]?.score,
      }, "RRF fusion complete");

      this.expandGraph(ranked, scoringMaps, options);

      if (options?.signal?.aborted) return [];

      this.expandSiblings(ranked, scoringMaps, options);

      const hydrated = await this.rerankOrHydrate(query, ranked, limit, options);
      return this.prependConceptTargetResults(query, hydrated);
    };

    return this.lock ? this.lock.withRead(doSearch) : doSearch();
  }

  async searchWithContext(
    query: string,
    tokenBudget?: number,
    activeFiles?: string[],
    signal?: AbortSignal
  ): Promise<AssembledContext> {
    const budget = tokenBudget ?? this.config.contextBudget;
    const conceptContext = this.buildConceptContext(query, budget);
    if (conceptContext) return conceptContext;

    const maxContextChunks = this.config.maxContextChunks > 0
      ? this.config.maxContextChunks
      : Math.min(100, Math.max(10, Math.floor(budget / 200)));  // ~200 tokens per avg chunk, capped at 100
    const hookLimit = Math.max(maxContextChunks * 2, 20);
    const results = await this.search(query, {
      limit: hookLimit,
      activeFiles,
      graphExpansion: false,
      siblingExpansion: false,
      rerank: false,
      signal,
    });
    const exactAware = this.prependExplicitTargetResults(query, results);
    const prioritized = this.prioritizeForHookContext(query, exactAware);

    const log = getLogger();
    log.debug({
      query: query.slice(0, 100),
      budget,
      maxContextChunks,
      retrievedCount: results.length,
      exactAwareCount: exactAware.length,
      prioritizedCount: prioritized.length,
    }, "searchWithContext pipeline");

    return assembleContext(
      prioritized,
      tokenBudget ?? this.config.contextBudget,
      {
        maxChunks: maxContextChunks,
        scoreFloorRatio: 0.7,
        query,
        factExtractors: this.config.factExtractors,
      }
    );
  }

  private buildConceptContext(
    query: string,
    tokenBudget: number
  ): AssembledContext | null {
    const conceptKind = this.getConceptKind(query);
    if (!conceptKind) return null;

    const hasResolvedExplicitTarget = resolveSeeds(query, this.metadata, this.fts).seeds
      .some((seed) => seed.reason === "explicit_target");
    if (hasResolvedExplicitTarget) return null;

    const selectedChunks = this.selectConceptChunks(
      this.getConceptSymbolsForKind(conceptKind),
      CONCEPT_MAX_CHUNKS[conceptKind]
    );
    if (selectedChunks.length === 0) return null;

    const conceptResults = selectedChunks.map((chunk, index) =>
      this.chunkToSearchResult(chunk, 1 - index * 0.01)
    );

    return assembleConceptContext(conceptKind, conceptResults, tokenBudget);
  }

  private prioritizeForHookContext(
    query: string,
    results: SearchResult[]
  ): SearchResult[] {
    const queryTerms = query.toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2);
    const hasImplementationChunks = results.some((result) => this.isImplementationChunk(result));

    return results
      .map((result) => ({
        result,
        adjustedScore: this.getHookPriorityScore(
          result,
          queryTerms,
          hasImplementationChunks
        ),
      }))
      .sort((a, b) => b.adjustedScore - a.adjustedScore)
      .map((item) => ({
        ...item.result,
        hookScore: item.adjustedScore,
      }));
  }

  private prependExplicitTargetResults(
    query: string,
    results: SearchResult[]
  ): SearchResult[] {
    const seedResult = resolveSeeds(query, this.metadata, this.fts);
    const explicitSeeds = seedResult.seeds
      .filter((seed) => seed.reason === "explicit_target")
      .slice(0, 5);

    if (explicitSeeds.length === 0) return results;

    const chunkMap = new Map(
      this.metadata
        .getChunksByIds(explicitSeeds.map((seed) => seed.chunkId))
        .map((chunk) => [chunk.id, chunk])
    );

    const byId = new Map(results.map((result) => [result.id, result]));
    const topScore = results[0]?.score ?? 1;

    for (let i = 0; i < explicitSeeds.length; i++) {
      const seed = explicitSeeds[i];
      const chunk = chunkMap.get(seed.chunkId);
      if (!chunk) continue;

      const existing = byId.get(seed.chunkId);
      const boostedScore = topScore + 1 + seed.confidence - i * 0.001;
      byId.set(
        seed.chunkId,
        existing
          ? { ...existing, score: Math.max(existing.score, boostedScore) }
          : this.chunkToSearchResult(chunk, boostedScore)
      );
    }

    return Array.from(byId.values()).sort((a, b) => b.score - a.score);
  }

  private prependConceptTargetResults(
    query: string,
    results: SearchResult[]
  ): SearchResult[] {
    const conceptSymbols = this.getConceptSymbols(query);
    if (conceptSymbols.length === 0) return results;

    const hasResolvedExplicitTarget = resolveSeeds(query, this.metadata, this.fts).seeds
      .some((seed) => seed.reason === "explicit_target");
    if (hasResolvedExplicitTarget) return results;

    const selectedChunks = this.selectConceptChunks(conceptSymbols);
    if (selectedChunks.length === 0) return results;

    const byId = new Map(results.map((result) => [result.id, result]));
    const topScore = results[0]?.score ?? 1;

    for (let i = 0; i < selectedChunks.length; i++) {
      const chunk = selectedChunks[i];
      const existing = byId.get(chunk.id);
      const boostedScore = topScore + CONCEPT_BOOST - i * 0.001;
      byId.set(
        chunk.id,
        existing
          ? { ...existing, score: Math.max(existing.score, boostedScore) }
          : this.chunkToSearchResult(chunk, boostedScore)
      );
    }

    return Array.from(byId.values()).sort((a, b) => b.score - a.score);
  }

  hasConceptContext(query: string): boolean {
    return this.getConceptKind(query) !== null;
  }

  private getConceptKind(query: string): ConceptContextKind | null {
    const ast = AST_CONCEPT_RE.test(query);
    const callGraph = CALL_GRAPH_CONCEPT_RE.test(query);
    const searchPipeline = SEARCH_PIPELINE_CONCEPT_RE.test(query);
    if (searchPipeline && !ast && !callGraph) return "search_pipeline";
    if (ast && !callGraph) return "ast";
    if (callGraph && !ast) return "call_graph";
    return null;
  }

  private getConceptSymbols(query: string): string[] {
    const kind = this.getConceptKind(query);
    return kind ? this.getConceptSymbolsForKind(kind) : [];
  }

  private getConceptSymbolsForKind(kind: ConceptContextKind): string[] {
    if (kind === "ast") return AST_CONCEPT_SYMBOLS;
    if (kind === "call_graph") return CALL_GRAPH_CONCEPT_SYMBOLS;
    return SEARCH_PIPELINE_CONCEPT_SYMBOLS;
  }

  private selectConceptChunks(symbols: string[], maxChunks?: number): StoredChunk[] {
    const nameOrder = new Map(symbols.map((name, index) => [name, index]));
    const bestByName = new Map<string, StoredChunk>();

    for (const chunk of this.metadata.findChunksByNames(symbols)) {
      const existing = bestByName.get(chunk.name);
      if (!existing || this.compareConceptChunks(chunk, existing) < 0) {
        bestByName.set(chunk.name, chunk);
      }
    }

    const ordered = Array.from(bestByName.values()).sort((a, b) => {
      const orderDiff = (nameOrder.get(a.name) ?? Number.MAX_SAFE_INTEGER)
        - (nameOrder.get(b.name) ?? Number.MAX_SAFE_INTEGER);
      if (orderDiff !== 0) return orderDiff;
      return a.filePath.localeCompare(b.filePath);
    });
    return typeof maxChunks === "number" ? ordered.slice(0, maxChunks) : ordered;
  }

  private compareConceptChunks(a: StoredChunk, b: StoredChunk): number {
    const implDiff = Number(this.isImplementationPath(b.filePath))
      - Number(this.isImplementationPath(a.filePath));
    if (implDiff !== 0) return implDiff;

    const testDiff = Number(this.isTestPath(a.filePath))
      - Number(this.isTestPath(b.filePath));
    if (testDiff !== 0) return testDiff;

    return a.filePath.localeCompare(b.filePath);
  }

  private getHookPriorityScore(
    result: SearchResult,
    queryTerms: string[],
    hasImplementationChunks: boolean
  ): number {
    let score = result.score;
    const lowerPath = result.filePath.toLowerCase();
    const baseName = lowerPath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    const lowerName = result.name.toLowerCase();

    if (this.isImplementationChunk(result)) score *= IMPL_BOOST;
    if (/(?:^|\/)(test|spec|__tests__|__fixtures__|fixtures|benchmark|examples)\//.test(lowerPath)) {
      score *= TEST_PENALTY;
    }
    if (/\.(md|mdx|txt)$/i.test(lowerPath) || /(?:^|\/)(docs?|audit|reports?)\//.test(lowerPath)) {
      score *= hasImplementationChunks ? DOC_PENALTY : DOC_PENALTY_NO_IMPL;
    }

    let termMatches = 0;
    for (const term of queryTerms) {
      if (baseName.includes(term) || lowerName.includes(term)) termMatches++;
    }
    if (termMatches > 0) {
      score *= Math.pow(TERM_MATCH_BOOST, termMatches);
    }

    return score;
  }

  private isImplementationChunk(result: SearchResult): boolean {
    return this.isImplementationPath(result.filePath);
  }

  private isImplementationPath(filePath: string): boolean {
    const lowerPath = filePath.toLowerCase();
    const implPaths = this.config.implementationPaths ?? ["src/", "lib/", "bin/"];
    return implPaths.some((prefix) => lowerPath.startsWith(prefix.toLowerCase()));
  }

  private isTestPath(filePath: string): boolean {
    return /(?:^|\/)(test|spec|__tests__|__fixtures__|fixtures|benchmark|examples)\//.test(
      filePath.toLowerCase()
    );
  }

  private chunkToSearchResult(chunk: StoredChunk, score: number): SearchResult {
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

  private resolveWeights(
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

  private async retrieve(
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

  private buildScoringMaps(
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
    };
  }

  private fuseResults(
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
    });
  }

  private expandGraph(
    ranked: Array<{ id: string; score: number }>,
    maps: ScoringMaps,
    options?: SearchOptions
  ): void {
    const doGraphExpansion =
      this.embedder.isEnabled() &&
      (options?.graphExpansion ?? this.config.graphExpansion);

    if (!doGraphExpansion) return;

    const rankedIds = new Set(ranked.map((r) => r.id));
    const top10 = ranked.slice(0, 10);
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
      const relevantFiles = new Set(
        top10.map((item) => maps.chunkFilePaths.get(item.id)).filter(Boolean)
      );
      const calleeChunks = this.metadata.findChunksByNames(
        Array.from(discoveredNames)
      );
      for (const chunk of calleeChunks) {
        if (!rankedIds.has(chunk.id) && relevantFiles.has(chunk.filePath)) {
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

  private expandSiblings(
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

  private async rerankOrHydrate(
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

  private async vectorSearch(
    query: string,
    limit: number
  ): Promise<Array<{ id: string; score: number }>> {
    try {
      const [queryVector] = await this.embedder.embed([query]);
      return this.vectors.search(queryVector, limit);
    } catch (err) {
      getLogger().warn(`Vector search failed: ${err}`);
      return [];
    }
  }

  private async keywordSearch(
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

  findCallers(
    name: string,
    limit?: number
  ): Array<{ chunkId: string; filePath: string; line: number; callerName: string }> {
    return this.metadata.findCallers(name, limit);
  }

  findCallees(
    name: string,
    limit?: number
  ): Array<{ targetName: string; callType: string; line: number; filePath: string }> {
    return this.metadata.findCallees(name, limit);
  }
}
