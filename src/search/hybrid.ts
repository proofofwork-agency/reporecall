/**
 * HybridSearch — orchestrator for the multi-strategy search pipeline.
 *
 * This module is the public entry-point.  All heavy lifting is delegated to:
 *   - RetrievalPipeline  (vector + keyword retrieval, fusion, expansion, reranking)
 *   - BugStrategy         (bug-localisation bundle selection)
 *   - ArchitectureStrategy(broad / inventory bundle selection)
 *   - trace-strategy      (trace-mode retrieval helpers)
 *   - lookup-strategy     (focused exact-match shortcircuit)
 *   - context-prioritization (hook scoring, seed/concept prepend, summary-only)
 */

import { type MemoryConfig, resolveContextBudget } from "../core/config.js";
import type { EmbeddingProvider } from "../indexer/types.js";
import type { VectorStore } from "../storage/vector-store.js";
import type { FTSStore } from "../storage/fts-store.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import {
  GENERIC_BROAD_TERMS,
  GENERIC_QUERY_ACTION_TERMS,
  textMatchesQueryTerm,
} from "./utils.js";
import {
  assembleContext,
} from "./context-assembler.js";
import { getLogger } from "../core/logger.js";
import type { SearchResult, SearchOptions, AssembledContext } from "./types.js";
import type { ReadWriteLock } from "../core/rwlock.js";
import { resolveSeeds } from "./seed.js";
import type { SeedResult } from "./seed.js";
import { classifyIntent } from "./intent.js";
import { normalizeTargetText } from "./targets.js";

// ── Strategy modules ────────────────────────────────────────────────
import { RetrievalPipeline } from "./pipeline-core.js";
import {
  BugStrategy,
  BUG_GENERIC_SEED_ALIAS_TERMS,
  BUG_LOW_SPECIFICITY_TERMS,
  BUG_STRUCTURAL_NOISE_RE,
  BUG_STRUCTURAL_ROLE_ALIAS_TERMS,
} from "./bug-strategy.js";
import type { BugSelectionDiagnostics } from "./bug-strategy.js";
import {
  ArchitectureStrategy,
  BROAD_INVENTORY_RE,
} from "./architecture-strategy.js";
import type { BroadSelectionDiagnostics } from "./architecture-strategy.js";
import {
  buildTraceRetrievalQuery,
  isInfrastructureTracePrompt,
  prependTraceTargetResults,
  extractTraceSalientTerms,
  getTraceFocusedExpandedTerms,
} from "./trace-strategy.js";
import {
  buildFocusedExactResults,
} from "./lookup-strategy.js";
import {
  buildConceptContext,
  prioritizeForHookContext,
  prependExplicitTargetResults,
  prependBugSeedResults,
  prependConceptTargetResults,
  prependBroadSeedResults,
  buildSummaryOnlyBroadContext,
  getConceptKind,
  type CompiledConceptBundle,
} from "./context-prioritization.js";

// ── Re-exports (public API surface used by other modules) ───────────
export type { BroadSelectionDiagnostics } from "./architecture-strategy.js";
export type { BugSelectionDiagnostics } from "./bug-strategy.js";

// ── Helpers ─────────────────────────────────────────────────────────

function compileConceptBundles(
  bundles: Array<{ kind: string; pattern: string; symbols: string[]; maxChunks: number }>
): CompiledConceptBundle[] {
  if (!bundles) return [];
  return bundles.map((b) => ({
    kind: b.kind,
    pattern: new RegExp(b.pattern, "i"),
    symbols: b.symbols,
    maxChunks: b.maxChunks,
  }));
}

// ── Main class ──────────────────────────────────────────────────────

export class HybridSearch {
  private pipeline: RetrievalPipeline;
  private bugStrategy: BugStrategy;
  private archStrategy: ArchitectureStrategy;
  private config: MemoryConfig;
  private lock: ReadWriteLock | undefined;
  private conceptBundles: CompiledConceptBundle[];
  private lastBroadSelection: BroadSelectionDiagnostics | null = null;
  private lastBugSelection: BugSelectionDiagnostics | null = null;
  private seedCommunityId: string | undefined;

