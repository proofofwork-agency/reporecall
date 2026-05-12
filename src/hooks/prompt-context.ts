import type { HybridSearch } from "../search/hybrid.js";
import { type MemoryConfig, resolveContextBudget } from "../core/config.js";
import type { AssembledContext } from "../search/types.js";
import type { QueryMode } from "../search/intent.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import type { FTSStore } from "../storage/fts-store.js";
import type { StoredChunk } from "../storage/types.js";
import { resolveSeeds } from "../search/seed.js";
import type { SeedResult } from "../search/seed.js";
import type { BroadSelectionDiagnostics } from "../search/hybrid.js";
import { buildStackTree } from "../search/tree-builder.js";
import { assembleContext, assembleFlowContext, assembleDeepRouteContext, countTokens } from "../search/context-assembler.js";
import type { MemorySearch } from "../memory/search.js";
import { assembleMemoryContext, type AssembledMemoryContext } from "../memory/context.js";
import type { MemoryClass, MemoryRoute, MemorySearchResult } from "../memory/types.js";
import { resolveMemoryClass, resolveMemorySummary } from "../memory/types.js";
import {
  buildBusinessContextFromMemoryStore,
  formatProductAreaContextForPrompt,
  queryBusinessContext,
  type BusinessContextPage,
  type MemoryLikeStore,
  type ProductAreaContext,
} from "../business/product-areas.js";
import { getLogger } from "../core/logger.js";
import { assembleWikiContext, type AssembledWikiContext } from "../wiki/context.js";
import { detectExecutionSurfaces, GENERIC_BROAD_TERMS, STOP_WORDS, textMatchesQueryTerm, type ExecutionSurface } from "../search/utils.js";
import { normalizeTargetText } from "../search/targets.js";
import {
  hasPrimaryCapabilityFamilyForQuery,
  hydrateCapabilityEvidenceFiles,
  resolveCapabilityEvidence,
  shouldHydrateGenericCapabilityEvidence,
  shouldUseCapabilityEvidence,
  type CapabilityEvidenceFile,
} from "../search/capability-evidence.js";
import { readFileSync } from "fs";

const MEMORY_QUERY_RE = /\b(memory|remember|previous|earlier|last time|follow[- ]?up|policy|rule|decision|constraint|benchmark|claim|docs?|documentation|continuity)\b/i;

export interface PromptContextResult {
  context: AssembledContext | null;
  resolvedQueryMode: QueryMode;
  deliveryMode?: "code_context" | "summary_only";
  contextStrength?: "sufficient" | "partial" | "weak";
  executionSurface?: ExecutionSurface | "mixed";
  dominantFamily?: string;
  familyConfidence?: number;
  selectedFiles?: Array<{
    filePath: string;
    selectionSource: string;
    selectionReason?: string;
    wikiPagesUsed?: string[];
  }>;
  deferredReason?: string;
  missingEvidence?: string[];
  recommendedNextReads?: string[];
  advisoryText?: string;
  memoryRoute?: MemoryRoute;
  memoryTokenCount?: number;
  memoryCount?: number;
  memoryNames?: string[];
  memoryResults?: MemorySearchResult[];
  memorySelected?: Array<{
    name: string;
    class: MemoryClass;
    score: number;
    summary: string;
  }>;
  memoryDropped?: Array<{
    name: string;
    class: MemoryClass;
    reason: string;
  }>;
  memoryClassTokens?: Record<MemoryClass, number>;
  memoryClassCounts?: Record<MemoryClass, number>;
  memoryBudget?: {
    total: number;
    used: number;
    remaining: number;
    codeFloorRatio: number;
    classBudgets: Record<MemoryClass, number>;
  };
  capabilityEvidenceEnabled?: boolean;
  genericCapabilityHydrationEnabled?: boolean;
  genericCapabilityHydrated?: boolean;
  wikiTokenCount?: number;
  wikiPageCount?: number;
  wikiPageNames?: string[];
  wikiPagesUsed?: string[];
  productAreaTokenCount?: number;
  productAreasUsed?: ProductAreaContext[];
  businessPagesUsed?: BusinessContextPage[];
}

