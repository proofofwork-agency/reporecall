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

export interface PromptContextResult {
  context: AssembledContext | null;
  resolvedRoute: RouteDecision;
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
  chunkCount?: number
): Promise<PromptContextResult> {
  if (!query.trim()) {
    return { context: null, resolvedRoute: "skip" };
  }

  if (route === "skip") {
    return { context: null, resolvedRoute: "skip" };
  }

  const budget = resolveContextBudget(config.contextBudget, chunkCount ?? 0);

  // R0 or fallback: existing behavior
  if (!route || route === "R0") {
    return {
      context: await search.searchWithContext(query, budget, activeFiles, signal, seedResult),
      resolvedRoute: "R0",
    };
  }

  // R1 without metadata/fts falls back to R0
  if (route === "R1" && (!metadata || !fts)) {
    return {
      context: await search.searchWithContext(query, budget, activeFiles, signal, seedResult),
      resolvedRoute: "R0",
    };
  }

  // R1: flow route — need seed + tree
  if (route === "R1" && metadata && fts) {
    // Concept queries should not attempt R1 — they resolve via R0 (concept bundle)
    if (search.hasConceptContext(query)) {
      return {
        context: await search.searchWithContext(query, budget, activeFiles, signal, seedResult),
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
      });

      // Weak tree coverage should degrade to deep mode rather than pretending
      // the flow route succeeded with only the seed node.
      if (tree.nodeCount <= 1) {
        return {
          context: await buildDeepRouteContext(query, search, budget, activeFiles, signal, resolvedSeeds),
          resolvedRoute: "R2",
        };
      }

      const flowContext = assembleFlowContext(tree, metadata, budget, query);
      if (flowContext.chunks.length === 0 || !flowContext.text.trim()) {
        return {
          context: await buildDeepRouteContext(query, search, budget, activeFiles, signal, resolvedSeeds),
          resolvedRoute: "R2",
        };
      }

      return { context: flowContext, resolvedRoute: "R1" };
    }
    return {
      context: await buildDeepRouteContext(query, search, budget, activeFiles, signal, resolvedSeeds),
      resolvedRoute: "R2",
    };
  }

  // R2: deep route — chunk context + MCP guidance
  return {
    context: await buildDeepRouteContext(query, search, budget, activeFiles, signal, seedResult),
    resolvedRoute: "R2",
  };
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
  chunkCount?: number
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
    chunkCount
  );
  return result.context;
}