  constructor(
    embedder: EmbeddingProvider,
    vectors: VectorStore,
    fts: FTSStore,
    metadata: MetadataStore,
    config: MemoryConfig,
    lock?: ReadWriteLock
  ) {
    this.config = config;
    this.lock = lock;
    this._fts = fts;
    this.conceptBundles = compileConceptBundles(config.conceptBundles);

    this.pipeline = new RetrievalPipeline({
      embedder,
      vectorStore: vectors,
      ftsStore: fts,
      metadata,
      config,
      lock,
    });

    this.bugStrategy = new BugStrategy({
      metadata,
      config,
      fts,
    });

    this.archStrategy = new ArchitectureStrategy({
      metadata,
      config,
      ftsStore: fts,
    });
  }

  // ── Store hot-swap (after re-index) ─────────────────────────────

  updateStores(
    vectors: VectorStore,
    fts: FTSStore,
    metadata: MetadataStore
  ): void {
    this._fts = fts;
    this.pipeline.updateStores(vectors, fts, metadata);
    this.bugStrategy.updateStores(metadata, fts);
    this.archStrategy.updateStores(metadata, fts);
  }

  // ── Diagnostic getters ──────────────────────────────────────────

  getLastBroadSelectionDiagnostics(): BroadSelectionDiagnostics | null {
    return this.lastBroadSelection;
  }

  getLastBugSelectionDiagnostics(): BugSelectionDiagnostics | null {
    return this.lastBugSelection;
  }

  // ── Core search ─────────────────────────────────────────────────

  async search(
    query: string,
    options?: SearchOptions,
    seedResult?: SeedResult
  ): Promise<SearchResult[]> {
    const doSearch = async (): Promise<SearchResult[]> => {
      const limit = options?.limit ?? 20;
      const isKeywordMode = !this.pipeline.getEmbedder().isEnabled();

      const log = getLogger();
      const weights = this.pipeline.resolveWeights(options, isKeywordMode);
      const { vectorResults, keywordResults } = await this.pipeline.retrieve(query, isKeywordMode);

      log.debug({
        query: query.slice(0, 100),
        isKeywordMode,
        vectorResultCount: vectorResults.length,
        keywordResultCount: keywordResults.length,
      }, "retrieval complete");

      if (options?.signal?.aborted) return [];

      const scoringMaps = this.pipeline.buildScoringMaps(vectorResults, keywordResults);
      const ranked = this.pipeline.fuseResults(query, vectorResults, keywordResults, weights, scoringMaps, options);

      log.debug({
        fusedResultCount: ranked.length,
        topScore: ranked[0]?.score,
      }, "RRF fusion complete");

      this.pipeline.expandGraph(ranked, scoringMaps, options);

      if (options?.signal?.aborted) return [];

      this.pipeline.expandSiblings(ranked, scoringMaps, options);

      const hydrated = await this.pipeline.rerankOrHydrate(query, ranked, limit, options);
      return prependConceptTargetResults(
        query,
        hydrated,
        this.pipeline.getMetadata(),
        this.fts,
        this.conceptBundles,
        this.config.implementationPaths ?? ["src/", "lib/", "bin/"],
        (chunk, score) => this.pipeline.chunkToSearchResult(chunk, score),
        seedResult
      );
    };

    return this.lock ? this.lock.withRead(doSearch) : doSearch();
  }

  // ── Context-aware search ────────────────────────────────────────

