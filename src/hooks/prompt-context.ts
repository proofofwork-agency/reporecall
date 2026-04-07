import type { HybridSearch } from "../search/hybrid.js";
import { type MemoryConfig, resolveContextBudget } from "../core/config.js";
import type { AssembledContext } from "../search/types.js";
import type { QueryMode } from "../search/intent.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import type { FTSStore } from "../storage/fts-store.js";
import { resolveSeeds } from "../search/seed.js";
import type { SeedResult } from "../search/seed.js";
import type { BroadSelectionDiagnostics } from "../search/hybrid.js";
import { buildStackTree } from "../search/tree-builder.js";
import { assembleFlowContext, assembleDeepRouteContext, countTokens } from "../search/context-assembler.js";
import type { MemorySearch } from "../memory/search.js";
import { assembleMemoryContext, type AssembledMemoryContext } from "../memory/context.js";
import type { MemoryClass, MemoryRoute, MemorySearchResult } from "../memory/types.js";
import { resolveMemoryClass, resolveMemorySummary } from "../memory/types.js";
import { getLogger } from "../core/logger.js";
import { assembleWikiContext, type AssembledWikiContext } from "../wiki/context.js";
import { detectExecutionSurfaces, GENERIC_BROAD_TERMS, STOP_WORDS, textMatchesQueryTerm, type ExecutionSurface } from "../search/utils.js";
import { normalizeTargetText } from "../search/targets.js";

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
  wikiTokenCount?: number;
  wikiPageCount?: number;
  wikiPageNames?: string[];
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
  memorySearchInstance?: MemorySearch
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
    });
  }

  let context = codeContext;
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

  return {
    context: context ?? null,
    resolvedQueryMode: codeResult.resolvedQueryMode,
    deliveryMode: codeResult.deliveryMode ?? codeContext?.deliveryMode ?? "code_context",
    contextStrength: codeResult.contextStrength,
    executionSurface: codeResult.executionSurface,
    dominantFamily: codeResult.dominantFamily,
    familyConfidence: codeResult.familyConfidence,
    selectedFiles: codeResult.selectedFiles,
    deferredReason: codeResult.deferredReason,
    missingEvidence: codeResult.missingEvidence,
    recommendedNextReads: codeResult.recommendedNextReads,
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
    wikiTokenCount: wikiContext?.tokenCount ?? 0,
    wikiPageCount: wikiContext?.pageCount ?? 0,
    wikiPageNames: wikiContext?.pageNames ?? [],
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

      return finalizePromptContextResult(query, { context: flowContext, resolvedQueryMode: queryMode, deliveryMode: "code_context" });
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
  _query: string,
  result: PromptContextResult
): PromptContextResult {
  const context = result.context;
  const selectedFiles = result.selectedFiles?.map((file) => file.filePath)
    ?? Array.from(new Set(context?.chunks.map((chunk) => chunk.filePath) ?? []));
  const executionSurface = inferDominantExecutionSurface(context);
  const contextStrength = inferContextStrength(result.resolvedQueryMode, result.deliveryMode, context, selectedFiles, result.familyConfidence);
  const recommendedNextReads = selectedFiles.slice(0, Math.min(contextStrength === "weak" ? 2 : 3, selectedFiles.length));
  const missingEvidence = inferMissingEvidence(result.resolvedQueryMode, contextStrength, result.deliveryMode, selectedFiles, result.deferredReason);
  return {
    ...result,
    contextStrength,
    executionSurface,
    missingEvidence,
    recommendedNextReads,
    advisoryText: buildReporecallAdvisory(result.resolvedQueryMode, contextStrength, selectedFiles, missingEvidence),
  };
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
  }
): Promise<AssembledWikiContext | null> {
  try {
    const results = await memorySearch.search(query, {
      limit: context.maxPages ?? 3,
      types: ["wiki"],
      statuses: ["active"],
      minConfidence: 0.5,
      topCodeFiles: context.topCodeFiles,
      topCodeSymbols: context.topCodeSymbols,
    });
    if (results.length === 0) return null;

    return assembleWikiContext(results, budget, context.maxPages ?? 3);
  } catch (err) {
    getLogger().warn({ err }, "Wiki search failed — continuing without wiki context");
    return null;
  }
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
  memorySearchInstance?: MemorySearch
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
    memorySearchInstance
  );
  return result.context;
}
