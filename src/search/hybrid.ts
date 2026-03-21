import { type MemoryConfig, resolveContextBudget } from "../core/config.js";
import type { EmbeddingProvider } from "../indexer/types.js";
import type { VectorStore } from "../storage/vector-store.js";
import type { FTSStore } from "../storage/fts-store.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import { reciprocalRankFusion } from "./ranker.js";
import {
  collectCorpusFamilyTerms,
  expandQueryTerms,
  GENERIC_BROAD_TERMS,
  type ExpandedQueryTerm,
  isTestFile,
  STOP_WORDS,
  textMatchesQueryTerm,
  tokenizeQueryTerms,
} from "./utils.js";
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
import type { SeedResult } from "./seed.js";
import type { ResolvedTargetAliasHit, StoredChunk, TargetKind } from "../storage/types.js";
import { classifyIntent } from "./intent.js";
import { normalizeTargetText } from "./targets.js";

const IMPL_BOOST = 1.25;

const DOC_PENALTY = 0.45;
const DOC_PENALTY_NO_IMPL = 0.8;
const TERM_MATCH_BOOST = 1.15;
const CONCEPT_BOOST = 0.9;
const BROAD_PHRASE_GENERIC_TERMS = GENERIC_BROAD_TERMS;
const BROAD_INVENTORY_RE =
  /\b(?:which|what|list|show)\s+files\b|\bfiles?\s+(?:implement|handle|power|control|cover)\b/i;
const INVENTORY_STRUCTURAL_TERMS = new Set([
  "which",
  "what",
  "list",
  "show",
  "file",
  "files",
  "implement",
  "implements",
  "handle",
  "handles",
  "power",
  "powers",
  "control",
  "controls",
  "cover",
  "covers",
  "full",
  "entire",
]);
const SUBSYSTEM_INVENTORY_FAMILIES = new Set(["search"]);

interface CompiledConceptBundle {
  kind: string;
  pattern: RegExp;
  symbols: string[];
  maxChunks: number;
}

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

interface ScoringMaps {
  chunkDates: Map<string, string>;
  chunkFilePaths: Map<string, string>;
  chunkKinds: Map<string, string>;
  chunkNames: Map<string, string>;
  chunkParents: Map<string, { parentName?: string; filePath: string }>;
  chunkLineRanges: Map<string, { startLine: number; endLine: number }>;
}

interface BroadWorkflowCandidate {
  result: SearchResult;
  score: number;
  layers: string[];
  matchedFamilies: string[];
  matchedWeight: number;
  genericOnly: boolean;
  utilityLike: boolean;
  directAnchorCount: number;
  coreAnchorCount: number;
  phraseMatchCount: number;
  callbackNoise: boolean;
}

interface BroadTargetCandidate {
  result: SearchResult;
  score: number;
  subsystem?: string;
}

interface BroadFileCandidate {
  filePath: string;
  primary: BroadWorkflowCandidate;
  chunks: BroadWorkflowCandidate[];
  score: number;
  layers: string[];
  matchedFamilies: string[];
  directAnchorCount: number;
  coreAnchorCount: number;
  phraseMatchCount: number;
  utilityLike: boolean;
  callbackNoise: boolean;
  genericOnly: boolean;
}

interface BroadQueryProfile {
  expandedTerms: ExpandedQueryTerm[];
  anchorTerms: ExpandedQueryTerm[];
  familyTerms: ExpandedQueryTerm[];
  allowedFamilies: Set<string>;
  phrases: string[];
  tokens: string[];
  inventoryMode: boolean;
  lifecycleMode: boolean;
}

type BroadMode = "inventory" | "workflow";

interface BroadSelectedFileDiagnostic {
  filePath: string;
  selectionSource: string;
}

export interface BroadSelectionDiagnostics {
  broadMode: BroadMode;
  dominantFamily?: string;
  selectedFiles: BroadSelectedFileDiagnostic[];
  fallbackReason?: string;
}

interface InventoryFileCandidate extends BroadFileCandidate {
  selectionSource: string;
  targetKind?: TargetKind;
  importCorroboration: number;
  subsystemMatch: boolean;
}

