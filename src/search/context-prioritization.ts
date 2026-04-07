/**
 * Context prioritization — extracted from HybridSearch.
 *
 * Standalone functions that reorder / prepend search results for hook
 * context injection.  These operate on SearchResult[] arrays and
 * metadata stores; they do not depend on HybridSearch instance state.
 */

import type { MemoryConfig } from "../core/config.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import type { FTSStore } from "../storage/fts-store.js";
import type { StoredChunk } from "../storage/types.js";
import {
  expandQueryTerms,
  isTestFile,
  STOP_WORDS,
  textMatchesQueryTerm,
  tokenizeQueryTerms,
  type ExpandedQueryTerm,
} from "./utils.js";
import {
  assembleConceptContext,
  countTokens,
  type ConceptContextKind,
} from "./context-assembler.js";
import type { SearchResult, AssembledContext } from "./types.js";
import { resolveSeeds } from "./seed.js";
import type { SeedResult } from "./seed.js";
import { normalizeTargetText } from "./targets.js";

// ── Scoring constants from the retrieval pipeline ─────────────────
import {
  IMPL_BOOST,
  COMMUNITY_SAME_BOOST,
  DOC_PENALTY,
  TERM_MATCH_BOOST,
} from "./pipeline-core.js";
export { IMPL_BOOST, COMMUNITY_SAME_BOOST, DOC_PENALTY, TERM_MATCH_BOOST };

// ── Local constants ────────────────────────────────────────────────
const DOC_PENALTY_NO_IMPL = 0.8;
const CONCEPT_BOOST = 0.9;

// ── Compiled concept bundle (mirrors HybridSearch's internal type) ─
export interface CompiledConceptBundle {
  kind: string;
  pattern: RegExp;
  symbols: string[];
  maxChunks: number;
}

// ── Shared helpers ─────────────────────────────────────────────────

/**
 * True when `filePath` sits under an implementation directory
 * (src/, lib/, bin/, etc.).
 */
export function isImplementationPath(
  filePath: string,
  implementationPaths: string[] = ["src/", "lib/", "bin/"]
): boolean {
  const lowerPath = filePath.toLowerCase();
  if (implementationPaths.some((prefix) => lowerPath.startsWith(prefix.toLowerCase()))) return true;
  return /(?:^|\/)(src|lib|bin|app|server|api|functions|handlers|controllers|services|supabase)\//.test(lowerPath);
}

/**
 * True when the search result lives in an implementation path.
 */
export function isImplementationChunk(
  result: SearchResult,
  implementationPaths?: string[]
): boolean {
  return isImplementationPath(result.filePath, implementationPaths);
}

// ── Concept handling ───────────────────────────────────────────────

export function getMatchedConceptBundles(
  query: string,
  conceptBundles: CompiledConceptBundle[]
): CompiledConceptBundle[] {
  return conceptBundles.filter((bundle) => bundle.pattern.test(query));
}

export function getConceptKind(
  query: string,
  conceptBundles: CompiledConceptBundle[]
): ConceptContextKind | null {
  const matched = getMatchedConceptBundles(query, conceptBundles);
  if (matched.length === 1) return (matched[0]?.kind ?? null) as ConceptContextKind | null;
  return null;
}