  async searchWithContext(
    query: string,
    tokenBudget?: number,
    activeFiles?: string[],
    signal?: AbortSignal,
    seedResult?: SeedResult
  ): Promise<AssembledContext> {
    const metadata = this.pipeline.getMetadata();
    const budget = tokenBudget ?? resolveContextBudget(
      this.config.contextBudget,
      metadata.getStats().totalChunks
    );
    const intent = classifyIntent(query);
    const queryMode = intent.queryMode;
    const isBroadWorkflow = queryMode === "architecture" || queryMode === "change";
    const isInventoryBroad = queryMode === "architecture" && BROAD_INVENTORY_RE.test(query);
    this.lastBroadSelection = null;
    this.lastBugSelection = null;
    const rawSeeds = seedResult ?? resolveSeeds(query, metadata, this.fts);
    const seeds = this.filterSeedsForMode(query, rawSeeds, queryMode);

    // Set seed community for community-aware scoring
    this.seedCommunityId = seeds.bestSeed && typeof metadata.getCommunityForChunk === "function"
      ? metadata.getCommunityForChunk(seeds.bestSeed.chunkId)
      : undefined;

    const chunkToResult = (chunk: import("../storage/types.js").StoredChunk, score: number) =>
      this.pipeline.chunkToSearchResult(chunk, score);
    const implPaths = this.config.implementationPaths ?? ["src/", "lib/", "bin/"];

    // Concept context shortcircuit
    const conceptContext = isInventoryBroad ? null : buildConceptContext(
      query,
      budget,
      metadata,
      this.fts,
      this.conceptBundles,
      implPaths,
      chunkToResult,
      seeds
    );
    if (conceptContext) return conceptContext;

    const maxContextChunks = this.config.maxContextChunks > 0
      ? this.config.maxContextChunks
      : Math.min(100, Math.max(10, Math.floor(budget / 200)));

    // Lookup shortcircuit
    const focusedExactResults = queryMode === "lookup"
      ? buildFocusedExactResults(query, seeds, maxContextChunks, metadata)
      : null;
    if (focusedExactResults && focusedExactResults.length > 0) {
      return assembleContext(
        focusedExactResults,
        budget,
        {
          maxChunks: Math.min(maxContextChunks, focusedExactResults.length),
          scoreFloorRatio: 0,
          query,
          factExtractors: this.config.factExtractors,
        }
      );
    }

    // Retrieval phase
    const hookLimit = Math.max(maxContextChunks * 2, 20);
    const bugRetrievalQueries = queryMode === "bug"
      ? this.bugStrategy.buildBugRetrievalQueries(query)
      : [];
    const retrievalQuery =
      queryMode === "bug"
        ? bugRetrievalQueries[0] ?? this.bugStrategy.buildBugRetrievalQuery(query)
        : queryMode === "trace"
          ? buildTraceRetrievalQuery(query)
          : query;
    const resultSets = await Promise.all(
      (queryMode === "bug" ? bugRetrievalQueries : [retrievalQuery]).map((variantQuery, index) =>
        this.search(variantQuery, {
          limit: index === 0 ? hookLimit : Math.max(12, Math.floor(hookLimit * 0.75)),
          activeFiles,
          graphExpansion: true,
          graphTopN: index === 0 ? 5 : 4,
          siblingExpansion: false,
          rerank: false,
          signal,
        }, seeds)
      )
    );

    const results = queryMode === "bug"
      ? this.mergeVariantResultSets(resultSets)
      : (resultSets[0] ?? []);

    // Prepend phase
    const exactAware = queryMode === "bug"
      ? prependBugSeedResults(
          query, results, metadata, this.fts, chunkToResult,
          (q: string) => this.bugStrategy.extractBugSalientTerms(q), seeds
        )
      : prependExplicitTargetResults(query, results, metadata, this.fts, chunkToResult, seeds);

    const traceAware = queryMode === "trace" && isInfrastructureTracePrompt(query)
      ? prependTraceTargetResults(query, exactAware, metadata, implPaths)
      : exactAware;

    const seedAware = queryMode === "bug"
      ? traceAware
      : prependBroadSeedResults(query, traceAware, metadata, this.fts, chunkToResult, seeds, isBroadWorkflow);

    // Prioritization
    const prioritized = prioritizeForHookContext(
      query, seedAware, this.config, this.seedCommunityId, metadata, isBroadWorkflow
    );

    // Strategy-specific bundle selection
    const bugBundle = queryMode === "bug"
      ? this.bugStrategy.selectBugLocalizationBundle(query, prioritized, maxContextChunks, seeds)
      : prioritized;
    this.lastBugSelection = this.bugStrategy.lastDiagnostics;

    const selectedBundle = isBroadWorkflow
      ? this.archStrategy.selectBroadWorkflowBundle(query, prioritized, seeds, maxContextChunks)
      : bugBundle;
    this.lastBroadSelection = this.archStrategy.lastBroadSelection;

    const broadDiagnostics = this.lastBroadSelection;
    const broadDeliveryMode = broadDiagnostics ? broadDiagnostics.deliveryMode : undefined;
    const broadFamilyConfidence = broadDiagnostics ? broadDiagnostics.familyConfidence : undefined;

    const log = getLogger();
    log.debug({
      query: query.slice(0, 100),
      budget,
      maxContextChunks,
      retrievedCount: results.length,
      exactAwareCount: exactAware.length,
      prioritizedCount: prioritized.length,
      broadWorkflowCount: selectedBundle.length,
      isBroadWorkflow,
      queryMode,
      broadDeliveryMode,
      broadFamilyConfidence,
    }, "searchWithContext pipeline");

    if (isBroadWorkflow && broadDeliveryMode === "summary_only" && broadDiagnostics) {
      return buildSummaryOnlyBroadContext(query, budget, broadDiagnostics);
    }

    const assembled = assembleContext(
      selectedBundle,
      budget,
      {
        maxChunks: isBroadWorkflow || queryMode === "bug" ? Math.min(maxContextChunks, 5) : maxContextChunks,
        scoreFloorRatio: isBroadWorkflow ? 0.25 : queryMode === "bug" ? 0.05 : 0.7,
        query,
        factExtractors: this.config.factExtractors,
        compressionRank: isBroadWorkflow ? 2 : queryMode === "bug" ? 2 : 3,
      }
    );

    if (isBroadWorkflow) {
      const broadSelection = this.lastBroadSelection;
      if (broadSelection?.deliveryMode === "code_context") {
        this.lastBroadSelection = {
          broadMode: broadSelection.broadMode,
          dominantFamily: broadSelection.dominantFamily,
          deliveryMode: broadSelection.deliveryMode,
          familyConfidence: broadSelection.familyConfidence,
          fallbackReason: broadSelection.fallbackReason,
          deferredReason: broadSelection.deferredReason,
          selectedFiles: Array.from(new Set(assembled.chunks.map((chunk) => chunk.filePath))).map((filePath) => ({
            filePath,
            selectionSource: "workflow_bundle",
          })),
        };
      }
    }
    return assembled;
  }