export class HybridSearch {
  private embedder: EmbeddingProvider;
  private vectors: VectorStore;
  private fts: FTSStore;
  private metadata: MetadataStore;
  private config: MemoryConfig;
  private reranker: LocalReranker | null = null;
  private lock: ReadWriteLock | undefined;
  private conceptBundles: CompiledConceptBundle[];
  private queryEmbedCache = new Map<string, number[]>();
  private static readonly EMBED_CACHE_MAX = 50;
  private lastBroadSelection: BroadSelectionDiagnostics | null = null;

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
    this.conceptBundles = compileConceptBundles(config.conceptBundles);
  }

  updateStores(
    vectors: VectorStore,
    fts: FTSStore,
    metadata: MetadataStore
  ): void {
    this.vectors = vectors;
    this.fts = fts;
    this.metadata = metadata;
    this.queryEmbedCache.clear();
  }

  getLastBroadSelectionDiagnostics(): BroadSelectionDiagnostics | null {
    return this.lastBroadSelection;
  }

  async search(
    query: string,
    options?: SearchOptions,
    seedResult?: SeedResult
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
      return this.prependConceptTargetResults(query, hydrated, seedResult);
    };

    return this.lock ? this.lock.withRead(doSearch) : doSearch();
  }

  async searchWithContext(
    query: string,
    tokenBudget?: number,
    activeFiles?: string[],
    signal?: AbortSignal,
    seedResult?: SeedResult
  ): Promise<AssembledContext> {
    const budget = tokenBudget ?? resolveContextBudget(
      this.config.contextBudget,
      this.metadata.getStats().totalChunks
    );
    const intent = classifyIntent(query);
    const isBroadWorkflow = intent.prefersBroadContext === true;
    const isInventoryBroad = isBroadWorkflow && BROAD_INVENTORY_RE.test(query);
    this.lastBroadSelection = null;
    const seeds = seedResult ?? resolveSeeds(query, this.metadata, this.fts);
    const conceptContext = isInventoryBroad ? null : this.buildConceptContext(query, budget, seeds);
    if (conceptContext) return conceptContext;

    const maxContextChunks = this.config.maxContextChunks > 0
      ? this.config.maxContextChunks
      : Math.min(100, Math.max(10, Math.floor(budget / 200)));  // ~200 tokens per avg chunk, capped at 100
    const hookLimit = Math.max(maxContextChunks * 2, 20);
    const results = await this.search(query, {
      limit: hookLimit,
      activeFiles,
      graphExpansion: true,
      graphTopN: 5,
      siblingExpansion: false,
      rerank: false,
      signal,
    }, seeds);
    const exactAware = this.prependExplicitTargetResults(query, results, seeds);
    const seedAware = this.prependBroadSeedResults(query, exactAware, seeds, isBroadWorkflow);
    const prioritized = this.prioritizeForHookContext(query, seedAware, isBroadWorkflow);
    const broadWorkflowBundle = isBroadWorkflow
      ? this.selectBroadWorkflowBundle(query, prioritized, seeds, maxContextChunks)
      : prioritized;

    const log = getLogger();
    log.debug({
      query: query.slice(0, 100),
      budget,
      maxContextChunks,
      retrievedCount: results.length,
      exactAwareCount: exactAware.length,
      prioritizedCount: prioritized.length,
      broadWorkflowCount: broadWorkflowBundle.length,
      isBroadWorkflow,
    }, "searchWithContext pipeline");

    return assembleContext(
      broadWorkflowBundle,
      budget,
      {
        maxChunks: isBroadWorkflow ? Math.min(maxContextChunks, 8) : maxContextChunks,
        scoreFloorRatio: isBroadWorkflow ? 0.05 : 0.55,
        query,
        factExtractors: this.config.factExtractors,
        compressionRank: isBroadWorkflow ? 0 : 3,
      }
    );
  }

  private buildConceptContext(
    query: string,
    tokenBudget: number,
    seedResult?: SeedResult
  ): AssembledContext | null {
    const conceptKind = this.getConceptKind(query);
    if (!conceptKind) return null;

    const seeds = seedResult ?? resolveSeeds(query, this.metadata, this.fts);
    const hasResolvedExplicitTarget = seeds.seeds
      .some((seed) => seed.reason === "explicit_target" || seed.reason === "resolved_target");
    if (hasResolvedExplicitTarget) return null;

    const bundle = this.getConceptBundle(conceptKind);
    const selectedChunks = this.selectConceptChunks(
      this.getConceptSymbolsForKind(conceptKind),
      bundle?.maxChunks ?? 4
    );
    if (selectedChunks.length === 0) return null;

    const conceptResults = selectedChunks.map((chunk, index) =>
      this.chunkToSearchResult(chunk, 1 - index * 0.01)
    );

    return assembleConceptContext(conceptKind, conceptResults, tokenBudget);
  }

  private prioritizeForHookContext(
    query: string,
    results: SearchResult[],
    broadQuery: boolean = false
  ): SearchResult[] {
    const queryTerms = tokenizeQueryTerms(query)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
    const expandedTerms = expandQueryTerms(query);
    const hasImplementationChunks = results.some((result) => this.isImplementationChunk(result));

    return results
      .map((result) => ({
        result,
        adjustedScore: this.getHookPriorityScore(
          result,
          queryTerms,
          hasImplementationChunks,
          expandedTerms,
          broadQuery
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
    results: SearchResult[],
    seedResult?: SeedResult
  ): SearchResult[] {
    const seeds = seedResult ?? resolveSeeds(query, this.metadata, this.fts);
    const explicitSeeds = seeds.seeds
      .filter((seed) => seed.reason === "explicit_target" || seed.reason === "resolved_target")
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
      if (!seed) continue;
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
    results: SearchResult[],
    seedResult?: SeedResult
  ): SearchResult[] {
    const conceptSymbols = this.getConceptSymbols(query);
    if (conceptSymbols.length === 0) return results;

    const resolved = seedResult ?? resolveSeeds(query, this.metadata, this.fts);
    const hasResolvedExplicitTarget = resolved.seeds
      .some((seed) => seed.reason === "explicit_target" || seed.reason === "resolved_target");
    if (hasResolvedExplicitTarget) return results;

    const selectedChunks = this.selectConceptChunks(conceptSymbols);
    if (selectedChunks.length === 0) return results;

    const byId = new Map(results.map((result) => [result.id, result]));
    const topScore = results[0]?.score ?? 1;

    for (let i = 0; i < selectedChunks.length; i++) {
      const chunk = selectedChunks[i];
      if (!chunk) continue;
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

  private prependBroadSeedResults(
    query: string,
    results: SearchResult[],
    seedResult?: SeedResult,
    broadQuery: boolean = false
  ): SearchResult[] {
    const seeds = seedResult ?? resolveSeeds(query, this.metadata, this.fts);
    if (seeds.seeds.some((seed) => seed.reason === "explicit_target")) return results;
    if (!broadQuery && seeds.seeds.some((seed) => seed.reason === "resolved_target")) return results;

    const contentTerms = tokenizeQueryTerms(query)
      .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
    if (contentTerms.length < 4) return results;

    const broadSeeds = seeds.seeds
      .filter((seed) => seed.confidence >= (broadQuery ? 0.5 : 0.6) && !isTestFile(seed.filePath))
      .filter((seed) => seed.kind !== "interface_declaration" && seed.kind !== "type_alias_declaration");
    if (broadSeeds.length === 0) return results;

    const selectedSeeds: typeof broadSeeds = [];
    const seenFiles = new Set<string>();
    for (const seed of broadSeeds) {
      if (seenFiles.has(seed.filePath)) continue;
      selectedSeeds.push(seed);
      seenFiles.add(seed.filePath);
      if (selectedSeeds.length >= 4) break;
    }
    if (selectedSeeds.length === 0) return results;

    const chunkMap = new Map(
      this.metadata
        .getChunksByIds(selectedSeeds.map((seed) => seed.chunkId))
        .map((chunk) => [chunk.id, chunk])
    );
    const byId = new Map(results.map((result) => [result.id, result]));
    const topScore = results[0]?.score ?? 1;

    for (let i = 0; i < selectedSeeds.length; i++) {
      const seed = selectedSeeds[i];
      if (!seed) continue;
      const chunk = chunkMap.get(seed.chunkId);
      if (!chunk) continue;

      const existing = byId.get(seed.chunkId);
      const boostedScore = topScore + (broadQuery ? 1.1 : 0.9) + seed.confidence - i * 0.001;
      byId.set(
        seed.chunkId,
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

  private getMatchedConceptBundles(query: string): CompiledConceptBundle[] {
    return this.conceptBundles.filter((bundle) => bundle.pattern.test(query));
  }

  private getConceptKind(query: string): ConceptContextKind | null {
    const matched = this.getMatchedConceptBundles(query);
    if (matched.length === 1) return (matched[0]?.kind ?? null) as ConceptContextKind | null;
    return null;
  }

  private getConceptSymbols(query: string): string[] {
    const kind = this.getConceptKind(query);
    return kind ? this.getConceptSymbolsForKind(kind) : [];
  }

  private getConceptBundle(kind: ConceptContextKind): CompiledConceptBundle | undefined {
    return this.conceptBundles.find((b) => b.kind === kind);
  }

  private getConceptSymbolsForKind(kind: ConceptContextKind): string[] {
    return this.getConceptBundle(kind)?.symbols ?? [];
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

    const testDiff = Number(isTestFile(a.filePath))
      - Number(isTestFile(b.filePath));
    if (testDiff !== 0) return testDiff;

    return a.filePath.localeCompare(b.filePath);
  }

  private getHookPriorityScore(
    result: SearchResult,
    queryTerms: string[],
    hasImplementationChunks: boolean,
    expandedTerms: ExpandedQueryTerm[] = expandQueryTerms(queryTerms),
    broadQuery: boolean = false
  ): number {
    let score = result.score;
    const lowerPath = result.filePath.toLowerCase();
    const baseName = lowerPath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    const lowerName = result.name.toLowerCase();

    if (this.isImplementationChunk(result)) score *= IMPL_BOOST;
    if (isTestFile(result.filePath)) {
      score *= this.config.testPenaltyFactor;
    }
    if (/\.(md|mdx|txt)$/i.test(lowerPath) || /(?:^|\/)(docs?|audit|reports?)\//.test(lowerPath)) {
      score *= hasImplementationChunks ? DOC_PENALTY : DOC_PENALTY_NO_IMPL;
    }

    const matchedTerms = expandedTerms.filter((term) =>
      textMatchesQueryTerm(baseName, term.term) || textMatchesQueryTerm(lowerName, term.term)
    );
    const termMatches = matchedTerms.length;
    if (termMatches > 0) {
      const weightedCoverage = matchedTerms.reduce((sum, term) => sum + term.weight, 0);
      const totalWeight = expandedTerms.reduce((sum, term) => sum + term.weight, 0) || 1;
      score *= Math.pow(TERM_MATCH_BOOST, Math.min(4, weightedCoverage));
      const coverageRatio = weightedCoverage / totalWeight;
      const hasLongAnchorMatch = matchedTerms.some((term) => term.term.length >= 8 && term.weight >= 0.7);
      if (queryTerms.length >= 3 && coverageRatio < 0.5 && !hasLongAnchorMatch) {
        score *= coverageRatio < 0.2 ? 0.65 : 0.8;
      }
      if (broadQuery) {
        const familyCount = new Set(matchedTerms.map((term) => term.family).filter(Boolean)).size;
        if (familyCount > 0) {
          score *= 1 + Math.min(0.25, familyCount * 0.1);
        }
        if (matchedTerms.every((term) => term.generic)) {
          score *= 0.55;
        }
      }
    } else if (broadQuery && this.isUtilityLikePath(lowerPath, lowerName)) {
      score *= 0.6;
    }

    // Length penalty: demote disproportionately large chunks (same curve as RRF)
    const lineCount = result.endLine - result.startLine + 1;
    if (lineCount > 80) {
      score *= 80 / (lineCount * 0.8 + 16);
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

  private selectBroadWorkflowBundle(
    query: string,
    results: SearchResult[],
    seedResult?: SeedResult,
    maxContextChunks: number = 8
  ): SearchResult[] {
    const allowTests = /\btest|spec|fixture|mock|e2e\b/i.test(query);
    const seeds = seedResult ?? resolveSeeds(query, this.metadata, this.fts);
    const baseTerms = expandQueryTerms(query);
    const baseProfile = this.buildBroadQueryProfile(query, baseTerms);
    const conceptResults = this.buildBroadConceptResults(query, allowTests, baseProfile);
    const targetResults = this.mergeBroadResults(
      conceptResults,
      this.buildBroadTargetResults(query, allowTests, baseProfile)
    );
    const corpusTerms = collectCorpusFamilyTerms(
      baseTerms,
      [
        ...targetResults.slice(0, 8).map((result) => ({ filePath: result.filePath, name: result.name })),
        ...results.slice(0, 10).map((result) => ({ filePath: result.filePath, name: result.name })),
        ...seeds.seeds.slice(0, 6).map((seed) => ({ filePath: seed.filePath, name: seed.name })),
      ]
    );
    const expandedTerms = [
      ...baseTerms,
      ...corpusTerms.filter((term) =>
        !term.family || baseProfile.allowedFamilies.size === 0 || baseProfile.allowedFamilies.has(term.family)
      ),
    ];
    const profile = this.buildBroadQueryProfile(query, expandedTerms);
    const mergedResults = this.mergeBroadResults(targetResults, results);
    const candidates = mergedResults
      .filter((result) => allowTests || !isTestFile(result.filePath))
      .filter((result) => result.kind !== "file")
      .map((result) => this.scoreBroadWorkflowCandidate(result, profile))
      .sort((a, b) => b.score - a.score);
    if (profile.inventoryMode) {
      return this.selectBroadInventoryBundle(profile, candidates, allowTests, maxContextChunks);
    }
    const baseFileCandidates = this.mergeBroadFileCandidates(
      this.buildBroadFileCandidates(candidates, profile),
      this.buildBroadConceptFileCandidates(query, profile, allowTests)
    );
    const fileCandidates = profile.lifecycleMode
      ? baseFileCandidates
      : this.mergeBroadFileCandidates(
          baseFileCandidates,
          this.buildBroadFamilyFileCandidates(profile, allowTests)
        );
    const dominantFamily = this.chooseDominantBroadFamily(profile, fileCandidates);
    const scopedFileCandidates = dominantFamily && !profile.lifecycleMode
      ? this.buildDominantFamilyNeighborhood(dominantFamily, profile, fileCandidates, allowTests)
      : fileCandidates;

    const selectedFiles: BroadFileCandidate[] = [];
    const seenFilePaths = new Set<string>();
    let utilityCount = 0;
    let observabilityCount = 0;
    const queryMentionsLogging = /\b(log|logging|trace|audit|instrument|instrumentation|telemetry)\b/i.test(query);
    const isLifecycleFile = (candidate: BroadFileCandidate): boolean => {
      const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
      return /\b(close|shutdown|drain|stop|serve|scheduler|pipeline)\b/.test(text);
    };
    const isObservabilityFile = (candidate: BroadFileCandidate): boolean =>
      this.isObservabilitySidecarPath(
        candidate.filePath.toLowerCase(),
        candidate.primary.result.name.toLowerCase()
      );
    const dominantFamilyNeighbors = dominantFamily && !profile.lifecycleMode
      ? new Set(
          scopedFileCandidates
            .filter((candidate) => candidate.matchedFamilies.includes(dominantFamily))
            .flatMap((candidate) => this.collectBroadImportNeighbors(candidate.filePath))
        )
      : new Set<string>();
    const isDominantFamilyFile = (candidate: BroadFileCandidate): boolean =>
      !!dominantFamily
      && (
        candidate.matchedFamilies.includes(dominantFamily)
        || candidate.filePath.includes(`/${dominantFamily}/`)
      );

    const trySelectFile = (candidate: BroadFileCandidate | undefined) => {
      if (!candidate) return;
      if (seenFilePaths.has(candidate.filePath)) return;
      if (candidate.callbackNoise) return;
      if (candidate.utilityLike && utilityCount >= 1) return;
      if (!profile.inventoryMode && !profile.lifecycleMode && selectedFiles.length < 3) {
        if (candidate.utilityLike) return;
        if (queryMentionsLogging && isObservabilityFile(candidate)) return;
      }
      if (!profile.inventoryMode && !profile.lifecycleMode && queryMentionsLogging) {
        if (isObservabilityFile(candidate) && observabilityCount >= 1) return;
      }
      if (profile.inventoryMode) {
        if (
          candidate.coreAnchorCount === 0
          && candidate.matchedFamilies.length === 0
          && !dominantFamilyNeighbors.has(candidate.filePath)
        ) {
          return;
        }
      } else if (candidate.directAnchorCount === 0 && candidate.phraseMatchCount === 0 && candidate.matchedFamilies.length === 0) {
        return;
      }
      selectedFiles.push(candidate);
      seenFilePaths.add(candidate.filePath);
      if (candidate.utilityLike) utilityCount++;
      if (isObservabilityFile(candidate)) observabilityCount++;
    };

    if (profile.inventoryMode) {
      const rankedInventoryCandidates = [...scopedFileCandidates].sort((a, b) => {
        const aFamily = dominantFamily && a.matchedFamilies.includes(dominantFamily) ? 1 : 0;
        const bFamily = dominantFamily && b.matchedFamilies.includes(dominantFamily) ? 1 : 0;
        if (aFamily !== bFamily) return bFamily - aFamily;
        const aSubsystem = dominantFamily && a.filePath.includes(`/${dominantFamily}/`) ? 1 : 0;
        const bSubsystem = dominantFamily && b.filePath.includes(`/${dominantFamily}/`) ? 1 : 0;
        if (aSubsystem !== bSubsystem) return bSubsystem - aSubsystem;
        if (a.coreAnchorCount !== b.coreAnchorCount) return b.coreAnchorCount - a.coreAnchorCount;
        if (a.phraseMatchCount !== b.phraseMatchCount) return b.phraseMatchCount - a.phraseMatchCount;
        return b.score - a.score;
      });

      for (const candidate of rankedInventoryCandidates) {
        if (selectedFiles.length >= Math.min(maxContextChunks, 8)) break;
        if (dominantFamily && !isDominantFamilyFile(candidate)) continue;
        trySelectFile(candidate);
      }
    } else if (profile.lifecycleMode) {
      const rankedLifecycleCandidates = [...scopedFileCandidates].sort((a, b) => {
        const aConcept = a.matchedFamilies.includes("lifecycle") ? 1 : 0;
        const bConcept = b.matchedFamilies.includes("lifecycle") ? 1 : 0;
        if (aConcept !== bConcept) return bConcept - aConcept;
        const aLifecycle = isLifecycleFile(a) ? 1 : 0;
        const bLifecycle = isLifecycleFile(b) ? 1 : 0;
        if (aLifecycle !== bLifecycle) return bLifecycle - aLifecycle;
        if (a.directAnchorCount !== b.directAnchorCount) return b.directAnchorCount - a.directAnchorCount;
        if (a.coreAnchorCount !== b.coreAnchorCount) return b.coreAnchorCount - a.coreAnchorCount;
        if (a.phraseMatchCount !== b.phraseMatchCount) return b.phraseMatchCount - a.phraseMatchCount;
        if (a.utilityLike !== b.utilityLike) return a.utilityLike ? 1 : -1;
        return b.score - a.score;
      });

      for (const candidate of rankedLifecycleCandidates) {
        if (selectedFiles.length >= Math.min(maxContextChunks, 8)) break;
        if (!isLifecycleFile(candidate) && candidate.directAnchorCount === 0 && candidate.phraseMatchCount === 0) {
          continue;
        }
        trySelectFile(candidate);
      }
    } else {
      const layerPriority = ["ui", "state", "routing", "backend", "shared", "core"];
      for (const layer of layerPriority) {
        for (const candidate of scopedFileCandidates) {
          if (
            !candidate.layers.includes(layer)
            || (
              candidate.directAnchorCount === 0
              && candidate.phraseMatchCount === 0
              && candidate.matchedFamilies.length === 0
            )
          ) {
            continue;
          }
          const countBefore = selectedFiles.length;
          trySelectFile(candidate);
          if (selectedFiles.length > countBefore) break;
        }
        if (selectedFiles.length >= Math.min(maxContextChunks, 8)) break;
      }
    }

    if (!profile.inventoryMode) {
      for (const candidate of scopedFileCandidates) {
        if (selectedFiles.length >= Math.min(maxContextChunks, 8)) break;
        if (
          candidate.callbackNoise
          || (
            profile.anchorTerms.length >= 3
            && candidate.directAnchorCount <= 1
            && candidate.phraseMatchCount === 0
            && candidate.matchedFamilies.length === 0
          )
        ) {
          continue;
        }
        if (
          candidate.genericOnly
          && candidate.matchedFamilies.length === 0
            && candidate.layers.every((layer) => layer === "shared" || layer === "core")
        ) {
          continue;
        }
        trySelectFile(candidate);
      }
    }

    const orderedSelectedFiles = profile.inventoryMode
      ? selectedFiles
      : [...selectedFiles].sort((a, b) => {
          const aDominant = dominantFamily && (
            a.matchedFamilies.includes(dominantFamily) || a.filePath.includes(`/${dominantFamily}/`)
          ) ? 1 : 0;
          const bDominant = dominantFamily && (
            b.matchedFamilies.includes(dominantFamily) || b.filePath.includes(`/${dominantFamily}/`)
          ) ? 1 : 0;
          if (aDominant !== bDominant) return bDominant - aDominant;
          if (queryMentionsLogging) {
            const aObservability = isObservabilityFile(a) ? 1 : 0;
            const bObservability = isObservabilityFile(b) ? 1 : 0;
            if (aObservability !== bObservability) return aObservability - bObservability;
          }
          if (a.coreAnchorCount !== b.coreAnchorCount) return b.coreAnchorCount - a.coreAnchorCount;
          if (a.directAnchorCount !== b.directAnchorCount) return b.directAnchorCount - a.directAnchorCount;
          if (a.phraseMatchCount !== b.phraseMatchCount) return b.phraseMatchCount - a.phraseMatchCount;
          if (a.utilityLike !== b.utilityLike) return a.utilityLike ? 1 : -1;
          return b.score - a.score;
        });

    const selectedChunks = this.expandSelectedBroadFiles(orderedSelectedFiles, maxContextChunks, profile, scopedFileCandidates);
    const fallbackInventoryChunks = profile.inventoryMode && selectedChunks.length === 0
      ? scopedFileCandidates
          .filter((candidate) =>
            dominantFamily
              ? isDominantFamilyFile(candidate)
              : candidate.coreAnchorCount > 0 || candidate.matchedFamilies.length > 0
          )
          .slice(0, Math.min(maxContextChunks, 8))
          .map((candidate) => candidate.primary)
      : [];

    const finalChunks = selectedChunks.length > 0 ? selectedChunks : fallbackInventoryChunks;
    this.lastBroadSelection = {
      broadMode: "workflow",
      dominantFamily: dominantFamily ?? undefined,
      selectedFiles: orderedSelectedFiles.map((candidate) => ({
        filePath: candidate.filePath,
        selectionSource: "workflow_bundle",
      })),
      fallbackReason: finalChunks.length === 0 ? "no_workflow_file_candidates" : undefined,
    };

    return finalChunks.length > 0
      ? finalChunks.map((candidate) => ({
          ...candidate.result,
          hookScore: candidate.score,
          score: Math.max(candidate.result.score, candidate.score),
        }))
      : results;
  }

  private selectBroadInventoryBundle(
    profile: BroadQueryProfile,
    candidates: BroadWorkflowCandidate[],
    allowTests: boolean,
    maxContextChunks: number
  ): SearchResult[] {
    const dominantFamily = this.chooseDominantBroadFamily(
      profile,
      this.mergeBroadFileCandidates(
        this.buildBroadFileCandidates(candidates, profile),
        this.buildBroadFamilyFileCandidates(profile, allowTests)
      )
    );
    const inventoryCandidates = this.buildInventoryFileCandidates(profile, candidates, dominantFamily, allowTests);
    const selectedFiles = this.selectInventoryFiles(profile, inventoryCandidates, dominantFamily, maxContextChunks);
    const selectedChunks = selectedFiles
      .slice(0, Math.min(maxContextChunks, 8))
      .map((candidate) => candidate.primary);

    this.lastBroadSelection = {
      broadMode: "inventory",
      dominantFamily: dominantFamily ?? undefined,
      selectedFiles: selectedFiles.map((candidate) => ({
        filePath: candidate.filePath,
        selectionSource: candidate.selectionSource,
      })),
      fallbackReason: selectedFiles.length === 0 ? "no_inventory_file_candidates" : undefined,
    };

    return selectedChunks.length > 0
      ? selectedChunks.map((candidate) => ({
          ...candidate.result,
          hookScore: candidate.score,
          score: Math.max(candidate.result.score, candidate.score),
        }))
      : candidates
          .slice(0, Math.min(maxContextChunks, 8))
          .map((candidate) => candidate.result);
  }

  private buildInventoryFileCandidates(
    profile: BroadQueryProfile,
    candidates: BroadWorkflowCandidate[],
    dominantFamily: string | null,
    allowTests: boolean
  ): InventoryFileCandidate[] {
    const baseCandidates = this.buildBroadFileCandidates(candidates, profile);
    const byPath = new Map<string, InventoryFileCandidate>();
    const dominantAliases = dominantFamily
      ? this.getBroadFamilyAliases(profile, dominantFamily)
      : [];

    const upsert = (
      filePath: string,
      source: string,
      targetKind?: TargetKind,
      boost: number = 0
    ) => {
      if (!allowTests && isTestFile(filePath)) return;
      const base = baseCandidates.find((candidate) => candidate.filePath === filePath)
        ?? this.buildBroadFileCandidateFromFilePath(filePath, profile);
      if (!base || base.callbackNoise) return;

      const subsystemMatch = !!dominantFamily && filePath.includes(`/${dominantFamily}/`);
      const importCorroboration = this.countInventoryImportCorroboration(
        filePath,
        dominantFamily,
        baseCandidates
      );
      const sourceWeight =
        source === "typed_target" ? 0.9
          : source === "subsystem" ? 0.7
            : source === "import_neighbor" ? 0.28
              : 0;

      const next: InventoryFileCandidate = {
        ...base,
        selectionSource: source,
        targetKind,
        subsystemMatch,
        importCorroboration,
        score:
          base.score
          + boost
          + sourceWeight
          + (subsystemMatch ? 0.45 : 0)
          + Math.min(0.36, importCorroboration * 0.12)
          + (base.coreAnchorCount > 0 ? Math.min(0.4, base.coreAnchorCount * 0.14) : 0)
          + (
            dominantFamily && base.matchedFamilies.includes(dominantFamily)
              ? 0.35
              : 0
          )
          - (
            source === "import_neighbor"
            && base.coreAnchorCount === 0
            && base.matchedFamilies.length === 0
              ? 0.6
              : 0
          )
          - (base.utilityLike ? 0.2 : 0)
          - (base.genericOnly && base.coreAnchorCount === 0 ? 0.4 : 0),
      };
      const dominantAliasMatch = dominantAliases.length === 0
        ? true
        : dominantAliases.some((alias) =>
            textMatchesQueryTerm(`${next.filePath} ${next.primary.result.name}`.toLowerCase(), alias)
          );

      if (
        dominantFamily
        && !next.subsystemMatch
        && !base.matchedFamilies.includes(dominantFamily)
        && source !== "import_neighbor"
      ) {
        return;
      }
      if (source === "typed_target" && dominantFamily && !dominantAliasMatch) {
        return;
      }

      const existing = byPath.get(filePath);
      if (!existing || next.score > existing.score) {
        byPath.set(filePath, next);
      }
    };

    for (const candidate of baseCandidates) {
      upsert(candidate.filePath, "chunk", undefined, 0);
    }

    for (const candidate of this.buildBroadFamilyFileCandidates(profile, allowTests)) {
      upsert(candidate.filePath, "typed_target", "file_module", 0.18);
    }

    if (dominantFamily && typeof this.metadata.findTargetsBySubsystem === "function") {
      for (const target of this.metadata.findTargetsBySubsystem([dominantFamily], 80)) {
        upsert(
          target.filePath,
          target.kind === "file_module" || target.kind === "endpoint" ? "typed_target" : "subsystem",
          target.kind,
          target.kind === "file_module" || target.kind === "endpoint" ? 0.2 : 0.1
        );
      }
    }

    const dominantPaths = Array.from(byPath.values())
      .filter((candidate) =>
        dominantFamily
          ? candidate.subsystemMatch || candidate.matchedFamilies.includes(dominantFamily)
          : candidate.coreAnchorCount > 0 || candidate.matchedFamilies.length > 0
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((candidate) => candidate.filePath);

    for (const filePath of dominantPaths) {
      for (const neighbor of this.collectBroadImportNeighbors(filePath)) {
        upsert(neighbor, "import_neighbor");
      }
    }

    return Array.from(byPath.values())
      .filter((candidate) => !candidate.callbackNoise)
      .sort((a, b) => b.score - a.score);
  }

  private countInventoryImportCorroboration(
    filePath: string,
    dominantFamily: string | null,
    baseCandidates: BroadFileCandidate[]
  ): number {
    const familyPaths = baseCandidates
      .filter((candidate) =>
        dominantFamily
          ? candidate.filePath.includes(`/${dominantFamily}/`) || candidate.matchedFamilies.includes(dominantFamily)
          : candidate.coreAnchorCount > 0 || candidate.matchedFamilies.length > 0
      )
      .slice(0, 12)
      .map((candidate) => candidate.filePath);
    if (familyPaths.length === 0) return 0;

    const neighbors = new Set(this.collectBroadImportNeighbors(filePath));
    let corroboration = 0;
    for (const familyPath of familyPaths) {
      if (familyPath === filePath || neighbors.has(familyPath)) corroboration++;
    }
    return corroboration;
  }

  private selectInventoryFiles(
    profile: BroadQueryProfile,
    candidates: InventoryFileCandidate[],
    dominantFamily: string | null,
    maxContextChunks: number
  ): InventoryFileCandidate[] {
    const limit = Math.min(maxContextChunks, 8);
    const selected: InventoryFileCandidate[] = [];
    const seenFilePaths = new Set<string>();
    const preferLayered = dominantFamily === "auth" || dominantFamily === "routing" || dominantFamily === "permissions";
    const requireSameSubsystem = !!dominantFamily && SUBSYSTEM_INVENTORY_FAMILIES.has(dominantFamily);
    const queryMentionsLogging = profile.tokens.includes("log") || profile.tokens.includes("logging") || profile.tokens.includes("error");

    const trySelect = (candidate: InventoryFileCandidate | undefined) => {
      if (!candidate) return;
      if (seenFilePaths.has(candidate.filePath)) return;
      if (candidate.callbackNoise) return;
      if (
        candidate.selectionSource === "import_neighbor"
        && candidate.coreAnchorCount === 0
        && candidate.matchedFamilies.length === 0
      ) {
        return;
      }
      if (
        candidate.utilityLike
        && !queryMentionsLogging
        && selected.some((item) => item.utilityLike)
      ) {
        return;
      }
      selected.push(candidate);
      seenFilePaths.add(candidate.filePath);
    };

    const ranked = [...candidates].sort((a, b) => {
      const aFamily = dominantFamily && (a.subsystemMatch || a.matchedFamilies.includes(dominantFamily)) ? 1 : 0;
      const bFamily = dominantFamily && (b.subsystemMatch || b.matchedFamilies.includes(dominantFamily)) ? 1 : 0;
      if (aFamily !== bFamily) return bFamily - aFamily;
      if (a.selectionSource !== b.selectionSource) {
        const order = ["typed_target", "chunk", "subsystem", "import_neighbor"];
        return order.indexOf(a.selectionSource) - order.indexOf(b.selectionSource);
      }
      if (a.coreAnchorCount !== b.coreAnchorCount) return b.coreAnchorCount - a.coreAnchorCount;
      if (a.importCorroboration !== b.importCorroboration) return b.importCorroboration - a.importCorroboration;
      return b.score - a.score;
    });

    if (preferLayered) {
      const layers = ["ui", "state", "routing", "backend"];
      for (const layer of layers) {
        trySelect(
          ranked.find((candidate) =>
            candidate.layers.includes(layer)
            && (!dominantFamily || candidate.subsystemMatch || candidate.matchedFamilies.includes(dominantFamily))
          )
        );
        if (selected.length >= limit) return selected;
      }
    }

    for (const candidate of ranked) {
      if (selected.length >= limit) break;
      if (
        requireSameSubsystem
        && !candidate.subsystemMatch
        && candidate.selectionSource !== "typed_target"
        && candidate.selectionSource !== "subsystem"
      ) {
        continue;
      }
      if (
        dominantFamily
        && candidate.selectionSource === "import_neighbor"
        && !candidate.subsystemMatch
        && !candidate.matchedFamilies.includes(dominantFamily)
        && candidate.coreAnchorCount === 0
        && candidate.phraseMatchCount === 0
      ) {
        continue;
      }
      if (
        dominantFamily
        && !candidate.subsystemMatch
        && !candidate.matchedFamilies.includes(dominantFamily)
        && candidate.importCorroboration === 0
      ) {
        continue;
      }
      trySelect(candidate);
    }

    return selected;
  }

  private buildBroadFileCandidates(
    candidates: BroadWorkflowCandidate[],
    profile: BroadQueryProfile
  ): BroadFileCandidate[] {
    const groups = new Map<string, BroadWorkflowCandidate[]>();
    for (const candidate of candidates) {
      const existing = groups.get(candidate.result.filePath) ?? [];
      existing.push(candidate);
      groups.set(candidate.result.filePath, existing);
    }

    const fileCandidates: BroadFileCandidate[] = [];
    for (const [filePath, chunks] of groups) {
      const sorted = [...chunks].sort((a, b) => b.score - a.score);
      const primary = sorted[0];
      if (!primary) continue;
      const layers = Array.from(new Set(sorted.flatMap((candidate) => candidate.layers)));
      const matchedFamilies = Array.from(new Set(sorted.flatMap((candidate) => candidate.matchedFamilies)));
      const directAnchorCount = Math.max(...sorted.map((candidate) => candidate.directAnchorCount));
      const coreAnchorCount = Math.max(...sorted.map((candidate) => candidate.coreAnchorCount));
      const phraseMatchCount = Math.max(...sorted.map((candidate) => candidate.phraseMatchCount));
      const callbackNoise = sorted.every((candidate) => candidate.callbackNoise);
      const utilityLike = primary.utilityLike && matchedFamilies.length === 0;
      const genericOnly = sorted.every((candidate) => candidate.genericOnly);
      const corroboratingChunks = sorted.filter((candidate) =>
        candidate.directAnchorCount > 0 || candidate.phraseMatchCount > 0 || candidate.matchedFamilies.length > 0
      ).length;
      const layerCoverage = layers.filter((layer) => layer !== "shared" && layer !== "core").length;

      let score = primary.score;
      score += Math.min(0.45, (corroboratingChunks - 1) * 0.12);
      score += Math.min(0.35, layerCoverage * 0.1);
      score += Math.min(0.28, matchedFamilies.length * 0.08);
      if (directAnchorCount >= 2) score += 0.2;
      if (profile.inventoryMode && coreAnchorCount === 0 && matchedFamilies.length === 0) score -= 0.55;
      if (profile.inventoryMode && coreAnchorCount > 0) score += Math.min(0.24, coreAnchorCount * 0.12);
      if (phraseMatchCount > 0) score += Math.min(0.25, phraseMatchCount * 0.12);
      if (utilityLike) score -= 0.2;
      if (callbackNoise) score -= 0.5;
      if (profile.anchorTerms.length >= 3 && directAnchorCount === 0 && phraseMatchCount === 0) {
        score -= matchedFamilies.length > 0 ? 0.25 : 0.45;
      }

      fileCandidates.push({
        filePath,
        primary,
        chunks: sorted,
        score,
        layers,
        matchedFamilies,
        directAnchorCount,
        coreAnchorCount,
        phraseMatchCount,
        utilityLike,
        callbackNoise,
        genericOnly,
      });
    }

    return fileCandidates.sort((a, b) => b.score - a.score);
  }

  private mergeBroadFileCandidates(
    primary: BroadFileCandidate[],
    secondary: BroadFileCandidate[]
  ): BroadFileCandidate[] {
    const byPath = new Map<string, BroadFileCandidate>();
    for (const candidate of [...primary, ...secondary]) {
      const existing = byPath.get(candidate.filePath);
      if (!existing || candidate.score > existing.score) {
        byPath.set(candidate.filePath, candidate);
      }
    }
    return Array.from(byPath.values()).sort((a, b) => b.score - a.score);
  }

  private buildBroadFamilyFileCandidates(
    profile: BroadQueryProfile,
    allowTests: boolean
  ): BroadFileCandidate[] {
    if (typeof this.metadata.resolveTargetAliases !== "function") return [];
    const aliases = Array.from(new Set(
      [
        ...profile.familyTerms.filter((term) =>
          (!term.family || profile.allowedFamilies.size === 0 || profile.allowedFamilies.has(term.family))
          && term.weight >= 0.68
        ),
        ...profile.anchorTerms.filter((term) => {
          if (term.family && profile.allowedFamilies.size > 0 && !profile.allowedFamilies.has(term.family)) {
            return false;
          }
          if (term.generic) {
            return /^(mcp|auth|hook|http|stdio|daemon|cli)$/.test(term.term);
          }
          return profile.inventoryMode ? term.weight >= 0.86 : term.weight >= 0.72;
        }),
      ].map((term) => normalizeTargetText(term.term))
    ));
    if (aliases.length === 0) return [];

    const hitKinds: TargetKind[] = profile.inventoryMode
      ? ["file_module", "endpoint"]
      : ["file_module", "endpoint", "symbol"];
    const hits = this.metadata.resolveTargetAliases(aliases, 80, hitKinds);
    const byPath = new Map<string, BroadFileCandidate>();

    for (const hit of hits) {
      const filePath = hit.target.filePath;
      if (!allowTests && isTestFile(filePath)) continue;
      const candidate = this.buildBroadFileCandidateFromFilePath(filePath, profile);
      if (!candidate) continue;
      if (candidate.callbackNoise) continue;
      const boosted: BroadFileCandidate = {
        ...candidate,
        score: candidate.score + (hit.target.kind === "file_module" || hit.target.kind === "endpoint" ? 0.35 : 0.18),
      };
      const existing = byPath.get(filePath);
      if (!existing || boosted.score > existing.score) {
        byPath.set(filePath, boosted);
      }
    }

    return Array.from(byPath.values()).sort((a, b) => b.score - a.score);
  }

  private chooseDominantBroadFamily(
    profile: BroadQueryProfile,
    fileCandidates: BroadFileCandidate[]
  ): string | null {
    if (profile.lifecycleMode) {
      const hasLifecycle = profile.anchorTerms.some((term) => term.family === "lifecycle")
        || profile.familyTerms.some((term) => term.family === "lifecycle")
        || fileCandidates.some((candidate) => candidate.matchedFamilies.includes("lifecycle"));
      if (hasLifecycle) return "lifecycle";
    }

    if (profile.allowedFamilies.size === 1) {
      return Array.from(profile.allowedFamilies)[0] ?? null;
    }

    const scores = new Map<string, number>();
    for (const term of profile.familyTerms) {
      if (!term.family) continue;
      scores.set(term.family, (scores.get(term.family) ?? 0) + term.weight);
    }
    for (const candidate of fileCandidates.slice(0, 12)) {
      for (const family of candidate.matchedFamilies) {
        scores.set(family, (scores.get(family) ?? 0) + candidate.score * 0.15);
      }
    }

    let bestFamily: string | null = null;
    let bestScore = -Infinity;
    for (const [family, score] of scores) {
      if (score > bestScore) {
        bestFamily = family;
        bestScore = score;
      }
    }
    return bestFamily;
  }

  private buildDominantFamilyNeighborhood(
    family: string,
    profile: BroadQueryProfile,
    fileCandidates: BroadFileCandidate[],
    allowTests: boolean
  ): BroadFileCandidate[] {
    const aliases = this.getBroadFamilyAliases(profile, family);
    const matchesFamily = (candidate: BroadFileCandidate): boolean => {
      if (candidate.matchedFamilies.includes(family)) return true;
      const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
      return aliases.some((alias) => textMatchesQueryTerm(text, alias));
    };

    const byPath = new Map(fileCandidates.map((candidate) => [candidate.filePath, candidate]));
    const neighborhoodPaths = new Set<string>();
    const seedCandidates = fileCandidates.filter((candidate) => matchesFamily(candidate));
    for (const candidate of seedCandidates.slice(0, 8)) {
      neighborhoodPaths.add(candidate.filePath);
      for (const neighborPath of this.collectBroadImportNeighbors(candidate.filePath)) {
        neighborhoodPaths.add(neighborPath);
      }
    }

    if (typeof this.metadata.findTargetsBySubsystem === "function") {
      for (const target of this.metadata.findTargetsBySubsystem([family], 30)) {
        if (!allowTests && isTestFile(target.filePath)) continue;
        neighborhoodPaths.add(target.filePath);
      }
    }

    const neighbors: BroadFileCandidate[] = [];
    for (const filePath of neighborhoodPaths) {
      const candidate = byPath.get(filePath) ?? this.buildBroadFileCandidateFromFilePath(filePath, profile);
      if (!candidate) continue;
      if (candidate.callbackNoise) continue;
      if (
        !matchesFamily(candidate)
        && (profile.inventoryMode ? candidate.coreAnchorCount : candidate.directAnchorCount) === 0
        && candidate.phraseMatchCount === 0
      ) {
        continue;
      }
      const boosted = {
        ...candidate,
        score: candidate.score + (matchesFamily(candidate) ? 0.36 : profile.inventoryMode ? 0.06 : 0.12),
      };
      const existing = byPath.get(filePath);
      if (!existing || boosted.score > existing.score) {
        byPath.set(filePath, boosted);
      }
      neighbors.push(boosted);
    }

    const scoped = Array.from(byPath.values()).filter((candidate) =>
      matchesFamily(candidate)
      || neighborhoodPaths.has(candidate.filePath)
      || (profile.inventoryMode ? candidate.coreAnchorCount : candidate.directAnchorCount) > 0
      || candidate.phraseMatchCount > 0
    );

    return scoped.sort((a, b) => b.score - a.score);
  }

  private getBroadFamilyAliases(profile: BroadQueryProfile, family: string): string[] {
    return Array.from(new Set(
      [...profile.anchorTerms, ...profile.familyTerms]
        .filter((term) => term.family === family)
        .map((term) => term.term)
    ));
  }

  private expandSelectedBroadFiles(
    files: BroadFileCandidate[],
    maxContextChunks: number,
    profile: BroadQueryProfile,
    allFileCandidates: BroadFileCandidate[]
  ): BroadWorkflowCandidate[] {
    const limit = Math.min(maxContextChunks, 8);
    const selected: BroadWorkflowCandidate[] = [];
    const seenIds = new Set<string>();
    const selectedFilePaths = new Set<string>();
    const fileCandidateByPath = new Map(allFileCandidates.map((candidate) => [candidate.filePath, candidate]));

    for (const file of files) {
      if (selected.length >= limit) break;
      const primary = file.primary;
      if (seenIds.has(primary.result.id)) continue;
      selected.push(primary);
      seenIds.add(primary.result.id);
      selectedFilePaths.add(file.filePath);
    }

    if (!profile.inventoryMode) {
      for (const file of files) {
        if (selected.length >= limit) break;
        const secondary = file.chunks.find((candidate) =>
          candidate.result.id !== file.primary.result.id
          && !seenIds.has(candidate.result.id)
          && (candidate.directAnchorCount > 0 || candidate.phraseMatchCount > 0)
        );
        if (!secondary) continue;
        selected.push(secondary);
        seenIds.add(secondary.result.id);
      }
    }

    if (profile.inventoryMode) {
      return selected;
    }

    const neighborFiles: BroadFileCandidate[] = [];
    for (const file of files) {
      if (neighborFiles.length >= limit) break;
      for (const neighborPath of this.collectBroadImportNeighbors(file.filePath)) {
        if (selectedFilePaths.has(neighborPath)) continue;
        const neighbor = fileCandidateByPath.get(neighborPath)
          ?? this.buildBroadFileCandidateFromFilePath(neighborPath, profile);
        if (!neighbor) continue;
        if (neighbor.callbackNoise) continue;
        if (
          (profile.inventoryMode ? neighbor.coreAnchorCount : neighbor.directAnchorCount) === 0
          && neighbor.phraseMatchCount === 0
          && neighbor.matchedFamilies.length === 0
        ) {
          continue;
        }
        if (
          profile.allowedFamilies.size > 0
          && neighbor.matchedFamilies.length > 0
          && !neighbor.matchedFamilies.some((family) => profile.allowedFamilies.has(family))
        ) {
          continue;
        }
        neighborFiles.push(neighbor);
      }
    }

    neighborFiles
      .sort((a, b) => b.score - a.score)
      .forEach((file) => {
        if (selected.length >= limit) return;
        if (selectedFilePaths.has(file.filePath)) return;
        selected.push(file.primary);
        seenIds.add(file.primary.result.id);
        selectedFilePaths.add(file.filePath);
      });

    return selected;
  }

  private collectBroadImportNeighbors(filePath: string): string[] {
    const neighbors = new Set<string>();
    if (typeof this.metadata.getImportsForFile === "function") {
      for (const record of this.metadata.getImportsForFile(filePath)) {
        if (record.resolvedPath) neighbors.add(record.resolvedPath);
      }
    }
    if (typeof this.metadata.findImporterFiles === "function") {
      for (const importer of this.metadata.findImporterFiles(filePath)) {
        neighbors.add(importer);
      }
    }
    neighbors.delete(filePath);
    return Array.from(neighbors);
  }

  private buildBroadFileCandidateFromFilePath(
    filePath: string,
    profile: BroadQueryProfile
  ): BroadFileCandidate | null {
    if (isTestFile(filePath)) return null;
    const chunks = this.metadata
      .findChunksByFilePath(filePath)
      .filter((chunk) => chunk.kind !== "file")
      .map((chunk) => this.scoreBroadWorkflowCandidate(this.chunkToSearchResult(chunk, 0.5), profile))
      .sort((a, b) => b.score - a.score);
    if (chunks.length === 0) return null;

    const primary = chunks[0];
    if (!primary) return null;
    const layers = Array.from(new Set(chunks.flatMap((candidate) => candidate.layers)));
    const matchedFamilies = Array.from(new Set(chunks.flatMap((candidate) => candidate.matchedFamilies)));
    const directAnchorCount = Math.max(...chunks.map((candidate) => candidate.directAnchorCount));
    const coreAnchorCount = Math.max(...chunks.map((candidate) => candidate.coreAnchorCount));
    const phraseMatchCount = Math.max(...chunks.map((candidate) => candidate.phraseMatchCount));
    const callbackNoise = chunks.every((candidate) => candidate.callbackNoise);
    const utilityLike = primary.utilityLike && matchedFamilies.length === 0;
    const genericOnly = chunks.every((candidate) => candidate.genericOnly);
    const corroboratingChunks = chunks.filter((candidate) =>
      candidate.directAnchorCount > 0 || candidate.phraseMatchCount > 0 || candidate.matchedFamilies.length > 0
    ).length;
    const layerCoverage = layers.filter((layer) => layer !== "shared" && layer !== "core").length;

    let score = primary.score;
    score += Math.min(0.45, (corroboratingChunks - 1) * 0.12);
    score += Math.min(0.35, layerCoverage * 0.1);
    score += Math.min(0.28, matchedFamilies.length * 0.08);
    if (directAnchorCount >= 2) score += 0.2;
    if (profile.inventoryMode && coreAnchorCount === 0 && matchedFamilies.length === 0) score -= 0.55;
    if (profile.inventoryMode && coreAnchorCount > 0) score += Math.min(0.24, coreAnchorCount * 0.12);
    if (phraseMatchCount > 0) score += Math.min(0.25, phraseMatchCount * 0.12);
    if (utilityLike) score -= 0.2;
    if (callbackNoise) score -= 0.5;

    return {
      filePath,
      primary,
      chunks,
      score,
      layers,
      matchedFamilies,
      directAnchorCount,
      coreAnchorCount,
      phraseMatchCount,
      utilityLike,
      callbackNoise,
      genericOnly,
    };
  }

  private mergeBroadResults(targetResults: SearchResult[], results: SearchResult[]): SearchResult[] {
    const byId = new Map<string, SearchResult>();
    for (const result of [...targetResults, ...results]) {
      const existing = byId.get(result.id);
      if (!existing || result.score > existing.score) {
        byId.set(result.id, result);
      }
    }
    return Array.from(byId.values()).sort((a, b) => b.score - a.score);
  }

  private buildBroadTargetResults(
    query: string,
    allowTests: boolean,
    profile?: BroadQueryProfile
  ): SearchResult[] {
    if (!this.metadata.resolveTargetAliases) return [];

    const resolvedProfile = profile ?? this.buildBroadQueryProfile(query);
    const aliases = this.buildBroadTargetAliasList(resolvedProfile);
    const hits = [
      ...this.metadata.resolveTargetAliases(aliases, 120, ["file_module", "endpoint"]),
      ...this.metadata.resolveTargetAliases(aliases, 160, ["symbol", "subsystem"]),
    ];
    const candidates = new Map<string, BroadTargetCandidate>();

    for (const hit of hits) {
      const candidate = this.scoreBroadTargetHit(hit, resolvedProfile, allowTests);
      if (!candidate) continue;
      const current = candidates.get(candidate.result.id);
      if (!current || candidate.score > current.score) {
        candidates.set(candidate.result.id, candidate);
      }
    }

    return Array.from(candidates.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 16)
      .map((candidate) => ({
        ...candidate.result,
        score: candidate.score,
        hookScore: candidate.score,
      }));
  }

  private buildBroadConceptResults(
    query: string,
    allowTests: boolean,
    profile: BroadQueryProfile
  ): SearchResult[] {
    if (profile.inventoryMode) return [];

    const bundles = this.getMatchedConceptBundles(query);
    if (bundles.length === 0) return [];

    const selected = new Map<string, SearchResult>();
    const lowerQuery = query.toLowerCase();

    for (const bundle of bundles) {
      const bonus =
        bundle.kind === "search_pipeline" ? 1.15
        : bundle.kind === "daemon" ? 1.1
        : bundle.kind === "lifecycle" ? 1.8
        : bundle.kind === "context_assembly" ? 1.05
        : 1.0;
      const chunks = this.selectConceptChunks(
        bundle.symbols,
        Math.min(bundle.symbols.length, Math.max(bundle.maxChunks ?? 4, 6))
      );

      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        if (!chunk) continue;
        if (!allowTests && isTestFile(chunk.filePath)) continue;
        const base = this.chunkToSearchResult(chunk, 2 - index * 0.05 + bonus);
        const scored = this.scoreBroadWorkflowCandidate(base, profile);
        let score = Math.max(base.score, scored.score + 0.45) + bonus;
        if (lowerQuery.includes("end-to-end") || lowerQuery.includes("complete workflow")) {
          score += 0.18;
        }
        if (bundle.kind === "lifecycle" && /\b(storage|daemon|server|pipeline|scheduler)\b/.test(lowerQuery)) {
          score += 0.24;
        }
        if (this.isImplementationPath(chunk.filePath)) {
          score += 0.08;
        }
        const enriched: SearchResult = {
          ...base,
          score,
          hookScore: score,
        };
        const existing = selected.get(enriched.id);
        if (!existing || enriched.score > existing.score) {
          selected.set(enriched.id, enriched);
        }
      }
    }

    return Array.from(selected.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 16);
  }

  private buildBroadConceptFileCandidates(
    query: string,
    profile: BroadQueryProfile,
    allowTests: boolean
  ): BroadFileCandidate[] {
    if (profile.inventoryMode) return [];

    const bundles = this.getMatchedConceptBundles(query);
    if (bundles.length === 0) return [];

    const byPath = new Map<string, BroadFileCandidate>();
    for (const bundle of bundles) {
      const chunks = this.selectConceptChunks(
        bundle.symbols,
        Math.min(bundle.symbols.length, Math.max(bundle.maxChunks ?? 4, 6))
      );
      const hitsByPath = new Map<string, number>();
      for (const chunk of chunks) {
        if (!allowTests && isTestFile(chunk.filePath)) continue;
        hitsByPath.set(chunk.filePath, (hitsByPath.get(chunk.filePath) ?? 0) + 1);
      }

      for (const [filePath, count] of hitsByPath) {
        const candidate = this.buildBroadFileCandidateFromFilePath(filePath, profile);
        if (!candidate || candidate.callbackNoise) continue;
        const boosted: BroadFileCandidate = {
          ...candidate,
          score:
            candidate.score
            + (bundle.kind === "lifecycle" ? 1.25 : 0.7)
            + Math.min(0.45, (count - 1) * 0.18),
        };
        const existing = byPath.get(filePath);
        if (!existing || boosted.score > existing.score) {
          byPath.set(filePath, boosted);
        }
      }
    }

    return Array.from(byPath.values()).sort((a, b) => b.score - a.score);
  }

  private buildBroadTargetAliasList(profile: BroadQueryProfile): string[] {
    const aliases = new Set<string>();
    const tokens = profile.tokens.filter((term) => term.length >= 3 && !STOP_WORDS.has(term));

    for (const token of tokens) aliases.add(normalizeTargetText(token));
    for (let i = 0; i < tokens.length; i++) {
      const bi = normalizeTargetText(tokens.slice(i, i + 2).join(" "));
      if (bi.split(" ").length === 2) aliases.add(bi);
      const tri = normalizeTargetText(tokens.slice(i, i + 3).join(" "));
      if (tri.split(" ").length === 3) aliases.add(tri);
    }

    const aliasTerms = profile.inventoryMode
      ? profile.anchorTerms
      : [...profile.anchorTerms, ...profile.familyTerms];
    for (const term of aliasTerms) {
      if (term.source === "semantic" && term.generic) continue;
      if (term.weight < 0.68) continue;
      aliases.add(normalizeTargetText(term.term));
    }

    return Array.from(aliases).filter(Boolean);
  }

  private scoreBroadTargetHit(
    hit: ResolvedTargetAliasHit,
    profile: BroadQueryProfile,
    allowTests: boolean
  ): BroadTargetCandidate | null {
    const target = hit.target;
    if (!allowTests && isTestFile(target.filePath)) return null;
    if (!target.ownerChunkId) return null;

    const chunk = this.metadata.getChunksByIds([target.ownerChunkId])[0];
    if (!chunk) return null;

    const text = normalizeTargetText(`${target.canonicalName} ${target.filePath} ${chunk.name}`);
    const lowerPath = target.filePath.toLowerCase();
    const lowerName = chunk.name.toLowerCase();
    const layers = this.detectWorkflowLayers(lowerPath, lowerName);
    const directTerms = profile.anchorTerms.filter((term) => textMatchesQueryTerm(text, term.term));
    const semanticTerms = profile.familyTerms.filter((term) => textMatchesQueryTerm(text, term.term));
    const phraseMatches = profile.phrases.filter((phrase) => text.includes(phrase));
    const familyMatches = new Set(
      [...directTerms, ...semanticTerms]
        .map((term) => term.family)
        .filter((family): family is string => !!family)
    );

    const coreDirectTerms = directTerms.filter((term) => !term.generic);
    const hasDirectAnchor = directTerms.length > 0 || phraseMatches.length > 0;
    const utilityLike = this.isUtilityLikePath(lowerPath, lowerName);
    const callbackNoise = this.isCallbackNoiseTarget(lowerPath, lowerName, profile);
    if (profile.inventoryMode && target.kind === "symbol" && coreDirectTerms.length === 0) return null;
    if (!hasDirectAnchor) {
      if (familyMatches.size === 0) return null;
      if (hit.source === "derived") return null;
      if (utilityLike || callbackNoise) return null;
      if (layers.every((layer) => layer === "shared" || layer === "core")) return null;
    }

    let score = hit.weight + target.confidence * 0.2;
    score += directTerms.reduce((sum, term) => sum + term.weight, 0) * 0.62;
    score += semanticTerms.reduce((sum, term) => sum + term.weight, 0) * 0.12;
    score += familyMatches.size * 0.12;
    score += phraseMatches.length * 0.5;

    if (target.kind === "file_module") score += 0.55;
    else if (target.kind === "endpoint") score += 0.65;
    else if (target.kind === "symbol") score += profile.inventoryMode ? -0.18 : /(class|function|method)/.test(chunk.kind) ? 0.18 : 0;
    else if (target.kind === "subsystem") score -= 0.12;

    if (hit.source === "slug" || hit.source === "file_path" || hit.source === "parent_dir") score += 0.18;
    if (hit.source === "derived") score -= 0.2;
    if (this.isImplementationPath(target.filePath)) score += 0.1;
    if (utilityLike) score -= hasDirectAnchor ? 0.08 : 0.35;
    if (callbackNoise) score -= 0.65;
    if (/constructor|describe|it|test/.test(chunk.name.toLowerCase())) score -= 0.4;
    if (directTerms.length >= 2) score += 0.28;
    if (familyMatches.size >= 2) score += 0.18;
    if (directTerms.length === 0 && semanticTerms.length <= 1 && familyMatches.size <= 1) score -= 0.32;

    return {
      result: this.chunkToSearchResult(chunk, score),
      score,
      subsystem: target.subsystem,
    };
  }

  private scoreBroadWorkflowCandidate(
    result: SearchResult,
    profile: BroadQueryProfile
  ): BroadWorkflowCandidate {
    let score = result.hookScore ?? result.score;
    const lowerPath = result.filePath.toLowerCase();
    const lowerName = result.name.toLowerCase();
    const text = `${lowerPath} ${lowerName}`;
    const matchedTerms = profile.expandedTerms.filter((term) => textMatchesQueryTerm(text, term.term));
    const directMatches = profile.anchorTerms.filter((term) => textMatchesQueryTerm(text, term.term));
    const coreDirectMatches = directMatches.filter((term) => !term.generic);
    const phraseMatches = profile.phrases.filter((phrase) => text.includes(phrase));
    const matchedFamilies = Array.from(new Set(matchedTerms.map((term) => term.family).filter(Boolean))) as string[];
    const matchedWeight = matchedTerms.reduce((sum, term) => sum + term.weight, 0);
    const genericOnly = matchedTerms.length > 0 && matchedTerms.every((term) => term.generic);
    const layers = this.detectWorkflowLayers(lowerPath, lowerName);
    const utilityLike = this.isUtilityLikePath(lowerPath, lowerName);
    const callbackNoise = this.isCallbackNoiseTarget(lowerPath, lowerName, profile);

    if (matchedFamilies.length > 0) {
      score *= 1 + Math.min(0.45, matchedFamilies.length * 0.14);
    }
    if (matchedWeight > 1) {
      score *= 1 + Math.min(0.35, matchedWeight * 0.12);
    }
    if (directMatches.length > 0) {
      score *= 1 + Math.min(0.5, directMatches.length * 0.18);
    } else if (phraseMatches.length > 0) {
      score *= 1 + Math.min(0.4, phraseMatches.length * 0.18);
    } else if (matchedFamilies.length > 0) {
      score *= 0.72;
    } else {
      score *= 0.48;
    }
    if (profile.anchorTerms.length >= 3 && directMatches.length <= 1 && phraseMatches.length === 0) {
      score *= matchedFamilies.length > 0 ? 0.78 : 0.52;
    }
    if (profile.inventoryMode) {
      if (coreDirectMatches.length > 0) {
        score *= 1 + Math.min(0.4, coreDirectMatches.length * 0.16);
      } else if (matchedFamilies.length === 0) {
        score *= 0.4;
      } else {
        score *= 0.78;
      }
      if (result.filePath.startsWith("src/search/") || result.filePath.startsWith("src/indexer/")) {
        score *= 1.08;
      }
    }
    if (layers.some((layer) => layer === "ui" || layer === "state" || layer === "routing" || layer === "backend")) {
      score *= 1.08;
    }
    if (genericOnly) {
      score *= 0.62;
    }
    if (utilityLike && matchedFamilies.length === 0) {
      score *= 0.58;
    }
    if (callbackNoise) {
      score *= 0.32;
    }

    return {
      result,
      score,
      layers,
      matchedFamilies,
      matchedWeight,
      genericOnly,
      utilityLike,
      directAnchorCount: directMatches.length,
      coreAnchorCount: coreDirectMatches.length,
      phraseMatchCount: phraseMatches.length,
      callbackNoise,
    };
  }

  private buildBroadQueryProfile(
    query: string,
    expandedTerms: ExpandedQueryTerm[] = expandQueryTerms(query)
  ): BroadQueryProfile {
    const inventoryMode = BROAD_INVENTORY_RE.test(query);
    const lifecycleMode = /\b(shutdown|startup|drain|close|teardown|boot|bootstrap)\b/i.test(query);
    const shouldKeepTerm = (term: string): boolean =>
      !inventoryMode || !INVENTORY_STRUCTURAL_TERMS.has(normalizeTargetText(term));
    const filteredExpandedTerms = expandedTerms.filter((term) => shouldKeepTerm(term.term));
    const tokens = tokenizeQueryTerms(query)
      .filter((term) => term.length >= 2 && !STOP_WORDS.has(term))
      .filter((term) => shouldKeepTerm(term));
    const anchorTerms = filteredExpandedTerms.filter((term) => {
      if (term.source !== "original" && term.source !== "morphological") return false;
      if (!term.generic) return true;
      return term.term.length <= 4 || /^(mcp|auth|hook|http)$/.test(term.term);
    });
    let allowedFamilies = new Set(
      anchorTerms
        .map((term) => term.family)
        .filter((family): family is string => Boolean(family))
    );
    if (allowedFamilies.size === 0) {
      const inferredFamilyScores = new Map<string, number>();
      for (const term of filteredExpandedTerms) {
        if (!term.family) continue;
        if (term.source === "corpus") continue;
        if (term.weight < 0.72) continue;
        inferredFamilyScores.set(term.family, (inferredFamilyScores.get(term.family) ?? 0) + term.weight);
      }
      const topFamily = Array.from(inferredFamilyScores.entries())
        .sort((a, b) => b[1] - a[1])[0]?.[0];
      if (topFamily) {
        allowedFamilies = new Set([topFamily]);
      }
    }
    const familyTerms = filteredExpandedTerms.filter((term) => {
      if (term.source === "original" || term.source === "morphological") return false;
      if (term.generic) return false;
      if (term.weight < 0.68) return false;
      if (allowedFamilies.size > 0) {
        if (!term.family) return false;
        if (!allowedFamilies.has(term.family)) return false;
      }
      return true;
    });
    const phrases = this.buildBroadPhrases(tokens);

    return {
      expandedTerms: filteredExpandedTerms,
      anchorTerms,
      familyTerms,
      allowedFamilies,
      phrases,
      tokens,
      inventoryMode,
      lifecycleMode,
    };
  }

  private buildBroadPhrases(tokens: string[]): string[] {
    const phrases = new Set<string>();
    for (let i = 0; i < tokens.length; i++) {
      const pair = tokens.slice(i, i + 2);
      if (pair.length === 2 && pair.some((token) => !BROAD_PHRASE_GENERIC_TERMS.has(token))) {
        phrases.add(normalizeTargetText(pair.join(" ")));
      }
      const triple = tokens.slice(i, i + 3);
      if (triple.length === 3 && triple.some((token) => !BROAD_PHRASE_GENERIC_TERMS.has(token))) {
        phrases.add(normalizeTargetText(triple.join(" ")));
      }
    }
    return Array.from(phrases);
  }

  private isCallbackNoiseTarget(
    lowerPath: string,
    lowerName: string,
    profile: BroadQueryProfile
  ): boolean {
    const text = `${lowerPath} ${lowerName}`;
    const mentionsCallback = profile.tokens.includes("callback");
    const mentionsNavigation = profile.tokens.includes("navigation") || profile.tokens.includes("route") || profile.tokens.includes("routing");
    const mentionsPerformance = profile.tokens.includes("performance");
    if (!mentionsCallback && /usecallback/.test(text)) return true;
    if (!mentionsPerformance && /\/performance\//.test(lowerPath)) return true;
    if (!mentionsNavigation && /\bnavigation\b/.test(text)) return true;
    return false;
  }

  private detectWorkflowLayers(lowerPath: string, lowerName: string): string[] {
    const layers: string[] = [];
    const text = `${lowerPath} ${lowerName}`;

    if (/(?:^|\/)(src\/)?(pages|components|screens|views|app)\//.test(lowerPath) || /\b(page|modal|dialog|screen|view|layout)\b/.test(text)) {
      layers.push("ui");
    }
    if (/(?:^|\/)(hooks|store|state|session|context|providers?)\//.test(lowerPath) || /\b(use[a-z]|provider|session|state|context)\b/.test(lowerName)) {
      layers.push("state");
    }
    if (/\b(route|router|routing|redirect|callback|guard|protected|middleware)\b/.test(text)) {
      layers.push("routing");
    }
    if (/(?:^|\/)(api|server|controllers?|handlers?|functions?|supabase|backend)\//.test(lowerPath) || /\b(api|server|handler|request|controller|service)\b/.test(text)) {
      layers.push("backend");
    }
    if (/(?:^|\/)(lib|shared|core|utils?)\//.test(lowerPath) || /\b(error|util|helper|type)\b/.test(text)) {
      layers.push("shared");
    }
    if (layers.length === 0) layers.push("core");
    return layers;
  }

  private isUtilityLikePath(lowerPath: string, lowerName: string): boolean {
    return /(?:^|\/)(lib|shared|core|utils?|helpers?|types?)\//.test(lowerPath)
      || /\b(utils?|helpers?|types?|errors?)\b/.test(lowerName);
  }

  private isObservabilitySidecarPath(lowerPath: string, lowerName: string): boolean {
    const text = `${lowerPath} ${lowerName}`;
    return /\b(metrics?|logger|logging|telemetry|audit|trace|rotating\s*log)\b/.test(text)
      || /(?:^|\/)(metrics|logger|logging|telemetry)\.ts$/.test(lowerPath)
      || /rotating-log/.test(lowerPath);
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
      chunkLineRanges: new Map(
        scoringInfo.map((c) => [c.id, { startLine: c.startLine, endLine: c.endLine }])
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
    const intent = classifyIntent(query);
    const expandedTerms = expandQueryTerms(query);

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
      broadQuery: intent.prefersBroadContext === true,
      chunkLineRanges: maps.chunkLineRanges,
    });
  }

  private expandGraph(
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
      let queryVector = this.queryEmbedCache.get(query);
      if (queryVector) {
        // LRU: refresh insertion order on hit
        this.queryEmbedCache.delete(query);
        this.queryEmbedCache.set(query, queryVector);
      } else {
        const embedResults = await this.embedder.embed([query]);
        queryVector = embedResults[0];
        if (!queryVector) return [];

        if (this.queryEmbedCache.size >= HybridSearch.EMBED_CACHE_MAX) {
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
