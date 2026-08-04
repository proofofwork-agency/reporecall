import type { BroadSelectionDiagnostics, HybridSearch } from "../search/hybrid.js";
import type { MemoryConfig } from "../core/config.js";
import type { AssembledContext } from "../search/types.js";
import type { QueryMode } from "../search/intent.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import type { FTSStore } from "../storage/fts-store.js";
import type { StoredChunk } from "../storage/types.js";
import { resolveSeeds, type SeedResult } from "../search/seed.js";
import { buildStackTree } from "../search/tree-builder.js";
import { assembleFlowContext, assembleDeepRouteContext, countTokens } from "../search/context-assembler.js";
import { GENERIC_BROAD_TERMS, STOP_WORDS, textMatchesQueryTerm } from "../search/utils.js";
import { normalizeTargetText } from "../search/targets.js";
import { isInfrastructureTracePrompt } from "../search/trace-strategy.js";
import { countQueryMatches, directlyMentionsSeed, finalizePromptContextResult, isNoiseLikeFlowSeed, tokenizeQueryTerms } from "./prompt-context-finalization.js";
import type { PromptContextResult } from "./prompt-context-types.js";
export function buildTopologySummary(metadata: MetadataStore, detailed = false): string | null {
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
  config: MemoryConfig,
  activeFiles?: string[],
  signal?: AbortSignal,
  seedResult?: SeedResult
): Promise<AssembledContext> {
  const baseContext = await search.searchWithContext(query, budget, activeFiles, signal, seedResult);
  if (baseContext.routeStyle === "concept") {
    return baseContext;
  }
  return assembleDeepRouteContext(baseContext.chunks, budget, query, compressionOptionsFromConfig(config));
}

function compressionOptionsFromConfig(config: MemoryConfig) {
  return {
    contextCompressionEnabled: config.contextCompressionEnabled,
    contextCompressionMode: config.contextCompressionMode,
    contextCompressionPreserveTopChunks: config.contextCompressionPreserveTopChunks,
    contextCompressionMinChunkTokens: config.contextCompressionMinChunkTokens,
    contextCompressionTargetRatio: config.contextCompressionTargetRatio,
  };
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

function labelFocusedTraceContext(context: AssembledContext): AssembledContext {
  const text = context.text
    .replace(
      "## Relevant codebase context (broad search)",
      "## Relevant codebase context (flow trace)"
    )
    .replace(
      "> Answer from this context first. If coverage is incomplete, Reporecall MCP tools can fill gaps.",
      "> Answer from this context first. The focused trace shows the smallest evidence bundle around the named target."
    );
  return {
    ...context,
    text,
    tokenCount: countTokens(text),
    routeStyle: "flow",
  };
}

function buildTraceSelectedFiles(
  query: string,
  metadata: MetadataStore,
  context: AssembledContext,
  seedResult: SeedResult
): Array<{ filePath: string; selectionSource: string }> {
  const queryTerms = tokenizeQueryTerms(query);
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
      addCandidate(record.resolvedPath, scoreTraceHintPath(queryTerms, record.resolvedPath ?? "", record.importedName));
    }
    const importers = typeof metadata.findImporterFiles === "function" ? metadata.findImporterFiles(filePath) : [];
    for (const importer of importers.slice(0, 20)) {
      const chunks = typeof metadata.findChunksByFilePath === "function" ? metadata.findChunksByFilePath(importer) : [];
      addCandidate(importer, scoreTraceHintFile(queryTerms, importer, chunks));
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
      addCandidate(filePath, scoreTraceHintFile(queryTerms, filePath, fileChunks));
    }
  }

  const hintLimit = context.chunks.length <= 2 ? 4 : 3;
  const threshold = 24;
  const rankedHints = Array.from(adjacencyCandidates.entries())
    .filter(([, score]) => score >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, hintLimit);
  for (const [filePath] of rankedHints) addFile(filePath, "trace_hint");

  return Array.from(selected.entries()).map(([filePath, selectionSource]) => ({ filePath, selectionSource }));
}

function scoreTraceHintPath(
  queryTerms: string[],
  filePath: string,
  symbolName?: string
): number {
  return scoreTraceHintFile(queryTerms, filePath, [], symbolName);
}

