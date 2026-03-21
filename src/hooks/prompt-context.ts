import type { HybridSearch } from "../search/hybrid.js";
import { type MemoryConfig, resolveContextBudget } from "../core/config.js";
import type { AssembledContext } from "../search/types.js";
import type { RouteDecision } from "../search/intent.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import type { FTSStore } from "../storage/fts-store.js";
import { resolveSeeds } from "../search/seed.js";
import type { SeedResult } from "../search/seed.js";
import { buildStackTree } from "../search/tree-builder.js";
import { assembleFlowContext, assembleDeepRouteContext } from "../search/context-assembler.js";
import type { MemorySearch } from "../memory/search.js";
import { assembleMemoryContext, type AssembledMemoryContext } from "../memory/context.js";
import type { MemoryClass, MemoryRoute, MemorySearchResult } from "../memory/types.js";
import { resolveMemoryClass, resolveMemorySummary } from "../memory/types.js";
import { getLogger } from "../core/logger.js";

export interface PromptContextResult {
  context: AssembledContext | null;
  resolvedRoute: RouteDecision;
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

export async function handlePromptContextDetailed(
  query: string,
  search: HybridSearch,
  config: MemoryConfig,
  activeFiles?: string[],
  signal?: AbortSignal,
  route?: RouteDecision,
  metadata?: MetadataStore,
  fts?: FTSStore,
  seedResult?: SeedResult,
  chunkCount?: number,
  memorySearchInstance?: MemorySearch
): Promise<PromptContextResult> {
  if (!query.trim()) {
    return { context: null, resolvedRoute: "skip" };
  }

  if (route === "skip") {
    return { context: null, resolvedRoute: "skip" };
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
    route,
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
  const memoryContext = memoryEnabled && memoryBudget > 0
    ? await searchMemories(query, memorySearchInstance!, config, memoryBudget, {
        activeFiles,
        topCodeFiles,
        topCodeSymbols,
        codeFloorRatio: memoryCodeFloorRatio,
      })
    : null;

  let context = codeContext;
  if (memoryContext?.text && context) {
    context = {
      ...context,
      text: memoryContext.text + "\n" + context.text,
      tokenCount: context.tokenCount + memoryContext.tokenCount,
    };
  } else if (memoryContext?.text && !context) {
    context = {
      text: memoryContext.text,
      tokenCount: memoryContext.tokenCount,
      chunks: [],
      routeStyle: "standard",
    };
  }

  return {
    context: context ?? null,
    resolvedRoute: codeResult.resolvedRoute,
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
  route?: RouteDecision,
  metadata?: MetadataStore,
  fts?: FTSStore,
  seedResult?: SeedResult
): Promise<PromptContextResult> {
  if (!route || route === "R0") {
    return {
      context: await search.searchWithContext(query, codeBudget, activeFiles, signal, seedResult),
      resolvedRoute: "R0",
    };
  }
  if (route === "R1" && (!metadata || !fts)) {
    return {
      context: await search.searchWithContext(query, codeBudget, activeFiles, signal, seedResult),
      resolvedRoute: "R0",
    };
  }
  if (route === "R1" && metadata && fts) {
    if (search.hasConceptContext(query)) {
      return {
        context: await search.searchWithContext(query, codeBudget, activeFiles, signal, seedResult),
        resolvedRoute: "R0",
      };
    }

    const resolvedSeeds = seedResult ?? resolveSeeds(query, metadata, fts);
    if (resolvedSeeds.bestSeed) {
      const tree = buildStackTree(metadata, {
        seed: resolvedSeeds.bestSeed,
        direction: "both",
        maxDepth: 2,
        maxBranchFactor: 3,
        maxNodes: 24,
        query,
      });

      if (tree.nodeCount <= 1) {
        return {
          context: await buildDeepRouteContext(query, search, codeBudget, activeFiles, signal, resolvedSeeds),
          resolvedRoute: "R2",
        };
      }

      const flowContext = assembleFlowContext(tree, metadata, codeBudget, query);
      if (flowContext.chunks.length === 0 || !flowContext.text.trim()) {
        return {
          context: await buildDeepRouteContext(query, search, codeBudget, activeFiles, signal, resolvedSeeds),
          resolvedRoute: "R2",
        };
      }

      return { context: flowContext, resolvedRoute: "R1" };
    }

    return {
      context: await buildDeepRouteContext(query, search, codeBudget, activeFiles, signal, resolvedSeeds),
      resolvedRoute: "R2",
    };
  }

  return {
    context: await buildDeepRouteContext(query, search, codeBudget, activeFiles, signal, seedResult),
    resolvedRoute: "R2",
  };
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value && value.trim().length > 0))];
}

function configAwareBudget(totalBudget: number, ratio: number): number {
  return Math.max(0, Math.floor(totalBudget * ratio));
}

export async function handlePromptContext(
  query: string,
  search: HybridSearch,
  config: MemoryConfig,
  activeFiles?: string[],
  signal?: AbortSignal,
  route?: RouteDecision,
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
    route,
    metadata,
    fts,
    seedResult,
    chunkCount,
    memorySearchInstance
  );
  return result.context;
}
