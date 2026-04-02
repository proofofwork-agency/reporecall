import { type MemoryConfig, resolveContextBudget } from "../core/config.js";
import type { EmbeddingProvider, EmbeddingVector } from "../indexer/types.js";
import type { VectorStore } from "../storage/vector-store.js";
import type { FTSStore } from "../storage/fts-store.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import { reciprocalRankFusion } from "./ranker.js";
import {
  detectExecutionSurfaces,
  collectCorpusFamilyTerms,
  expandQueryTerms,
  GENERIC_BROAD_TERMS,
  GENERIC_QUERY_ACTION_TERMS,
  getQueryTermVariants,
  type ExpandedQueryTerm,
  inferQueryExecutionSurfaceBias,
  isTestFile,
  type ExecutionSurfaceBias,
  scoreExecutionSurfaceAlignment,
  STOP_WORDS,
  textMatchesQueryTerm,
  tokenizeQueryTerms,
} from "./utils.js";
import {
  assembleConceptContext,
  assembleContext,
  countTokens,
  type ConceptContextKind,
} from "./context-assembler.js";
import { getLogger } from "../core/logger.js";
import { LocalReranker } from "./reranker.js";
import type { SearchResult, SearchOptions, AssembledContext } from "./types.js";
import type { ReadWriteLock } from "../core/rwlock.js";
import { resolveSeeds } from "./seed.js";
import type { SeedResult } from "./seed.js";
import type { ChunkFeature, ResolvedTargetAliasHit, StoredChunk, TargetKind } from "../storage/types.js";
import { classifyIntent } from "./intent.js";
import { normalizeTargetText, resolveTargetsForQuery } from "./targets.js";

const IMPL_BOOST = 1.25;

const DOC_PENALTY = 0.45;
const DOC_PENALTY_NO_IMPL = 0.8;
const TERM_MATCH_BOOST = 1.15;
const CONCEPT_BOOST = 0.9;
const BROAD_PHRASE_GENERIC_TERMS = GENERIC_BROAD_TERMS;
const INVENTORY_GENERIC_TARGET_ALIAS_TERMS = new Set(["route", "routes", "router", "routing", "navigation"]);
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
const STRICT_WORKFLOW_FAMILY_COHESION = new Set([
  "auth",
  "routing",
  "billing",
  "storage",
  "generation",
]);
const ADJACENT_WORKFLOW_FAMILIES: Record<string, string[]> = {
  auth: ["routing", "permissions"],
  routing: ["auth", "permissions"],
  billing: ["auth"],
  storage: ["auth"],
  generation: ["storage"],
};
const BUG_GATE_RE =
  /(?:\b(?:validate|valid|check|assert|verify|guard|compat|schema|allow|deny|reject|permission|connect|connection)\b|\b(?:validate|valid|check|assert|verify|guard|compat|schema|allow|deny|reject|permission|connect|connection|is|has|can|should)[A-Z_][a-zA-Z0-9_]*\b|\b(?:is|has|can|should)\s+(?:valid|allowed|enabled|disabled|ready|connected|authenticated|authorized|compatible|protected)\b)/i;
const BUG_STRUCTURAL_NOISE_RE = /(?:^|\/)(docs?|documentation)\//i;
const BUG_UI_NOISE_RE = /(registry|styles?|theme|tokens?|catalog|readme|guide|examples?)/i;
const BUG_UI_LEAF_TERMS = new Set(["menu", "modal", "dialog", "popover", "tooltip", "button", "picker", "item", "card", "panel", "tile", "row", "list"]);
const BUG_GENERIC_TERMS = new Set(["possible", "supposed", "wrong", "incorrect", "unexpected", "broken", "fails", "failing", "failure", "issue", "problem", "bug", "possible"]);
const BUG_GENERIC_SEED_ALIAS_TERMS = new Set([
  "auth",
  "navigation",
  "callback",
  "provider",
  "session",
  "state",
  "page",
  "route",
  "pending",
  "destination",
]);
const BUG_STRUCTURAL_ROLE_ALIAS_TERMS = new Set([
  "controller",
  "service",
  "handler",
  "provider",
  "manager",
  "state",
  "page",
]);
const BUG_STRUCTURAL_HINT_TERMS = new Set([
  "control",
  "controls",
  "controlled",
  "controlling",
  "controll",
  "controller",
  "controllers",
  "service",
  "services",
  "handler",
  "handlers",
  "provider",
  "providers",
  "manager",
  "managers",
  "middleware",
  "adapter",
  "adapters",
  "boundary",
  "boundaries",
  "orchestrator",
  "orchestrators",
  "implementation",
  "implement",
  "implements",
  "implementing",
]);
const BUG_NOISE_TERMS = new Set([
  "some", "they", "them", "their", "there", "thing", "things", "something", "anything",
  "seeing", "around", "sometimes", "feels", "somewhere", "first", "inspect", "trying",
  "getting", "users", "user", "during", "land", "lands", "bounced", "get", "go", "dont", "like",
  "another", "one", "people", "instead", "likely", "page", "pages",
  "exactly", "matter", "matters", "care", "understand", "want", "lets", "code", "runs", "run",
  "control", "controlling", "relevant", "relevance", "successfully", "suspect", "suspects", "seems", "seem",
  "wanted", "place", "places", "opens", "opened", "flaky",
]);
const BUG_LOW_SPECIFICITY_TERMS = new Set([
  "node", "nodes", "item", "items", "data", "file", "files", "flow", "system", "app", "apps",
  "sign", "signing", "state", "controller", "controllers", "service", "services", "handler", "handlers",
  "provider", "providers", "manager", "managers",
]);
const BUG_MECHANISM_ONLY_TERMS = new Set([
  "call",
  "calls",
  "caller",
  "calling",
  "check",
  "checks",
  "runtime",
  "stored",
  "store",
  "consumed",
  "consume",
  "consuming",
  "enforce",
  "enforces",
]);
const BUG_AUTH_ROUTING_OFFDOMAIN_RE =
  /\b(billing|payment|checkout|invoice|credit|webhook|stripe|storage|upload|media|generation)\b/i;
const BUG_CONNECTION_OFFDOMAIN_RE =
  /\b(auth|login|signin|session|token|oauth|billing|payment|credit|webhook|api|server|upload|storage|media|provider)\b/i;
const TRACE_NOISE_TERMS = new Set(["path", "page", "pages", "include", "includes", "including", "start", "first", "then", "full", "intent"]);
const MODE_EXPLICIT_LOGGING_RE = /\b(log|logger|logging|audit|instrument|instrumentation|telemetry|metrics?)\b/i;
const MODE_EXPLICIT_WEBHOOK_RE = /\b(webhook|signature|payload|delivery|event)\b/i;
const BUG_SUBJECT_TAG_RULES: Array<{ tag: string; pattern: RegExp; relatedTags?: string[] }> = [
  { tag: "connection", pattern: /\b(edge|connect|connection|link|compat|compatible)\b/i, relatedTags: ["schema"] },
  { tag: "schema", pattern: /\b(schema|compat|compatible|type|types)\b/i, relatedTags: ["connection"] },
  { tag: "auth", pattern: /\b(auth|login|signin|signout|signing|authenticate|authenticated|authorization|authorize|authorized|session|token|oauth|credential)\b/i, relatedTags: ["routing", "permissions"] },
  { tag: "routing", pattern: /\b(route|router|navigation|redirect|callback|protected|pending|destination|handoff|return)\b/i, relatedTags: ["auth", "permissions"] },
  { tag: "billing", pattern: /\b(billing|checkout|subscription|invoice|payment|credit|portal)\b/i },
  { tag: "storage", pattern: /\b(storage|upload|bucket|blob|media)\b/i },
  { tag: "generation", pattern: /\b(generate|generation|image|render|regen|thumbnail|preview)\b/i },
];

interface QueryDecomposition {
  literalTerms: string[];
  normalizedVariants: string[];
  semanticVariants: string[];
  implementationTerms: string[];
  runtimeTerms: string[];
  architecturalTerms: string[];
  controlFlowTerms: string[];
  dataFlowTerms: string[];
  implementationHypotheses: string[];
  excludedTerms: string[];
}

interface BugSubjectProfile {
  subjectTerms: string[];
  focusTerms: string[];
  primaryTags: Set<string>;
  relatedTags: Set<string>;
  decomposition: QueryDecomposition;
  negativeTerms: string[];
  surfaceBias: ExecutionSurfaceBias;
}

interface BugContradictionDiagnostic {
  filePath: string;
  symbol: string;
  reasons: string[];
}

interface BugCandidateDiagnostic {
  filePath: string;
  symbol: string;
  confidence: number;
  evidence: string[];
}

interface BugScoredCandidate {
  result: SearchResult;
  score: number;
  keywordHit: boolean;
  semanticHit: boolean;
  callerHit: boolean;
  seedHit: boolean;
  strongDomainMatch: boolean;
  callsPredicateCount: number;
  contradictions: string[];
  feature: ChunkFeature | undefined;
  signals: ReturnType<HybridSearch["getBugCandidateSignals"]>;
}

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
  workflowTraceMode: boolean;
  surfaceBias: ExecutionSurfaceBias;
}

type BroadMode = "inventory" | "workflow";

interface BroadSelectedFileDiagnostic {
  filePath: string;
  selectionSource: string;
}

export interface BroadSelectionDiagnostics {
  broadMode: BroadMode;
  dominantFamily?: string;
  deliveryMode: "code_context" | "summary_only";
  familyConfidence?: number;
  selectedFiles: BroadSelectedFileDiagnostic[];
  fallbackReason?: string;
  deferredReason?: string;
}

export interface BugSelectionDiagnostics {
  queryDecomposition: QueryDecomposition;
  searchStepsUsed: string[];
  subjectTerms: string[];
  primaryTags: string[];
  inputResults: Array<{ name: string; filePath: string; score: number }>;
  semanticSeedResults: Array<{ name: string; filePath: string; score: number }>;
  keywordResults: Array<{ name: string; filePath: string; score: number }>;
  callerResults: Array<{ name: string; filePath: string; score: number }>;
  neighborResults: Array<{ name: string; filePath: string; score: number }>;
  scored: Array<{
    name: string;
    filePath: string;
    score: number;
    keywordHit: boolean;
    semanticHit: boolean;
    callerHit: boolean;
    strongDomainMatch: boolean;
    callsPredicateCount: number;
  }>;
  topCandidates: BugCandidateDiagnostic[];
  contradictions: BugContradictionDiagnostic[];
  nextPivots: string[];
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
  private queryEmbedCache = new Map<string, EmbeddingVector>();
  private static readonly EMBED_CACHE_MAX = 50;
  private lastBroadSelection: BroadSelectionDiagnostics | null = null;
  private lastBugSelection: BugSelectionDiagnostics | null = null;

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