function buildTopologySummary(metadata: MetadataStore, detailed = false): string | null {
  try {
    const communityLimit = detailed ? 8 : 5;
    const hubLimit = detailed ? 5 : 3;
    const surpriseLimit = detailed ? 3 : 1;

    const communities = metadata.getAllCommunities(communityLimit);
    const godNodes = metadata.getGodNodes(hubLimit);
    const surprises = metadata.getTopSurprises(surpriseLimit);

    if (communities.length === 0 && godNodes.length === 0) return null;

    const lines: string[] = ["## Codebase topology"];
    // Filter out test/scripts communities for cleaner summaries
    const srcCommunities = communities.filter(c =>
      c.label && !c.label.startsWith("test:") && !c.label.startsWith("scripts:")
    );
    const displayCommunities = srcCommunities.length > 0 ? srcCommunities : communities;

    if (displayCommunities.length > 0) {
      lines.push(`- **${displayCommunities.length}+ module communities** detected`);
      if (detailed) {
        for (const c of displayCommunities.slice(0, 5)) {
          lines.push(`  - "${c.label}" (${c.nodeCount} nodes, cohesion: ${c.cohesion})`);
        }
      } else {
        const top3 = displayCommunities.slice(0, 3).map(c => `"${c.label}"`).join(", ");
        lines.push(`  Top: ${top3}`);
      }
    }
    if (godNodes.length > 0) {
      const hubList = godNodes.map(g => `${g.name} (${g.degree} edges)`).join(", ");
      lines.push(`- **Hub nodes:** ${hubList}`);
    }
    if (surprises.length > 0) {
      for (const s of surprises) {
        const srcChunk = metadata.getChunk(s.sourceChunkId);
        const tgtChunk = metadata.getChunk(s.targetChunkId);
        const srcName = srcChunk?.name ?? s.sourceChunkId;
        const tgtName = tgtChunk?.name ?? s.targetChunkId;
        lines.push(`- **Surprising:** ${srcName} → ${tgtName} (${s.reasons[0] ?? "cross-boundary"})`);
      }
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

async function buildDeepRouteContext(
  query: string,
  search: HybridSearch,
  budget: number,
  activeFiles?: string[],
  signal?: AbortSignal,
  seedResult?: SeedResult
): Promise<AssembledContext> {
  const baseContext = await search.searchWithContext(query, budget, activeFiles, signal, seedResult);
  if (baseContext.routeStyle === "concept") {
    return baseContext;
  }
  return assembleDeepRouteContext(baseContext.chunks, budget, query);
}

function scoreTraceContextCoherence(query: string, context: AssembledContext): number {
  const salientTerms = normalizeTargetText(query)
    .split(" ")
    .filter(Boolean)
    .filter((term) =>
      term.length >= 4
      && !STOP_WORDS.has(term)
      && !GENERIC_BROAD_TERMS.has(term)
      && !["start", "trace", "full", "path", "page", "pages", "include", "including", "first", "then"].includes(term)
    );
  if (context.chunks.length === 0 || salientTerms.length === 0) return 0;

  let score = 0;
  for (const [index, chunk] of context.chunks.slice(0, 5).entries()) {
    const chunkText = `${chunk.filePath} ${chunk.name}`;
    const matches = salientTerms.filter((term) => textMatchesQueryTerm(chunkText, term)).length;
    score += matches * (5 - index * 0.6);
  }
  return score;
}

function buildTraceSelectedFiles(
  query: string,
  metadata: MetadataStore,
  context: AssembledContext,
  seedResult: SeedResult
): Array<{ filePath: string; selectionSource: string }> {
  const queryTerms = tokenizeQueryTerms(query);
  const families = inferTraceHintFamilies(queryTerms);
  const selected = new Map<string, string>();

  const addFile = (filePath: string | undefined | null, source: string) => {
    if (!filePath || isNoiseLikeFlowSeed(filePath) || selected.has(filePath)) return;
    selected.set(filePath, source);
  };

  for (const chunk of context.chunks) addFile(chunk.filePath, "flow_chunk");

  const seedFiles = seedResult.seeds
    .filter((seed) => seed.confidence >= 0.9)
    .filter((seed) => !isNoiseLikeFlowSeed(seed.filePath))
    .map((seed) => ({
      filePath: seed.filePath,
      score: countQueryMatches(queryTerms, seed.filePath, seed.name, seed.resolvedAlias)
        + (seed.reason === "explicit_target" ? 2 : 0)
        + (seed.reason === "resolved_target" ? 1 : 0),
    }))
    .filter((candidate) => candidate.score >= 1)
    .sort((a, b) => b.score - a.score);
  for (const candidate of seedFiles.slice(0, 4)) addFile(candidate.filePath, "trace_seed");

  const adjacencyCandidates = new Map<string, number>();
  const addCandidate = (filePath: string | undefined | null, score: number) => {
    if (!filePath || selected.has(filePath) || isNoiseLikeFlowSeed(filePath)) return;
    adjacencyCandidates.set(filePath, Math.max(adjacencyCandidates.get(filePath) ?? -Infinity, score));
  };

  for (const filePath of Array.from(selected.keys()).slice(0, 6)) {
    const imports = typeof metadata.getImportsForFile === "function" ? metadata.getImportsForFile(filePath) : [];
    for (const record of imports) {
      addCandidate(record.resolvedPath, scoreTraceHintPath(queryTerms, families, record.resolvedPath ?? "", record.importedName));
    }
    const importers = typeof metadata.findImporterFiles === "function" ? metadata.findImporterFiles(filePath) : [];
    for (const importer of importers.slice(0, 20)) {
      const chunks = typeof metadata.findChunksByFilePath === "function" ? metadata.findChunksByFilePath(importer) : [];
      addCandidate(importer, scoreTraceHintFile(queryTerms, families, importer, chunks));
    }
  }

  const chunksByFile = new Map<string, StoredChunk[]>();
  if (typeof metadata.getAllChunks === "function") {
    for (const chunk of metadata.getAllChunks()) {
      if (selected.has(chunk.filePath) || isNoiseLikeFlowSeed(chunk.filePath)) continue;
      const existing = chunksByFile.get(chunk.filePath) ?? [];
      if (existing.length < 5) existing.push(chunk);
      chunksByFile.set(chunk.filePath, existing);
    }
    for (const [filePath, fileChunks] of chunksByFile.entries()) {
      addCandidate(filePath, scoreTraceHintFile(queryTerms, families, filePath, fileChunks));
    }
  }

  const hintLimit = context.chunks.length <= 2 ? 4 : 3;
  const threshold = families.auth || families.billing || families.generation || families.upload ? 18 : 24;
  const rankedHints = Array.from(adjacencyCandidates.entries())
    .filter(([, score]) => score >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, hintLimit);
  for (const [filePath] of rankedHints) addFile(filePath, "trace_hint");

  return Array.from(selected.entries()).map(([filePath, selectionSource]) => ({ filePath, selectionSource }));
}

function inferTraceHintFamilies(queryTerms: string[]) {
  return {
    auth: queryTerms.some((term) => /^auth|token|session|login|signin|credential|callback|redirect|protect/.test(term)),
    generation: queryTerms.some((term) => /^image|generate|generation|render|asset|regen/.test(term)),
    billing: queryTerms.some((term) => /^bill|checkout|portal|subscription|invoice|payment|credit|customer|pricing|plan/.test(term)),
    upload: queryTerms.some((term) => /^upload|storage|media|signed|bucket|file/.test(term)),
  };
}

function scoreTraceHintPath(
  queryTerms: string[],
  families: ReturnType<typeof inferTraceHintFamilies>,
  filePath: string,
  symbolName?: string
): number {
  return scoreTraceHintFile(queryTerms, families, filePath, [], symbolName);
}

function scoreTraceHintFile(
  queryTerms: string[],
  families: ReturnType<typeof inferTraceHintFamilies>,
  filePath: string,
  chunks: StoredChunk[],
  symbolName?: string
): number {
  const contentPreview = chunks.slice(0, 3).map((chunk) => chunk.content.slice(0, 800)).join(" ");
  const symbolText = chunks.map((chunk) => `${chunk.name} ${chunk.parentName ?? ""}`).join(" ");
  let score = countQueryMatches(queryTerms, filePath, symbolName, symbolText) * 10;

  if (families.auth) {
    if (/(auth|callback|protected|session|login|signin|redirect|token)/i.test(`${filePath} ${symbolName ?? ""} ${symbolText}`)) score += 22;
    if (/(^|\/)app\.(tsx|jsx|ts|js)$/i.test(filePath) && /(auth|protected|callback|route|navigate)/i.test(contentPreview)) score += 22;
  }
  if (families.billing) {
    if (/(billing|checkout|portal|subscription|invoice|payment|customer|credit|pricing|plan)/i.test(`${filePath} ${symbolName ?? ""} ${symbolText}`)) score += 22;
    if (/(^|\/)billing\.(tsx|jsx|ts|js)$/i.test(filePath)) score += 12;
  }
  if (families.generation) {
    if (/(generate|generation|render|image|asset|regener)/i.test(`${filePath} ${symbolName ?? ""} ${symbolText}`)) score += 22;
  }
  if (families.upload) {
    if (/(upload|storage|media|signed|bucket|file|request|auth)/i.test(`${filePath} ${symbolName ?? ""} ${symbolText}`)) score += 20;
  }
  if (/(?:^|\/)(tests?|specs?|e2e|mocks?)\//i.test(filePath)) score -= 60;
  return score;
}

export async function handlePromptContextDetailed(
  query: string,
  search: HybridSearch,
  config: MemoryConfig,
  activeFiles?: string[],
  signal?: AbortSignal,
  queryMode?: QueryMode,
  metadata?: MetadataStore,
  fts?: FTSStore,
  seedResult?: SeedResult,
  chunkCount?: number,
  memorySearchInstance?: MemorySearch,
  memoryStore?: MemoryLikeStore
): Promise<PromptContextResult> {
  if (!query.trim()) {
    return { context: null, resolvedQueryMode: "skip" };
  }

  if (queryMode === "skip") {
    return { context: null, resolvedQueryMode: "skip" };
  }

  const totalBudget = resolveContextBudget(config.contextBudget, chunkCount ?? 0);
  const memoryEnabled = config.memory && !!memorySearchInstance;
  const memoryCodeFloorRatio = memoryEnabled ? clamp01(config.memoryCodeFloorRatio ?? 0.8) : 1;
  const codeBudget = memoryEnabled
    ? Math.max(0, Math.floor(totalBudget * memoryCodeFloorRatio))
    : totalBudget;

  let codeResult = await resolveCodeContext(
    query,
    search,
    codeBudget,
    activeFiles,
    signal,
    queryMode,
    metadata,
    fts,
    seedResult
  );

  const codeContext = codeResult.context;
  const remainingBudget = memoryEnabled
    ? Math.max(0, totalBudget - (codeContext?.tokenCount ?? 0))
    : 0;
  const memoryBudget = memoryEnabled
    ? Math.min(config.memoryBudget ?? 500, remainingBudget)
    : 0;
  const codeChunkHints = codeContext?.chunks ?? [];
  const topCodeFiles = uniqueStrings([
    ...(activeFiles ?? []),
    ...codeChunkHints.slice(0, 5).map((chunk) => chunk.filePath),
  ]);
  const topCodeSymbols = uniqueStrings([
    ...codeChunkHints.slice(0, 8).map((chunk) => chunk.name),
    ...codeChunkHints
      .slice(0, 8)
      .map((chunk) => chunk.parentName)
      .filter((name): name is string => !!name),
  ]);
  const memoryContext = memoryEnabled && memoryBudget > 0 && shouldSearchMemoryContext(query, codeContext)
    ? await searchMemories(query, memorySearchInstance!, config, memoryBudget, {
        activeFiles,
        topCodeFiles,
        topCodeSymbols,
        codeFloorRatio: memoryCodeFloorRatio,
      })
    : null;

  // --- Wiki search (always-on, separate from memory) ---
  const memoryTokensUsed = memoryContext?.tokenCount ?? 0;
  const wikiBudget = memoryEnabled
    ? Math.min(config.wikiBudget ?? 400, Math.max(0, remainingBudget - memoryTokensUsed))
    : 0;
  let wikiContext: AssembledWikiContext | null = null;
  if (memoryEnabled && wikiBudget > 0 && memorySearchInstance) {
    wikiContext = await searchWikiPages(query, memorySearchInstance, wikiBudget, {
      topCodeFiles,
      topCodeSymbols,
      maxPages: config.wikiMaxPages ?? 3,
      queryMode: codeResult.resolvedQueryMode,
    });
  }

  let context = codeContext;
  const capabilityEvidenceEnabled = config.capabilityEvidence !== false;
  const genericCapabilityHydrationEnabled = config.genericCapabilityHydration !== false;
  let genericCapabilityHydrated = false;
  const capabilityEvidence = capabilityEvidenceEnabled && metadata && shouldUseCapabilityEvidence(codeResult.resolvedQueryMode)
    ? resolveCapabilityEvidence({
        query,
        queryMode: codeResult.resolvedQueryMode,
        topCodeChunks: codeContext?.chunks ?? [],
        wikiPages: wikiContext?.pages,
        metadata,
        maxFiles: codeResult.resolvedQueryMode === "architecture" ? 10 : 8,
      })
    : null;
  if (
    context
    && metadata
    && capabilityEvidence?.files.length
    && !hasPrimaryCapabilityFamilyForQuery(query)
    && genericCapabilityHydrationEnabled
    && shouldHydrateGenericCapabilityEvidence(query, codeResult.resolvedQueryMode)
  ) {
    const existingFiles = new Set(context.chunks.map((chunk) => chunk.filePath));
    const evidenceChunks = hydrateCapabilityEvidenceFiles(
      metadata,
      capabilityEvidence.files,
      existingFiles,
      codeResult.resolvedQueryMode === "architecture" ? 10 : 8
    );
    if (evidenceChunks.length > 0) {
      const mergedChunks = mergePromptContextChunks(evidenceChunks, context.chunks);
      const hydratedContext = assembleContext(mergedChunks, codeBudget, {
        maxChunks: codeResult.resolvedQueryMode === "architecture" ? 10 : 8,
        scoreFloorRatio: 0.05,
        query,
        factExtractors: config.factExtractors,
        compressionRank: 3,
      });
      context = {
        ...hydratedContext,
        routeStyle: context.routeStyle,
        deliveryMode: "code_context",
      };
      genericCapabilityHydrated = true;
    }
  }
  const injectMemory = shouldInjectMemoryIntoPrompt(query, codeContext, memoryContext);
  if (injectMemory && memoryContext?.text && context) {
    context = {
      ...context,
      text: context.text + "\n" + memoryContext.text,
      tokenCount: context.tokenCount + memoryContext.tokenCount,
    };
  } else if (injectMemory && memoryContext?.text && !context) {
    context = {
      text: memoryContext.text,
      tokenCount: memoryContext.tokenCount,
      chunks: [],
      routeStyle: "standard",
    };
  }

  // Inject wiki context (always-on, separate from memory)
  if (wikiContext?.text && context) {
    context = {
      ...context,
      text: context.text + "\n" + wikiContext.text,
      tokenCount: context.tokenCount + wikiContext.tokenCount,
    };
  } else if (wikiContext?.text && !context) {
    context = {
      text: wikiContext.text,
      tokenCount: wikiContext.tokenCount,
      chunks: [],
      routeStyle: "standard",
    };
  }

  let productAreaTokenCount = 0;
  let productAreasUsed: ProductAreaContext[] = [];
  let businessPagesUsed: BusinessContextPage[] = [];
  if (context && memoryStore && shouldUseProductAreaEvidence(query, codeResult.resolvedQueryMode)) {
    try {
      const businessContext = buildBusinessContextFromMemoryStore(memoryStore);
      const matches = queryBusinessContext(query, businessContext, 3);
      const productAreaText = formatProductAreaContextForPrompt(matches.productAreas, 2);
      const tokens = productAreaText ? countTokens(productAreaText) : 0;
      if (productAreaText && tokens > 0 && context.tokenCount + tokens <= totalBudget) {
        context = {
          ...context,
          text: context.text + "\n" + productAreaText,
          tokenCount: context.tokenCount + tokens,
        };
        productAreaTokenCount = tokens;
        productAreasUsed = matches.productAreas;
        businessPagesUsed = matches.businessPages;
      }
    } catch (err) {
      getLogger().warn({ err }, "Product area evidence failed — continuing without business context");
    }
  }

  // Inject topology summary when available and within budget
  if (context && metadata) {
    const isBroad = queryMode === "architecture" || queryMode === "change";
    const topoSummary = buildTopologySummary(metadata, isBroad);
    if (topoSummary) {
      const topoTokens = countTokens(topoSummary);
      if (context.tokenCount + topoTokens <= totalBudget) {
        context = {
          ...context,
          text: context.text + "\n" + topoSummary,
          tokenCount: context.tokenCount + topoTokens,
        };
      }
    }
  }

  const selectedFilesForReturn = prunePromptSelectedFiles(
    query,
    codeResult.resolvedQueryMode,
    mergeCapabilitySelectedFiles(codeResult.selectedFiles, capabilityEvidence?.files)
      ?? Array.from(new Set(context?.chunks.map((chunk) => chunk.filePath) ?? [])).map((filePath) => ({
        filePath,
        selectionSource: "context_chunk",
      })),
    context
  );
  const missingEvidenceForReturn = uniqueStrings([
    ...(codeResult.missingEvidence ?? []),
    ...(capabilityEvidence?.missingEvidence ?? []),
  ]);

  return {
    context: context ?? null,
    resolvedQueryMode: codeResult.resolvedQueryMode,
    deliveryMode: codeResult.deliveryMode ?? codeContext?.deliveryMode ?? "code_context",
    contextStrength: codeResult.contextStrength,
    executionSurface: codeResult.executionSurface,
    dominantFamily: codeResult.dominantFamily,
    familyConfidence: codeResult.familyConfidence,
    selectedFiles: selectedFilesForReturn,
    deferredReason: codeResult.deferredReason,
    missingEvidence: missingEvidenceForReturn,
    recommendedNextReads: uniqueStrings([
      ...(codeResult.recommendedNextReads ?? []),
      ...selectedFilesForReturn.slice(0, 3).map((file) => file.filePath),
    ]),
    advisoryText: codeResult.advisoryText,
    memoryRoute: memoryContext?.route ?? "M0",
    memoryTokenCount: memoryContext?.tokenCount ?? 0,
    memoryCount: memoryContext?.memories.length ?? 0,
    memoryNames: memoryContext?.memories.map((m) => m.name) ?? [],
    memoryResults: memoryContext?.memories ?? [],
    memorySelected: memoryContext?.memories.map((m) => ({
      name: m.name,
      class: resolveMemoryClass(m),
      score: m.score,
      summary: resolveMemorySummary(m),
    })) ?? [],
    memoryDropped: memoryContext?.dropped.map((m) => ({
      name: m.name,
      class: m.class ?? "fact",
      reason: m.dropReason,
    })),
    memoryClassTokens: memoryContext?.classTokens,
    memoryClassCounts: memoryContext?.classCounts,
    memoryBudget: memoryContext?.budget,
    capabilityEvidenceEnabled,
    genericCapabilityHydrationEnabled,
    genericCapabilityHydrated,
    wikiTokenCount: wikiContext?.tokenCount ?? 0,
    wikiPageCount: wikiContext?.pageCount ?? 0,
    wikiPageNames: wikiContext?.pageNames ?? [],
    wikiPagesUsed: capabilityEvidence?.wikiPagesUsed ?? [],
    productAreaTokenCount,
    productAreasUsed,
    businessPagesUsed,
  };
}

async function searchMemories(
  query: string,
  memorySearch: MemorySearch,
  config: MemoryConfig,
  budget: number,
  context?: {
    activeFiles?: string[];
    topCodeFiles?: string[];
    topCodeSymbols?: string[];
    codeFloorRatio?: number;
  }
): Promise<AssembledMemoryContext | null> {
  try {
    const results = await memorySearch.search(query, {
      limit: 8,
      types: ["user", "feedback", "project", "reference"],
      statuses: ["active"],
      minConfidence: 0.55,
      activeFiles: context?.activeFiles,
      topCodeFiles: context?.topCodeFiles,
      topCodeSymbols: context?.topCodeSymbols,
    });
    if (results.length === 0) return null;

    const assembled = assembleMemoryContext(results, budget, {
      codeFloorRatio: context?.codeFloorRatio,
      classBudgets: {
        rule: Math.min(budget, config.memoryHotBudget ?? configAwareBudget(budget, 0.35)),
        working: Math.min(budget, config.memoryWorkingBudget ?? configAwareBudget(budget, 0.2)),
        fact: Math.min(budget, Math.max(0, budget - ((config.memoryHotBudget ?? 0) + (config.memoryWorkingBudget ?? 0)))),
        episode: Math.min(budget, config.memoryEpisodeBudget ?? configAwareBudget(budget, 0.15)),
      },
      maxMemories: 6,
    });
    if (!assembled.text) return null;

    // Record access for included memories (non-fatal)
    for (const mem of assembled.memories) {
      try { memorySearch.recordAccess(mem.id); } catch { /* non-fatal */ }
    }

    return assembled;
  } catch (err) {
    getLogger().warn({ err }, "Memory search failed — continuing without memories");
    return null;
  }
}

async function resolveCodeContext(
  query: string,
  search: HybridSearch,
  codeBudget: number,
  activeFiles?: string[],
  signal?: AbortSignal,
  queryMode?: QueryMode,
  metadata?: MetadataStore,
  fts?: FTSStore,
  seedResult?: SeedResult
): Promise<PromptContextResult> {
  const getBroadDiagnostics = (): BroadSelectionDiagnostics | null =>
    typeof (search as HybridSearch & { getLastBroadSelectionDiagnostics?: () => BroadSelectionDiagnostics | null }).getLastBroadSelectionDiagnostics === "function"
      ? (search as HybridSearch & { getLastBroadSelectionDiagnostics: () => BroadSelectionDiagnostics | null }).getLastBroadSelectionDiagnostics()
      : null;
  if (!queryMode || queryMode === "lookup") {
    const context = await search.searchWithContext(query, codeBudget, activeFiles, signal, seedResult);
    return finalizePromptContextResult(query, {
      context,
      resolvedQueryMode: "lookup",
      deliveryMode: context.deliveryMode ?? "code_context",
    });
  }
  if (queryMode === "bug" || queryMode === "architecture" || queryMode === "change") {
    const context = await search.searchWithContext(query, codeBudget, activeFiles, signal, seedResult);
    const diagnostics = getBroadDiagnostics();
    return finalizePromptContextResult(query, {
      context,
      resolvedQueryMode: queryMode,
      deliveryMode: diagnostics?.deliveryMode ?? context.deliveryMode ?? "code_context",
      dominantFamily: diagnostics?.dominantFamily,
      familyConfidence: diagnostics?.familyConfidence,
      selectedFiles: diagnostics?.selectedFiles,
      deferredReason: diagnostics?.deferredReason ?? diagnostics?.fallbackReason,
    });
  }
  if (queryMode === "trace" && (!metadata || !fts)) {
    const context = await search.searchWithContext(query, codeBudget, activeFiles, signal, seedResult);
    return finalizePromptContextResult(query, {
      context,
      resolvedQueryMode: queryMode,
      deliveryMode: context.deliveryMode ?? "code_context",
    });
  }
  if (queryMode === "trace" && metadata && fts) {
    if (search.hasConceptContext(query)) {
      const context = await search.searchWithContext(query, codeBudget, activeFiles, signal, seedResult);
      return finalizePromptContextResult(query, {
        context,
        resolvedQueryMode: "lookup",
        deliveryMode: context.deliveryMode ?? "code_context",
      });
    }

    const resolvedSeeds = search.prepareSeedResult(
      query,
      queryMode,
      seedResult ?? resolveSeeds(query, metadata, fts)
    );
    if (resolvedSeeds.bestSeed) {
      const tree = buildStackTree(metadata, {
        seed: resolvedSeeds.bestSeed,
        direction: "both",
        maxDepth: 2,
        maxBranchFactor: 3,
        maxNodes: 24,
        query,
      });
      const augmentedTree = augmentFlowTreeWithRelatedSeeds(tree, resolvedSeeds, query);

      if (augmentedTree.nodeCount <= 1) {
        const context = await buildDeepRouteContext(query, search, codeBudget, activeFiles, signal, resolvedSeeds);
        const diagnostics = getBroadDiagnostics();
        return finalizePromptContextResult(query, {
          context,
          resolvedQueryMode: queryMode,
          deliveryMode: diagnostics?.deliveryMode ?? context.deliveryMode ?? "code_context",
          dominantFamily: diagnostics?.dominantFamily,
          familyConfidence: diagnostics?.familyConfidence,
          selectedFiles: diagnostics?.selectedFiles,
          deferredReason: diagnostics?.deferredReason ?? diagnostics?.fallbackReason,
        });
      }

      const flowContext = assembleFlowContext(augmentedTree, metadata, codeBudget, query);
      if (flowContext.chunks.length === 0 || !flowContext.text.trim()) {
        const context = await buildDeepRouteContext(query, search, codeBudget, activeFiles, signal, resolvedSeeds);
        const diagnostics = getBroadDiagnostics();
        return finalizePromptContextResult(query, {
          context,
          resolvedQueryMode: queryMode,
          deliveryMode: diagnostics?.deliveryMode ?? context.deliveryMode ?? "code_context",
          dominantFamily: diagnostics?.dominantFamily,
          familyConfidence: diagnostics?.familyConfidence,
          selectedFiles: diagnostics?.selectedFiles,
          deferredReason: diagnostics?.deferredReason ?? diagnostics?.fallbackReason,
        });
      }

      const deepContext = await buildDeepRouteContext(query, search, codeBudget, activeFiles, signal, resolvedSeeds);
      const flowScore = scoreTraceContextCoherence(query, flowContext);
      const deepScore = scoreTraceContextCoherence(query, deepContext);
      if (deepScore > flowScore * 1.1) {
        const diagnostics = getBroadDiagnostics();
        return finalizePromptContextResult(query, {
          context: deepContext,
          resolvedQueryMode: queryMode,
          deliveryMode: diagnostics?.deliveryMode ?? deepContext.deliveryMode ?? "code_context",
          dominantFamily: diagnostics?.dominantFamily,
          familyConfidence: diagnostics?.familyConfidence,
          selectedFiles: diagnostics?.selectedFiles,
          deferredReason: diagnostics?.deferredReason ?? diagnostics?.fallbackReason,
        });
      }

      return finalizePromptContextResult(query, {
        context: flowContext,
        resolvedQueryMode: queryMode,
        deliveryMode: "code_context",
        selectedFiles: buildTraceSelectedFiles(query, metadata, flowContext, resolvedSeeds),
      });
    }

    const context = await buildDeepRouteContext(query, search, codeBudget, activeFiles, signal, resolvedSeeds);
    const diagnostics = getBroadDiagnostics();
    return finalizePromptContextResult(query, {
      context,
      resolvedQueryMode: queryMode,
      deliveryMode: diagnostics?.deliveryMode ?? context.deliveryMode ?? "code_context",
      dominantFamily: diagnostics?.dominantFamily,
      familyConfidence: diagnostics?.familyConfidence,
      selectedFiles: diagnostics?.selectedFiles,
      deferredReason: diagnostics?.deferredReason ?? diagnostics?.fallbackReason,
    });
  }

  const context = await buildDeepRouteContext(query, search, codeBudget, activeFiles, signal, seedResult);
  const diagnostics = getBroadDiagnostics();
  return finalizePromptContextResult(query, {
    context,
    resolvedQueryMode: queryMode,
    deliveryMode: diagnostics?.deliveryMode ?? context.deliveryMode ?? "code_context",
    dominantFamily: diagnostics?.dominantFamily,
    familyConfidence: diagnostics?.familyConfidence,
    selectedFiles: diagnostics?.selectedFiles,
    deferredReason: diagnostics?.deferredReason ?? diagnostics?.fallbackReason,
  });
}

function finalizePromptContextResult(
  query: string,
  result: PromptContextResult
): PromptContextResult {
  const context = result.context;
  const selectedFileRecords = prunePromptSelectedFiles(
    query,
    result.resolvedQueryMode,
    result.selectedFiles ?? Array.from(new Set(context?.chunks.map((chunk) => chunk.filePath) ?? [])).map((filePath) => ({
      filePath,
      selectionSource: "context_chunk",
    })),
    context
  );
  const selectedFiles = selectedFileRecords.map((file) => file.filePath);
  const executionSurface = inferDominantExecutionSurface(context);
  const contextStrength = inferContextStrength(result.resolvedQueryMode, result.deliveryMode, context, selectedFiles, result.familyConfidence);
  const recommendedNextReads = uniqueStrings([
    ...(result.recommendedNextReads ?? []),
    ...selectedFiles.slice(0, Math.min(contextStrength === "weak" ? 2 : 3, selectedFiles.length)),
  ]);
  const missingEvidence = uniqueStrings([
    ...(result.missingEvidence ?? []),
    ...inferMissingEvidence(result.resolvedQueryMode, contextStrength, result.deliveryMode, selectedFiles, result.deferredReason),
  ]);
  return {
    ...result,
    selectedFiles: selectedFileRecords,
    contextStrength,
    executionSurface,
    missingEvidence,
    recommendedNextReads,
    advisoryText: buildReporecallAdvisory(result.resolvedQueryMode, contextStrength, selectedFiles, missingEvidence),
  };
}

function prunePromptSelectedFiles(
  query: string,
  queryMode: QueryMode,
  selectedFiles: NonNullable<PromptContextResult["selectedFiles"]>,
  context: AssembledContext | null
): NonNullable<PromptContextResult["selectedFiles"]> {
  if (queryMode === "lookup" || selectedFiles.length <= 1) return selectedFiles;
  const limit =
    queryMode === "trace" ? 5
      : queryMode === "bug" ? 8
        : queryMode === "architecture" || queryMode === "change" ? 6
          : selectedFiles.length;
  if (selectedFiles.length <= limit) return selectedFiles;

  const contextOrder = new Map<string, number>();
  for (const [index, chunk] of (context?.chunks ?? []).entries()) {
    if (!contextOrder.has(chunk.filePath)) contextOrder.set(chunk.filePath, index);
  }
  return [...selectedFiles]
    .sort((a, b) => {
      const diff = scorePromptSelectedFile(query, b, contextOrder) - scorePromptSelectedFile(query, a, contextOrder);
      if (Math.abs(diff) > 0.001) return diff;
      return (contextOrder.get(a.filePath) ?? 999) - (contextOrder.get(b.filePath) ?? 999);
    })
    .slice(0, limit);
}

function scorePromptSelectedFile(
  query: string,
  file: NonNullable<PromptContextResult["selectedFiles"]>[number],
  contextOrder: Map<string, number>
): number {
  const terms = tokenizeQueryTerms(query)
    .map((term) => normalizeTargetText(term))
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
  const lowerQuery = query.toLowerCase();
  const text = normalizeTargetText(`${file.filePath} ${file.selectionSource} ${file.selectionReason ?? ""}`);
  let score = 0;
  for (const term of terms) {
    if (textMatchesQueryTerm(text, term)) score += 24;
  }
  const order = contextOrder.get(file.filePath);
  if (order !== undefined) score += Math.max(0, 18 - order * 2);
  const source = file.selectionSource;
  if (source === "direct_match" || source === "flow_chunk" || source === "workflow_bundle" || source === "inventory_bundle") score += 28;
  if (source === "mandatory_flow_step") score += 46;
  if (source === "wiki_capability") score += 48;
  if (source === "trace_seed") score += 18;
  if (source === "trace_hint") score += 6;

  if (/\b(auth|authentication|login|session|protected|redirect|callback|guard|provider|token)\b/i.test(lowerQuery)) {
    if (/\b(auth|login|session|protected|redirect|callback|guard|provider|token)\b/.test(text)) score += 34;
  }
  if (/\b(upload|media|storage|bucket|request auth|storage write)\b/i.test(lowerQuery)) {
    if (/\b(upload|storage|media|bucket|request|shared|helper|auth|write)\b/.test(text)) score += 34;
    if (/\b(login|signin|signup|protected|redirect|callback)\b/.test(text) && !/\b(upload|storage|media|bucket|request)\b/.test(text)) score -= 30;
  }
  if (/\b(generate|generation|image|asset|render)\b/i.test(lowerQuery)) {
    if (/\b(generate|generation|image|asset|render|controller|handler|store|hook)\b/.test(text)) score += 34;
  }
  if (/\b(billing|checkout|portal|subscription|invoice|payment|pricing|plan)\b/i.test(lowerQuery)) {
    if (/\b(billing|checkout|portal|subscription|invoice|payment|credit|plan|service|controller)\b/.test(text)) score += 34;
    if (/\b(auth|login|protected|redirect|callback)\b/.test(text) && !/\b(billing|checkout|portal|subscription|invoice|payment|credit|plan)\b/.test(text)) score -= 30;
  }
  if (isNoiseLikeFlowSeed(file.filePath)) score -= 100;
  return score;
}

function inferDominantExecutionSurface(context: AssembledContext | null): ExecutionSurface | "mixed" {
  if (!context || context.chunks.length === 0) return "mixed";
  const counts = new Map<ExecutionSurface, number>();
  for (const chunk of context.chunks.slice(0, 5)) {
    for (const surface of detectExecutionSurfaces(chunk.filePath, chunk.name, chunk.content)) {
      counts.set(surface, (counts.get(surface) ?? 0) + 1);
    }
  }
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return "mixed";
  if ((ranked[0]?.[1] ?? 0) === (ranked[1]?.[1] ?? -1)) return "mixed";
  return ranked[0]?.[0] ?? "mixed";
}

function inferContextStrength(
  queryMode: QueryMode,
  deliveryMode: "code_context" | "summary_only" | undefined,
  context: AssembledContext | null,
  selectedFiles: string[],
  familyConfidence?: number
): "sufficient" | "partial" | "weak" {
  if (!context || context.chunks.length === 0) return "weak";
  if (deliveryMode === "summary_only") return "weak";
  if (queryMode === "lookup") return selectedFiles.length >= 1 ? "sufficient" : "partial";
  if (queryMode === "trace" || queryMode === "bug") {
    if (selectedFiles.length >= 2) return "sufficient";
    return "partial";
  }
  if ((queryMode === "architecture" || queryMode === "change") && (familyConfidence ?? 0) >= 0.72 && selectedFiles.length >= 2) {
    return "sufficient";
  }
  return selectedFiles.length > 0 ? "partial" : "weak";
}

function inferMissingEvidence(
  queryMode: QueryMode,
  contextStrength: "sufficient" | "partial" | "weak",
  deliveryMode: "code_context" | "summary_only" | undefined,
  selectedFiles: string[],
  deferredReason?: string
): string[] {
  const issues: string[] = [];
  if (deliveryMode === "summary_only") {
    issues.push("Reporecall deferred broad code injection because subsystem cohesion was weak.");
  }
  if ((queryMode === "bug" || queryMode === "trace") && contextStrength !== "sufficient") {
    issues.push("Runtime caller or orchestrator coverage is still incomplete.");
  }
  if ((queryMode === "architecture" || queryMode === "change") && selectedFiles.length < 2) {
    issues.push("Representative subsystem coverage is still thin.");
  }
  if (deferredReason) {
    issues.push(`Deferred reason: ${deferredReason}.`);
  }
  return issues;
}

function buildReporecallAdvisory(
  queryMode: QueryMode,
  contextStrength: "sufficient" | "partial" | "weak",
  selectedFiles: string[],
  missingEvidence: string[]
): string | undefined {
  if (selectedFiles.length === 0) return undefined;
  const lines = [
    "## Reporecall Guidance",
    "",
    `Reporecall classified this as a \`${queryMode}\` query and already selected likely files: ${selectedFiles.slice(0, 4).join(", ")}${selectedFiles.length > 4 ? ` (+${selectedFiles.length - 4} more)` : ""}.`,
  ];
  if (contextStrength === "sufficient") {
    lines.push("Prefer answering from these files first. Use extra read/search tools only to fill a clearly missing gap.");
  } else if (contextStrength === "partial") {
    lines.push("Start from these files first. If you need more evidence, prefer narrow targeted reads instead of broad codebase exploration.");
  } else {
    lines.push("The injected context is weak. If you expand, prefer the listed files first and keep exploration narrow.");
  }
  if (missingEvidence.length > 0) {
    lines.push(`Missing evidence: ${missingEvidence.join(" ")}`);
  }
  return lines.join("\n");
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value && value.trim().length > 0))];
}

function tokenizeQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
}