export function selectConceptChunks(
  symbols: string[],
  metadata: MetadataStore,
  implementationPaths: string[],
  maxChunks?: number
): StoredChunk[] {
  const nameOrder = new Map(symbols.map((name, index) => [name, index]));
  const bestByName = new Map<string, StoredChunk>();

  for (const chunk of metadata.findChunksByNames(symbols)) {
    const existing = bestByName.get(chunk.name);
    if (!existing || compareConceptChunks(chunk, existing, implementationPaths) < 0) {
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

export function compareConceptChunks(
  a: StoredChunk,
  b: StoredChunk,
  implementationPaths: string[]
): number {
  const implDiff = Number(isImplementationPath(b.filePath, implementationPaths))
    - Number(isImplementationPath(a.filePath, implementationPaths));
  if (implDiff !== 0) return implDiff;

  const testDiff = Number(isTestFile(a.filePath))
    - Number(isTestFile(b.filePath));
  if (testDiff !== 0) return testDiff;

  return a.filePath.localeCompare(b.filePath);
}

// ── Hook priority scoring ──────────────────────────────────────────

export function getHookPriorityScore(
  result: SearchResult,
  queryTerms: string[],
  hasImplementationChunks: boolean,
  config: MemoryConfig,
  seedCommunityId: string | undefined,
  metadata: MetadataStore,
  expandedTerms: ExpandedQueryTerm[] = expandQueryTerms(queryTerms),
  broadQuery: boolean = false
): number {
  let score = result.score;
  const lowerPath = result.filePath.toLowerCase();
  const baseName = lowerPath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  const lowerName = result.name.toLowerCase();

  if (isImplementationChunk(result, config.implementationPaths)) score *= IMPL_BOOST;
  if (isTestFile(result.filePath)) {
    score *= config.testPenaltyFactor;
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
  } else if (broadQuery && isUtilityLikePath(lowerPath, lowerName)) {
    score *= 0.6;
  }

  // Length penalty: demote disproportionately large chunks (same curve as RRF)
  const lineCount = result.endLine - result.startLine + 1;
  if (lineCount > 80) {
    score *= 80 / (lineCount * 0.8 + 16);
  }

  // Community cohesion boost: results in the same community as seed get a small boost
  if (seedCommunityId && typeof metadata.getCommunityForChunk === "function") {
    const chunkComm = metadata.getCommunityForChunk(result.id);
    if (chunkComm && chunkComm === seedCommunityId) {
      score *= COMMUNITY_SAME_BOOST;
    }
  }

  return score;
}

// ── Utility-like path detection ────────────────────────────────────
function isUtilityLikePath(lowerPath: string, lowerName: string): boolean {
  return /(?:^|\/)(lib|shared|core|utils?|helpers?|types?)\//.test(lowerPath)
    || /\b(utils?|helpers?|types?|errors?)\b/.test(lowerName);
}

// ── Context-building functions ─────────────────────────────────────

/**
 * Build a concept-oriented context (e.g. "search pipeline", "AST",
 * "storage") when the query matches exactly one concept bundle.
 */
export function buildConceptContext(
  query: string,
  tokenBudget: number,
  metadata: MetadataStore,
  fts: FTSStore,
  conceptBundles: CompiledConceptBundle[],
  implementationPaths: string[],
  chunkToSearchResult: (chunk: StoredChunk, score: number) => SearchResult,
  seedResult?: SeedResult
): AssembledContext | null {
  const conceptKind = getConceptKind(query, conceptBundles);
  if (!conceptKind) return null;

  const seeds = seedResult ?? resolveSeeds(query, metadata, fts);
  const hasResolvedExplicitTarget = seeds.seeds
    .some((seed) => seed.reason === "explicit_target" || seed.reason === "resolved_target");
  if (hasResolvedExplicitTarget) return null;

  const bundle = conceptBundles.find((b) => b.kind === conceptKind);
  const symbols = bundle?.symbols ?? [];
  const selectedChunks = selectConceptChunks(
    symbols,
    metadata,
    implementationPaths,
    bundle?.maxChunks ?? 4
  );
  if (selectedChunks.length === 0) return null;

  const conceptResults = selectedChunks.map((chunk, index) =>
    chunkToSearchResult(chunk, 1 - index * 0.01)
  );

  return assembleConceptContext(conceptKind, conceptResults, tokenBudget);
}

/**
 * Re-score and sort results by hook-injection priority.
 */
export function prioritizeForHookContext(
  query: string,
  results: SearchResult[],
  config: MemoryConfig,
  seedCommunityId: string | undefined,
  metadata: MetadataStore,
  broadQuery: boolean = false
): SearchResult[] {
  const queryTerms = tokenizeQueryTerms(query)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
  const expandedTerms = expandQueryTerms(query);
  const hasImplChunks = results.some((result) =>
    isImplementationChunk(result, config.implementationPaths)
  );

  return results
    .map((result) => ({
      result,
      adjustedScore: getHookPriorityScore(
        result,
        queryTerms,
        hasImplChunks,
        config,
        seedCommunityId,
        metadata,
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

// ── Prepend strategies ─────────────────────────────────────────────

/** Inventory-suppression gate shared by several prepend strategies. */
const BROAD_INVENTORY_RE =
  /\b(?:which|what|list|show)\s+files\b|\bfiles?\s+(?:implement|handle|power|control|cover)\b/i;
const INVENTORY_GENERIC_TARGET_ALIAS_TERMS = new Set(["route", "routes", "router", "routing", "navigation"]);
const INVENTORY_STRUCTURAL_TERMS = new Set([
  "which", "what", "list", "show", "file", "files",
  "implement", "implements", "handle", "handles",
  "power", "powers", "control", "controls", "cover", "covers",
  "full", "entire",
]);

function shouldSuppressBroadResolvedTarget(
  query: string,
  seed: SeedResult["seeds"][number]
): boolean {
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

/**
 * Boost explicit / resolved target seeds to the top of the result list.
 */
export function prependExplicitTargetResults(
  query: string,
  results: SearchResult[],
  metadata: MetadataStore,
  fts: FTSStore,
  chunkToSearchResult: (chunk: StoredChunk, score: number) => SearchResult,
  seedResult?: SeedResult
): SearchResult[] {
  const seeds = seedResult ?? resolveSeeds(query, metadata, fts);
  const explicitSeeds = seeds.seeds
    .filter((seed) => seed.reason === "explicit_target" || seed.reason === "resolved_target")
    .filter((seed) => !shouldSuppressBroadResolvedTarget(query, seed))
    .slice(0, 5);

  if (explicitSeeds.length === 0) return results;

  const chunkMap = new Map(
    metadata
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
        : chunkToSearchResult(chunk, boostedScore)
    );
  }

  return Array.from(byId.values()).sort((a, b) => b.score - a.score);
}

/**
 * Boost bug-relevant seeds (filtered by salient terms) to the top.
 */
export function prependBugSeedResults(
  query: string,
  results: SearchResult[],
  metadata: MetadataStore,
  fts: FTSStore,
  chunkToSearchResult: (chunk: StoredChunk, score: number) => SearchResult,
  extractBugSalientTerms: (q: string) => string[],
  seedResult?: SeedResult
): SearchResult[] {
  const seeds = seedResult ?? resolveSeeds(query, metadata, fts);
  const focusTerms = extractBugSalientTerms(query);
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
    metadata
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
        : chunkToSearchResult(chunk, boostedScore)
    );
  }

  return Array.from(byId.values()).sort((a, b) => b.score - a.score);
}

/**
 * Boost concept-target symbols when no explicit seed was resolved.
 */
export function prependConceptTargetResults(
  query: string,
  results: SearchResult[],
  metadata: MetadataStore,
  fts: FTSStore,
  conceptBundles: CompiledConceptBundle[],
  implementationPaths: string[],
  chunkToSearchResult: (chunk: StoredChunk, score: number) => SearchResult,
  seedResult?: SeedResult
): SearchResult[] {
  const kind = getConceptKind(query, conceptBundles);
  const conceptSymbols = kind
    ? (conceptBundles.find((b) => b.kind === kind)?.symbols ?? [])
    : [];
  if (conceptSymbols.length === 0) return results;

  const resolved = seedResult ?? resolveSeeds(query, metadata, fts);
  const hasResolvedExplicitTarget = resolved.seeds
    .some((seed) => seed.reason === "explicit_target" || seed.reason === "resolved_target");
  if (hasResolvedExplicitTarget) return results;

  const selectedChunks = selectConceptChunks(conceptSymbols, metadata, implementationPaths);
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
        : chunkToSearchResult(chunk, boostedScore)
    );
  }

  return Array.from(byId.values()).sort((a, b) => b.score - a.score);
}

/**
 * Boost broad (high-confidence, non-explicit) seeds when the query
 * contains enough content terms and no explicit target was found.
 */
export function prependBroadSeedResults(
  query: string,
  results: SearchResult[],
  metadata: MetadataStore,
  fts: FTSStore,
  chunkToSearchResult: (chunk: StoredChunk, score: number) => SearchResult,
  seedResult?: SeedResult,
  broadQuery: boolean = false
): SearchResult[] {
  const seeds = seedResult ?? resolveSeeds(query, metadata, fts);
  if (seeds.seeds.some((seed) => seed.reason === "explicit_target")) return results;
  if (!broadQuery && seeds.seeds.some((seed) => seed.reason === "resolved_target")) return results;

  const contentTerms = tokenizeQueryTerms(query)
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
  if (contentTerms.length < 4) return results;

  const broadSeeds = seeds.seeds
    .filter((seed) => seed.confidence >= (broadQuery ? 0.5 : 0.6) && !isTestFile(seed.filePath))
    .filter((seed) => seed.kind !== "interface_declaration" && seed.kind !== "type_alias_declaration")
    .filter((seed) => !shouldSuppressBroadResolvedTarget(query, seed));
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
    metadata
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
        : chunkToSearchResult(chunk, boostedScore)
    );
  }

  return Array.from(byId.values()).sort((a, b) => b.score - a.score);
}

// ── Summary-only broad context ─────────────────────────────────────

// BroadSelectionDiagnostics is the canonical type from architecture-strategy;
// re-export it here so callers that only import context-prioritization get it.
export type { BroadSelectionDiagnostics } from "./architecture-strategy.js";
import type { BroadSelectionDiagnostics } from "./architecture-strategy.js";

export function buildSummaryOnlyBroadContext(
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