  getLastBugSelectionDiagnostics(): BugSelectionDiagnostics | null {
    return this.lastBugSelection;
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
    const queryMode = intent.queryMode;
    const isBroadWorkflow = queryMode === "architecture" || queryMode === "change";
    const isInventoryBroad = queryMode === "architecture" && BROAD_INVENTORY_RE.test(query);
    this.lastBroadSelection = null;
    this.lastBugSelection = null;
    const rawSeeds = seedResult ?? resolveSeeds(query, this.metadata, this.fts);
    const seeds = this.filterSeedsForMode(query, rawSeeds, queryMode);
    const conceptContext = isInventoryBroad ? null : this.buildConceptContext(query, budget, seeds);
    if (conceptContext) return conceptContext;

    const maxContextChunks = this.config.maxContextChunks > 0
      ? this.config.maxContextChunks
      : Math.min(100, Math.max(10, Math.floor(budget / 200)));  // ~200 tokens per avg chunk, capped at 100
    const focusedExactResults = queryMode === "lookup"
      ? this.buildFocusedExactResults(query, seeds, maxContextChunks)
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
    const hookLimit = Math.max(maxContextChunks * 2, 20);
    const bugRetrievalQueries = queryMode === "bug"
      ? this.buildBugRetrievalQueries(query)
      : [];
    const retrievalQuery =
      queryMode === "bug"
        ? bugRetrievalQueries[0] ?? this.buildBugRetrievalQuery(query)
        : queryMode === "trace"
          ? this.buildTraceRetrievalQuery(query)
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
    const exactAware = queryMode === "bug"
      ? this.prependBugSeedResults(query, results, seeds)
      : this.prependExplicitTargetResults(query, results, seeds);
    const traceAware = queryMode === "trace" && this.isInfrastructureTracePrompt(query)
      ? this.prependTraceTargetResults(query, exactAware)
      : exactAware;
    const seedAware = queryMode === "bug"
      ? traceAware
      : this.prependBroadSeedResults(query, traceAware, seeds, isBroadWorkflow);
    const prioritized = this.prioritizeForHookContext(query, seedAware, isBroadWorkflow);
    const bugBundle = queryMode === "bug"
      ? this.selectBugLocalizationBundle(query, prioritized, maxContextChunks, seeds)
      : prioritized;
    const selectedBundle = isBroadWorkflow
      ? this.selectBroadWorkflowBundle(query, prioritized, seeds, maxContextChunks)
      : bugBundle;
    const broadDiagnostics = this.lastBroadSelection as BroadSelectionDiagnostics | null;
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
      return this.buildSummaryOnlyBroadContext(query, budget, broadDiagnostics);
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
      const broadSelection = this.lastBroadSelection as BroadSelectionDiagnostics | null;
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

  prepareSeedResult(
    query: string,
    queryMode: "lookup" | "trace" | "bug" | "architecture" | "change" | "skip",
    seedResult?: SeedResult
  ): SeedResult {
    const rawSeeds = seedResult ?? resolveSeeds(query, this.metadata, this.fts);
    return this.filterSeedsForMode(query, rawSeeds, queryMode);
  }

  private buildSummaryOnlyBroadContext(
    query: string,
    tokenBudget: number,
    diagnostics: BroadSelectionDiagnostics
  ): AssembledContext {
    const candidateLines = diagnostics.selectedFiles
      .slice(0, 3)
      .map((item) => `- ${item.filePath}`);
    const familyLine = diagnostics.dominantFamily
      ? `Dominant family: \`${diagnostics.dominantFamily}\``
      : "Dominant family: uncertain";
    const confidenceLine = typeof diagnostics.familyConfidence === "number"
      ? `Family confidence: ${Math.round(diagnostics.familyConfidence * 100)}%`
      : "Family confidence: low";
    const reasonLine = diagnostics.deferredReason
      ? `Reason: ${diagnostics.deferredReason.replace(/_/g, " ")}`
      : "Reason: low broad retrieval confidence";
    const text = [
      "## Relevant codebase context",
      "",
      "> Reporecall deferred broad code injection because the candidate bundle is low confidence.",
      "> Expand with Reporecall MCP tools first (`search_code`, `explain_flow`, `find_callers`, `get_symbol`) before grep.",
      "",
      `- Query: ${query}`,
      `- Broad mode: ${diagnostics.broadMode}`,
      `- ${familyLine}`,
      `- ${confidenceLine}`,
      `- ${reasonLine}`,
      ...(candidateLines.length > 0 ? ["- Top candidates:", ...candidateLines] : []),
      "",
    ].join("\n");

    const trimmedText = countTokens(text) > tokenBudget
      ? text.split("\n").slice(0, Math.max(6, Math.floor(tokenBudget / 20))).join("\n")
      : text;

    return {
      text: trimmedText,
      tokenCount: Math.min(countTokens(trimmedText), tokenBudget),
      chunks: [],
      routeStyle: "deep",
      deliveryMode: "summary_only",
    };
  }

  private buildFocusedExactResults(
    query: string,
    seedResult: SeedResult,
    maxContextChunks: number
  ): SearchResult[] | null {
    const exactSeeds = seedResult.seeds
      .filter((seed) => (seed.reason === "explicit_target" || seed.reason === "resolved_target") && !isTestFile(seed.filePath))
      .slice(0, 6);
    if (exactSeeds.length === 0) return null;

    const primarySeed = seedResult.bestSeed
      && (seedResult.bestSeed.reason === "explicit_target" || seedResult.bestSeed.reason === "resolved_target")
      && !isTestFile(seedResult.bestSeed.filePath)
        ? seedResult.bestSeed
        : exactSeeds[0];
    if (!primarySeed) return null;

    const seenChunkIds = new Set<string>();
    const selected: SearchResult[] = [];

    for (const seed of [primarySeed, ...exactSeeds.filter((candidate) =>
      candidate.chunkId !== primarySeed.chunkId && candidate.filePath === primarySeed.filePath
    )]) {
      if (selected.length >= Math.min(maxContextChunks, 3)) break;
      if (seenChunkIds.has(seed.chunkId)) continue;
      const chunk = this.metadata.getChunksByIds([seed.chunkId])[0];
      if (!chunk) continue;
      seenChunkIds.add(seed.chunkId);
      selected.push(this.chunkToSearchResult(chunk, 3 - selected.length * 0.05 + seed.confidence));
    }

    if (selected.length > 0) return selected;

    const directTargetHits = resolveTargetsForQuery(query, this.metadata)
      .filter((hit) => (hit.target.kind === "endpoint" || hit.target.kind === "file_module"))
      .filter((hit) => !isTestFile(hit.target.filePath))
      .slice(0, 4);
    if (directTargetHits.length === 0) return null;

    for (const hit of directTargetHits) {
      if (selected.length >= Math.min(maxContextChunks, 2)) break;
      const ownerChunkId = hit.target.ownerChunkId
        ?? this.metadata.findChunksByFilePath(hit.target.filePath)[0]?.id;
      if (!ownerChunkId || seenChunkIds.has(ownerChunkId)) continue;
      const chunk = this.metadata.getChunksByIds([ownerChunkId])[0];
      if (!chunk || isTestFile(chunk.filePath)) continue;
      seenChunkIds.add(chunk.id);
      selected.push(this.chunkToSearchResult(chunk, 3 - selected.length * 0.05 + hit.confidence));
    }

    return selected.length > 0 ? selected : null;
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
      .filter((seed) => !this.shouldSuppressBroadResolvedTarget(query, seed))
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

  private prependBugSeedResults(
    query: string,
    results: SearchResult[],
    seedResult?: SeedResult
  ): SearchResult[] {
    const seeds = seedResult ?? resolveSeeds(query, this.metadata, this.fts);
    const focusTerms = this.extractBugSalientTerms(query);
    const explicitSeeds = seeds.seeds
      .filter((seed) => seed.reason === "explicit_target" || seed.reason === "resolved_target")
      .filter((seed) => {
        const seedText = `${seed.filePath} ${seed.name} ${seed.resolvedAlias ?? ""}`;
        const matches = focusTerms.filter((term) => textMatchesQueryTerm(seedText, term)).length;
        return matches > 0;
      })
      .slice(0, 4);

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
      if (!chunk || isTestFile(chunk.filePath)) continue;

      const existing = byId.get(seed.chunkId);
      const boostedScore = topScore + 2 + seed.confidence - i * 0.001;
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
      .filter((seed) => seed.kind !== "interface_declaration" && seed.kind !== "type_alias_declaration")
      .filter((seed) => !this.shouldSuppressBroadResolvedTarget(query, seed));
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
    if (implPaths.some((prefix) => lowerPath.startsWith(prefix.toLowerCase()))) return true;
    return /(?:^|\/)(src|lib|bin|app|server|api|functions|handlers|controllers|services|supabase)\//.test(lowerPath);
  }

  private buildBugSubjectProfile(queryTerms: string[], rawQuery = ""): BugSubjectProfile {
    const rawSignalTerms = this.collectBugRawSignalTerms(rawQuery);
    const allTerms = Array.from(new Set([...queryTerms, ...rawSignalTerms]));
    const normalizedSourceTerms = Array.from(new Set(
      allTerms
        .flatMap((term) => normalizeTargetText(term).split(" ").filter(Boolean))
        .filter((term) =>
          term.length >= 2
          && !STOP_WORDS.has(term)
          && !BUG_NOISE_TERMS.has(term)
          && !BUG_LOW_SPECIFICITY_TERMS.has(term)
          && !this.isBugStructuralHintTerm(term)
          && this.isUsefulBugSignalTerm(term)
        )
    ));
    const literalTerms = Array.from(new Set(
      normalizedSourceTerms
        .filter((term) => term.length >= 3)
    ));
    const subjectTerms = Array.from(new Set(
      normalizedSourceTerms
        .flatMap((term) => this.getBugQueryVariants(term))
        .filter((term) =>
          term.length >= 3
          && !STOP_WORDS.has(term)
          && !BUG_NOISE_TERMS.has(term)
          && !BUG_LOW_SPECIFICITY_TERMS.has(term)
        )
    ));
    const primaryTags = new Set<string>();
    const relatedTags = new Set<string>();

    for (const rule of BUG_SUBJECT_TAG_RULES) {
      if (!subjectTerms.some((term) => rule.pattern.test(term)) && !rule.pattern.test(rawQuery)) continue;
      primaryTags.add(rule.tag);
      for (const related of rule.relatedTags ?? []) relatedTags.add(related);
    }

    const negativeTerms = this.extractNegatedPromptTerms(rawQuery);
    const decomposition = this.buildBugQueryDecomposition(
      literalTerms,
      subjectTerms,
      primaryTags,
      relatedTags,
      negativeTerms
    );
    const focusTerms = decomposition.normalizedVariants.filter((term) =>
      !BUG_LOW_SPECIFICITY_TERMS.has(term) && !negativeTerms.includes(term)
    );

    return {
      subjectTerms,
      focusTerms: focusTerms.length > 0 ? focusTerms : decomposition.normalizedVariants,
      primaryTags,
      relatedTags,
      decomposition,
      negativeTerms,
      surfaceBias: inferQueryExecutionSurfaceBias(rawQuery, "bug"),
    };
  }

  private getBugQueryVariants(term: string): string[] {
    const normalized = normalizeTargetText(term).trim();
    if (!normalized) return [];

    return Array.from(new Set(
      getQueryTermVariants(normalized).filter((variant) => {
        if (!variant) return false;
        if (variant === normalized) return true;
        if (variant.length < 5 && !BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(variant)) && !BUG_GATE_RE.test(variant)) {
          return false;
        }
        if (normalized.length >= 6 && variant.length === 4 && normalized.startsWith(variant)) return false;
        if (
          normalized.endsWith("ing")
          && variant === `${normalized.slice(0, -3)}er`
          && !BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(variant))
          && !BUG_GATE_RE.test(variant)
        ) {
          return false;
        }
        if (
          this.isBugStructuralHintTerm(variant)
          && !BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(variant))
          && !BUG_GATE_RE.test(variant)
        ) {
          return false;
        }
        return true;
      })
    ));
  }

  private isBugStructuralHintTerm(term: string): boolean {
    const normalized = normalizeTargetText(term).trim();
    if (!normalized) return false;
    return BUG_STRUCTURAL_HINT_TERMS.has(normalized)
      || /^controll/.test(normalized)
      || /^implement/.test(normalized);
  }

  private isUsefulBugSignalTerm(term: string): boolean {
    if (!term) return false;
    if (BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(term)) || BUG_GATE_RE.test(term)) return true;
    if (this.isBugStructuralHintTerm(term)) return false;
    if (term.length <= 4) return false;
    return true;
  }

  private collectBugRawSignalTerms(rawQuery: string): string[] {
    if (!rawQuery) return [];

    const negativeTerms = new Set(this.extractNegatedPromptTerms(rawQuery));
    const rawTokens = tokenizeQueryTerms(rawQuery);
    const pathLikeTerms = rawTokens
      .filter((term) => /[-_/]/.test(term))
      .flatMap((term) => normalizeTargetText(term).split(" ").filter(Boolean));
    const expanded = expandQueryTerms(rawQuery);
    const familyAnchors = expanded
      .filter((term) =>
        term.source === "original"
        && !!term.family
        && !term.generic
        && term.weight >= 0.72
      )
      .flatMap((term) => normalizeTargetText(term.term).split(" ").filter(Boolean));
    const mechanismTerms = rawTokens
      .flatMap((term) => normalizeTargetText(term).split(" ").filter(Boolean))
      .filter((term) =>
        term.length >= 4
        && !STOP_WORDS.has(term)
        && !BUG_NOISE_TERMS.has(term)
        && !BUG_LOW_SPECIFICITY_TERMS.has(term)
        && this.isUsefulBugSignalTerm(term)
        && !BUG_GENERIC_TERMS.has(term)
        && !GENERIC_QUERY_ACTION_TERMS.has(term)
        && !negativeTerms.has(term)
      )
      .filter((term) =>
        BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(term))
        || BUG_GATE_RE.test(term)
        || familyAnchors.includes(term)
      );

    return Array.from(new Set([
      ...pathLikeTerms,
      ...familyAnchors,
      ...mechanismTerms,
    ])).filter((term) =>
      term.length >= 3
      && !STOP_WORDS.has(term)
      && !BUG_NOISE_TERMS.has(term)
      && !this.isBugStructuralHintTerm(term)
      && !negativeTerms.has(term)
    );
  }

  private buildBugQueryDecomposition(
    literalTerms: string[],
    subjectTerms: string[],
    primaryTags: Set<string>,
    relatedTags: Set<string>,
    negativeTerms: string[]
  ): QueryDecomposition {
    const normalizedVariants = Array.from(new Set(
      subjectTerms.flatMap((term) => getQueryTermVariants(term))
        .filter((term) => term.length >= 3 && !STOP_WORDS.has(term) && !BUG_NOISE_TERMS.has(term))
    ));
    const tagTerms = Array.from(new Set([...primaryTags, ...relatedTags]));
    const semanticVariants = Array.from(new Set(
      tagTerms.flatMap((tag) => {
        switch (tag) {
          case "connection":
            return ["link", "relationship", "compatibility", "edge"];
          case "schema":
            return ["contract", "compatibility"];
          case "auth":
            return ["session", "credential", "token", "identity"];
          case "routing":
            return ["redirect", "navigation", "guard", "middleware"];
          case "storage":
            return ["persist", "write", "bucket", "blob"];
          case "billing":
            return ["charge", "invoice", "subscription", "checkout"];
          case "generation":
            return ["render", "worker", "queue", "job"];
          default:
            return [];
        }
      })
    ));
    const implementationTerms = Array.from(new Set([
      ...(tagTerms.includes("validation") || tagTerms.includes("schema") ? ["validate", "check", "assert", "compat"] : []),
      ...(tagTerms.includes("connection") ? ["guard", "predicate", "schema"] : []),
      ...(tagTerms.includes("auth") ? ["middleware", "provider", "guard", "session"] : []),
      ...(tagTerms.includes("routing") ? ["redirect", "middleware", "callback"] : []),
      ...(tagTerms.includes("storage") ? ["write", "persist", "adapter"] : []),
      "validator",
      "guard",
    ].filter((term, index, items) => term.length >= 3 && items.indexOf(term) === index)));
    const runtimeTerms = Array.from(new Set([
      "return false",
      "throw new",
      "reject",
      "allow",
      "error",
      "state",
      "request",
      "response",
    ]));
    const architecturalTerms = Array.from(new Set([
      "controller",
      "service",
      "adapter",
      "store",
      "middleware",
      "provider",
      "schema",
      "api",
      "boundary",
      "orchestrator",
    ]));
    const controlFlowTerms = ["guard", "predicate", "branch", "condition", "return false", "throw"];
    const dataFlowTerms = ["input", "output", "state", "payload", "request", "response", "config"];
    const implementationHypotheses = [
      "A runtime validator or guard is allowing or rejecting the behavior.",
      "An orchestrator/controller is calling a predicate or compatibility check in the wrong place.",
      "A schema, adapter, or state boundary is missing or bypassing validation.",
    ];

    return {
      literalTerms,
      normalizedVariants,
      semanticVariants,
      implementationTerms,
      runtimeTerms,
      architecturalTerms,
      controlFlowTerms,
      dataFlowTerms,
      implementationHypotheses,
      excludedTerms: negativeTerms,
    };
  }

  private extractNegatedPromptTerms(query: string): string[] {
    if (!query) return [];

    const collected = new Set<string>();
    const patterns = [
      /\bdo not care about\s+([^.;,\n]+?)(?=\s+(?:but|and)\s+|[.;,\n]|$)/gi,
      /\bdon't care about\s+([^.;,\n]+?)(?=\s+(?:but|and)\s+|[.;,\n]|$)/gi,
      /\bwithout\s+([^.;,\n]+?)(?=\s+(?:but|and)\s+|[.;,\n]|$)/gi,
      /\bnot\s+the\s+([^.;,\n]+?)(?=\s+(?:but|and)\s+|[.;,\n]|$)/gi,
    ];

    for (const pattern of patterns) {
      for (const match of query.matchAll(pattern)) {
        const clause = match[1] ?? "";
        for (const term of tokenizeQueryTerms(clause).flatMap((token) =>
          normalizeTargetText(token).split(" ").filter(Boolean)
        )) {
          if (
            term.length >= 3
            && !STOP_WORDS.has(term)
            && !BUG_NOISE_TERMS.has(term)
            && !GENERIC_QUERY_ACTION_TERMS.has(term)
          ) {
            collected.add(term);
          }
        }
      }
    }

    return Array.from(collected);
  }

  private isBugGateLike(
    result: { filePath: string; name: string; content: string },
    feature?: {
      isPredicate?: boolean;
      isValidator?: boolean;
      isGuard?: boolean;
      returnsBoolean?: boolean;
      callsPredicateCount?: number;
      branchCount?: number;
      guardCount?: number;
      isController?: boolean;
      isRegistry?: boolean;
      isUiComponent?: boolean;
    }
  ): boolean {
    const text = `${result.filePath} ${result.name} ${result.content.slice(0, 1200)}`;
    return !!feature?.isPredicate
      || !!feature?.isValidator
      || !!feature?.isGuard
      || !!feature?.returnsBoolean
      || !!feature?.isController
      || /(?:validate|check|assert|verify|guard|predicate|compat|schema|reject|allow|controller|service|handler|orchestr)/i.test(text);
  }

  private isBugOrchestratorCandidate(
    result: { filePath: string; name: string; content: string },
    feature?: {
      isController?: boolean;
      callsPredicateCount?: number;
      branchCount?: number;
      writesState?: boolean;
      writesNetwork?: boolean;
      writesStorage?: boolean;
    }
  ): boolean {
    const text = `${result.filePath} ${result.name}`.toLowerCase();
    return !!feature?.isController
      || ((feature?.callsPredicateCount ?? 0) > 0 && (feature?.branchCount ?? 0) > 0)
      || (!!(feature?.writesState || feature?.writesNetwork || feature?.writesStorage) && /(controller|service|handler|provider|manager|workflow|pipeline|orchestr)/.test(text));
  }

  private isBugLeafUiLike(result: { filePath: string; name: string }): boolean {
    const normalized = normalizeTargetText(`${result.filePath} ${result.name}`);
    return normalized.split(/\s+/).some((token) => BUG_UI_LEAF_TERMS.has(token));
  }

  private getBugCandidateFamilies(result: { filePath: string; name: string }): Set<string> {
    const text = `${result.filePath} ${result.name}`;
    return new Set(
      BUG_SUBJECT_TAG_RULES
        .filter((rule) => rule.pattern.test(text))
        .map((rule) => rule.tag)
    );
  }

  private isBugGenericNavigationLeaf(
    result: { filePath: string; name: string },
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>,
    profile: BugSubjectProfile
  ): boolean {
    if (!(profile.primaryTags.has("routing") || profile.relatedTags.has("routing"))) return false;
    if (this.isBugRedirectBackboneCandidate(result, signals)) return false;
    const text = `${result.filePath} ${result.name}`.toLowerCase();
    const isNavigationNamed =
      /\bnavigation\b/.test(text)
      || /\b(drawer|menu|tab|segment|keyboard|mobile|floating|skip)\b/.test(text);
    if (!isNavigationNamed) return false;
    const hasStrongRedirectAnchor =
      /\b(protected|guard|redirect|callback|auth|route|router|destination|pending)\b/.test(text)
      || signals.rawLiteralMatches > 1
      || signals.pathNameTermMatches > 1;
    return !hasStrongRedirectAnchor;
  }

  private isBugRedirectHandoffPrompt(profile: BugSubjectProfile): boolean {
    if (!(profile.primaryTags.has("auth") || profile.primaryTags.has("routing") || profile.relatedTags.has("routing"))) {
      return false;
    }
    const focus = new Set([
      ...profile.subjectTerms,
      ...profile.focusTerms,
      ...profile.decomposition.literalTerms,
      ...profile.decomposition.semanticVariants,
    ]);
    return [
      "redirect",
      "callback",
      "protected",
      "guard",
      "pending",
      "destination",
      "handoff",
      "route",
      "router",
      "navigation",
      "session",
      "signin",
      "auth",
    ].some((term) => focus.has(term));
  }

  private isBugAuthRoutingPrompt(profile: BugSubjectProfile): boolean {
    return profile.primaryTags.has("auth")
      || profile.primaryTags.has("routing")
      || profile.relatedTags.has("auth")
      || profile.relatedTags.has("routing");
  }

  private isBugFrontendAuthRoutingHandoffPrompt(profile: BugSubjectProfile): boolean {
    if (!this.isBugAuthRoutingPrompt(profile)) return false;
    const focus = new Set([
      ...profile.subjectTerms,
      ...profile.focusTerms,
      ...profile.decomposition.literalTerms,
    ]);
    const hasHandoffIntent = [
      "redirect",
      "callback",
      "protected",
      "pending",
      "destination",
      "handoff",
      "navigation",
      "route",
      "router",
      "return",
      "logged",
      "page",
    ].some((term) => focus.has(term));
    const backendIntent = [
      "request",
      "response",
      "api",
      "server",
      "endpoint",
      "bearer",
      "token",
      "header",
      "upload",
      "storage",
      "media",
      "webhook",
      "billing",
      "credit",
      "queue",
      "worker",
    ].some((term) => focus.has(term));
    return hasHandoffIntent && !backendIntent;
  }

  private isBugBackendRequestPrompt(profile: BugSubjectProfile): boolean {
    const focus = new Set([
      ...profile.subjectTerms,
      ...profile.focusTerms,
      ...profile.decomposition.literalTerms,
    ]);
    const backendRequestIntent = [
      "request",
      "response",
      "api",
      "server",
      "endpoint",
      "bearer",
      "token",
      "header",
      "upload",
      "storage",
      "media",
      "webhook",
      "bucket",
      "blob",
    ].some((term) => focus.has(term));
    return backendRequestIntent && !this.isBugFrontendAuthRoutingHandoffPrompt(profile);
  }

  private isBugRedirectNoiseCandidate(
    result: { filePath: string; name: string },
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>,
    profile: BugSubjectProfile
  ): boolean {
    if (!this.isBugRedirectHandoffPrompt(profile)) return false;
    const text = `${result.filePath} ${result.name}`.toLowerCase();
    const hasRedirectBackbone =
      /\b(protected|guard|redirect|callback|auth|route|router|destination|pending|session)\b/.test(text)
      || signals.pathNameTermMatches > 1;
    if (/\b(signout|logout)\b/.test(text) && !hasRedirectBackbone) return true;
    if (
      /\b(navigation|drawer|menu|segment|mobile|keyboard|floating|tab|skip)\b/.test(text)
      && !hasRedirectBackbone
      && signals.rawLiteralMatches <= 1
    ) {
      return true;
    }
    return false;
  }

  private isBugOffDomainBackendCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>
  ): boolean {
    if (!this.isBugRedirectHandoffPrompt(profile) && !this.isBugAuthRoutingPrompt(profile)) return false;
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    const backendLike =
      /(?:^|\/)(api|server|controllers?|handlers?|functions?|supabase|backend)\//.test(result.filePath.toLowerCase())
      || /\b(controller|handler|service|endpoint)\b/.test(text);
    if (!backendLike) return false;
    const authRoutingAnchored =
      /\b(auth|login|signin|signout|authenticate|authenticated|session|token|oauth|callback|redirect|protected|guard|route|router|navigation|pending|destination|handoff|return)\b/.test(text)
      || signals.pathNameTermMatches > 0
      || signals.primaryTagMatches > 0;
    return !authRoutingAnchored;
  }

  private isBugFrontendHandoffNoiseCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>
  ): boolean {
    if (!this.isBugFrontendAuthRoutingHandoffPrompt(profile)) return false;
    const lowerPath = result.filePath.toLowerCase();
    const lowerName = result.name.toLowerCase();
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    const layers = this.detectWorkflowLayers(lowerPath, lowerName);
    const handoffAnchored =
      this.hasBugHandoffSpecificAnchor(result, signals)
      || this.isBugRedirectBackboneCandidate(result, signals);
    const authRoutingAnchored =
      handoffAnchored
      || (
        /\b(auth|login|signin|signout|authenticate|authenticated|session)\b/.test(text)
        && /\b(callback|redirect|protected|guard|route|router|pending|destination|return)\b/.test(text)
      )
      || (signals.pathNameTermMatches > 0 && signals.primaryTagMatches > 0);
    const genericCallbackUtility =
      /\bcallback\b/.test(text)
      && (layers.includes("shared") || layers.includes("core"))
      && !/\b(auth|login|signin|session|redirect|protected|guard|route|router|destination|pending|return)\b/.test(text);
    if (genericCallbackUtility) return true;
    if (layers.includes("backend") && !layers.includes("routing") && !handoffAnchored) return true;
    if (layers.includes("ui") && !layers.includes("routing") && !authRoutingAnchored) return true;
    return false;
  }

  private isBugMigrationNoiseCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>
  ): boolean {
    const lowerPath = result.filePath.toLowerCase();
    if (!/(?:^|\/)(migrations?|schema)\//.test(lowerPath) && !/\.sql$/i.test(lowerPath)) return false;
    const schemaPrompt =
      profile.subjectTerms.some((term) => ["migration", "migrations", "schema", "sql", "table", "column", "database", "db"].includes(term))
      || profile.primaryTags.has("storage")
      || profile.primaryTags.has("billing")
      || profile.primaryTags.has("schema");
    return !schemaPrompt && signals.pathNameTermMatches <= 1 && signals.rawLiteralMatches <= 1;
  }

  private isBugRedirectBackboneCandidate(
    result: { filePath: string; name: string },
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>
  ): boolean {
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    if (/\b(protected|guard|redirect|callback|auth|route|router|destination|pending|return|session|signin|login|navigation|app)\b/.test(text)) {
      return true;
    }
    return signals.pathNameTermMatches > 1;
  }

  private hasBugHandoffSpecificAnchor(
    result: { filePath: string; name: string },
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>
  ): boolean {
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    return /\b(callback|redirect|protected|guard|pending|destination|route|router|return)\b/.test(text)
      || signals.pathNameTermMatches > 1;
  }

  private getBugSpecificSubjectTerms(profile: BugSubjectProfile): string[] {
    return profile.subjectTerms.filter((term) =>
      term.length >= 4
      && !BUG_NOISE_TERMS.has(term)
      && !BUG_LOW_SPECIFICITY_TERMS.has(term)
      && !BUG_MECHANISM_ONLY_TERMS.has(term)
      && !this.isBugStructuralHintTerm(term)
    );
  }

  private hasBugSpecificSubjectAnchor(
    result: { filePath: string; name: string; content?: string },
    profile: BugSubjectProfile
  ): boolean {
    const terms = this.getBugSpecificSubjectTerms(profile);
    if (terms.length === 0) return false;
    const text = `${result.filePath} ${result.name} ${result.content?.slice(0, 1200) ?? ""}`;
    return terms.some((term) => textMatchesQueryTerm(text, term));
  }

  private hasBugFrontendAuthAnchor(
    result: { filePath: string; name: string },
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>
  ): boolean {
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    return /\b(auth|login|signin|signout|authenticate|authenticated|session|oauth|token)\b/.test(text)
      || signals.primaryTagMatches > 0
      || signals.rawLiteralMatches > 0;
  }

  private hasBugFrontendRoutingAnchor(
    result: { filePath: string; name: string },
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>
  ): boolean {
    return this.hasBugHandoffSpecificAnchor(result, signals)
      || this.isBugRedirectBackboneCandidate(result, signals);
  }

  private hasBugFrontendAuthRoutingPair(
    result: { filePath: string; name: string },
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>
  ): boolean {
    return this.hasBugFrontendAuthAnchor(result, signals)
      && this.hasBugFrontendRoutingAnchor(result, signals);
  }

  private needsDedicatedBugGateCompanion(profile: BugSubjectProfile): boolean {
    const focus = new Set([
      ...profile.subjectTerms,
      ...profile.focusTerms,
      ...profile.decomposition.literalTerms,
      ...profile.decomposition.semanticVariants,
    ]);
    return profile.primaryTags.has("connection")
      || profile.primaryTags.has("schema")
      || focus.has("runtime")
      || focus.has("caller")
      || focus.has("compatibility")
      || focus.has("compatible");
  }

  private isBugGenericAuthEntryCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>
  ): boolean {
    if (!this.isBugFrontendAuthRoutingHandoffPrompt(profile)) return false;
    const lowerPath = result.filePath.toLowerCase();
    const lowerName = result.name.toLowerCase();
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    const layers = this.detectWorkflowLayers(lowerPath, lowerName);
    const authEntryLike = /\b(auth|login|signin|signup)\b/.test(text);
    const handoffAnchor = this.hasBugHandoffSpecificAnchor(result, signals);
    return authEntryLike && layers.includes("ui") && !handoffAnchor;
  }

  private isBugGenericStateSupportNoiseCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>
  ): boolean {
    if (!this.isBugFrontendAuthRoutingHandoffPrompt(profile)) return false;
    const lowerPath = result.filePath.toLowerCase();
    const lowerName = result.name.toLowerCase();
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    const layers = this.detectWorkflowLayers(lowerPath, lowerName);
    const authRoutingAnchor =
      this.hasBugHandoffSpecificAnchor(result, signals)
      || this.isBugRedirectBackboneCandidate(result, signals)
      || /\b(auth|login|signin|session)\b/.test(text);
    return (layers.includes("state") || layers.includes("shared"))
      && !layers.includes("routing")
      && !authRoutingAnchor;
  }

  private isBugUnrelatedExecutionNoiseCandidate(
    result: { filePath: string; name: string },
    profile: BugSubjectProfile,
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>
  ): boolean {
    if (!this.isBugFrontendAuthRoutingHandoffPrompt(profile)) return false;
    const text = normalizeTargetText(`${result.filePath} ${result.name}`);
    const executionLike = /\b(execution|workflow|processor|retry|executor|job|queue|worker)\b/.test(text);
    if (!executionLike) return false;
    const authRoutingAnchor =
      this.hasBugHandoffSpecificAnchor(result, signals)
      || /\b(auth|login|signin|session|callback|redirect|protected|guard|route|router)\b/.test(text);
    return !authRoutingAnchor;
  }

  private isBugCrossDomainNoiseCandidate(
    result: { filePath: string; name: string; content?: string },
    profile: BugSubjectProfile,
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>
  ): boolean {
    const text = normalizeTargetText(`${result.filePath} ${result.name} ${result.content?.slice(0, 800) ?? ""}`);
    const hasStrongLocalAnchor =
      signals.pathNameTermMatches > 0
      || signals.primaryTagMatches > 0
      || signals.rawLiteralMatches > 0
      || this.hasBugSpecificSubjectAnchor(result, profile);

    if (this.isBugAuthRoutingPrompt(profile)) {
      if (this.hasBugHandoffSpecificAnchor(result, signals) || this.isBugRedirectBackboneCandidate(result, signals)) {
        return false;
      }
      return BUG_AUTH_ROUTING_OFFDOMAIN_RE.test(text) && !this.hasBugFrontendAuthRoutingPair(result, signals);
    }

    if (profile.primaryTags.has("connection") || profile.primaryTags.has("schema")) {
      const connectionAnchored =
        hasStrongLocalAnchor
        || /\b(connect|connection|compat|compatible|schema|edge|handle|link|editor|flow)\b/.test(text);
      return BUG_CONNECTION_OFFDOMAIN_RE.test(text) && !connectionAnchored;
    }

    return false;
  }

  private isBroadOrchestratorLikePath(lowerPath: string, lowerName: string): boolean {
    const text = `${lowerPath} ${lowerName}`;
    return /\b(orchestr|pipeline|engine|manager|router|dispatcher|coordinator|hybrid|core)\b/.test(text)
      || /(?:^|\/)(index|main|entry)\.[a-z0-9]+$/i.test(lowerPath);
  }

  private buildBugSeedResults(seedResult: SeedResult | undefined, profile: BugSubjectProfile): SearchResult[] {
    if (!seedResult?.seeds?.length) return [];

    const chunks = this.metadata.getChunksByIds(seedResult.seeds.map((seed) => seed.chunkId));
    const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const featureMap = new Map(
      this.metadata.getChunkFeaturesByIds(chunks.map((chunk) => chunk.id)).map((feature) => [feature.chunkId, feature])
    );

    return seedResult.seeds
      .slice(0, 4)
      .map((seed) => {
        const chunk = chunkMap.get(seed.chunkId);
        if (!chunk || isTestFile(chunk.filePath) || !this.isImplementationPath(chunk.filePath)) return null;
        const feature = featureMap.get(chunk.id);
        const tags = this.metadata.getChunkTagsByIds([chunk.id]).map((tag) => tag.tag);
        const signals = this.getBugCandidateSignals(
          { filePath: chunk.filePath, name: chunk.name, content: chunk.content },
          profile,
          tags
        );
        const candidateFamilies = this.getBugCandidateFamilies(chunk);
        const familyOverlap = Array.from(candidateFamilies).filter((family) =>
          profile.primaryTags.has(family) || profile.relatedTags.has(family)
        ).length;
        const normalizedAlias = normalizeTargetText(seed.resolvedAlias ?? seed.name);
        const aliasTokens = normalizedAlias.split(" ").filter(Boolean);
        const resolvedFile =
          seed.targetKind === "file_module"
          || seed.resolutionSource === "file_path";
        const seedSpecificity =
          signals.pathNameTermMatches
          + signals.primaryTagMatches
          + signals.rawLiteralMatches
          + familyOverlap;

        if (signals.negativeMatches > 0 && signals.pathNameTermMatches === 0) return null;
        if (signals.surfaceAlignment <= -1.4 && signals.pathNameTermMatches === 0 && signals.primaryTagMatches === 0) return null;
        if (this.isBugRedirectNoiseCandidate(chunk, signals, profile)) return null;
        if (this.isBugFrontendHandoffNoiseCandidate(chunk, profile, signals)) return null;
        if (this.isBugGenericAuthEntryCandidate(chunk, profile, signals)) return null;
        if (this.isBugGenericStateSupportNoiseCandidate(chunk, profile, signals)) return null;
        if (this.isBugOffDomainBackendCandidate(chunk, profile, signals)) return null;
        if (this.isBugCrossDomainNoiseCandidate(chunk, profile, signals)) return null;
        if (this.isBugUnrelatedExecutionNoiseCandidate(chunk, profile, signals)) return null;
        if (
          aliasTokens.length <= 1
          && (
            GENERIC_BROAD_TERMS.has(normalizedAlias)
            || INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(normalizedAlias)
            || GENERIC_QUERY_ACTION_TERMS.has(normalizedAlias)
            || BUG_GENERIC_SEED_ALIAS_TERMS.has(normalizedAlias)
          )
          && signals.pathNameTermMatches === 0
          && signals.rawLiteralMatches === 0
          && seed.reason !== "explicit_target"
        ) {
          return null;
        }
        if (
          seed.reason !== "explicit_target"
          && aliasTokens.length <= 1
          && BUG_STRUCTURAL_ROLE_ALIAS_TERMS.has(normalizedAlias)
          && familyOverlap === 0
          && signals.pathNameTermMatches <= 1
          && signals.rawLiteralMatches <= 1
          && signals.primaryTagMatches === 0
        ) {
          return null;
        }
        if (
          seed.reason === "explicit_target"
          && aliasTokens.length > 0
          && GENERIC_QUERY_ACTION_TERMS.has(aliasTokens[0] ?? "")
          && signals.pathNameTermMatches === 0
          && signals.rawLiteralMatches === 0
        ) {
          return null;
        }
        if (
          seed.reason !== "explicit_target"
          && !resolvedFile
          && seedSpecificity === 0
        ) {
          return null;
        }
        if (
          profile.primaryTags.size >= 2
          && familyOverlap === 0
          && signals.pathNameTermMatches === 0
          && signals.rawLiteralMatches === 0
          && seed.reason !== "explicit_target"
        ) {
          return null;
        }

        let score = 7 + seed.confidence * 3;
        if (seed.reason === "explicit_target") score += 2;
        if (resolvedFile) score += 1.4;
        score += Math.min(2.4, seedSpecificity * 0.65);
        if (this.isBugGateLike(chunk, feature)) score += 1.5;
        if (this.isBugOrchestratorCandidate(chunk, feature)) score += 1.1;
        score += signals.surfaceAlignment * 0.9;

        return this.chunkToSearchResult(chunk, score);
      })
      .filter((chunk): chunk is SearchResult => chunk !== null);
  }

  private buildBugStructuralSupportResults(profile: BugSubjectProfile): SearchResult[] {
    if (!this.metadata.resolveTargetAliases) return [];

    const aliases = this.isBugAuthRoutingPrompt(profile)
      ? ["auth callback", "callback", "protected route", "redirect", "pending destination", "destination"]
      : (profile.primaryTags.has("connection") || profile.primaryTags.has("schema"))
        ? ["connection schema", "compatibility schema", "edge", "handle", "editor", "flow"]
        : [];
    if (aliases.length === 0) return [];

    const hits = [
      ...this.metadata.resolveTargetAliases(aliases, 60, ["file_module"]),
      ...this.metadata.resolveTargetAliases(aliases, 60, ["symbol"]),
    ];
    const byId = new Map<string, SearchResult>();

    for (const hit of hits) {
      const ownerChunkId = hit.target.ownerChunkId
        ?? this.metadata.findChunksByFilePath(hit.target.filePath)[0]?.id;
      if (!ownerChunkId) continue;
      const chunk = this.metadata.getChunksByIds([ownerChunkId])[0];
      if (!chunk || isTestFile(chunk.filePath) || !this.isImplementationPath(chunk.filePath)) continue;
      const tags = this.metadata.getChunkTagsByIds([chunk.id]).map((tag) => tag.tag);
      const signals = this.getBugCandidateSignals(
        { filePath: chunk.filePath, name: chunk.name, content: chunk.content },
        profile,
        tags
      );
      if (this.isBugCrossDomainNoiseCandidate(chunk, profile, signals)) continue;

      let score = 8 + hit.weight * 2.2;
      if (this.isBugAuthRoutingPrompt(profile)) {
        if (this.hasBugHandoffSpecificAnchor(chunk, signals)) score += 3.2;
        if (this.isBugRedirectBackboneCandidate(chunk, signals)) score += 2.4;
      }
      if (profile.primaryTags.has("connection") || profile.primaryTags.has("schema")) {
        if (signals.pathNameTermMatches > 0) score += 3.1;
        if (signals.primaryTagMatches > 0) score += 2.8;
        if (this.hasBugSpecificSubjectAnchor(chunk, profile)) score += 1.8;
      }

      const existing = byId.get(chunk.id);
      const candidate = this.chunkToSearchResult(chunk, score);
      if (!existing || candidate.score > existing.score) byId.set(chunk.id, candidate);
    }

    return Array.from(byId.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  private collectBugContradictions(
    result: SearchResult,
    feature: ReturnType<MetadataStore["getChunkFeaturesByIds"]>[number] | undefined,
    signals: {
      literalMatches: number;
      semanticMatches: number;
      implementationMatches: number;
      runtimeMatches: number;
      pathNameTermMatches: number;
      strongDomainMatch: boolean;
    }
  ): string[] {
    const reasons: string[] = [];
    if (feature?.docLike || feature?.testLike || BUG_STRUCTURAL_NOISE_RE.test(result.filePath.toLowerCase())) reasons.push("doc_or_test_like");
    if (feature?.isRegistry && !signals.strongDomainMatch) reasons.push("registry_without_runtime");
    if (feature?.isUiComponent && !signals.strongDomainMatch && signals.runtimeMatches === 0) reasons.push("ui_wrapper_without_runtime");
    if ((result.kind.includes("type") || result.kind.includes("interface")) && signals.runtimeMatches === 0) reasons.push("passive_declaration");
    if (signals.literalMatches + signals.semanticMatches > 0 && signals.implementationMatches + signals.runtimeMatches === 0) reasons.push("lexical_only");
    return reasons;
  }

  private getBugCandidateSignals(
    result: { filePath: string; name: string; content: string },
    profile: BugSubjectProfile,
    tags: string[] = []
  ): {
    rawLiteralMatches: number;
    literalMatches: number;
    pathNameSemanticMatches: number;
    semanticMatches: number;
    implementationMatches: number;
    runtimeMatches: number;
    architectureMatches: number;
    controlFlowMatches: number;
    dataFlowMatches: number;
    rawTermMatches: number;
    termMatches: number;
    pathNameTermMatches: number;
    primaryTagMatches: number;
    relatedTagMatches: number;
    negativeMatches: number;
    runtimeGateOverlap: boolean;
    strongDomainMatch: boolean;
    surfaceAlignment: number;
  } {
    const pathNameTextRaw = `${result.filePath} ${result.name}`;
    const pathNameTextNormalized = normalizeTargetText(pathNameTextRaw);
    const combinedRaw = `${result.filePath} ${result.name} ${result.content.slice(0, 1200)}`;
    const effectiveTerms = profile.focusTerms.length > 0 ? profile.focusTerms : profile.subjectTerms;
    const anchorTerms = effectiveTerms.filter((term) =>
      !this.isBugStructuralHintTerm(term)
      || BUG_SUBJECT_TAG_RULES.some((rule) => rule.pattern.test(term))
      || BUG_GATE_RE.test(term)
    );
    const rawLiteralMatches = profile.decomposition.literalTerms.filter((term) =>
      textMatchesQueryTerm(combinedRaw, term)
    ).length;
    const literalMatches = profile.decomposition.literalTerms.filter((term) =>
      textMatchesQueryTerm(combinedRaw, term) || tags.some((tag) => textMatchesQueryTerm(tag, term))
    ).length;
    const pathNameSemanticMatches = profile.decomposition.semanticVariants.filter((term) =>
      textMatchesQueryTerm(pathNameTextRaw, term) || textMatchesQueryTerm(pathNameTextNormalized, term)
    ).length;
    const semanticMatches = profile.decomposition.semanticVariants.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const implementationMatches = profile.decomposition.implementationTerms.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const runtimeMatches = profile.decomposition.runtimeTerms.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const architectureMatches = profile.decomposition.architecturalTerms.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const controlFlowMatches = profile.decomposition.controlFlowTerms.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const dataFlowMatches = profile.decomposition.dataFlowTerms.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const rawTermMatches = anchorTerms.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const termMatches = anchorTerms.filter((term) =>
      textMatchesQueryTerm(combinedRaw, term) || tags.some((tag) => textMatchesQueryTerm(tag, term))
    ).length;
    const pathNameTermMatches = anchorTerms.filter((term) => textMatchesQueryTerm(pathNameTextRaw, term)).length;
    const primaryTagMatches = BUG_SUBJECT_TAG_RULES.filter((rule) =>
      profile.primaryTags.has(rule.tag) && (rule.pattern.test(pathNameTextRaw) || rule.pattern.test(pathNameTextNormalized))
    ).length;
    const relatedTagMatches = tags.filter((tag) => profile.relatedTags.has(tag)).length;
    const negativeMatches = (profile.negativeTerms ?? []).filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
    const runtimeGateOverlap = BUG_GATE_RE.test(combinedRaw);
    const surfaceAlignment = scoreExecutionSurfaceAlignment(
      detectExecutionSurfaces(result.filePath, result.name, result.content),
      profile.surfaceBias
    );
    const directDomainEvidence =
      rawLiteralMatches > 0
      || semanticMatches > 0
      || pathNameTermMatches > 0
      || primaryTagMatches > 0;
    const strongDomainMatch = profile.primaryTags.size > 0
      ? (
          directDomainEvidence
          || (runtimeGateOverlap && semanticMatches > 0)
        )
      : (
          literalMatches > 0
          || semanticMatches > 0
          || pathNameTermMatches > 0
          || primaryTagMatches > 0
          || relatedTagMatches > 0
          || implementationMatches > 0
          || runtimeMatches > 0
          || architectureMatches > 0
          || controlFlowMatches > 0
          || dataFlowMatches > 0
          || runtimeGateOverlap
        );

    return {
      rawLiteralMatches,
      literalMatches,
      pathNameSemanticMatches,
      semanticMatches,
      implementationMatches,
      runtimeMatches,
      architectureMatches,
      controlFlowMatches,
      dataFlowMatches,
      rawTermMatches,
      termMatches,
      pathNameTermMatches,
      primaryTagMatches,
      relatedTagMatches,
      negativeMatches,
      runtimeGateOverlap,
      strongDomainMatch,
      surfaceAlignment,
    };
  }

  private hasBugAnchorSignals(
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>
  ): boolean {
    return signals.rawTermMatches > 0
      || signals.semanticMatches > 0
      || signals.pathNameTermMatches > 0
      || signals.primaryTagMatches > 0;
  }

  private hasBugDirectAnchorSignals(
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>
  ): boolean {
    return signals.rawLiteralMatches > 0
      || signals.pathNameTermMatches > 0
      || signals.primaryTagMatches > 0;
  }

  private hasBugMechanismAnchorSignals(
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>,
    profile: BugSubjectProfile
  ): boolean {
    if (this.hasBugDirectAnchorSignals(signals)) return true;
    if (signals.pathNameSemanticMatches === 0) return false;
    return profile.primaryTags.has("connection")
      || profile.primaryTags.has("schema")
      || profile.primaryTags.has("routing");
  }

  private isStrongBugAnchorCandidate(
    result: { filePath: string; name: string; content: string },
    signals: ReturnType<HybridSearch["getBugCandidateSignals"]>,
    feature?: ChunkFeature,
    profile?: BugSubjectProfile
  ): boolean {
    return ((profile ? this.hasBugMechanismAnchorSignals(signals, profile) : this.hasBugDirectAnchorSignals(signals)) || signals.implementationMatches > 0 || signals.runtimeMatches > 0)
      && this.isBugGateLike(result, feature);
  }

  private getModeFocusedExpandedTerms(
    query: string,
    queryMode: "bug" | "trace"
  ): ExpandedQueryTerm[] {
    const expanded = expandQueryTerms(query);
    const explicitLogging = MODE_EXPLICIT_LOGGING_RE.test(query);
    const explicitWebhook = MODE_EXPLICIT_WEBHOOK_RE.test(query);
    const familyScores = new Map<string, number>();

    for (const term of expanded) {
      if (!term.family) continue;
      if (term.source !== "original" && term.source !== "morphological") continue;
      const normalized = normalizeTargetText(term.term);
      if (GENERIC_QUERY_ACTION_TERMS.has(normalized)) continue;
      familyScores.set(term.family, (familyScores.get(term.family) ?? 0) + term.weight);
    }

    const rankedFamilies = Array.from(familyScores.entries()).sort((a, b) => b[1] - a[1]);
    const topScore = rankedFamilies[0]?.[1] ?? 0;
    const allowedFamilies = new Set<string>();
    for (const [family, score] of rankedFamilies) {
      if (score < Math.max(0.86, topScore * 0.55)) continue;
      allowedFamilies.add(family);
      for (const adjacent of ADJACENT_WORKFLOW_FAMILIES[family] ?? []) {
        allowedFamilies.add(adjacent);
      }
    }
    if (!explicitLogging) allowedFamilies.delete("logging");
    if (!explicitWebhook && (allowedFamilies.has("auth") || allowedFamilies.has("routing"))) {
      allowedFamilies.delete("webhook");
    }

    return expanded.filter((term) => {
      const normalized = normalizeTargetText(term.term);
      if (GENERIC_QUERY_ACTION_TERMS.has(normalized)) return false;
      if (queryMode === "bug" && BUG_NOISE_TERMS.has(normalized)) return false;
      if (queryMode === "trace" && TRACE_NOISE_TERMS.has(normalized)) return false;
      if (!term.family) {
        return term.source === "original" || term.source === "morphological" || !term.generic;
      }
      if (allowedFamilies.size === 0) {
        if (term.family === "logging" && !explicitLogging) return false;
        if (term.family === "webhook" && !explicitWebhook) return false;
        return true;
      }
      if (allowedFamilies.has(term.family)) return true;
      if (
        queryMode === "bug"
        && (term.source === "original" || term.source === "morphological")
        && !term.generic
        && normalized.length >= 4
        && !BUG_LOW_SPECIFICITY_TERMS.has(normalized)
      ) {
        return true;
      }
      return false;
    });
  }

  private collectModeCompoundSemanticTerms(focusedExpanded: ExpandedQueryTerm[]): string[] {
    return focusedExpanded
      .filter((term) =>
        term.source === "semantic"
        && !!term.family
        && !term.generic
        && term.weight >= 0.72
        && (
          /[A-Z_]/.test(term.term)
          || normalizeTargetText(term.term).split(" ").filter(Boolean).length > 1
        )
        && normalizeTargetText(term.term).split(" ").filter(Boolean).length <= 2
      )
      .flatMap((term) => normalizeTargetText(term.term).split(" ").filter(Boolean))
      .filter((term) =>
        term.length >= 3
        && !STOP_WORDS.has(term)
        && !GENERIC_QUERY_ACTION_TERMS.has(term)
        && !BUG_NOISE_TERMS.has(term)
        && !TRACE_NOISE_TERMS.has(term)
      );
  }

  private extractTraceSalientTerms(query: string): string[] {
    const focusedExpanded = this.getModeFocusedExpandedTerms(query, "trace");
    const semanticTerms = this.collectModeCompoundSemanticTerms(focusedExpanded);
    const originalTerms = focusedExpanded
      .filter((term) => term.source === "original" || term.source === "morphological")
      .flatMap((term) => normalizeTargetText(term.term).split(" ").filter(Boolean));
    const rawTerms = tokenizeQueryTerms(query)
      .flatMap((term) => normalizeTargetText(term).split(" ").filter(Boolean))
      .filter((term) =>
        term.length >= 3
        && !STOP_WORDS.has(term)
        && !GENERIC_QUERY_ACTION_TERMS.has(term)
        && !TRACE_NOISE_TERMS.has(term)
      );

    return Array.from(new Set([
      ...originalTerms,
      ...semanticTerms,
      ...rawTerms,
    ])).slice(0, 12);
  }

  private filterSeedsForMode(
    query: string,
    seedResult: SeedResult,
    queryMode: "lookup" | "trace" | "bug" | "architecture" | "change" | "skip"
  ): SeedResult {
    if (queryMode !== "bug" && queryMode !== "trace" && queryMode !== "architecture" && queryMode !== "change") {
      return seedResult;
    }

    const focusTerms = queryMode === "bug"
      ? this.extractBugSalientTerms(query)
      : this.extractTraceSalientTerms(query);
    const familyTerms = this.getModeFocusedExpandedTerms(query, queryMode === "bug" ? "bug" : "trace")
      .filter((term) => term.family && !term.generic && term.weight >= 0.72)
      .flatMap((term) => normalizeTargetText(term.term).split(" ").filter(Boolean));
    const bugProfile = queryMode === "bug"
      ? this.buildBugSubjectProfile(focusTerms, query)
      : null;
    const handoffPrompt = bugProfile ? this.isBugRedirectHandoffPrompt(bugProfile) : false;
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

  private buildBugRetrievalQuery(query: string): string {
    const subjectTerms = this.extractBugSalientTerms(query)
      .filter((term) => term.length >= 3 && !BUG_GENERIC_TERMS.has(term));
    const profile = this.buildBugSubjectProfile(subjectTerms, query);
    const expanded = new Set<string>([
      ...profile.focusTerms,
      ...profile.decomposition.semanticVariants,
      ...profile.decomposition.implementationTerms,
    ]);
    for (const tag of profile.primaryTags) expanded.add(tag);
    for (const tag of profile.relatedTags) expanded.add(tag);
    if (this.isBugFrontendAuthRoutingHandoffPrompt(profile)) {
      for (const term of ["callback", "protected", "guard", "pending", "destination", "route"]) {
        expanded.add(term);
      }
    }
    if (profile.primaryTags.has("connection") || profile.primaryTags.has("schema")) {
      for (const term of ["schema", "compat", "edge", "handle", "editor", "flow"]) {
        expanded.add(term);
      }
    }
    return Array.from(expanded).slice(0, 8).join(" ") || query;
  }

  private buildBugRetrievalQueries(query: string): string[] {
    const subjectTerms = this.extractBugSalientTerms(query)
      .filter((term) => term.length >= 3 && !BUG_GENERIC_TERMS.has(term));
    const profile = this.buildBugSubjectProfile(subjectTerms, query);
    const familyTerms = Array.from(new Set([
      ...profile.primaryTags,
      ...profile.relatedTags,
    ]));
    const focusQuery = Array.from(new Set([
      ...profile.focusTerms.slice(0, 4),
      ...familyTerms.slice(0, 2),
      ...profile.decomposition.implementationTerms.slice(0, 2),
    ])).slice(0, 8).join(" ");
    const mechanismQuery = Array.from(new Set([
      ...profile.focusTerms.slice(0, 3),
      ...profile.decomposition.implementationTerms.slice(0, 3),
      ...profile.decomposition.controlFlowTerms.slice(0, 2),
    ])).slice(0, 8).join(" ");
    const runtimeQuery = Array.from(new Set([
      ...profile.focusTerms.slice(0, 2),
      ...familyTerms.slice(0, 2),
      ...profile.decomposition.runtimeTerms.slice(0, 2),
      ...profile.decomposition.architecturalTerms.slice(0, 2),
    ])).slice(0, 8).join(" ");
    const bridgeQuery = this.isBugFrontendAuthRoutingHandoffPrompt(profile)
      ? Array.from(new Set([
          ...profile.focusTerms.slice(0, 3),
          "callback",
          "protected",
          "pending",
          "destination",
          "route",
          "guard",
        ])).slice(0, 8).join(" ")
      : (profile.primaryTags.has("connection") || profile.primaryTags.has("schema"))
        ? Array.from(new Set([
            ...profile.focusTerms.slice(0, 3),
            "schema",
            "compat",
            "edge",
            "handle",
            "editor",
            "flow",
          ])).slice(0, 8).join(" ")
        : "";

    return Array.from(new Set([
      this.buildBugRetrievalQuery(query),
      focusQuery,
      mechanismQuery,
      runtimeQuery,
      bridgeQuery,
    ].filter((candidate) => candidate.trim().length > 0)));
  }

  private buildTraceRetrievalQuery(query: string): string {
    return this.extractTraceSalientTerms(query).join(" ") || query;
  }

  private isInfrastructureTracePrompt(query: string): boolean {
    const lower = query.toLowerCase();
    return /^(trace|follow)\b/.test(lower)
      && /\bfrom\b.+\bto\b.+/.test(lower)
      && /\b(mcp|stdio|cli|command|transport|registration|hook|daemon|server|http|endpoint|socket)\b/.test(lower);
  }

  private prependTraceTargetResults(
    query: string,
    results: SearchResult[]
  ): SearchResult[] {
    if (!this.metadata.resolveTargetAliases) return results;

    const traceTerms = this.extractTraceSalientTerms(query)
      .map((term) => normalizeTargetText(term))
      .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
    if (traceTerms.length === 0) return results;

    const aliases = Array.from(new Set(traceTerms));
    const hits = [
      ...this.metadata.resolveTargetAliases(aliases, 40, ["file_module", "endpoint"]),
      ...this.metadata.resolveTargetAliases(aliases, 60, ["symbol"]),
    ];
    if (hits.length === 0) return results;

    const byId = new Map(results.map((result) => [result.id, result]));
    const topScore = results[0]?.score ?? 1;
    const seenFiles = new Set<string>();

    for (let index = 0; index < hits.length; index += 1) {
      const hit = hits[index];
      if (!hit) continue;
      const filePath = hit.target.filePath;
      if (!filePath || isTestFile(filePath) || !this.isImplementationPath(filePath)) continue;
      if (seenFiles.has(filePath)) continue;

      const ownerChunkId = hit.target.ownerChunkId
        ?? this.metadata.findChunksByFilePath(filePath)[0]?.id;
      if (!ownerChunkId) continue;
      const chunk = this.metadata.getChunksByIds([ownerChunkId])[0];
      if (!chunk) continue;

      const aliasText = normalizeTargetText(`${hit.alias} ${hit.normalizedAlias}`);
      const infrastructureBonus =
        /\b(mcp|stdio|cli|command|transport|registration|hook|daemon|server)\b/.test(aliasText)
          ? 1.2
          : 0.45;
      const boostedScore = topScore + 1.8 + infrastructureBonus - index * 0.001;
      const existing = byId.get(chunk.id);
      byId.set(
        chunk.id,
        existing
          ? { ...existing, score: Math.max(existing.score, boostedScore) }
          : this.chunkToSearchResult(chunk, boostedScore)
      );
      seenFiles.add(filePath);
      if (seenFiles.size >= 4) break;
    }

    return Array.from(byId.values()).sort((a, b) => b.score - a.score);
  }

  private buildBugKeywordResults(results: SearchResult[], profile: BugSubjectProfile): SearchResult[] {
    const bestByFile = new Map<string, SearchResult>();
    for (const result of results.slice(0, 30)) {
      if (isTestFile(result.filePath) || !this.isImplementationPath(result.filePath)) continue;
      const representative = this.promoteBugRepresentativeChunk(result, profile);
      const existing = bestByFile.get(representative.filePath);
      if (!existing || representative.score > existing.score) {
        bestByFile.set(representative.filePath, representative);
      }
    }

    const promotedByFile = Array.from(bestByFile.values());
    const featureMap = new Map(
      this.metadata.getChunkFeaturesByIds(promotedByFile.map((result) => result.id)).map((feature) => [feature.chunkId, feature])
    );
    const tagMap = new Map<string, string[]>();
    for (const tag of this.metadata.getChunkTagsByIds(promotedByFile.map((result) => result.id))) {
      const existing = tagMap.get(tag.chunkId) ?? [];
      existing.push(tag.tag);
      tagMap.set(tag.chunkId, existing);
    }

    const scoredResults: Array<SearchResult | null> = promotedByFile
      .map((representative) => {
        const feature = featureMap.get(representative.id);
        const tags = tagMap.get(representative.id) ?? [];
        const signals = this.getBugCandidateSignals(
          { filePath: representative.filePath, name: representative.name, content: representative.content },
          profile,
          tags
        );
        const strongPathMatch = signals.pathNameTermMatches > 0 || signals.primaryTagMatches > 0;
        const gateLike = this.isBugGateLike(representative, feature);
        const contradictions = this.collectBugContradictions(representative, feature, signals);

        if (feature?.docLike || feature?.testLike) return null;
        if (this.isBugGenericNavigationLeaf(representative, signals, profile)) return null;
        if (this.isBugRedirectNoiseCandidate(representative, signals, profile)) return null;
        if (this.isBugMigrationNoiseCandidate(representative, profile, signals)) return null;
        if (signals.negativeMatches > 0 && signals.pathNameTermMatches === 0) return null;
        if (signals.surfaceAlignment <= -1.5 && !gateLike && !strongPathMatch) return null;
        if (contradictions.includes("registry_without_runtime") && !gateLike) return null;
        if (contradictions.includes("ui_wrapper_without_runtime") && !gateLike) return null;
        if (profile.primaryTags.size > 0 && !(strongPathMatch || gateLike || signals.implementationMatches > 0 || signals.runtimeMatches > 0)) return null;

        let score = representative.score;
        if (strongPathMatch) score += 2.6;
        if (gateLike) score += 2.1;
        if (signals.literalMatches > 0) score += Math.min(1.2, signals.literalMatches * 0.3);
        if (signals.semanticMatches > 0) score += Math.min(1, signals.semanticMatches * 0.25);
        if (signals.implementationMatches > 0) score += Math.min(1.5, signals.implementationMatches * 0.35);
        if (signals.runtimeMatches > 0) score += Math.min(1.2, signals.runtimeMatches * 0.25);
        if (signals.architectureMatches > 0) score += Math.min(0.8, signals.architectureMatches * 0.15);
        if (signals.controlFlowMatches > 0) score += Math.min(0.8, signals.controlFlowMatches * 0.18);
        if (signals.relatedTagMatches > 0) score += Math.min(0.5, signals.relatedTagMatches * 0.15);
        score += signals.surfaceAlignment * 1.15;
        if ((feature?.callsPredicateCount ?? 0) > 0) score += Math.min(1.2, (feature?.callsPredicateCount ?? 0) * 0.2);
        if ((feature?.branchCount ?? 0) > 0) score += Math.min(0.8, (feature?.branchCount ?? 0) * 0.08);
        score -= Math.min(2, contradictions.length * 0.45);
        score -= Math.min(3, signals.negativeMatches * 1.25);

        return {
          ...representative,
          score,
          hookScore: Math.max(representative.hookScore ?? representative.score, score),
        };
      });

    return scoredResults
      .filter((result): result is SearchResult => result !== null)
      .sort((a, b) => b.score - a.score);
  }

  private selectBugLocalizationBundle(
    query: string,
    results: SearchResult[],
    maxContextChunks: number = 6,
    seedResult?: SeedResult
  ): SearchResult[] {
    const queryTerms = this.extractBugSalientTerms(query);
    const subjectTerms = queryTerms.filter((term) => !BUG_GENERIC_TERMS.has(term));
    const subjectProfile = this.buildBugSubjectProfile(subjectTerms, query);
    const seedAnchorIds = new Set(
      (seedResult?.seeds ?? [])
        .filter((seed) => seed.reason === "explicit_target" || seed.reason === "resolved_target")
        .filter((seed) => {
          const normalizedAlias = normalizeTargetText(seed.resolvedAlias ?? seed.name);
          const aliasTokens = normalizedAlias.split(" ").filter(Boolean);
          if (
            aliasTokens.length <= 1
            && (
              GENERIC_BROAD_TERMS.has(normalizedAlias)
              || INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(normalizedAlias)
              || GENERIC_QUERY_ACTION_TERMS.has(normalizedAlias)
            )
          ) {
            return false;
          }
          if (
            seed.reason === "explicit_target"
            && GENERIC_QUERY_ACTION_TERMS.has(aliasTokens[0] ?? "")
          ) {
            return false;
          }
          const seedText = `${seed.filePath} ${seed.name} ${seed.resolvedAlias ?? ""}`;
          const matches = subjectProfile.focusTerms.filter((term) => textMatchesQueryTerm(seedText, term)).length;
          if (matches >= 2) return true;
          return matches >= 1 && seed.reason === "explicit_target";
        })
        .map((seed) => seed.chunkId)
    );
    const maxFiles = Math.min(3, maxContextChunks);
    const semanticSeedResults = this.buildBugPredicateResults(subjectProfile);
    const structuralSupportResults = this.buildBugStructuralSupportResults(subjectProfile);
    const seedResults = this.buildBugSeedResults(seedResult, subjectProfile);
    const keywordResults = this.buildBugKeywordResults(results, subjectProfile);
    const strongKeywordAnchorResults = keywordResults.filter((result) => {
      const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
      const feature = this.metadata.getChunkFeaturesByIds([result.id])[0];
      const signals = this.getBugCandidateSignals(
        { filePath: result.filePath, name: result.name, content: result.content },
        subjectProfile,
        tags
      );
      return this.isStrongBugAnchorCandidate(result, signals, feature, subjectProfile);
    });
    const strongSemanticAnchorResults = semanticSeedResults.filter((result) => {
      const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
      const feature = this.metadata.getChunkFeaturesByIds([result.id])[0];
      const signals = this.getBugCandidateSignals(
        { filePath: result.filePath, name: result.name, content: result.content },
        subjectProfile,
        tags
      );
      return this.isStrongBugAnchorCandidate(result, signals, feature, subjectProfile);
    });
    const filteredSemanticSeedResults = strongKeywordAnchorResults.length > 0
      ? semanticSeedResults.filter((result) => {
          const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
          const feature = this.metadata.getChunkFeaturesByIds([result.id])[0];
          const signals = this.getBugCandidateSignals(
            { filePath: result.filePath, name: result.name, content: result.content },
            subjectProfile,
            tags
          );
          return signals.pathNameTermMatches > 0
            || signals.primaryTagMatches > 0
            || this.isStrongBugAnchorCandidate(result, signals, feature, subjectProfile);
        })
      : semanticSeedResults;
    const callerSeedResults = strongKeywordAnchorResults.length > 0
      ? strongKeywordAnchorResults
      : strongSemanticAnchorResults;
    const hasStrongKeywordAnchors = strongKeywordAnchorResults.length > 0;
    const callerResults = this.buildBugCallerResults(
      callerSeedResults.length > 0
        ? callerSeedResults
        : this.mergeBroadResults(semanticSeedResults, keywordResults),
      subjectProfile
    );
    const neighborResults = this.buildBugNeighborResults(
      hasStrongKeywordAnchors
        ? [...strongKeywordAnchorResults, ...callerResults]
        : [...semanticSeedResults, ...keywordResults, ...callerResults],
      subjectProfile
    );
    const semanticSeedIds = new Set(semanticSeedResults.map((result) => result.id));
    const structuralSupportIds = new Set(structuralSupportResults.map((result) => result.id));
    const seedResultIds = new Set(seedResults.map((result) => result.id));
    const keywordIds = new Set(keywordResults.map((result) => result.id));
    const callerIds = new Set(callerResults.map((result) => result.id));
    const neighborIds = new Set(neighborResults.map((result) => result.id));
    const anchoredSemanticSeedIds = new Set(
      semanticSeedResults
        .filter((result) => {
          const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
          const signals = this.getBugCandidateSignals(
            { filePath: result.filePath, name: result.name, content: result.content },
            subjectProfile,
            tags
          );
          return this.hasBugAnchorSignals(signals);
        })
        .map((result) => result.id)
    );
    const keywordFocused = keywordResults.filter((result) => {
      const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
      const signals = this.getBugCandidateSignals(
        { filePath: result.filePath, name: result.name, content: result.content },
        subjectProfile,
        tags
      );
      return signals.pathNameTermMatches > 0
        || signals.primaryTagMatches > 0
        || signals.implementationMatches > 0
        || signals.runtimeMatches > 0;
    });
    const genericDomainResults = results.filter((result) => {
      const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
      const signals = this.getBugCandidateSignals(
        { filePath: result.filePath, name: result.name, content: result.content },
        subjectProfile,
        tags
      );
      if (subjectProfile.primaryTags.size === 0) {
        return signals.literalMatches + signals.semanticMatches + signals.implementationMatches + signals.runtimeMatches > 0
          || signals.runtimeGateOverlap;
      }
      return signals.strongDomainMatch || signals.runtimeGateOverlap;
    });
    const preAugmentedResults = subjectProfile.primaryTags.size > 0 && keywordFocused.length > 0
      ? this.mergeBroadResults(
          this.mergeBroadResults(neighborResults, callerResults),
          keywordFocused
        )
      : this.mergeBroadResults(filteredSemanticSeedResults, genericDomainResults);
    const augmentedResults = this.mergeBroadResults(
      structuralSupportResults,
      this.mergeBroadResults(seedResults, preAugmentedResults)
    );
    const featureMap = new Map(
      this.metadata.getChunkFeaturesByIds(augmentedResults.map((result) => result.id)).map((feature) => [feature.chunkId, feature])
    );

    const scored: BugScoredCandidate[] = augmentedResults
      .map((result) => {
        const lowerPath = result.filePath.toLowerCase();
        const lowerName = result.name.toLowerCase();
        const lowerContent = result.content.toLowerCase();
        const combined = `${lowerPath} ${lowerName} ${lowerContent.slice(0, 1200)}`;
        const fileBase = lowerPath.split("/").pop() ?? lowerPath;
        const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
        const feature = featureMap.get(result.id);
        const signals = this.getBugCandidateSignals(
          { filePath: result.filePath, name: result.name, content: result.content },
          subjectProfile,
          tags
        );
        const candidateFamilies = this.getBugCandidateFamilies(result);
        const matchedPrimaryFamilyCount = Array.from(candidateFamilies).filter((family) =>
          subjectProfile.primaryTags.has(family)
        ).length;
        const matchedRelatedFamilyCount = Array.from(candidateFamilies).filter((family) =>
          subjectProfile.relatedTags.has(family)
        ).length;
        const hasSpecificSubjectAnchor = this.hasBugSpecificSubjectAnchor(result, subjectProfile);
        const graphExpanded =
          keywordIds.has(result.id) || callerIds.has(result.id) || neighborIds.has(result.id) || seedResultIds.has(result.id);
        const structuralAnchorHit =
          signals.literalMatches > 0
          || signals.pathNameTermMatches > 0
          || signals.primaryTagMatches > 0
          || signals.relatedTagMatches > 0;
        const directStructuralAnchorHit =
          signals.pathNameTermMatches > 0
          || signals.primaryTagMatches > 0;
        const genericRuntimeHelper =
          /^(create|invoke|handle|handler|process|run|execute|load|update|fetch|submit|callback|memo)/.test(lowerName)
          || /\bcreate[_\s]?handler\b/.test(lowerName);
        const contradictions = this.collectBugContradictions(result, feature, signals);
        if (contradictions.includes("doc_or_test_like")) return null;
        if (signals.negativeMatches > 0 && signals.pathNameTermMatches === 0 && !callerIds.has(result.id)) return null;
        if (
          this.isBugFrontendHandoffNoiseCandidate(result, subjectProfile, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          return null;
        }
        if (
          this.isBugOffDomainBackendCandidate(result, subjectProfile, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          return null;
        }
        if (
          this.isBugCrossDomainNoiseCandidate(result, subjectProfile, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
          && !seedResultIds.has(result.id)
        ) {
          return null;
        }
        if (
          this.isBugRedirectHandoffPrompt(subjectProfile)
          && !this.hasBugHandoffSpecificAnchor(result, signals)
          && !this.isBugRedirectBackboneCandidate(result, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
          && !seedResultIds.has(result.id)
        ) {
          return null;
        }
        if (
          this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)
          && !this.hasBugHandoffSpecificAnchor(result, signals)
          && !this.isBugRedirectBackboneCandidate(result, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
          && !seedResultIds.has(result.id)
        ) {
          return null;
        }
        if (
          subjectProfile.primaryTags.size > 0
          && !signals.strongDomainMatch
          && !graphExpanded
          && signals.implementationMatches === 0
          && signals.runtimeMatches === 0
        ) {
          return null;
        }
        if (
          subjectProfile.primaryTags.size > 0
          && !this.hasBugMechanismAnchorSignals(signals, subjectProfile)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
          && !seedResultIds.has(result.id)
        ) {
          return null;
        }
        let score = result.score;

        if (BUG_STRUCTURAL_NOISE_RE.test(lowerPath) || /\.mdx?$/i.test(lowerPath)) score *= 0.05;
        if (BUG_UI_NOISE_RE.test(fileBase) && !BUG_GATE_RE.test(combined)) score *= 0.25;
        if (/(?:^|\/)styles?\//.test(lowerPath)) score *= 0.2;
        if (/registry/i.test(result.name) && !BUG_GATE_RE.test(combined)) score *= 0.3;
        if (this.isImplementationChunk(result)) score *= 1.12;
        if (seedAnchorIds.has(result.id)) score *= 3.8;
        if (seedResultIds.has(result.id)) score *= 1.85;
        if (structuralSupportIds.has(result.id)) score *= 2.35;
        if (
          seedResultIds.has(result.id)
          && (signals.pathNameTermMatches > 0 || signals.primaryTagMatches > 0)
        ) {
          score *= 1.45;
        }
        if (anchoredSemanticSeedIds.has(result.id)) score *= 1.45;
        else if (semanticSeedIds.has(result.id)) score *= 1.12;
        if (keywordIds.has(result.id)) score *= 1.8;
        if (callerIds.has(result.id)) score *= 1.7;
        if (neighborIds.has(result.id)) score *= 1.35;
        if (
          hasStrongKeywordAnchors
          && !keywordIds.has(result.id)
          && !callerIds.has(result.id)
          && !this.hasBugAnchorSignals(signals)
        ) {
          score *= 0.22;
        }
        if (
          subjectProfile.primaryTags.size > 0
          && !structuralAnchorHit
          && !callerIds.has(result.id)
          && !semanticSeedIds.has(result.id)
        ) {
          score *= 0.18;
        }
        if (
          subjectProfile.primaryTags.size > 0
          && genericRuntimeHelper
          && !directStructuralAnchorHit
          && !callerIds.has(result.id)
          && !semanticSeedIds.has(result.id)
        ) {
          score *= 0.08;
        }
        if (
          subjectProfile.primaryTags.size > 0
          && semanticSeedIds.has(result.id)
          && !directStructuralAnchorHit
          && signals.primaryTagMatches === 0
          && signals.pathNameTermMatches === 0
          && signals.literalMatches === 0
        ) {
          score *= 0.02;
        }
        if (
          subjectProfile.primaryTags.size > 0
          && keywordIds.has(result.id)
          && !structuralAnchorHit
          && signals.literalMatches === 0
          && signals.semanticMatches === 0
          && signals.pathNameTermMatches === 0
          && signals.primaryTagMatches === 0
        ) {
          score *= 0.08;
        }
        if (
          subjectProfile.primaryTags.size > 0
          && candidateFamilies.size > 0
          && !Array.from(candidateFamilies).some((family) =>
            subjectProfile.primaryTags.has(family) || subjectProfile.relatedTags.has(family)
          )
          && signals.rawLiteralMatches === 0
          && signals.pathNameTermMatches === 0
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.08;
        }
        if (
          subjectProfile.primaryTags.size >= 2
          && matchedPrimaryFamilyCount === 0
          && matchedRelatedFamilyCount === 0
          && signals.pathNameTermMatches === 0
          && signals.rawLiteralMatches === 0
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedResultIds.has(result.id)
        ) {
          return null;
        }
        if (subjectProfile.primaryTags.size >= 2 && matchedPrimaryFamilyCount >= 2) score *= 1.45;
        else if (
          subjectProfile.primaryTags.size >= 2
          && matchedPrimaryFamilyCount === 1
          && !seedResultIds.has(result.id)
        ) {
          score *= 0.55;
        }
        if (this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)) {
          if (matchedPrimaryFamilyCount >= 2) score *= 1.4;
          else if (
            matchedPrimaryFamilyCount === 1
            && !callerIds.has(result.id)
            && !neighborIds.has(result.id)
            && !seedAnchorIds.has(result.id)
          ) {
            score *= 0.08;
          } else if (
            matchedPrimaryFamilyCount === 0
            && !callerIds.has(result.id)
            && !neighborIds.has(result.id)
            && !seedAnchorIds.has(result.id)
          ) {
            score *= 0.02;
          }
        }
        if (
          (subjectProfile.primaryTags.has("connection") || subjectProfile.primaryTags.has("schema"))
          && !hasSpecificSubjectAnchor
          && matchedPrimaryFamilyCount === 0
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.02;
        }
        if (this.isBugRedirectNoiseCandidate(result, signals, subjectProfile)) score *= 0.04;
        if (
          this.isBugGenericNavigationLeaf(result, signals, subjectProfile)
          && !seedAnchorIds.has(result.id)
          && !callerIds.has(result.id)
        ) {
          score *= 0.04;
        }
        if (
          this.isBugGenericStateSupportNoiseCandidate(result, subjectProfile, signals)
          && !seedAnchorIds.has(result.id)
          && !callerIds.has(result.id)
        ) {
          score *= 0.03;
        }
        if (
          this.isBugUnrelatedExecutionNoiseCandidate(result, subjectProfile, signals)
          && !seedAnchorIds.has(result.id)
          && !neighborIds.has(result.id)
        ) {
          score *= callerIds.has(result.id) ? 0.08 : 0.03;
        }
        if (
          this.isBugFrontendHandoffNoiseCandidate(result, subjectProfile, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.02;
        }
        if (
          this.isBugOffDomainBackendCandidate(result, subjectProfile, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.04;
        }
        if (
          this.isBugCrossDomainNoiseCandidate(result, subjectProfile, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.03;
        }
        if (
          this.isBugRedirectHandoffPrompt(subjectProfile)
          && /\b(protected|guard|redirect|callback|auth|route|router|destination|pending|session)\b/.test(combined)
        ) {
          score *= 1.35;
        }
        if (
          this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)
          && !this.hasBugHandoffSpecificAnchor(result, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.05;
        }
        if (
          this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)
          && !this.hasBugFrontendAuthRoutingPair(result, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.04;
        }
        if (
          this.isBugRedirectHandoffPrompt(subjectProfile)
          && !this.isBugRedirectBackboneCandidate(result, signals)
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.02;
        }
        if (
          this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)
          && callerIds.has(result.id)
          && !this.hasBugFrontendAuthRoutingPair(result, signals)
        ) {
          score *= 0.08;
        }
        if (this.isBugMigrationNoiseCandidate(result, subjectProfile, signals)) score *= 0.01;
        if (feature?.isValidator) score *= 1.85;
        if (feature?.isGuard) score *= 1.55;
        if (feature?.isPredicate) score *= 1.45;
        if (feature?.returnsBoolean) score *= 1.35;
        if ((feature?.callsPredicateCount ?? 0) > 0) score *= 1 + Math.min(0.8, (feature?.callsPredicateCount ?? 0) * 0.08);
        if ((feature?.branchCount ?? 0) > 0) score *= 1 + Math.min(0.4, (feature?.branchCount ?? 0) * 0.03);
        if (BUG_GATE_RE.test(combined)) score *= 1.75;
        if (/\b(return\s+false|return\s+true|throw\s+new|if\s*\(|switch\s*\(|case\s+)/.test(lowerContent)) score *= 1.15;
        if (signals.implementationMatches > 0) score *= 1 + Math.min(0.35, signals.implementationMatches * 0.08);
        if (signals.runtimeMatches > 0) score *= 1 + Math.min(0.3, signals.runtimeMatches * 0.07);
        if (signals.architectureMatches > 0) score *= 1 + Math.min(0.25, signals.architectureMatches * 0.05);
        if (signals.controlFlowMatches > 0) score *= 1 + Math.min(0.25, signals.controlFlowMatches * 0.06);
        if (signals.dataFlowMatches > 0) score *= 1 + Math.min(0.2, signals.dataFlowMatches * 0.04);
        if (this.isBugOrchestratorCandidate(result, feature)) score *= 1.45;
        const anchoredCallerReference = callerIds.has(result.id)
          && keywordResults.some((anchor) => result.content.includes(anchor.name));
        if (anchoredCallerReference) score *= 1.35;
        if (callerIds.has(result.id) && this.isBugLeafUiLike(result)) score *= 0.72;
        if (
          callerIds.has(result.id)
          && subjectProfile.primaryTags.size > 0
          && !anchoredCallerReference
          && signals.literalMatches === 0
          && signals.semanticMatches === 0
          && signals.pathNameTermMatches === 0
          && signals.primaryTagMatches === 0
        ) {
          score *= 0.62;
        }
        if (contradictions.includes("registry_without_runtime")) score *= 0.2;
        if (contradictions.includes("ui_wrapper_without_runtime")) score *= 0.18;
        if (contradictions.includes("passive_declaration")) score *= 0.16;
        if (contradictions.includes("lexical_only")) score *= 0.65;

        if (signals.termMatches > 0) score *= 1 + Math.min(0.45, signals.termMatches * 0.12);
        if (signals.pathNameTermMatches > 0) score *= 1 + Math.min(0.8, signals.pathNameTermMatches * 0.2);
        if (signals.primaryTagMatches > 0) score *= 1 + Math.min(0.6, signals.primaryTagMatches * 0.18);
        if (signals.relatedTagMatches > 0) score *= 1 + Math.min(0.2, signals.relatedTagMatches * 0.08);
        if (signals.negativeMatches > 0) score *= Math.max(0.04, 1 - signals.negativeMatches * 0.55);
        if (
          subjectProfile.primaryTags.size > 0
          && (feature?.writesState || feature?.writesStorage)
          && signals.primaryTagMatches === 0
          && signals.pathNameTermMatches === 0
          && signals.literalMatches === 0
          && !callerIds.has(result.id)
        ) {
          score *= 0.2;
        }
        if (
          subjectProfile.subjectTerms.length >= 2
          && !signals.strongDomainMatch
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= signals.termMatches === 0 ? 0.05 : 0.18;
        } else if (
          subjectProfile.subjectTerms.length > 0
          && !signals.strongDomainMatch
          && !callerIds.has(result.id)
          && !neighborIds.has(result.id)
          && !seedAnchorIds.has(result.id)
        ) {
          score *= 0.18;
        }
        if (result.kind.includes("function") || result.kind.includes("method")) score *= 1.15;
        if (result.kind === "file") score *= 0.7;

        return {
          result,
          score,
          keywordHit: keywordIds.has(result.id),
          semanticHit: semanticSeedIds.has(result.id),
          callerHit: callerIds.has(result.id),
          seedHit: seedResultIds.has(result.id),
          strongDomainMatch: signals.strongDomainMatch,
          callsPredicateCount: feature?.callsPredicateCount ?? 0,
          contradictions,
          feature,
          signals,
        };
      })
      .filter((candidate): candidate is BugScoredCandidate => candidate !== null)
      .sort((a, b) => b.score - a.score);

    this.lastBugSelection = {
      queryDecomposition: subjectProfile.decomposition,
      searchStepsUsed: ["literal", "vector", "ast", "runtime-path", "query reformulation fusion", "graph expansion", "neighborhood expansion", "contradiction check"],
      subjectTerms,
      primaryTags: Array.from(subjectProfile.primaryTags),
      inputResults: results.slice(0, 8).map((item) => ({ name: item.name, filePath: item.filePath, score: item.score })),
      semanticSeedResults: semanticSeedResults.slice(0, 5).map((item) => ({ name: item.name, filePath: item.filePath, score: item.score })),
      keywordResults: keywordResults.slice(0, 5).map((item) => ({ name: item.name, filePath: item.filePath, score: item.score })),
      callerResults: callerResults.slice(0, 5).map((item) => ({ name: item.name, filePath: item.filePath, score: item.score })),
      neighborResults: neighborResults.slice(0, 5).map((item) => ({ name: item.name, filePath: item.filePath, score: item.score })),
      scored: scored.slice(0, 8).map((item) => ({
        name: item.result.name,
        filePath: item.result.filePath,
        score: item.score,
        keywordHit: item.keywordHit,
        semanticHit: item.semanticHit,
        callerHit: item.callerHit,
        seedHit: item.seedHit,
        strongDomainMatch: item.strongDomainMatch,
        callsPredicateCount: item.callsPredicateCount,
      })),
      topCandidates: scored.slice(0, 5).map((item, index) => ({
        filePath: item.result.filePath,
        symbol: item.result.name,
        confidence: Math.max(15, Math.round((item.score / (scored[0]?.score || 1)) * 100) - index * 4),
        evidence: [
          ...(item.keywordHit ? ["literal_or_symbol_hit"] : []),
          ...(item.semanticHit ? ["runtime_feature_hit"] : []),
          ...(item.callerHit ? ["graph_caller_hit"] : []),
          ...(item.seedHit ? ["seed_anchor_hit"] : []),
          ...(item.signals.implementationMatches > 0 ? ["implementation_term_match"] : []),
          ...(item.signals.runtimeMatches > 0 ? ["runtime_term_match"] : []),
          ...(this.isBugOrchestratorCandidate(item.result, item.feature) ? ["orchestrator_candidate"] : []),
        ],
      })),
      contradictions: scored
        .filter((item) => item.contradictions.length > 0)
        .slice(0, 5)
        .map((item) => ({
          filePath: item.result.filePath,
          symbol: item.result.name,
          reasons: item.contradictions,
        })),
      nextPivots: Array.from(new Set([
        ...Array.from(new Set(
          [...keywordResults, ...semanticSeedResults]
            .filter((result) => result.kind.includes("function") || result.kind.includes("method"))
            .slice(0, 2)
            .map((result) => `expand direct callers of ${result.name}`)
        )),
        ...(scored[0] ? [`inspect executable neighbors in ${scored[0].result.filePath}`] : []),
        "compare top runtime candidates against registry/ui-wrapper contradictions",
      ])).slice(0, 3),
    };

    const selected: SearchResult[] = [];
    const seenFiles = new Set<string>();
    const primaryAnchorResults = keywordResults
      .filter((result) => {
        const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
        const signals = this.getBugCandidateSignals(
          { filePath: result.filePath, name: result.name, content: result.content },
          subjectProfile,
          tags
        );
        return this.hasBugAnchorSignals(signals);
      })
      .filter((result) => result.kind.includes("function") || result.kind.includes("method"))
      .slice(0, 2);
    const anchorGateNames = Array.from(new Set(
      [
        ...primaryAnchorResults,
        ...semanticSeedResults.filter((result) => anchoredSemanticSeedIds.has(result.id)),
      ]
        .filter((result) => result.kind.includes("function") || result.kind.includes("method"))
        .map((result) => result.name)
    )).slice(0, 3);
    const bestScoredByFile = new Map<string, typeof scored[number]>();
    for (const candidate of scored) {
      const existing = bestScoredByFile.get(candidate.result.filePath);
      if (!existing || candidate.score > existing.score) {
        bestScoredByFile.set(candidate.result.filePath, candidate);
      }
    }
    const takeCandidate = (candidate: typeof scored[number] | undefined) => {
      if (!candidate) return;
      if (selected.length >= maxFiles) return;
      if (seenFiles.has(candidate.result.filePath)) return;
      const lowerPath = candidate.result.filePath.toLowerCase();
      if ((BUG_STRUCTURAL_NOISE_RE.test(lowerPath) || /\.mdx?$/i.test(lowerPath)) && selected.length > 0) return;
      selected.push({
        ...candidate.result,
        hookScore: candidate.score,
        score: Math.max(candidate.result.score, candidate.score),
      });
      seenFiles.add(candidate.result.filePath);
    };

    const handoffPrimaryCandidate = this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)
      ? [...scored]
          .filter((candidate) => structuralSupportIds.has(candidate.result.id) || candidate.seedHit || candidate.keywordHit)
          .filter((candidate) => candidate.strongDomainMatch)
          .filter((candidate) => this.isBugRedirectBackboneCandidate(candidate.result, candidate.signals))
          .filter((candidate) => this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals))
          .filter((candidate) => !this.isBugGenericAuthEntryCandidate(candidate.result, subjectProfile, candidate.signals))
          .filter((candidate) => !this.isBugGenericStateSupportNoiseCandidate(candidate.result, subjectProfile, candidate.signals))
          .sort((a, b) => {
            const aLayers = this.detectWorkflowLayers(a.result.filePath.toLowerCase(), a.result.name.toLowerCase());
            const bLayers = this.detectWorkflowLayers(b.result.filePath.toLowerCase(), b.result.name.toLowerCase());
            const aRouting = aLayers.includes("routing") ? 80 : 0;
            const bRouting = bLayers.includes("routing") ? 80 : 0;
            const aState = aLayers.includes("state") ? 35 : 0;
            const bState = bLayers.includes("state") ? 35 : 0;
            const aPair = this.hasBugFrontendAuthRoutingPair(a.result, a.signals) ? 160 : 0;
            const bPair = this.hasBugFrontendAuthRoutingPair(b.result, b.signals) ? 160 : 0;
            const aSignal = a.signals.pathNameTermMatches * 60 + a.signals.primaryTagMatches * 50 + a.signals.rawLiteralMatches * 35;
            const bSignal = b.signals.pathNameTermMatches * 60 + b.signals.primaryTagMatches * 50 + b.signals.rawLiteralMatches * 35;
            return (bPair + bRouting + bState + bSignal + b.score) - (aPair + aRouting + aState + aSignal + a.score);
          })[0]
      : undefined;
    const primarySeedCandidate = [...scored]
      .filter((candidate) => candidate.seedHit && candidate.strongDomainMatch)
      .filter((candidate) =>
        !this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)
        || (
          !this.isBugGenericAuthEntryCandidate(candidate.result, subjectProfile, candidate.signals)
          && !this.isBugGenericStateSupportNoiseCandidate(candidate.result, subjectProfile, candidate.signals)
          && !this.isBugOffDomainBackendCandidate(candidate.result, subjectProfile, candidate.signals)
          && (
            this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals)
            || this.isBugRedirectBackboneCandidate(candidate.result, candidate.signals)
            || candidate.signals.pathNameTermMatches > 0
            || candidate.signals.primaryTagMatches > 0
          )
        )
      )
      .sort((a, b) => {
        const aSpecificity = a.signals.pathNameTermMatches * 90 + a.signals.primaryTagMatches * 70 + a.signals.rawLiteralMatches * 50;
        const bSpecificity = b.signals.pathNameTermMatches * 90 + b.signals.primaryTagMatches * 70 + b.signals.rawLiteralMatches * 50;
        const aGate = this.isBugGateLike(a.result, a.feature) ? 50 : 0;
        const bGate = this.isBugGateLike(b.result, b.feature) ? 50 : 0;
        return (bSpecificity + bGate + b.score) - (aSpecificity + aGate + a.score);
      })[0];
    const initialFallbackCandidate = [...scored].find((candidate) => {
      if (this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)) {
        if (this.isBugGenericAuthEntryCandidate(candidate.result, subjectProfile, candidate.signals)) return false;
        if (this.isBugGenericStateSupportNoiseCandidate(candidate.result, subjectProfile, candidate.signals)) return false;
        if (this.isBugOffDomainBackendCandidate(candidate.result, subjectProfile, candidate.signals)) return false;
        return this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals)
          || this.isBugRedirectBackboneCandidate(candidate.result, candidate.signals)
          || candidate.signals.pathNameTermMatches > 0
          || candidate.signals.primaryTagMatches > 0;
      }
      return candidate.keywordHit && candidate.strongDomainMatch;
    }) ?? scored.find((candidate) => candidate.semanticHit && candidate.strongDomainMatch);
    takeCandidate(
      handoffPrimaryCandidate
      ?? primarySeedCandidate
      ?? [...scored].find((candidate) => structuralSupportIds.has(candidate.result.id) && candidate.strongDomainMatch)
      ?? initialFallbackCandidate
    );
    if (this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile) && selected.length < 2) {
      const structuralCallbackCandidate = [...scored]
        .filter((candidate) => structuralSupportIds.has(candidate.result.id))
        .filter((candidate) => !seenFiles.has(candidate.result.filePath))
        .filter((candidate) => this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals))
        .sort((a, b) => b.score - a.score)[0];
      takeCandidate(structuralCallbackCandidate);
    }
    if (this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile) && selected.length < 2) {
      const callbackBackboneCandidate = [...scored]
        .filter((candidate) => !seenFiles.has(candidate.result.filePath))
        .filter((candidate) => candidate.strongDomainMatch || candidate.keywordHit || candidate.seedHit)
        .filter((candidate) => this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals))
        .filter((candidate) => !this.isBugFrontendHandoffNoiseCandidate(candidate.result, subjectProfile, candidate.signals))
        .filter((candidate) => !this.isBugOffDomainBackendCandidate(candidate.result, subjectProfile, candidate.signals))
        .sort((a, b) => {
          const aText = `${a.result.filePath} ${a.result.name}`.toLowerCase();
          const bText = `${b.result.filePath} ${b.result.name}`.toLowerCase();
          const aCallback = /\b(callback|redirect|pending|destination|return)\b/.test(aText) ? 140 : 0;
          const bCallback = /\b(callback|redirect|pending|destination|return)\b/.test(bText) ? 140 : 0;
          const aAnchor = a.signals.pathNameTermMatches * 45 + a.signals.primaryTagMatches * 30;
          const bAnchor = b.signals.pathNameTermMatches * 45 + b.signals.primaryTagMatches * 30;
          return (bCallback + bAnchor + b.score) - (aCallback + aAnchor + a.score);
        })[0];
      takeCandidate(callbackBackboneCandidate);
    }
    const primarySelectedIsGate = selected[0]
      ? this.isBugGateLike(selected[0], featureMap.get(selected[0].id))
      : false;
    const primarySelectedIsOrchestrator = selected[0]
      ? this.isBugOrchestratorCandidate(selected[0], featureMap.get(selected[0].id))
      : false;
    if (primarySelectedIsOrchestrator && !primarySelectedIsGate) {
      takeCandidate(
        [...scored]
          .filter((candidate) =>
            !seenFiles.has(candidate.result.filePath)
            && candidate.strongDomainMatch
            && this.isBugGateLike(candidate.result, candidate.feature)
            && (
              candidate.signals.pathNameTermMatches > 0
              || candidate.signals.rawLiteralMatches > 0
              || candidate.signals.primaryTagMatches > 0
              || candidate.seedHit
            )
          )
          .sort((a, b) => {
            const aSignalScore =
              a.signals.pathNameTermMatches * 60
              + a.signals.primaryTagMatches * 50
              + a.signals.implementationMatches * 20
              + a.signals.runtimeMatches * 16
              + (a.seedHit ? 30 : 0)
              + a.score;
            const bSignalScore =
              b.signals.pathNameTermMatches * 60
              + b.signals.primaryTagMatches * 50
              + b.signals.implementationMatches * 20
              + b.signals.runtimeMatches * 16
              + (b.seedHit ? 30 : 0)
              + b.score;
            return bSignalScore - aSignalScore;
          })[0]
      );
    }
    if (selected.length < 2 && this.needsDedicatedBugGateCompanion(subjectProfile)) {
      const structuralGateCandidate = [...scored]
        .filter((candidate) => structuralSupportIds.has(candidate.result.id))
        .filter((candidate) => !seenFiles.has(candidate.result.filePath))
        .filter((candidate) => this.isBugGateLike(candidate.result, candidate.feature) || candidate.signals.pathNameTermMatches > 0 || candidate.signals.primaryTagMatches > 0)
        .sort((a, b) => b.score - a.score)[0];
      takeCandidate(structuralGateCandidate);
    }
    if (selected.length < 2 && this.needsDedicatedBugGateCompanion(subjectProfile)) {
      takeCandidate(
        [...scored]
          .filter((candidate) =>
        !seenFiles.has(candidate.result.filePath)
        && !candidate.feature?.isUiComponent
        && candidate.strongDomainMatch
        && this.isBugGateLike(candidate.result, candidate.feature)
        && (
          this.hasBugSpecificSubjectAnchor(candidate.result, subjectProfile)
          || candidate.signals.primaryTagMatches > 0
          || candidate.signals.pathNameTermMatches > 0
          || this.hasBugDirectAnchorSignals(candidate.signals)
          || this.hasBugMechanismAnchorSignals(candidate.signals, subjectProfile)
          || candidate.seedHit
        )
      )
          .sort((a, b) => {
            const aDirect = this.hasBugDirectAnchorSignals(a.signals) ? 90 : 0;
            const bDirect = this.hasBugDirectAnchorSignals(b.signals) ? 90 : 0;
            const aMechanism = this.hasBugMechanismAnchorSignals(a.signals, subjectProfile) ? 60 : 0;
            const bMechanism = this.hasBugMechanismAnchorSignals(b.signals, subjectProfile) ? 60 : 0;
            const aSignal = a.signals.pathNameTermMatches * 70 + a.signals.primaryTagMatches * 60 + a.signals.semanticMatches * 24;
            const bSignal = b.signals.pathNameTermMatches * 70 + b.signals.primaryTagMatches * 60 + b.signals.semanticMatches * 24;
            return (bDirect + bMechanism + bSignal + b.score) - (aDirect + aMechanism + aSignal + a.score);
          })[0]
      );
    }
    const callerAnchorCandidates = [...scored]
      .filter((candidate) =>
        candidate.callerHit
        && !seenFiles.has(candidate.result.filePath)
        && (!primarySelectedIsGate || !(candidate.feature?.isValidator || candidate.feature?.isGuard || candidate.feature?.isPredicate))
        && (
          !this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile)
          || this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals)
          || this.isBugRedirectBackboneCandidate(candidate.result, candidate.signals)
        )
      );
    const nonLeafCallerAnchorCandidates = callerAnchorCandidates.filter(
      (candidate) => !this.isBugLeafUiLike(candidate.result)
    );
    const anchorCallerCandidate = (nonLeafCallerAnchorCandidates.length > 0
      ? nonLeafCallerAnchorCandidates
      : callerAnchorCandidates)
      .sort((a, b) => {
        const aAnchorRefs = anchorGateNames.filter((gateName) => a.result.content.includes(gateName)).length;
        const bAnchorRefs = anchorGateNames.filter((gateName) => b.result.content.includes(gateName)).length;
        const aDomain = a.signals.literalMatches + a.signals.semanticMatches + a.signals.termMatches + a.signals.pathNameTermMatches + a.signals.primaryTagMatches;
        const bDomain = b.signals.literalMatches + b.signals.semanticMatches + b.signals.termMatches + b.signals.pathNameTermMatches + b.signals.primaryTagMatches;
        const aControl = (a.feature?.branchCount ?? 0) + (a.feature?.callsPredicateCount ?? 0);
        const bControl = (b.feature?.branchCount ?? 0) + (b.feature?.callsPredicateCount ?? 0);
        const aMechanismPenalty = (a.feature?.isValidator || a.feature?.isGuard || a.feature?.isPredicate) ? 45 : 0;
        const bMechanismPenalty = (b.feature?.isValidator || b.feature?.isGuard || b.feature?.isPredicate) ? 45 : 0;
        const aUiPenalty = a.feature?.isUiComponent && aDomain === 0 ? 500 : 0;
        const bUiPenalty = b.feature?.isUiComponent && bDomain === 0 ? 500 : 0;
        const aLeafPenalty = this.isBugLeafUiLike(a.result) ? 120 : 0;
        const bLeafPenalty = this.isBugLeafUiLike(b.result) ? 120 : 0;
        return (bAnchorRefs * 120 + bDomain * 24 + bControl * 6 + b.score - bMechanismPenalty - bUiPenalty - bLeafPenalty)
          - (aAnchorRefs * 120 + aDomain * 24 + aControl * 6 + a.score - aMechanismPenalty - aUiPenalty - aLeafPenalty);
      })[0];
    if (this.isBugAuthRoutingPrompt(subjectProfile) && selected.length < 2) {
      const authRoutingSupportCandidate = [...scored]
        .filter((candidate) => !seenFiles.has(candidate.result.filePath))
        .filter((candidate) => candidate.strongDomainMatch)
        .filter((candidate) =>
          this.isBugRedirectBackboneCandidate(candidate.result, candidate.signals)
          || this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals)
        )
        .filter((candidate) => !this.isBugGenericNavigationLeaf(candidate.result, candidate.signals, subjectProfile))
        .filter((candidate) => !this.isBugGenericStateSupportNoiseCandidate(candidate.result, subjectProfile, candidate.signals))
        .filter((candidate) => !this.isBugOffDomainBackendCandidate(candidate.result, subjectProfile, candidate.signals))
        .sort((a, b) => {
          const aText = `${a.result.filePath} ${a.result.name}`.toLowerCase();
          const bText = `${b.result.filePath} ${b.result.name}`.toLowerCase();
          const aBackbone = this.isBugRedirectBackboneCandidate(a.result, a.signals) ? 110 : 0;
          const bBackbone = this.isBugRedirectBackboneCandidate(b.result, b.signals) ? 110 : 0;
          const aHandoff = this.hasBugHandoffSpecificAnchor(a.result, a.signals) ? 80 : 0;
          const bHandoff = this.hasBugHandoffSpecificAnchor(b.result, b.signals) ? 80 : 0;
          const aAnchor = a.signals.pathNameTermMatches * 35 + a.signals.primaryTagMatches * 35 + a.signals.rawLiteralMatches * 20;
          const bAnchor = b.signals.pathNameTermMatches * 35 + b.signals.primaryTagMatches * 35 + b.signals.rawLiteralMatches * 20;
          const aPenalty = /\b(generate|storage|upload|billing|credit|pricing|service-status)\b/.test(aText) ? 140 : 0;
          const bPenalty = /\b(generate|storage|upload|billing|credit|pricing|service-status)\b/.test(bText) ? 140 : 0;
          return (bBackbone + bHandoff + bAnchor + b.score - bPenalty)
            - (aBackbone + aHandoff + aAnchor + a.score - aPenalty);
        })[0];
      takeCandidate(authRoutingSupportCandidate);
    }
    takeCandidate(anchorCallerCandidate);
    if (this.isBugFrontendAuthRoutingHandoffPrompt(subjectProfile) && selected.length < 2) {
      const primaryLayers = selected[0]
        ? this.detectWorkflowLayers(selected[0].filePath.toLowerCase(), selected[0].name.toLowerCase())
        : [];
      const handoffSupportCandidate = [...scored]
        .filter((candidate) => !seenFiles.has(candidate.result.filePath))
        .filter((candidate) =>
          candidate.strongDomainMatch
          || this.isBugRedirectBackboneCandidate(candidate.result, candidate.signals)
        )
        .filter((candidate) =>
          this.isBugRedirectBackboneCandidate(candidate.result, candidate.signals)
          || candidate.seedHit
          || candidate.keywordHit
          || candidate.callerHit
        )
        .filter((candidate) => this.hasBugHandoffSpecificAnchor(candidate.result, candidate.signals))
        .filter((candidate) => !this.isBugFrontendHandoffNoiseCandidate(candidate.result, subjectProfile, candidate.signals))
        .filter((candidate) => !this.isBugOffDomainBackendCandidate(candidate.result, subjectProfile, candidate.signals))
        .filter((candidate) => !this.isBugGenericAuthEntryCandidate(candidate.result, subjectProfile, candidate.signals))
        .filter((candidate) => !this.isBugGenericStateSupportNoiseCandidate(candidate.result, subjectProfile, candidate.signals))
        .sort((a, b) => {
          const aLayers = this.detectWorkflowLayers(a.result.filePath.toLowerCase(), a.result.name.toLowerCase());
          const bLayers = this.detectWorkflowLayers(b.result.filePath.toLowerCase(), b.result.name.toLowerCase());
          const aText = `${a.result.filePath} ${a.result.name}`.toLowerCase();
          const bText = `${b.result.filePath} ${b.result.name}`.toLowerCase();
          const aBackbone = this.isBugRedirectBackboneCandidate(a.result, a.signals) ? 180 : 0;
          const bBackbone = this.isBugRedirectBackboneCandidate(b.result, b.signals) ? 180 : 0;
          const aRouting = aLayers.includes("routing") ? 120 : 0;
          const bRouting = bLayers.includes("routing") ? 120 : 0;
          const aState = aLayers.includes("state") ? 70 : 0;
          const bState = bLayers.includes("state") ? 70 : 0;
          const aUi = aLayers.includes("ui") ? 30 : 0;
          const bUi = bLayers.includes("ui") ? 30 : 0;
          const aDiversity = aLayers.some((layer) => !primaryLayers.includes(layer)) ? 45 : 0;
          const bDiversity = bLayers.some((layer) => !primaryLayers.includes(layer)) ? 45 : 0;
          const aAnchor = /\b(callback|redirect|protected|guard|pending|destination|auth|session|route|router|navigation)\b/.test(aText) ? 90 : 0;
          const bAnchor = /\b(callback|redirect|protected|guard|pending|destination|auth|session|route|router|navigation)\b/.test(bText) ? 90 : 0;
          const aSignal = a.signals.pathNameTermMatches * 40 + a.signals.primaryTagMatches * 40 + a.signals.rawLiteralMatches * 25;
          const bSignal = b.signals.pathNameTermMatches * 40 + b.signals.primaryTagMatches * 40 + b.signals.rawLiteralMatches * 25;
          const aUtilityPenalty = this.isUtilityLikePath(a.result.filePath.toLowerCase(), a.result.name.toLowerCase()) ? 80 : 0;
          const bUtilityPenalty = this.isUtilityLikePath(b.result.filePath.toLowerCase(), b.result.name.toLowerCase()) ? 80 : 0;
          return (bBackbone + bRouting + bState + bUi + bDiversity + bAnchor + bSignal + b.score - bUtilityPenalty)
            - (aBackbone + aRouting + aState + aUi + aDiversity + aAnchor + aSignal + a.score - aUtilityPenalty);
        })[0];
      takeCandidate(handoffSupportCandidate);
    }
    takeCandidate(
      (() => {
        const callerCandidate = scored.find((candidate) =>
          candidate.callerHit
          && candidate.strongDomainMatch
          && !seenFiles.has(candidate.result.filePath)
          && (!primarySelectedIsGate || !(candidate.feature?.isValidator || candidate.feature?.isGuard || candidate.feature?.isPredicate))
        );
        return callerCandidate ? bestScoredByFile.get(callerCandidate.result.filePath) ?? callerCandidate : undefined;
      })()
    );

    const hasFocusedBugPair =
      selected.length >= 2
      && primarySelectedIsGate
      && !!anchorCallerCandidate
      && seenFiles.has(anchorCallerCandidate.result.filePath);

    for (const candidate of scored) {
      if (hasFocusedBugPair) break;
      if (selected.length >= maxFiles) break;
      if (
        primarySelectedIsOrchestrator
        && !primarySelectedIsGate
        && !seenFiles.has(candidate.result.filePath)
        && candidate.signals.pathNameTermMatches === 0
        && candidate.signals.rawLiteralMatches === 0
        && candidate.signals.primaryTagMatches === 0
        && !candidate.callerHit
        && !candidate.seedHit
      ) {
        continue;
      }
      takeCandidate(candidate);
    }

    const promoted = selected.map((result) => {
      const feature = featureMap.get(result.id);
      if (
        (result.kind.includes("function") || result.kind.includes("method"))
        && this.isBugOrchestratorCandidate(result, feature)
        && anchorGateNames.some((gateName) => result.content.includes(gateName))
      ) {
        return result;
      }
      return this.promoteBugRepresentativeChunk(result, subjectProfile);
    });
    const cappedPromoted = this.isBugBackendRequestPrompt(subjectProfile)
      ? promoted.slice(0, 1)
      : promoted;
    return cappedPromoted.map((result, index) => {
      const normalizedScore = Math.max(1, 3 - index * 0.2);
      return {
        ...result,
        score: normalizedScore,
        hookScore: Math.max(result.hookScore ?? 0, normalizedScore),
      };
    });
  }

  private extractBugSalientTerms(query: string): string[] {
    const focusedExpanded = this.getModeFocusedExpandedTerms(query, "bug");
    const semanticAnchors = this.collectModeCompoundSemanticTerms(focusedExpanded);
    const negativeTerms = new Set(this.extractNegatedPromptTerms(query));
    const explicitCompoundTerms = tokenizeQueryTerms(query)
      .filter((term) => /[-_/]/.test(term))
      .flatMap((term) => normalizeTargetText(term).split(" ").filter(Boolean))
      .filter((term) =>
        term.length >= 3
        && !STOP_WORDS.has(term)
        && !BUG_NOISE_TERMS.has(term)
        && !GENERIC_QUERY_ACTION_TERMS.has(term)
        && !negativeTerms.has(term)
      );
    const rawTerms = tokenizeQueryTerms(query)
      .flatMap((term) => normalizeTargetText(term).split(" ").filter(Boolean))
      .filter((term) =>
        term.length >= 3
        && !STOP_WORDS.has(term)
        && !BUG_NOISE_TERMS.has(term)
        && !GENERIC_QUERY_ACTION_TERMS.has(term)
        && !negativeTerms.has(term)
      );
    const originalAnchors = focusedExpanded
      .filter((term) =>
        (term.source === "original" || term.source === "morphological")
        && !term.generic
        && term.weight >= 0.72
      )
      .flatMap((term) => normalizeTargetText(term.term).split(" ").filter(Boolean))
      .filter((term) =>
        term.length >= 3
        && !STOP_WORDS.has(term)
        && !BUG_NOISE_TERMS.has(term)
        && !BUG_LOW_SPECIFICITY_TERMS.has(term)
        && !GENERIC_QUERY_ACTION_TERMS.has(term)
        && !negativeTerms.has(term)
      );

    const prioritized = Array.from(new Set([
      ...explicitCompoundTerms,
      ...originalAnchors,
      ...rawTerms.filter((term) => !BUG_LOW_SPECIFICITY_TERMS.has(term) && !GENERIC_QUERY_ACTION_TERMS.has(term)),
      ...semanticAnchors,
    ])).filter((term) =>
      term.length >= 3
      && !STOP_WORDS.has(term)
      && !BUG_NOISE_TERMS.has(term)
      && !negativeTerms.has(term)
    );

    if (semanticAnchors.length >= 2) {
      const focused = prioritized.filter((term) =>
        semanticAnchors.includes(term)
        || originalAnchors.includes(term)
        || (!BUG_LOW_SPECIFICITY_TERMS.has(term) && term.length >= 5)
      );
      return Array.from(new Set(focused)).slice(0, 12);
    }

    return prioritized.slice(0, 12);
  }

  private buildBugPredicateResults(profile: BugSubjectProfile): SearchResult[] {
    const chunks = this.metadata.findPredicateLikeChunks(240);
    const featureMap = new Map(
      this.metadata.getChunkFeaturesByIds(chunks.map((chunk) => chunk.id)).map((feature) => [feature.chunkId, feature])
    );
    const tagMap = new Map<string, string[]>();
    for (const tag of this.metadata.getChunkTagsByIds(chunks.map((chunk) => chunk.id))) {
      const existing = tagMap.get(tag.chunkId) ?? [];
      existing.push(tag.tag);
      tagMap.set(tag.chunkId, existing);
    }

    return chunks
      .filter((chunk) => !isTestFile(chunk.filePath))
      .filter((chunk) => this.isImplementationPath(chunk.filePath))
      .map((chunk) => {
        const feature = featureMap.get(chunk.id);
        if (!feature) return null;
        if (feature.docLike || feature.testLike) return null;
        const tags = tagMap.get(chunk.id) ?? [];
        const signals = this.getBugCandidateSignals(
          { filePath: chunk.filePath, name: chunk.name, content: chunk.content },
          profile,
          tags
        );
        const anchored = this.hasBugMechanismAnchorSignals(signals, profile) || (profile.primaryTags.size === 0 && signals.relatedTagMatches > 0);
        const strictConnectionPrompt = profile.primaryTags.has("connection") || profile.primaryTags.has("schema");
        if (profile.focusTerms.length >= 2 && !signals.strongDomainMatch && signals.implementationMatches === 0 && signals.runtimeMatches === 0) return null;
        if (signals.negativeMatches > 0 && signals.pathNameTermMatches === 0) return null;
        if (profile.focusTerms.length > 0 && !anchored) return null;
        if (
          strictConnectionPrompt
          && !this.hasBugSpecificSubjectAnchor(chunk, profile)
          && signals.pathNameTermMatches === 0
          && signals.primaryTagMatches === 0
        ) {
          return null;
        }
        if (feature.isRegistry && !signals.strongDomainMatch) return null;
        if (feature.isUiComponent && !signals.strongDomainMatch && signals.runtimeMatches === 0) return null;
        if (this.isBugRedirectNoiseCandidate(chunk, signals, profile)) return null;
        if (this.isBugFrontendHandoffNoiseCandidate(chunk, profile, signals)) return null;
        if (this.isBugOffDomainBackendCandidate(chunk, profile, signals)) return null;
        if (this.isBugCrossDomainNoiseCandidate(chunk, profile, signals)) return null;
        if (this.isBugMigrationNoiseCandidate(chunk, profile, signals)) return null;

        let score = 2.5;
        if (feature.isValidator) score += 2;
        if (feature.isGuard) score += 1.8;
        if (feature.isPredicate) score += 1.4;
        score += Math.min(1.6, signals.termMatches * 0.45);
        score += Math.min(1.2, signals.implementationMatches * 0.3 + signals.runtimeMatches * 0.25);
        score += Math.min(1.8, signals.pathNameTermMatches * 0.7);
        score += Math.min(1.8, signals.primaryTagMatches * 0.7);
        score += Math.min(0.5, signals.relatedTagMatches * 0.2);
        score += Math.min(1.2, feature.branchCount * 0.1 + feature.guardCount * 0.25);
        score += Math.min(0.8, feature.callsPredicateCount * 0.2);
        score += signals.runtimeGateOverlap ? 1.5 : 0;
        if (feature.isController) score += 0.8;
        if (feature.writesState || feature.writesNetwork || feature.writesStorage) score += 0.2;
        if (feature.isRegistry) score -= 1.2;
        if (feature.isUiComponent && !signals.strongDomainMatch) score -= 1.2;
        score -= Math.min(3, signals.negativeMatches * 1.2);

        return this.chunkToSearchResult(chunk, score);
      })
      .filter((chunk): chunk is SearchResult => !!chunk)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40);
  }

  private buildBugCallerResults(results: SearchResult[], profile: BugSubjectProfile): SearchResult[] {
    const gateCandidates = results
      .filter((result) => BUG_GATE_RE.test(`${result.filePath} ${result.name}`))
      .filter((result) => {
        const tags = this.metadata.getChunkTagsByIds([result.id]).map((tag) => tag.tag);
        const signals = this.getBugCandidateSignals(
          { filePath: result.filePath, name: result.name, content: result.content },
          profile,
          tags
        );
        return this.hasBugMechanismAnchorSignals(signals, profile);
      })
      .filter((result) => result.kind.includes("function") || result.kind.includes("method"))
      .slice(0, 8);

    const callerScores = new Map<string, number>();
    for (const result of gateCandidates) {
      let gateScore = 6.5;
      if (BUG_GATE_RE.test(`${result.filePath} ${result.name}`)) gateScore += 1.5;
      if (result.hookScore) gateScore += Math.min(1.5, result.hookScore * 0.08);
      const callers = this.metadata.findCallers(result.name, 4, result.filePath);
      for (const caller of callers) {
        const current = callerScores.get(caller.chunkId) ?? 0;
        callerScores.set(caller.chunkId, Math.max(current, gateScore));
      }
    }

    const callerChunks = this.metadata.getChunksByIds(Array.from(callerScores.keys()));
    const featureMap = new Map(
      this.metadata.getChunkFeaturesByIds(callerChunks.map((chunk) => chunk.id)).map((feature) => [feature.chunkId, feature])
    );
    return callerChunks
      .filter((chunk) => !isTestFile(chunk.filePath))
      .filter((chunk) => this.isImplementationPath(chunk.filePath))
      .map((chunk, index) => {
        const feature = featureMap.get(chunk.id);
        const tags = this.metadata.getChunkTagsByIds([chunk.id]).map((tag) => tag.tag);
        const signals = this.getBugCandidateSignals(
          { filePath: chunk.filePath, name: chunk.name, content: chunk.content },
          profile,
          tags
        );
        if (
          (profile.primaryTags.has("connection") || profile.primaryTags.has("schema"))
          && !this.hasBugSpecificSubjectAnchor(chunk, profile)
          && signals.pathNameTermMatches === 0
          && signals.primaryTagMatches === 0
        ) {
          return null;
        }
        if (signals.negativeMatches > 0 && signals.pathNameTermMatches === 0) return null;
        if (this.isBugRedirectNoiseCandidate(chunk, signals, profile)) return null;
        if (this.isBugFrontendHandoffNoiseCandidate(chunk, profile, signals)) return null;
        if (this.isBugOffDomainBackendCandidate(chunk, profile, signals)) return null;
        if (this.isBugCrossDomainNoiseCandidate(chunk, profile, signals)) return null;
        if (this.isBugMigrationNoiseCandidate(chunk, profile, signals)) return null;
        let score = (callerScores.get(chunk.id) ?? 6.5) - index * 0.05;
        score += Math.min(1.8, (feature?.callsPredicateCount ?? 0) * 0.25);
        score += Math.min(1.2, (feature?.branchCount ?? 0) * 0.08 + (feature?.guardCount ?? 0) * 0.18);
        if (signals.pathNameTermMatches > 0) score += 1.2;
        if (signals.primaryTagMatches > 0) score += 1.2;
        if (signals.implementationMatches > 0) score += Math.min(1.4, signals.implementationMatches * 0.3);
        if (signals.runtimeMatches > 0) score += Math.min(1.1, signals.runtimeMatches * 0.25);
        if (signals.runtimeGateOverlap) score += 0.8;
        if (this.isBugOrchestratorCandidate(chunk, feature)) score += 1.2;
        if (feature?.isUiComponent && !signals.strongDomainMatch) score -= 1.2;
        return this.chunkToSearchResult(chunk, score);
      })
      .filter((chunk): chunk is SearchResult => chunk !== null)
      .sort((a, b) => b.score - a.score);
  }

  private buildBugNeighborResults(results: SearchResult[], profile: BugSubjectProfile): SearchResult[] {
    const byFile = new Map<string, SearchResult[]>();
    for (const result of results) {
      const existing = byFile.get(result.filePath) ?? [];
      existing.push(result);
      byFile.set(result.filePath, existing);
    }

    const neighbors: SearchResult[] = [];
    for (const [filePath] of byFile) {
      const fileChunks = this.metadata.findChunksByFilePath(filePath);
      const localFeatures = new Map(
        this.metadata.getChunkFeaturesByIds(fileChunks.map((chunk) => chunk.id)).map((feature) => [feature.chunkId, feature])
      );
      const ranked = fileChunks
        .map((chunk) => {
          const feature = localFeatures.get(chunk.id);
          if (!feature || feature.docLike || feature.testLike) return null;
          const tags = this.metadata.getChunkTagsByIds([chunk.id]).map((tag) => tag.tag);
          const signals = this.getBugCandidateSignals(
            { filePath: chunk.filePath, name: chunk.name, content: chunk.content },
            profile,
            tags
          );
          let score = 0;
          if (feature.isValidator) score += 2.1;
          if (feature.isGuard) score += 1.8;
          if (feature.isPredicate) score += 1.2;
          score += Math.min(1.7, feature.branchCount * 0.12 + feature.guardCount * 0.3 + feature.callsPredicateCount * 0.25);
          score += Math.min(1.3, signals.termMatches * 0.5);
          score += Math.min(1.2, signals.implementationMatches * 0.3 + signals.runtimeMatches * 0.25);
          score += Math.min(1.8, signals.pathNameTermMatches * 0.8);
          score += Math.min(1.8, signals.primaryTagMatches * 0.8);
        if (signals.runtimeGateOverlap) score += 1.2;
        score += signals.surfaceAlignment * 0.9;
        return score > 0
            ? this.chunkToSearchResult(chunk, 5 + score)
            : null;
        })
        .filter((chunk): chunk is SearchResult => !!chunk)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);
      neighbors.push(...ranked);
    }

    return neighbors;
  }

  private promoteBugRepresentativeChunk(result: SearchResult, profile: BugSubjectProfile): SearchResult {
    const fileChunks = this.metadata.findChunksByFilePath(result.filePath);
    const featureMap = new Map(
      this.metadata.getChunkFeaturesByIds(fileChunks.map((chunk) => chunk.id)).map((feature) => [feature.chunkId, feature])
    );
    const tagMap = new Map<string, string[]>();
    for (const tag of this.metadata.getChunkTagsByIds(fileChunks.map((chunk) => chunk.id))) {
      const existing = tagMap.get(tag.chunkId) ?? [];
      existing.push(tag.tag);
      tagMap.set(tag.chunkId, existing);
    }
    const originalFeature = featureMap.get(result.id);
    const originalSignals = this.getBugCandidateSignals(
      { filePath: result.filePath, name: result.name, content: result.content },
      profile,
      tagMap.get(result.id) ?? []
    );
    const candidates = fileChunks
      .filter((chunk) => chunk.kind !== "file")
      .map((chunk) => {
        const feature = featureMap.get(chunk.id);
        const tags = tagMap.get(chunk.id) ?? [];
        const combinedRaw = `${chunk.filePath} ${chunk.name} ${chunk.content.slice(0, 1200)}`;
        const combined = combinedRaw.toLowerCase();
        const signals = this.getBugCandidateSignals(
          { filePath: chunk.filePath, name: chunk.name, content: chunk.content },
          profile,
          tags
        );
        if (
          (profile.primaryTags.has("connection") || profile.primaryTags.has("schema"))
          && !this.hasBugSpecificSubjectAnchor(chunk, profile)
          && signals.pathNameTermMatches === 0
          && signals.primaryTagMatches === 0
        ) {
          return null;
        }
        let score = 0;
        if (BUG_GATE_RE.test(combined)) score += 2.2;
        if (/(valid|validate|check|compat|connect|connection|guard|schema|reject|allow)/i.test(chunk.name)) score += 1.8;
        const termMatches = profile.subjectTerms.filter((term) => textMatchesQueryTerm(combinedRaw, term)).length;
        score += termMatches * 0.35;
        if (/\breturn\s+(true|false)\b/.test(combined)) score += 0.6;
        if (/\b(if|switch)\s*\(/.test(combined)) score += 0.4;
        if (chunk.kind.includes("function") || chunk.kind.includes("method")) score += 2.2;
        if (chunk.kind.includes("type") || chunk.kind.includes("interface")) score -= 1.4;
        if (feature?.isValidator) score += 2.6;
        if (feature?.isGuard) score += 1.9;
        if (feature?.isPredicate) score += 1.5;
        if (feature?.returnsBoolean) score += 1.2;
        if (feature?.isController) score += 1;
        score += Math.min(1.6, (feature?.callsPredicateCount ?? 0) * 0.35);
        score += Math.min(1.2, (feature?.branchCount ?? 0) * 0.08 + (feature?.guardCount ?? 0) * 0.18);
        score += Math.min(1.2, signals.implementationMatches * 0.3 + signals.runtimeMatches * 0.25);
        if (signals.pathNameTermMatches > 0) score += Math.min(2.4, signals.pathNameTermMatches * 0.7);
        if (signals.primaryTagMatches > 0) score += Math.min(2.4, signals.primaryTagMatches * 0.8);
        if (signals.runtimeGateOverlap) score += 1.1;
        score += signals.surfaceAlignment * 0.9;
        if (chunk.kind.includes("type") || chunk.kind.includes("interface")) score -= 4.5;
        if (feature?.isUiComponent && !signals.strongDomainMatch && signals.runtimeMatches === 0) score -= 3;
        if (feature?.isRegistry && !signals.strongDomainMatch) score -= 3;
        if (!signals.strongDomainMatch && signals.implementationMatches === 0 && signals.runtimeMatches === 0) score -= 2.5;
        return { chunk, score };
      })
      .filter((candidate): candidate is { chunk: StoredChunk; score: number } => candidate !== null)
      .sort((a, b) => b.score - a.score);

    const best = candidates[0]?.chunk;
    if (!best || candidates[0]!.score <= 0) return result;
    const bestFeature = featureMap.get(best.id);
    if (
      this.isBugOrchestratorCandidate(result, originalFeature)
      && (result.kind.includes("function") || result.kind.includes("method"))
      && (
        (
          originalSignals.pathNameTermMatches > 0
          && originalSignals.strongDomainMatch
          && ((originalFeature?.callsPredicateCount ?? 0) > 0 || (originalFeature?.branchCount ?? 0) > 1)
        )
        || !this.isBugGateLike({ filePath: best.filePath, name: best.name, content: best.content }, bestFeature)
      )
    ) {
      return result;
    }

    return this.chunkToSearchResult(best, Math.max(result.score, result.hookScore ?? result.score));
  }

  private selectBroadWorkflowBundle(
    query: string,
    results: SearchResult[],
    seedResult?: SeedResult,
    maxContextChunks: number = 8
  ): SearchResult[] {
    const queryMode = classifyIntent(query).queryMode;
    const isChangeMode = queryMode === "change";
    const isCrossCuttingChangeQuery =
      /\b(every\s+step|across|throughout|full|entire|complete|end-to-end|all\s+steps)\b/i.test(query);
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
    const isBillingBackboneFile = (candidate: BroadFileCandidate): boolean => {
      const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
      if (!/\b(billing|checkout|portal|subscription|invoice|payment|credit|stripe)\b/.test(text)) return false;
      if (/(?:^|\/)src\/pages\//.test(candidate.filePath)) return true;
      if (/(?:controller|service)/.test(text)) return true;
      if (candidate.layers.includes("backend") || candidate.layers.includes("state")) return true;
      if (/(?:^|\/)supabase\/functions\//.test(candidate.filePath)) return true;
      return false;
    };
    const isRoutingBackboneFile = (candidate: BroadFileCandidate): boolean => {
      const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
      if (/\/(App|_app|Root|Main|Layout)\.[jt]sx?$/.test(candidate.filePath)) return true;
      if (/\b(protected|guard|redirect|callback|router|route)\b/.test(text)) return true;
      if (/(?:^|\/)src\/lib\/navigation\.ts$/.test(candidate.filePath)) return true;
      return false;
    };
    const isRoutingUiNoise = (candidate: BroadFileCandidate): boolean => {
      const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
      return /\b(keyboard|drawer|menu|mobile|floating|tab)\b/.test(text);
    };
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
    const requireStrictWorkflowFamilyAlignment =
      !profile.inventoryMode
      && !profile.lifecycleMode
      && !!dominantFamily
      && STRICT_WORKFLOW_FAMILY_COHESION.has(dominantFamily);

    const trySelectFile = (candidate: BroadFileCandidate | undefined) => {
      if (!candidate) return;
      if (seenFilePaths.has(candidate.filePath)) return;
      if (candidate.callbackNoise) return;
      if (
        requireStrictWorkflowFamilyAlignment
        && !this.isStrictWorkflowFamilyCandidate(profile, dominantFamily, candidate)
      ) {
        return;
      }
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

    if (isChangeMode) {
      const selectedLayers = new Set(selectedFiles.flatMap((candidate) => candidate.layers));
      const changeExpansionLimit = Math.min(maxContextChunks, 4);
      const rankedChangeCandidates = [...scopedFileCandidates].sort((a, b) => {
        const aDominant = dominantFamily && (
          a.matchedFamilies.includes(dominantFamily) || a.filePath.includes(`/${dominantFamily}/`)
        ) ? 1 : 0;
        const bDominant = dominantFamily && (
          b.matchedFamilies.includes(dominantFamily) || b.filePath.includes(`/${dominantFamily}/`)
        ) ? 1 : 0;
        if (aDominant !== bDominant) return bDominant - aDominant;
        const aLayerDiversity = a.layers.some((layer) => !selectedLayers.has(layer)) ? 1 : 0;
        const bLayerDiversity = b.layers.some((layer) => !selectedLayers.has(layer)) ? 1 : 0;
        if (aLayerDiversity !== bLayerDiversity) return bLayerDiversity - aLayerDiversity;
        const aSignals = a.coreAnchorCount * 4 + a.directAnchorCount * 3 + a.phraseMatchCount * 2;
        const bSignals = b.coreAnchorCount * 4 + b.directAnchorCount * 3 + b.phraseMatchCount * 2;
        if (aSignals !== bSignals) return bSignals - aSignals;
        return b.score - a.score;
      });

      for (const candidate of rankedChangeCandidates) {
        if (selectedFiles.length >= changeExpansionLimit) break;
        if (seenFilePaths.has(candidate.filePath)) continue;
        const text = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
        if (queryMentionsLogging && isObservabilityFile(candidate) && selectedFiles.length < 3) continue;
        if (
          dominantFamily === "auth"
          && !/\b(auth|login|signin|session|callback|redirect|protected|guard)\b/.test(text)
          && !candidate.matchedFamilies.includes("auth")
          && !candidate.matchedFamilies.includes("routing")
        ) {
          continue;
        }
        trySelectFile(candidate);
        for (const layer of candidate.layers) selectedLayers.add(layer);
      }

      if (dominantFamily === "auth" && selectedFiles.length < changeExpansionLimit) {
        const authFallbackCandidates = this.mergeBroadFileCandidates(
          [...scopedFileCandidates],
          [...fileCandidates]
        )
          .filter((candidate) => !seenFilePaths.has(candidate.filePath))
          .filter((candidate) => {
            const text = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
            return /\b(auth|login|signin|session|callback|redirect|protected|guard)\b/.test(text)
              || candidate.matchedFamilies.includes("auth")
              || candidate.matchedFamilies.includes("routing");
          })
          .sort((a, b) => {
            const aText = normalizeTargetText(`${a.filePath} ${a.primary.result.name}`);
            const bText = normalizeTargetText(`${b.filePath} ${b.primary.result.name}`);
            const aBackbone = /\b(callback|redirect|protected|guard|auth|signin|login)\b/.test(aText) ? 100 : 0;
            const bBackbone = /\b(callback|redirect|protected|guard|auth|signin|login)\b/.test(bText) ? 100 : 0;
            const aLayerDiversity = a.layers.some((layer) => !selectedLayers.has(layer)) ? 35 : 0;
            const bLayerDiversity = b.layers.some((layer) => !selectedLayers.has(layer)) ? 35 : 0;
            return (bBackbone + bLayerDiversity + b.score) - (aBackbone + aLayerDiversity + a.score);
          });
        for (const candidate of authFallbackCandidates) {
          if (selectedFiles.length >= changeExpansionLimit) break;
          trySelectFile(candidate);
          for (const layer of candidate.layers) selectedLayers.add(layer);
        }
      }

      if (
        isCrossCuttingChangeQuery
        && (dominantFamily === "auth" || dominantFamily === "routing")
        && selectedFiles.length < changeExpansionLimit
      ) {
        const authRoutingChangeCandidates = this.mergeBroadFileCandidates(
          [...scopedFileCandidates],
          [...fileCandidates]
        )
          .filter((candidate) => !seenFilePaths.has(candidate.filePath))
          .filter((candidate) => {
            const text = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
            return /\b(auth|login|signin|session|callback|redirect|protected|guard|route|router|pending|destination)\b/.test(text)
              || candidate.matchedFamilies.includes("auth")
              || candidate.matchedFamilies.includes("routing");
          })
          .filter((candidate) => !isObservabilityFile(candidate))
          .sort((a, b) => {
            const aText = normalizeTargetText(`${a.filePath} ${a.primary.result.name}`);
            const bText = normalizeTargetText(`${b.filePath} ${b.primary.result.name}`);
            const aBackbone = /\b(callback|redirect|protected|guard|pending|destination)\b/.test(aText) ? 110 : 0;
            const bBackbone = /\b(callback|redirect|protected|guard|pending|destination)\b/.test(bText) ? 110 : 0;
            const aLayerDiversity = a.layers.some((layer) => !selectedLayers.has(layer)) ? 40 : 0;
            const bLayerDiversity = b.layers.some((layer) => !selectedLayers.has(layer)) ? 40 : 0;
            const aUiRouting = a.layers.includes("routing") || a.layers.includes("ui") ? 20 : 0;
            const bUiRouting = b.layers.includes("routing") || b.layers.includes("ui") ? 20 : 0;
            return (bBackbone + bLayerDiversity + bUiRouting + b.score)
              - (aBackbone + aLayerDiversity + aUiRouting + a.score);
          });
        for (const candidate of authRoutingChangeCandidates) {
          if (selectedFiles.length >= changeExpansionLimit) break;
          trySelectFile(candidate);
          for (const layer of candidate.layers) selectedLayers.add(layer);
        }
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
          if (dominantFamily === "billing") {
            const aBackbone = isBillingBackboneFile(a) ? 1 : 0;
            const bBackbone = isBillingBackboneFile(b) ? 1 : 0;
            if (aBackbone !== bBackbone) return bBackbone - aBackbone;
          }
          if (dominantFamily === "routing") {
            const aBackbone = isRoutingBackboneFile(a) ? 1 : 0;
            const bBackbone = isRoutingBackboneFile(b) ? 1 : 0;
            if (aBackbone !== bBackbone) return bBackbone - aBackbone;
            const aNoise = isRoutingUiNoise(a) ? 1 : 0;
            const bNoise = isRoutingUiNoise(b) ? 1 : 0;
            if (aNoise !== bNoise) return aNoise - bNoise;
          }
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

    if (
      isChangeMode
      && isCrossCuttingChangeQuery
      && (dominantFamily === "auth" || dominantFamily === "routing")
      && orderedSelectedFiles.length < Math.min(maxContextChunks, 4)
    ) {
      const orderedSeen = new Set(orderedSelectedFiles.map((candidate) => candidate.filePath));
      const supplementalAuthRoutingFiles = this.mergeBroadFileCandidates(
        [...scopedFileCandidates],
        [...fileCandidates]
      )
        .filter((candidate) => !orderedSeen.has(candidate.filePath))
        .filter((candidate) => {
          const text = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
          return /\b(callback|redirect|protected|guard|pending|destination|auth|login|signin|session|route|router)\b/.test(text)
            || candidate.matchedFamilies.includes("auth")
            || candidate.matchedFamilies.includes("routing");
        })
        .filter((candidate) => !isObservabilityFile(candidate))
        .sort((a, b) => {
          const aText = normalizeTargetText(`${a.filePath} ${a.primary.result.name}`);
          const bText = normalizeTargetText(`${b.filePath} ${b.primary.result.name}`);
          const aBackbone = /\b(callback|redirect|protected|guard|pending|destination)\b/.test(aText) ? 120 : 0;
          const bBackbone = /\b(callback|redirect|protected|guard|pending|destination)\b/.test(bText) ? 120 : 0;
          const aLayerDiversity = a.layers.some((layer) => !orderedSelectedFiles.flatMap((item) => item.layers).includes(layer)) ? 30 : 0;
          const bLayerDiversity = b.layers.some((layer) => !orderedSelectedFiles.flatMap((item) => item.layers).includes(layer)) ? 30 : 0;
          return (bBackbone + bLayerDiversity + b.score) - (aBackbone + aLayerDiversity + a.score);
        })
        .slice(0, Math.min(maxContextChunks, 4) - orderedSelectedFiles.length);
      orderedSelectedFiles.push(...supplementalAuthRoutingFiles);
    }

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
    const familyConfidence = this.computeBroadSelectionConfidence(
      profile,
      "workflow",
      dominantFamily,
      orderedSelectedFiles
    );
    const deferredReason = this.shouldDeferBroadSelection(profile, "workflow", {
      dominantFamily,
      selectedFiles: orderedSelectedFiles,
      familyConfidence,
    });
    const diagnosticSelectedFiles = deferredReason
      ? orderedSelectedFiles.slice(0, 3).map((candidate) => ({
          filePath: candidate.filePath,
          selectionSource: "workflow_bundle",
        }))
      : Array.from(new Set(finalChunks.map((candidate) => candidate.result.filePath))).map((filePath) => ({
          filePath,
          selectionSource: "workflow_bundle",
        }));
    this.lastBroadSelection = {
      broadMode: "workflow",
      dominantFamily: dominantFamily ?? undefined,
      deliveryMode: deferredReason ? "summary_only" : "code_context",
      familyConfidence,
      selectedFiles: diagnosticSelectedFiles,
      fallbackReason: finalChunks.length === 0 ? "no_workflow_file_candidates" : undefined,
      deferredReason: deferredReason ?? undefined,
    };

    if (deferredReason) {
      return results;
    }
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
    const familyConfidence = this.computeBroadSelectionConfidence(
      profile,
      "inventory",
      dominantFamily,
      selectedFiles
    );
    const deferredReason = this.shouldDeferBroadSelection(profile, "inventory", {
      dominantFamily,
      selectedFiles,
      familyConfidence,
    });
    const diagnosticSelectedFiles = deferredReason
      ? selectedFiles.slice(0, 3).map((candidate) => ({
          filePath: candidate.filePath,
          selectionSource: candidate.selectionSource,
        }))
      : Array.from(new Map(selectedChunks.map((candidate) => [candidate.result.filePath, candidate.result.filePath])).values())
          .map((filePath) => ({
            filePath,
            selectionSource: "inventory_bundle",
          }));

    this.lastBroadSelection = {
      broadMode: "inventory",
      dominantFamily: dominantFamily ?? undefined,
      deliveryMode: deferredReason ? "summary_only" : "code_context",
      familyConfidence,
      selectedFiles: diagnosticSelectedFiles,
      fallbackReason: selectedFiles.length === 0 ? "no_inventory_file_candidates" : undefined,
      deferredReason: deferredReason ?? undefined,
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
    const matchesAllowedFamilies = (base: BroadFileCandidate): boolean =>
      profile.allowedFamilies.size === 0
      || base.matchedFamilies.some((family) => profile.allowedFamilies.has(family));

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
      const allowedFamilyCoverage = profile.allowedFamilies.size > 0
        ? base.matchedFamilies.filter((family) => profile.allowedFamilies.has(family)).length
        : 0;
      const orchestratorLike = this.isBroadOrchestratorLikePath(
        filePath.toLowerCase(),
        base.primary.result.name.toLowerCase()
      );

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
          + (allowedFamilyCoverage > 0 ? Math.min(0.42, allowedFamilyCoverage * 0.16) : 0)
          + (
            profile.workflowTraceMode
            && orchestratorLike
            && (allowedFamilyCoverage > 0 || base.coreAnchorCount > 0 || base.phraseMatchCount > 0)
              ? 0.26
              : 0
          )
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
        && !matchesAllowedFamilies(base)
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
    if (profile.workflowTraceMode && profile.allowedFamilies.size > 1 && typeof this.metadata.findTargetsBySubsystem === "function") {
      for (const family of profile.allowedFamilies) {
        if (family === dominantFamily) continue;
        for (const target of this.metadata.findTargetsBySubsystem([family], 40)) {
          upsert(
            target.filePath,
            target.kind === "file_module" || target.kind === "endpoint" ? "typed_target" : "subsystem",
            target.kind,
            target.kind === "file_module" || target.kind === "endpoint" ? 0.14 : 0.08
          );
        }
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
    const queryMentionsProtection = profile.tokens.includes("protection") || profile.tokens.includes("protected") || profile.tokens.includes("guard");
    const queryMentionsPending = profile.tokens.includes("pending") || profile.tokens.includes("pendingnavigation");
    const routingInventoryBackbone = (candidate: InventoryFileCandidate): boolean => {
      const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
      if (/\/(App|_app|Root|Main|Layout)\.[jt]sx?$/.test(candidate.filePath)) return true;
      if (/\b(protected|guard|redirect|callback|auth|route|router)\b/.test(text)) return true;
      if (queryMentionsPending && /\bpending\b/.test(text)) return true;
      return false;
    };
    const routingInventoryNoise = (candidate: InventoryFileCandidate): boolean => {
      const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
      return /\b(skip|keyboard|drawer|menu|mobile|floating|tab|a11y)\b/.test(text)
        && !/\b(protected|guard|redirect|callback|auth|pending|route|router)\b/.test(text);
    };
    const matchesAcceptedFamily = (candidate: InventoryFileCandidate): boolean => {
      if (!dominantFamily && profile.allowedFamilies.size === 0) return true;
      if (dominantFamily && (candidate.subsystemMatch || candidate.matchedFamilies.includes(dominantFamily))) return true;
      return profile.allowedFamilies.size > 1
        && candidate.matchedFamilies.some((family) => profile.allowedFamilies.has(family));
    };

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
      if (profile.workflowTraceMode && profile.allowedFamilies.size > 1) {
        const aCoverage = a.matchedFamilies.filter((family) => profile.allowedFamilies.has(family)).length;
        const bCoverage = b.matchedFamilies.filter((family) => profile.allowedFamilies.has(family)).length;
        if (aCoverage !== bCoverage) return bCoverage - aCoverage;
      }
      const aFamily = dominantFamily && (a.subsystemMatch || a.matchedFamilies.includes(dominantFamily)) ? 1 : 0;
      const bFamily = dominantFamily && (b.subsystemMatch || b.matchedFamilies.includes(dominantFamily)) ? 1 : 0;
      if (aFamily !== bFamily) return bFamily - aFamily;
      if (dominantFamily === "routing" || (dominantFamily === "auth" && (queryMentionsProtection || queryMentionsPending))) {
        const aBackbone = routingInventoryBackbone(a) ? 1 : 0;
        const bBackbone = routingInventoryBackbone(b) ? 1 : 0;
        if (aBackbone !== bBackbone) return bBackbone - aBackbone;
        const aNoise = routingInventoryNoise(a) ? 1 : 0;
        const bNoise = routingInventoryNoise(b) ? 1 : 0;
        if (aNoise !== bNoise) return aNoise - bNoise;
      }
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
            && matchesAcceptedFamily(candidate)
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
        && !matchesAcceptedFamily(candidate)
        && candidate.coreAnchorCount === 0
        && candidate.phraseMatchCount === 0
      ) {
        continue;
      }
      if (
        (dominantFamily || profile.allowedFamilies.size > 0)
        && !matchesAcceptedFamily(candidate)
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
          && (!profile.inventoryMode || !INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(normalizeTargetText(term.term)))
        ),
        ...profile.anchorTerms.filter((term) => {
          if (term.family && profile.allowedFamilies.size > 0 && !profile.allowedFamilies.has(term.family)) {
            return false;
          }
          if (profile.inventoryMode && INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(normalizeTargetText(term.term))) {
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
      const backendSupport = fileCandidates
        .slice(0, 12)
        .filter((candidate) =>
          candidate.matchedFamilies.includes(family)
          && candidate.layers.includes("backend")
          && !candidate.utilityLike
          && !candidate.callbackNoise
        ).length;
      const adjustedScore =
        family === "logging" && scores.size > 1
          ? score * 0.72
          : score;
      const workflowAdjustedScore = profile.workflowTraceMode
        ? adjustedScore + backendSupport * 0.55
        : adjustedScore;
      if (workflowAdjustedScore > bestScore) {
        bestFamily = family;
        bestScore = workflowAdjustedScore;
      }
    }
    return bestFamily;
  }

  private isBroadCandidateFamilyAligned(
    profile: BroadQueryProfile,
    dominantFamily: string | null,
    candidate: BroadFileCandidate
  ): boolean {
    if (!dominantFamily) return candidate.coreAnchorCount > 0 || candidate.matchedFamilies.length > 0;
    if (candidate.filePath.includes(`/${dominantFamily}/`)) return true;
    if (candidate.matchedFamilies.includes(dominantFamily)) return true;
    if (
      profile.allowedFamilies.size > 1
      && candidate.matchedFamilies.some((family) => profile.allowedFamilies.has(family))
    ) {
      return true;
    }
    const aliases = this.getBroadFamilyAliases(profile, dominantFamily);
    if (aliases.length === 0) return false;
    const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
    return aliases.some((alias) => textMatchesQueryTerm(text, alias));
  }

  private isStrictWorkflowFamilyCandidate(
    profile: BroadQueryProfile,
    dominantFamily: string,
    candidate: BroadFileCandidate
  ): boolean {
    const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
    const dominantAliases = this.getBroadFamilyAliases(profile, dominantFamily);
    const hasDominantAlias = dominantAliases.some((alias) => textMatchesQueryTerm(text, alias));
    const genericWorkflowSubsystem =
      /(?:^|\/)(flow|workflow|pipeline)(?:\/|$)/.test(candidate.filePath.toLowerCase())
      || /\b(workflow|pipeline)\b/.test(candidate.primary.result.name.toLowerCase());
    if (genericWorkflowSubsystem && !hasDominantAlias) {
      return false;
    }

    if (candidate.filePath.includes(`/${dominantFamily}/`)) return true;
    if (candidate.matchedFamilies.includes(dominantFamily)) {
      return candidate.directAnchorCount > 0
        || candidate.coreAnchorCount > 0
        || candidate.phraseMatchCount > 0
        || hasDominantAlias;
    }

    const adjacentFamilies = ADJACENT_WORKFLOW_FAMILIES[dominantFamily] ?? [];
    if (adjacentFamilies.some((family) => candidate.matchedFamilies.includes(family))) {
      if (dominantFamily === "auth") {
        const candidateText = normalizeTargetText(`${candidate.filePath} ${candidate.primary.result.name}`);
        return candidate.layers.includes("routing")
          || candidate.layers.includes("state")
          || /\/(App|_app|Root|Main|Layout)\.[jt]sx?$/.test(candidate.filePath)
          || /\b(route|router|routing|redirect|callback|guard|protected|destination|pending|navigation)\b/.test(candidateText);
      }
      if (dominantFamily === "routing") {
        return candidate.layers.includes("state")
          || /\/(App|_app|Root|Main|Layout)\.[jt]sx?$/.test(candidate.filePath);
      }
      return candidate.directAnchorCount > 0 || candidate.phraseMatchCount > 0;
    }

    return false;
  }

  private computeBroadSelectionConfidence(
    profile: BroadQueryProfile,
    mode: BroadMode,
    dominantFamily: string | null,
    candidates: BroadFileCandidate[]
  ): number {
    if (candidates.length === 0) return 0;
    const considered = candidates.slice(0, Math.min(6, candidates.length));
    const alignedCandidates = considered.filter((candidate) =>
      this.isBroadCandidateFamilyAligned(profile, dominantFamily, candidate)
    );
    const familyAligned = alignedCandidates.length / considered.length;
    const alignedNonUtilityRatio = alignedCandidates.filter((candidate) =>
      !candidate.utilityLike
      && !candidate.callbackNoise
      && !candidate.genericOnly
    ).length / considered.length;
    const anchorStrength = considered.reduce((sum, candidate) => sum + Math.min(1, (
      candidate.coreAnchorCount * 0.45
      + candidate.directAnchorCount * 0.2
      + candidate.phraseMatchCount * 0.2
      + (candidate.matchedFamilies.length > 0 ? 0.15 : 0)
    )), 0) / considered.length;
    const lowNoiseRatio = considered.filter((candidate) => !candidate.utilityLike && !candidate.callbackNoise && !candidate.genericOnly).length / considered.length;
    const sharedHeavyRate = considered.filter((candidate) =>
      candidate.layers.every((layer) => layer === "shared" || layer === "core")
    ).length / considered.length;
    const offFamilyNoiseRate = considered.filter((candidate) =>
      !this.isBroadCandidateFamilyAligned(profile, dominantFamily, candidate)
      && (
        candidate.utilityLike
        || candidate.genericOnly
        || candidate.layers.every((layer) => layer === "shared" || layer === "core")
      )
    ).length / considered.length;
    const backendBackboneRatio = considered.filter((candidate) =>
      this.isBroadCandidateFamilyAligned(profile, dominantFamily, candidate)
      && candidate.layers.includes("backend")
      && !candidate.utilityLike
    ).length / considered.length;
    const layerCoverage = new Set(
      considered.flatMap((candidate) => candidate.layers.filter((layer) => layer !== "shared" && layer !== "core"))
    ).size;
    const layerScore = mode === "workflow"
      ? Math.min(1, layerCoverage / 3)
      : Math.min(1, considered.length / 4);

    let score =
      (dominantFamily ? 0.1 : 0)
      + familyAligned * 0.26
      + alignedNonUtilityRatio * 0.2
      + anchorStrength * 0.18
      + lowNoiseRatio * 0.12
      + layerScore * 0.08
      + backendBackboneRatio * (mode === "workflow" ? 0.08 : 0.04)
      - offFamilyNoiseRate * 0.22
      - sharedHeavyRate * 0.12;

    if (mode === "inventory" && profile.allowedFamilies.size > 1) {
      const multiFamilyCoverage = considered.filter((candidate) =>
        candidate.matchedFamilies.some((family) => profile.allowedFamilies.has(family))
      ).length / considered.length;
      score += multiFamilyCoverage * 0.05;
      if (profile.workflowTraceMode) {
        score += multiFamilyCoverage * 0.08;
      }
    }

    return Number(Math.max(0, Math.min(1, score)).toFixed(3));
  }

  private shouldDeferBroadSelection(
    profile: BroadQueryProfile,
    mode: BroadMode,
    diagnostics: {
      dominantFamily: string | null;
      selectedFiles: BroadFileCandidate[];
      familyConfidence: number;
    }
  ): string | null {
    const { dominantFamily, selectedFiles, familyConfidence } = diagnostics;
    if (selectedFiles.length === 0) return mode === "inventory" ? "no_inventory_candidates" : "no_workflow_candidates";
    if (!dominantFamily && !profile.lifecycleMode) return "no_dominant_family";

    const limit = mode === "inventory" ? 0.8 : 0.72;
    if (familyConfidence < limit) return "low_family_confidence";

    if (mode === "inventory" && selectedFiles.length < 3) return "insufficient_inventory_coverage";

    const highNoiseRate = selectedFiles.filter((candidate) => candidate.utilityLike || candidate.callbackNoise || candidate.genericOnly).length / selectedFiles.length;
    if (highNoiseRate > 0.34) return "high_noise_bundle";

    const considered = selectedFiles.slice(0, Math.min(mode === "inventory" ? 6 : 5, selectedFiles.length));
    const alignedCandidates = considered.filter((candidate) =>
      this.isBroadCandidateFamilyAligned(profile, dominantFamily, candidate)
    );
    const alignedRatio = alignedCandidates.length / considered.length;
    if (alignedRatio < (mode === "inventory" ? 0.8 : 0.6)) return "low_family_cohesion";

    const alignedBackbone = alignedCandidates.filter((candidate) =>
      !candidate.utilityLike
      && !candidate.callbackNoise
      && !candidate.genericOnly
      && !candidate.layers.every((layer) => layer === "shared" || layer === "core")
    );
    if (alignedBackbone.length < (mode === "inventory" ? 3 : 2)) return "weak_family_backbone";

    const queryText = profile.tokens.join(" ");
    const mentionsUploadDomain = /\b(upload|storage|media|signed|bucket|write)\b/.test(queryText);
    const mentionsBillingDomain = /\b(billing|checkout|portal|subscription|invoice|payment|credit)\b/.test(queryText);
    const mentionsGenerationDomain = /\b(generate|generation|image|shot|render|regen)\b/.test(queryText);
    const mentionsFullTrace = /\b(full|trace|flow)\b/.test(queryText);
    const mentionsUiBoundary = /\b(ui|request|edge|storage|write)\b/.test(queryText);

    const candidateText = (candidate: BroadFileCandidate): string =>
      `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
    const hasStrongAnchor = (candidate: BroadFileCandidate, pattern: RegExp): boolean =>
      pattern.test(candidateText(candidate));

    if (dominantFamily === "generation") {
      const generationBackbone = alignedCandidates.filter((candidate) => {
        const text = candidate.filePath.toLowerCase();
        const hasGenPath = /\b(generate|generation|regener|render)\b/.test(text);
        return (candidate.layers.includes("backend") || candidate.layers.includes("state")) && hasGenPath;
      });
      if (generationBackbone.length < 2) return "missing_generation_backbone";
      const weakGenerationRatio = considered.filter((candidate) => {
        const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
        const hasStrongGenerationAnchor =
          /\b(generate|generation|regener|image|render|orchestrated)\b/.test(text);
        const sharedHelper = candidate.layers.every((layer) => layer === "shared" || layer === "core");
        const weakByName = !hasStrongGenerationAnchor && !sharedHelper;
        return weakByName || (sharedHelper && !hasStrongGenerationAnchor);
      }).length / considered.length;
      if (weakGenerationRatio > 0.3) return "weak_generation_bundle";
      if (mentionsGenerationDomain && mentionsFullTrace && mentionsUiBoundary) {
        const uiGeneration = alignedCandidates.filter((candidate) =>
          candidate.layers.includes("ui") && hasStrongAnchor(candidate, /\b(generate|generation|image|shot|render)\b/)
        );
        if (uiGeneration.length < 1) return "missing_generation_layers";
        const helperHeavyRatio = considered.filter((candidate) => {
          const text = candidateText(candidate);
          return /(?:logger|share|progress|client|analytics)/.test(text)
            && !/\bgenerate\b/.test(text);
        }).length / considered.length;
        if (helperHeavyRatio > 0.25) return "helper_heavy_generation_bundle";
      }
    }

    if (dominantFamily === "routing") {
      const authRoutingBackbone = alignedCandidates.filter((candidate) =>
        candidate.layers.includes("routing")
        || candidate.layers.includes("state")
        || /\/(App|_app|Root|Main|Layout)\.[jt]sx?$/.test(candidate.filePath)
      );
      if (authRoutingBackbone.length < 2) return "missing_routing_backbone";
      const genericNavigationRatio = considered.filter((candidate) => {
        const text = `${candidate.filePath} ${candidate.primary.result.name}`.toLowerCase();
        return /navigation/.test(text)
          && !/\b(protected|guard|redirect|callback|auth|route|router)\b/.test(text);
      }).length / considered.length;
      if (genericNavigationRatio > 0.34) return "generic_navigation_bundle";
    }

    if (dominantFamily === "auth") {
      const authBackbone = alignedCandidates.filter((candidate) => {
        const text = candidateText(candidate);
        return /\b(auth|login|signin|signup|signout|session|callback|redirect|protected|guard|token|oauth)\b/.test(text)
          && (
            candidate.layers.includes("ui")
            || candidate.layers.includes("state")
            || candidate.layers.includes("routing")
            || candidate.layers.includes("backend")
            || /\/(App|_app|Root|Main|Layout)\.[jt]sx?$/.test(candidate.filePath)
          );
      });
      if (authBackbone.length < 2) return "missing_auth_backbone";

      const flowNoiseRatio = considered.filter((candidate) => {
        const text = candidateText(candidate);
        return /(?:^|\/)src\/lib\/flow\//.test(candidate.filePath)
          || (/\bworkflow|flow\b/.test(text)
            && !/\b(auth|login|signin|signup|signout|session|callback|redirect|protected|guard|token|oauth)\b/.test(text));
      }).length / considered.length;
      if (flowNoiseRatio > 0.25) return "flow_noise_auth_bundle";
    }

    if (mentionsBillingDomain) {
      const billingBackbone = alignedCandidates.filter((candidate) => {
        const text = candidateText(candidate);
        return /\b(billing|checkout|portal|subscription|invoice|payment|credit)\b/.test(text)
          && (
            candidate.layers.includes("backend")
            || candidate.layers.includes("state")
            || /(?:^|\/)src\/pages\//.test(candidate.filePath)
            || /controller/.test(text)
          );
      });
      if (billingBackbone.length < 2) return "missing_billing_backbone";

      const widgetHeavyRatio = considered.filter((candidate) => {
        const text = candidateText(candidate);
        return /(?:^|\/)src\/components\//.test(candidate.filePath)
          && /\b(card|prompt|history|options|analytics)\b/.test(text)
          && !/\b(page|modal|dialog|layout)\b/.test(text);
      }).length / considered.length;
      if (widgetHeavyRatio > 0.4) return "widget_heavy_billing_bundle";
    }

    if (mentionsUploadDomain) {
      const uploadBackbone = alignedCandidates.filter((candidate) => {
        const text = candidateText(candidate);
        return /\b(upload|storage|media|signed|bucket|write)\b/.test(text)
          && (candidate.layers.includes("backend") || candidate.layers.includes("state"));
      });
      if (uploadBackbone.length < 2) return "missing_upload_backbone";

      const offUploadUiRatio = considered.filter((candidate) => {
        const text = candidateText(candidate);
        const uploadAnchored = /\b(upload|storage|media|signed|bucket|write)\b/.test(text);
        return candidate.layers.includes("ui") && !uploadAnchored;
      }).length / considered.length;
      if (offUploadUiRatio > 0.34) return "weak_upload_bundle";
    }

    return null;
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
    const singleTokenAliases = profile.inventoryMode
      ? tokens.filter((term) =>
          !BROAD_PHRASE_GENERIC_TERMS.has(term)
          && !INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(normalizeTargetText(term))
        )
      : tokens;

    for (const token of singleTokenAliases) aliases.add(normalizeTargetText(token));
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
      const normalizedTerm = normalizeTargetText(term.term);
      if (term.source === "semantic" && term.generic) continue;
      if (profile.inventoryMode && INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(normalizedTerm)) continue;
      if (term.weight < 0.68) continue;
      aliases.add(normalizedTerm);
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
    const surfaceAlignment = scoreExecutionSurfaceAlignment(
      detectExecutionSurfaces(target.filePath, chunk.name, chunk.content),
      profile.surfaceBias
    );
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
    const inventoryMentionsProtection = profile.inventoryMode
      && (profile.tokens.includes("protection") || profile.tokens.includes("protected") || profile.tokens.includes("guard"));
    const inventoryMentionsPending = profile.inventoryMode
      && (profile.tokens.includes("pending") || profile.tokens.includes("pendingnavigation"));
    const genericNavigationLeaf =
      /\b(skip|keyboard|navigation|drawer|menu|mobile|tab)\b/.test(text)
      && !/\b(protected|guard|redirect|callback|auth|pending|route|router)\b/.test(text);
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
    if ((inventoryMentionsProtection || inventoryMentionsPending) && genericNavigationLeaf) score -= 1.1;
    if (/constructor|describe|it|test/.test(chunk.name.toLowerCase())) score -= 0.4;
    if (directTerms.length >= 2) score += 0.28;
    if (familyMatches.size >= 2) score += 0.18;
    if (directTerms.length === 0 && semanticTerms.length <= 1 && familyMatches.size <= 1) score -= 0.32;
    score += surfaceAlignment * 0.45;

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
    const contentText = result.content.toLowerCase().slice(0, 1600);
    const matchedTerms = profile.expandedTerms.filter((term) =>
      textMatchesQueryTerm(text, term.term)
      || (profile.inventoryMode && !term.generic && textMatchesQueryTerm(contentText, term.term))
    );
    const directMatches = profile.anchorTerms.filter((term) =>
      textMatchesQueryTerm(text, term.term)
      || (
        profile.inventoryMode
        && !term.generic
        && term.weight >= 0.82
        && textMatchesQueryTerm(contentText, term.term)
      )
    );
    const coreDirectMatches = directMatches.filter((term) => !term.generic);
    const phraseMatches = profile.phrases.filter((phrase) =>
      text.includes(phrase)
      || (profile.inventoryMode && phrase.split(" ").some((term) => !BROAD_PHRASE_GENERIC_TERMS.has(term)) && contentText.includes(phrase))
    );
    const matchedFamilies = Array.from(new Set(matchedTerms.map((term) => term.family).filter(Boolean))) as string[];
    const matchedWeight = matchedTerms.reduce((sum, term) => sum + term.weight, 0);
    const genericOnly = matchedTerms.length > 0 && matchedTerms.every((term) => term.generic);
    const layers = this.detectWorkflowLayers(lowerPath, lowerName);
    const utilityLike = this.isUtilityLikePath(lowerPath, lowerName);
    const callbackNoise = this.isCallbackNoiseTarget(lowerPath, lowerName, profile);
    const orchestratorLike = this.isBroadOrchestratorLikePath(lowerPath, lowerName);
    const surfaceAlignment = scoreExecutionSurfaceAlignment(
      detectExecutionSurfaces(result.filePath, result.name, result.content),
      profile.surfaceBias
    );
    const queryNeedsOrchestrator =
      profile.workflowTraceMode
      || profile.tokens.includes("pipeline")
      || profile.tokens.includes("workflow")
      || profile.tokens.includes("full");

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
    if (queryNeedsOrchestrator && orchestratorLike && (coreDirectMatches.length > 0 || matchedFamilies.length > 0 || profile.workflowTraceMode)) {
      score *= 1.16;
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
    const userFacingLayer = layers.some((layer) => layer === "ui" || layer === "routing" || layer === "state");
    const pureOperationalSurface =
      !userFacingLayer
      && (/(?:^|\/)(mcp|mcp-server)\//.test(lowerPath) || /(?:^|\/)(cli|commands?)\//.test(lowerPath));
    if (
      profile.surfaceBias.defaultUserFacing
      && !profile.surfaceBias.explicitInfrastructure
      && !profile.surfaceBias.explicitBackend
    ) {
      if (pureOperationalSurface) {
        score *= coreDirectMatches.length > 0 || phraseMatches.length > 0 ? 0.24 : 0.12;
      } else if (userFacingLayer && (coreDirectMatches.length > 0 || phraseMatches.length > 0 || matchedFamilies.length > 0)) {
        score *= 1.14;
      }
    }
    if (
      profile.surfaceBias.explicitBackend
      && !profile.surfaceBias.explicitInfrastructure
      && !profile.surfaceBias.defaultUserFacing
    ) {
      const backendLayer = layers.includes("backend");
      const uiOnly = (layers.includes("ui") || layers.includes("state")) && !backendLayer;
      const backendPathAnchor =
        /(?:^|\/)(api|server|controllers?|handlers?|functions?|supabase|backend)\//.test(lowerPath)
        || /\b(provider|credit|credits|request|response|endpoint|server)\b/.test(text);
      if (backendLayer && (coreDirectMatches.length > 0 || phraseMatches.length > 0 || matchedFamilies.length > 0 || profile.workflowTraceMode)) {
        score *= 1.18;
      }
      if (backendPathAnchor && (coreDirectMatches.length > 0 || phraseMatches.length > 0 || matchedFamilies.length > 0 || profile.workflowTraceMode)) {
        score *= 1.14;
      }
      if (uiOnly && coreDirectMatches.length <= 1 && phraseMatches.length === 0) {
        score *= 0.34;
      }
    }
    if (surfaceAlignment < 0) {
      score *= Math.max(0.08, 1 + surfaceAlignment * 0.3);
    } else if (surfaceAlignment > 0) {
      score *= 1 + Math.min(0.38, surfaceAlignment * 0.14);
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
    const queryMode = classifyIntent(query).queryMode;
    const surfaceBias = inferQueryExecutionSurfaceBias(query, queryMode);
    const explicitBackendWorkflow =
      surfaceBias.explicitBackend
      && (
        /\bend(?:\s+to\s+|\s*-\s*to\s*-?\s*)end\b/i.test(query)
        || /\bfrom\b[\s\S]{0,80}\bto\b/i.test(query)
        || /\b(provider|credit|credits|authentication|request|response|server|endpoint)\b/i.test(query)
      );
    const inventoryMode = BROAD_INVENTORY_RE.test(query) && !explicitBackendWorkflow;
    const lifecycleMode = /\b(shutdown|startup|drain|close|teardown|boot|bootstrap)\b/i.test(query);
    const workflowTraceMode =
      /\bend(?:\s+to\s+|\s*-\s*to\s*-?\s*)end\b/i.test(query)
      || /\bthrough\b/i.test(query)
      || /\bhandoff\b/i.test(query)
      || /\bfrom\b[\s\S]{0,80}\bto\b/i.test(query)
      || explicitBackendWorkflow;
    const shouldKeepTerm = (term: string): boolean =>
      (!inventoryMode || !INVENTORY_STRUCTURAL_TERMS.has(normalizeTargetText(term)))
      && !GENERIC_QUERY_ACTION_TERMS.has(normalizeTargetText(term));
    const filteredExpandedTerms = expandedTerms.filter((term) => shouldKeepTerm(term.term));
    const tokens = tokenizeQueryTerms(query)
      .filter((term) => term.length >= 2 && !STOP_WORDS.has(term))
      .filter((term) => shouldKeepTerm(term));
    const anchorTerms = filteredExpandedTerms.filter((term) => {
      if (term.source !== "original" && term.source !== "morphological") return false;
      if (!term.generic) return true;
      return /^(mcp|auth|hook|http|api|rpc)$/.test(term.term);
    });
    const inferredFamilyScores = new Map<string, number>();
    for (const term of filteredExpandedTerms) {
      if (!term.family) continue;
      if (term.source === "corpus") continue;
      if (term.weight < 0.72) continue;
      inferredFamilyScores.set(term.family, (inferredFamilyScores.get(term.family) ?? 0) + term.weight);
    }
    let allowedFamilies = new Set(
      anchorTerms
        .map((term) => term.family)
        .filter((family): family is string => Boolean(family))
    );
    if (allowedFamilies.size === 0) {
      const rankedFamilies = Array.from(inferredFamilyScores.entries()).sort((a, b) => b[1] - a[1]);
      const topFamily = rankedFamilies[0]?.[0];
      if (topFamily) {
        allowedFamilies = new Set([topFamily]);
        if (inventoryMode || workflowTraceMode) {
          const topScore = rankedFamilies[0]?.[1] ?? 0;
          for (const [family, score] of rankedFamilies.slice(1)) {
            const adjacentFamilies = ADJACENT_WORKFLOW_FAMILIES[topFamily] ?? [];
            if (
              (adjacentFamilies.includes(family) || workflowTraceMode)
              && score >= Math.max(0.95, topScore * 0.55)
            ) {
              allowedFamilies.add(family);
            }
          }
        }
      }
    } else if (inventoryMode || workflowTraceMode) {
      for (const [family, score] of inferredFamilyScores) {
        if (allowedFamilies.has(family)) continue;
        const adjacentToAllowed = Array.from(allowedFamilies).some((allowed) =>
          (ADJACENT_WORKFLOW_FAMILIES[allowed] ?? []).includes(family)
        );
        if (!adjacentToAllowed && !workflowTraceMode) continue;
        const strongestAllowedScore = Array.from(allowedFamilies).reduce((max, allowed) => {
          const adjacentScore = inferredFamilyScores.get(allowed) ?? 0;
          return Math.max(max, adjacentScore);
        }, 0);
        if (score >= Math.max(0.95, strongestAllowedScore * 0.55)) {
          allowedFamilies.add(family);
        }
      }
    }
    if (workflowTraceMode && surfaceBias.explicitBackend) {
      const rankedFamilies = Array.from(inferredFamilyScores.entries()).sort((a, b) => b[1] - a[1]);
      const topScore = rankedFamilies[0]?.[1] ?? 0;
      for (const [family, score] of rankedFamilies) {
        if (allowedFamilies.has(family)) continue;
        if (score >= Math.max(0.9, topScore * 0.5)) {
          allowedFamilies.add(family);
        }
      }
      for (const family of ["auth", "billing", "generation", "storage"]) {
        if (inferredFamilyScores.has(family)) allowedFamilies.add(family);
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
      workflowTraceMode,
      surfaceBias,
    };
  }

  private shouldSuppressBroadResolvedTarget(query: string, seed: SeedResult["seeds"][number]): boolean {
    if (seed.reason !== "resolved_target") return false;
    if (!BROAD_INVENTORY_RE.test(query)) return false;
    const normalizedAlias = normalizeTargetText(seed.resolvedAlias ?? "");
    if (!INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(normalizedAlias)) return false;
    const specificTerms = tokenizeQueryTerms(query)
      .map((term) => normalizeTargetText(term))
      .filter((term) =>
        term.length >= 3
        && !STOP_WORDS.has(term)
        && !INVENTORY_STRUCTURAL_TERMS.has(term)
        && !INVENTORY_GENERIC_TARGET_ALIAS_TERMS.has(term)
      );
    return specificTerms.length > 0;
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