function countQueryMatches(queryTerms: string[], ...texts: Array<string | undefined>): number {
  if (queryTerms.length === 0) return 0;
  const haystack = texts
    .filter((text): text is string => !!text)
    .join(" ")
    .toLowerCase()
    .replace(/[_-]/g, " ");
  let count = 0;
  for (const term of queryTerms) {
    const prefix = term.length >= 6 ? term.slice(0, 4) : term;
    if (haystack.includes(term) || (prefix.length >= 4 && haystack.includes(prefix))) count++;
  }
  return count;
}

function augmentFlowTreeWithRelatedSeeds(
  tree: ReturnType<typeof buildStackTree>,
  seedResult: SeedResult,
  query: string
): ReturnType<typeof buildStackTree> {
  const bestSeed = seedResult.bestSeed;
  if (!bestSeed) return tree;

  const queryTerms = tokenizeQueryTerms(query);
  const normalizedQuery = normalizeTargetText(query);
  const seenChunkIds = new Set([
    tree.seed.chunkId,
    ...tree.upTree.map((node) => node.chunkId),
    ...tree.downTree.map((node) => node.chunkId),
  ]);

  const relatedSeeds = seedResult.seeds
    .filter((seed) => seed.chunkId !== bestSeed.chunkId)
    .filter((seed) => (seed.reason === "explicit_target" || seed.reason === "resolved_target"))
    .filter((seed) => seed.confidence >= 0.9)
    .filter((seed) => !seenChunkIds.has(seed.chunkId))
    .filter((seed) => !isNoiseLikeFlowSeed(seed.filePath))
    .map((seed) => ({
      seed,
      queryMatches: countQueryMatches(queryTerms, seed.filePath, seed.name, seed.resolvedAlias),
      directNameMention: directlyMentionsSeed(normalizedQuery, seed.name),
      directAliasMention: directlyMentionsSeed(normalizedQuery, seed.resolvedAlias),
      directMention:
        directlyMentionsSeed(normalizedQuery, seed.name)
        || directlyMentionsSeed(normalizedQuery, seed.resolvedAlias),
      nameTokenCount: normalizeTargetText(seed.name).split(" ").filter(Boolean).length,
      aliasTokenCount: normalizeTargetText(seed.resolvedAlias ?? seed.name).split(" ").filter(Boolean).length,
      genericAlias:
        !!seed.resolvedAlias
        && GENERIC_BROAD_TERMS.has(normalizeTargetText(seed.resolvedAlias)),
    }))
    .filter((item) =>
      item.seed.resolutionSource !== "file_path"
      || item.directNameMention
      || (item.directAliasMention && item.aliasTokenCount >= 2)
    )
    .filter((item) => item.directNameMention || item.directAliasMention || item.aliasTokenCount >= 2 || item.nameTokenCount >= 2)
    .filter((item) => !item.genericAlias || item.directNameMention || (item.directAliasMention && item.aliasTokenCount >= 2))
    .filter((item) => item.directNameMention || (item.directAliasMention && item.aliasTokenCount >= 2) || item.queryMatches >= 2)
    .filter((item) =>
      !(bestSeed.reason === "explicit_target"
        && item.seed.targetKind === "file_module"
        && item.nameTokenCount < 2
        && item.queryMatches < 2)
    )
    .sort((a, b) =>
      Number(b.directMention) - Number(a.directMention)
      || b.queryMatches - a.queryMatches
      || Number((b.seed.targetKind === "endpoint" || b.seed.targetKind === "file_module"))
        - Number((a.seed.targetKind === "endpoint" || a.seed.targetKind === "file_module"))
    )
    .slice(0, 2);

  if (relatedSeeds.length === 0) return tree;

  return {
    ...tree,
    downTree: [
      ...tree.downTree,
      ...relatedSeeds.map(({ seed }) => ({
        chunkId: seed.chunkId,
        name: seed.name,
        filePath: seed.filePath,
        kind: seed.kind,
        depth: 1 as const,
        direction: "down" as const,
      })),
    ],
    edges: [
      ...tree.edges,
      ...relatedSeeds.map(({ seed }) => ({
        from: tree.seed.chunkId,
        to: seed.chunkId,
        callType: "related",
      })),
    ],
    nodeCount: tree.nodeCount + relatedSeeds.length,
  };
}