  // ── Seed preparation (public, used by hooks) ────────────────────

  prepareSeedResult(
    query: string,
    queryMode: "lookup" | "trace" | "bug" | "architecture" | "change" | "skip",
    seedResult?: SeedResult
  ): SeedResult {
    const rawSeeds = seedResult ?? resolveSeeds(query, this.pipeline.getMetadata(), this.fts);
    return this.filterSeedsForMode(query, rawSeeds, queryMode);
  }

  hasConceptContext(query: string): boolean {
    return getConceptKind(query, this.conceptBundles) !== null;
  }

  // ── Call-graph pass-through ─────────────────────────────────────

  findCallers(
    name: string,
    limit?: number
  ): Array<{ chunkId: string; filePath: string; line: number; callerName: string }> {
    return this.pipeline.getMetadata().findCallers(name, limit);
  }

  findCallees(
    name: string,
    limit?: number
  ): Array<{ targetName: string; callType: string; line: number; filePath: string }> {
    return this.pipeline.getMetadata().findCallees(name, limit);
  }

  // ── Private convenience accessor ────────────────────────────────

  private get fts(): FTSStore {
    // The FTS store is stored inside both the pipeline and the strategies;
    // we always need the "current" one after updateStores, which lives in
    // the pipeline's metadata companion.  Rather than duplicating the field
    // we expose a thin getter.  The strategies are updated in parallel via
    // updateStores(), so any of them is correct.
    //
    // However, RetrievalPipeline doesn't expose FTS directly.  We keep a
    // reference through the metadata + fts passed at construction and
    // updated via updateStores().  For now we store a mirror reference.
    return this._fts;
  }
  private _fts: FTSStore;

  // ── Private: seed filtering ─────────────────────────────────────