function scoreTraceHintFile(
  queryTerms: string[],
  filePath: string,
  chunks: StoredChunk[],
  symbolName?: string
): number {
  const symbolText = chunks.map((chunk) => `${chunk.name} ${chunk.parentName ?? ""}`).join(" ");
  let score = countQueryMatches(queryTerms, filePath, symbolName, symbolText) * 10;
  if (/(?:^|\/)(tests?|specs?|e2e|mocks?)\//i.test(filePath)) score -= 60;
  return score;
}

export async function resolveCodeContext(
  query: string,
  search: HybridSearch,
  codeBudget: number,
  config: MemoryConfig,
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
  if (queryMode === "bug") {
    const context = await search.searchWithContext(query, codeBudget, activeFiles, signal, seedResult);
    return finalizePromptContextResult(query, {
      context,
      resolvedQueryMode: queryMode,
      deliveryMode: context.deliveryMode ?? "code_context",
    });
  }
  if (queryMode === "architecture" || queryMode === "change") {
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
        const context = await buildDeepRouteContext(query, search, codeBudget, config, activeFiles, signal, resolvedSeeds);
        return finalizePromptContextResult(query, {
          context,
          resolvedQueryMode: queryMode,
          deliveryMode: context.deliveryMode ?? "code_context",
        });
      }

      const flowContext = assembleFlowContext(augmentedTree, metadata, codeBudget, query, compressionOptionsFromConfig(config));
      if (flowContext.chunks.length === 0 || !flowContext.text.trim()) {
        const context = await buildDeepRouteContext(query, search, codeBudget, config, activeFiles, signal, resolvedSeeds);
        return finalizePromptContextResult(query, {
          context,
          resolvedQueryMode: queryMode,
          deliveryMode: context.deliveryMode ?? "code_context",
        });
      }

      const deepContext = await buildDeepRouteContext(query, search, codeBudget, config, activeFiles, signal, resolvedSeeds);
      const flowScore = scoreTraceContextCoherence(query, flowContext);
      const deepScore = scoreTraceContextCoherence(query, deepContext);
      const focusedDeepTrace =
        !isInfrastructureTracePrompt(query)
        && deepContext.chunks.some((chunk) => chunk.selectionSource === "focused_trace");
      if (focusedDeepTrace) {
        const focusedContext = labelFocusedTraceContext(deepContext);
        return finalizePromptContextResult(query, {
          context: focusedContext,
          resolvedQueryMode: queryMode,
          deliveryMode: focusedContext.deliveryMode ?? "code_context",
          selectedFiles: focusedContext.chunks.map((chunk) => ({
            filePath: chunk.filePath,
            selectionSource: chunk.selectionSource ?? "focused_trace",
            selectionReason: chunk.selectionReason,
          })),
        });
      }
      const anchoredFlow =
        flowContext.chunks.some((chunk) => chunk.id === resolvedSeeds.bestSeed?.chunkId)
        && (
          resolvedSeeds.bestSeed.reason === "explicit_target"
          || resolvedSeeds.bestSeed.targetKind === "endpoint"
          || resolvedSeeds.bestSeed.targetKind === "route"
        );
      if (!anchoredFlow && deepScore > flowScore * 1.1) {
        return finalizePromptContextResult(query, {
          context: deepContext,
          resolvedQueryMode: queryMode,
          deliveryMode: deepContext.deliveryMode ?? "code_context",
        });
      }

      return finalizePromptContextResult(query, {
        context: flowContext,
        resolvedQueryMode: queryMode,
        deliveryMode: "code_context",
        selectedFiles: buildTraceSelectedFiles(query, metadata, flowContext, resolvedSeeds),
      });
    }

    const context = await buildDeepRouteContext(query, search, codeBudget, config, activeFiles, signal, resolvedSeeds);
    return finalizePromptContextResult(query, {
      context,
      resolvedQueryMode: queryMode,
      deliveryMode: context.deliveryMode ?? "code_context",
    });
  }

  const context = await buildDeepRouteContext(query, search, codeBudget, config, activeFiles, signal, seedResult);
  return finalizePromptContextResult(query, {
    context,
    resolvedQueryMode: queryMode,
    deliveryMode: context.deliveryMode ?? "code_context",
  });
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