function isNoiseLikeFlowSeed(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return /(?:^|\/)(migrations?|fixtures?|examples?|docs?|reports?)\//.test(lower)
    || /(?:^|\/)(__tests__|tests?|specs?|e2e|mocks?)\//.test(lower)
    || /\.(test|spec)\.[jt]sx?$/i.test(lower)
    || /\.(md|mdx|txt|sql)$/i.test(lower);
}

function directlyMentionsSeed(normalizedQuery: string, candidate?: string): boolean {
  if (!candidate) return false;
  const normalizedCandidate = normalizeTargetText(candidate);
  if (!normalizedCandidate || normalizedCandidate.length < 3) return false;
  return normalizedQuery.includes(normalizedCandidate);
}

function configAwareBudget(totalBudget: number, ratio: number): number {
  return Math.max(0, Math.floor(totalBudget * ratio));
}

async function searchWikiPages(
  query: string,
  memorySearch: MemorySearch,
  budget: number,
  context: {
    topCodeFiles?: string[];
    topCodeSymbols?: string[];
    maxPages?: number;
    queryMode?: QueryMode;
  }
): Promise<AssembledWikiContext | null> {
  try {
    const requestedLimit = context.maxPages ?? 3;
    const rawResults = await memorySearch.search(query, {
      limit: Math.max(requestedLimit * 3, requestedLimit),
      types: ["wiki"],
      statuses: ["active"],
      minConfidence: 0.5,
      topCodeFiles: context.topCodeFiles,
      topCodeSymbols: context.topCodeSymbols,
    });
    const includeBusinessPagesForEvidence = shouldUseCapabilityEvidence(context.queryMode ?? "lookup");
    if (includeBusinessPagesForEvidence) {
      for (const capabilityQuery of inferCapabilityWikiQueries(query)) {
        const capabilityResults = await memorySearch.search(capabilityQuery, {
          limit: 2,
          types: ["wiki"],
          statuses: ["active"],
          minConfidence: 0.5,
        });
        for (const result of capabilityResults) {
          if (!rawResults.some((existing) => existing.id === result.id || existing.name === result.name)) {
            rawResults.unshift(result);
          }
        }
      }
    }
    const evidenceResults = includeBusinessPagesForEvidence
      ? rawResults
      : rawResults.filter((result) => !isBusinessWikiResult(result));
    const promptResults = rawResults.filter((result) => !isBusinessWikiResult(result));
    if (evidenceResults.length === 0) return null;

    const assembled = assembleWikiContext(promptResults, budget, requestedLimit);
    return assembled
      ? { ...assembled, pages: evidenceResults.slice(0, requestedLimit) }
      : {
          text: "",
          tokenCount: 0,
          pageCount: 0,
          pageNames: [],
          pages: evidenceResults.slice(0, requestedLimit),
        };
  } catch (err) {
    getLogger().warn({ err }, "Wiki search failed — continuing without wiki context");
    return null;
  }
}