  private filterSeedsForMode(
    query: string,
    seedResult: SeedResult,
    queryMode: "lookup" | "trace" | "bug" | "architecture" | "change" | "skip"
  ): SeedResult {
    if (queryMode !== "bug" && queryMode !== "trace" && queryMode !== "architecture" && queryMode !== "change") {
      return seedResult;
    }

    const focusTerms = queryMode === "bug"
      ? this.bugStrategy.extractBugSalientTerms(query)
      : extractTraceSalientTerms(query);
    const familyTerms = (queryMode === "bug"
      ? this.bugStrategy.getModeFocusedExpandedTerms(query, "bug")
      : getTraceFocusedExpandedTerms(query)
    )
      .filter((term) => term.family && !term.generic && term.weight >= 0.72)
      .flatMap((term) => normalizeTargetText(term.term).split(" ").filter(Boolean));
    const bugProfile = queryMode === "bug"
      ? this.bugStrategy.buildBugSubjectProfile(focusTerms, query)
      : null;
    const handoffPrompt = bugProfile ? this.bugStrategy.isBugRedirectHandoffPrompt(bugProfile) : false;
    const schemaPrompt = bugProfile
      ? bugProfile.subjectTerms.some((term) => ["migration", "migrations", "schema", "sql", "table", "column", "database", "db"].includes(term))
        || bugProfile.primaryTags.has("storage")
        || bugProfile.primaryTags.has("billing")
      : false;

    const filteredSeeds = seedResult.seeds.filter((seed) => {
      const seedText = `${seed.filePath} ${seed.name} ${seed.resolvedAlias ?? ""}`;
      const lowerSeedText = seedText.toLowerCase();
      const normalizedSeedText = normalizeTargetText(seedText);
      const normalizedNameTokens = normalizeTargetText(seed.name).split(" ").filter(Boolean);
      const leadingToken = normalizedNameTokens[0] ?? "";
      const focusMatch = focusTerms.some((term) => textMatchesQueryTerm(seedText, term));
      const familyMatch = familyTerms.some((term) => textMatchesQueryTerm(seedText, term));

      if (
        queryMode === "bug"
        && !schemaPrompt
        && (/(?:^|\/)(migrations?|schema)\//.test(seed.filePath.toLowerCase()) || /\.sql$/i.test(seed.filePath))
      ) {
        return false;
      }

      if (
        queryMode === "bug"
        && handoffPrompt
        && /\b(navigation|drawer|menu|segment|mobile|keyboard|floating|tab|skip|signout|logout)\b/.test(lowerSeedText)
        && !/\b(protected|guard|redirect|callback|auth|route|router|destination|pending|session)\b/.test(lowerSeedText)
      ) {
        return false;
      }
      if (
        queryMode === "bug"
        && handoffPrompt
        && /(?:^|\/)(src\/)?(components|pages|views|screens)\//.test(seed.filePath.toLowerCase())
        && /\b(auth|login|signin|signup)\b/.test(normalizedSeedText)
        && !/\b(callback|redirect|protected|guard|pending|destination|route|router|session|return)\b/.test(normalizedSeedText)
      ) {
        return false;
      }

        if (
          queryMode === "bug"
          && !focusMatch
          && !familyMatch
          && seed.reason !== "explicit_target"
          && BUG_STRUCTURAL_ROLE_ALIAS_TERMS.has(normalizeTargetText(seed.resolvedAlias ?? seed.name))
        ) {
          return false;
        }

      if (
        queryMode === "bug"
        && seed.reason !== "explicit_target"
        && normalizeTargetText(seed.resolvedAlias ?? seed.name).split(" ").length <= 1
        && BUG_LOW_SPECIFICITY_TERMS.has(normalizeTargetText(seed.resolvedAlias ?? seed.name))
        && BUG_STRUCTURAL_NOISE_RE.test(seed.filePath.toLowerCase())
        && !familyMatch
      ) {
        return false;
      }

      if (
        seed.reason === "explicit_target"
        && GENERIC_QUERY_ACTION_TERMS.has(leadingToken)
        && !focusMatch
        && !familyMatch
      ) {
        return false;
      }

      if (
        (seed.reason === "explicit_target" || seed.reason === "resolved_target")
        && familyTerms.length > 0
        && !focusMatch
        && !familyMatch
      ) {
        return false;
      }

      if (
        (queryMode === "architecture" || queryMode === "change")
        && seed.reason === "explicit_target"
        && (/^(what|where|which|when|why|how)$/i.test(seed.name) || /^(what|where|which|when|why|how)[A-Z_]/.test(seed.name))
      ) {
        return false;
      }

      return true;
    });

    if (filteredSeeds.length === 0) return seedResult;
    const rankedSeeds = [...filteredSeeds].sort((a, b) => {
      const scoreSeed = (seed: SeedResult["seeds"][number]): number => {
        const seedText = `${seed.filePath} ${seed.name} ${seed.resolvedAlias ?? ""}`;
        const focusMatches = focusTerms.filter((term) => textMatchesQueryTerm(seedText, term)).length;
        const familyMatches = familyTerms.filter((term) => textMatchesQueryTerm(seedText, term)).length;
        const aliasTokens = normalizeTargetText(seed.resolvedAlias ?? seed.name).split(" ").filter(Boolean);
        const aliasIsGeneric = aliasTokens.length === 1
          && (
            GENERIC_BROAD_TERMS.has(aliasTokens[0] ?? "")
            || GENERIC_QUERY_ACTION_TERMS.has(aliasTokens[0] ?? "")
            || BUG_GENERIC_SEED_ALIAS_TERMS.has(aliasTokens[0] ?? "")
          );
        const compoundBonus = /[A-Z_]/.test(seed.name) ? 1.5 : aliasTokens.length >= 2 ? 1 : 0;
        const reasonBonus =
          seed.reason === "explicit_target" ? 1.4
            : seed.reason === "fts_exact" ? 1.2
              : seed.targetKind === "symbol" ? 1.1
                : seed.targetKind === "file_module" ? 0.8
                  : 0.5;
        return focusMatches * 5 + familyMatches * 3 + compoundBonus + reasonBonus - (aliasIsGeneric ? 2.2 : 0);
      };
      const diff = scoreSeed(b) - scoreSeed(a);
      if (Math.abs(diff) > 0.01) return diff;
      return b.confidence - a.confidence;
    });
    return {
      seeds: rankedSeeds,
      bestSeed: rankedSeeds[0] ?? null,
    };
  }

  // ── Private: merge multi-query result sets (bug mode) ───────────

  private mergeVariantResultSets(resultSets: SearchResult[][]): SearchResult[] {
    if (resultSets.length <= 1) return resultSets[0] ?? [];

    const byId = new Map<string, {
      result: SearchResult;
      fusedScore: number;
      appearances: number;
      bestLocalScore: number;
    }>();

    for (let queryIndex = 0; queryIndex < resultSets.length; queryIndex++) {
      const results = resultSets[queryIndex] ?? [];
      const topScore = results[0]?.score ?? 1;
      const queryWeight = Math.max(0.55, 1 - queryIndex * 0.15);

      for (let rank = 0; rank < results.length; rank++) {
        const result = results[rank];
        if (!result) continue;
        const normalizedScore = topScore > 0 ? result.score / topScore : 0;
        const contribution = queryWeight * (normalizedScore + (1 / (rank + 1)) * 0.2);
        const existing = byId.get(result.id);
        if (!existing) {
          byId.set(result.id, {
            result,
            fusedScore: contribution,
            appearances: 1,
            bestLocalScore: result.score,
          });
          continue;
        }

        existing.fusedScore += contribution;
        existing.appearances += 1;
        if (result.score > existing.bestLocalScore) {
          existing.bestLocalScore = result.score;
          existing.result = result;
        }
      }
    }

    return Array.from(byId.values())
      .map((entry) => ({
        ...entry.result,
        score: entry.fusedScore + Math.max(0, entry.appearances - 1) * 0.18,
        hookScore: Math.max(entry.result.hookScore ?? 0, entry.fusedScore),
      }))
      .sort((a, b) => b.score - a.score);
  }
}
