import type { HybridSearch } from "../search/hybrid.js";
import { type MemoryConfig, resolveContextBudget } from "../core/config.js";
import type { AssembledContext } from "../search/types.js";
import type { QueryMode } from "../search/intent.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import type { FTSStore } from "../storage/fts-store.js";
import type { SeedResult } from "../search/seed.js";
import { assembleContext, countTokens } from "../search/context-assembler.js";
import type { MemorySearch } from "../memory/search.js";
import { resolveMemoryClass, resolveMemorySummary } from "../memory/types.js";
import { buildBusinessContextFromMemoryStore, formatProductAreaContextForPrompt, queryBusinessContext, type BusinessContextPage, type MemoryLikeStore, type ProductAreaContext } from "../business/product-areas.js";
import { getLogger } from "../core/logger.js";
import type { AssembledWikiContext } from "../wiki/context.js";
import { hasPrimaryCapabilityFamilyForQuery, hydrateCapabilityEvidenceFiles, resolveCapabilityEvidence, shouldHydrateGenericCapabilityEvidence, shouldUseCapabilityEvidence } from "../search/capability-evidence.js";
import { buildTopologySummary, resolveCodeContext } from "./prompt-context-code.js";
import { searchMemories, searchWikiPages, shouldInjectMemoryIntoPrompt, shouldSearchMemoryContext, shouldUseProductAreaEvidence } from "./prompt-context-enrichment.js";
import { buildReporecallAdvisory, clamp01, inferVanishedSelectedFileEvidence, mergeCapabilitySelectedFiles, mergePromptContextChunks, prunePromptSelectedFiles, uniqueStrings } from "./prompt-context-finalization.js";
import type { PromptContextResult } from "./prompt-context-types.js";
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
    config,
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
        compressionRank: config.contextCompressionPreserveTopChunks,
        contextCompressionEnabled: config.contextCompressionEnabled,
        contextCompressionMode: config.contextCompressionMode,
        contextCompressionPreserveTopChunks: config.contextCompressionPreserveTopChunks,
        contextCompressionMinChunkTokens: config.contextCompressionMinChunkTokens,
        contextCompressionTargetRatio: config.contextCompressionTargetRatio,
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
    ...inferVanishedSelectedFileEvidence(selectedFilesForReturn, context ?? null, metadata),
  ]);
  const selectedFilePathsForAdvisory = selectedFilesForReturn.map((file) => file.filePath);

  return {
    context: context ?? null,
    resolvedQueryMode: codeResult.resolvedQueryMode,
    deliveryMode: codeResult.deliveryMode ?? codeContext?.deliveryMode ?? "code_context",
    contextStrength: codeResult.contextStrength,
    executionSurface: codeResult.executionSurface,
    dominantFamily: codeResult.dominantFamily,
    familyConfidence: codeResult.familyConfidence,
    evidenceConfidence: codeResult.evidenceConfidence,
    selectedFiles: selectedFilesForReturn,
    deferredReason: codeResult.deferredReason,
    missingEvidence: missingEvidenceForReturn,
    recommendedNextReads: uniqueStrings([
      ...(codeResult.recommendedNextReads ?? []),
      ...selectedFilesForReturn.slice(0, 3).map((file) => file.filePath),
    ]),
    advisoryText: buildReporecallAdvisory(
      codeResult.resolvedQueryMode,
      codeResult.contextStrength ?? "weak",
      selectedFilePathsForAdvisory,
      missingEvidenceForReturn,
      context?.compression
    ),
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