function inferCapabilityWikiQueries(query: string): string[] {
  const normalized = normalizeTargetText(query);
  const queries: string[] = [];
  if (/\b(auth|authentication|authorization|login|signin|signup|signout|session|oauth|protected|redirect|callback|credential)\b/.test(normalized)) {
    queries.push("business user authentication");
  }
  if (/\b(billing|checkout|portal|subscription|invoice|payment|credit|pricing|plan|customer)\b/.test(normalized)) {
    queries.push("business credits billing pricing");
  }
  if (/\b(image|generation|generate|render|asset|storyboard|regenerate)\b/.test(normalized)) {
    queries.push("business media generation request");
  }
  if (/\b(upload|storage|media upload|bucket|signed url|storage write|request auth)\b/.test(normalized)) {
    queries.push("business media upload");
  }
  return queries;
}

function mergeCapabilitySelectedFiles(
  base: PromptContextResult["selectedFiles"],
  evidenceFiles?: CapabilityEvidenceFile[]
): PromptContextResult["selectedFiles"] {
  const merged = new Map<string, NonNullable<PromptContextResult["selectedFiles"]>[number]>();
  for (const file of base ?? []) {
    merged.set(file.filePath, file);
  }
  for (const file of evidenceFiles ?? []) {
    const existing = merged.get(file.filePath);
    if (!existing) {
      merged.set(file.filePath, {
        filePath: file.filePath,
        selectionSource: file.selectionSource,
        selectionReason: file.selectionReason,
        wikiPagesUsed: file.wikiPagesUsed,
      });
      continue;
    }
    if (existing.selectionSource === "workflow_bundle" || existing.selectionSource === "flow_chunk") {
      merged.set(file.filePath, {
        ...existing,
        selectionReason: existing.selectionReason ?? file.selectionReason,
        wikiPagesUsed: uniqueStrings([...(existing.wikiPagesUsed ?? []), ...file.wikiPagesUsed]),
      });
    }
  }
  return Array.from(merged.values());
}

function mergePromptContextChunks(
  primary: AssembledContext["chunks"],
  secondary: AssembledContext["chunks"]
): AssembledContext["chunks"] {
  const byFilePath = new Map<string, AssembledContext["chunks"][number]>();
  for (const chunk of [...primary, ...secondary]) {
    const existing = byFilePath.get(chunk.filePath);
    if (!existing || (chunk.hookScore ?? chunk.score) > (existing.hookScore ?? existing.score)) {
      byFilePath.set(chunk.filePath, chunk);
    }
  }
  return Array.from(byFilePath.values()).sort((a, b) =>
    (b.hookScore ?? b.score) - (a.hookScore ?? a.score)
    || b.score - a.score
    || a.filePath.localeCompare(b.filePath)
  );
}

function shouldInjectMemoryIntoPrompt(
  query: string,
  _codeContext: AssembledContext | null,
  memoryContext: AssembledMemoryContext | null
): boolean {
  if (!memoryContext?.text) return false;
  if (!MEMORY_QUERY_RE.test(query)) return false;
  return true;
}

function shouldUseProductAreaEvidence(query: string, queryMode: QueryMode): boolean {
  if (!shouldUseCapabilityEvidence(queryMode)) return false;
  return queryMode === "trace"
    || queryMode === "architecture"
    || queryMode === "change"
    || /\b(product area|business|capabilit(?:y|ies)|feature|workflow|which files|implement|where .* lives?)\b/i.test(query);
}

function isBusinessWikiResult(result: MemorySearchResult): boolean {
  if (result.name.startsWith("business-")) return true;
  try {
    const raw = readFileSync(result.filePath, "utf-8");
    return /^---[\s\S]*?\npageType:\s*"?business"?/m.test(raw);
  } catch {
    return false;
  }
}

function shouldSearchMemoryContext(
  query: string,
  _codeContext: AssembledContext | null
): boolean {
  if (!MEMORY_QUERY_RE.test(query)) return false;
  return true;
}

export async function handlePromptContext(
  query: string,
  search: HybridSearch,
  config: MemoryConfig,
  activeFiles?: string[],
  signal?: AbortSignal,
  queryMode?: QueryMode,
  metadata?: MetadataStore,
  fts?: FTSStore,
  seedResult?: SeedResult,
  chunkCount?: number,
  memorySearchInstance?: MemorySearch,
  memoryStore?: MemoryLikeStore
): Promise<AssembledContext | null> {
  const result = await handlePromptContextDetailed(
    query,
    search,
    config,
    activeFiles,
    signal,
    queryMode,
    metadata,
    fts,
    seedResult,
    chunkCount,
    memorySearchInstance,
    memoryStore
  );
  return result.context;
}
