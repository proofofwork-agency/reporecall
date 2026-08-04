/**
 * Lookup-specific search strategy helpers.
 *
 * Extracted from HybridSearch so they can be reused (and tested) independently.
 * Every function is stateless -- callers supply the data they need.
 */

import type { SearchResult } from "./types.js";
import type { SeedResult, SeedCandidate } from "./seed.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import { GENERIC_BROAD_TERMS, GENERIC_QUERY_ACTION_TERMS, isTestFile, STOP_WORDS } from "./utils.js";
import { resolveTargetsForQuery } from "./targets.js";
import { chunkToSearchResult } from "./shared/mappers.js";
import { splitIdentifierTokens } from "./target-text.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Seed filtering helpers
// ---------------------------------------------------------------------------

function isExactSeed(seed: SeedCandidate): boolean {
  return seed.reason === "explicit_target" || seed.reason === "resolved_target";
}

/**
 * Extract non-generic query terms used to verify that a seed actually
 * matches the user's query. Splits on whitespace, lowercases, drops short
 * tokens, stop words, generic broad nouns ("flow", "service"...), and
 * generic action verbs ("show", "inspect"...).
 */
function extractQueryAnchors(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) =>
      t.length >= 3
      && !STOP_WORDS.has(t)
      && !GENERIC_BROAD_TERMS.has(t)
      && !GENERIC_QUERY_ACTION_TERMS.has(t)
    );
}

/**
 * A seed survives only if ≥2 non-generic query anchors appear in its
 * filePath or name. Short queries (fewer than 2 anchors) bypass the check
 * — the existing target-resolver heuristics are the only thing keeping
 * a single-symbol lookup from over-matching, and tightening further would
 * regress those.
 */
function seedMatchesQueryAnchors(seed: SeedCandidate, query: string): boolean {
  const anchors = extractQueryAnchors(query);
  if (anchors.length < 2) return true;
  const haystack = `${seed.filePath} ${seed.name ?? ""}`.toLowerCase();
  let matched = 0;
  for (const anchor of anchors) {
    if (haystack.includes(anchor)) {
      matched += 1;
      if (matched >= 2) return true;
    }
  }
  return false;
}

function selectPrimarySeed(
  seedResult: SeedResult,
  exactSeeds: SeedCandidate[],
  query: string,
): SeedCandidate | null {
  if (
    seedResult.bestSeed
    && isExactSeed(seedResult.bestSeed)
    && !isTestFile(seedResult.bestSeed.filePath)
    && seedMatchesQueryAnchors(seedResult.bestSeed, query)
  ) {
    return seedResult.bestSeed;
  }
  const fallback = exactSeeds.find((seed) => seedMatchesQueryAnchors(seed, query));
  return fallback ?? null;
}

function extractDirectLookupNames(query: string): string[] {
  const names = query.match(/[A-Za-z_$][A-Za-z0-9_$-]*/g) ?? [];
  return Array.from(new Set(names.filter((name) => {
    const normalized = name.toLowerCase();
    if (name.length < 3) return false;
    if (STOP_WORDS.has(normalized)) return false;
    if (GENERIC_BROAD_TERMS.has(normalized)) return false;
    if (GENERIC_QUERY_ACTION_TERMS.has(normalized)) return false;
    return true;
  })));
}

function resolveDirectNamedChunks(
  query: string,
  metadata: MetadataStore,
): SearchResult[] {
  const names = extractDirectLookupNames(query);
  if (names.length === 0) return [];

  const normalizedNames = new Set(names.map((name) => splitIdentifierTokens(name).join(" ")));
  const matches = metadata.findChunksByNames(names)
    .filter((chunk) => !isTestFile(chunk.filePath))
    .filter((chunk) => normalizedNames.has(splitIdentifierTokens(chunk.name).join(" ")));
  if (matches.length === 0) return [];

  const primary = [...matches].sort((a, b) => {
    const aExactCase = names.includes(a.name) ? 1 : 0;
    const bExactCase = names.includes(b.name) ? 1 : 0;
    if (aExactCase !== bExactCase) return bExactCase - aExactCase;
    const aExported = a.isExported ? 1 : 0;
    const bExported = b.isExported ? 1 : 0;
    if (aExported !== bExported) return bExported - aExported;
    return a.filePath.localeCompare(b.filePath);
  })[0];
  if (!primary) return [];

  return [chunkToSearchResult(primary, 4)];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build focused exact results from resolved seeds.
 *
 * Attempts to return a small set of high-confidence SearchResults that exactly
 * match the user's query target. Returns `null` when no exact match is found,
 * signalling the caller to fall through to broader retrieval.
 *
 * @param query            - The raw user query string
 * @param seedResult       - Pre-resolved seed candidates
 * @param maxContextChunks - Upper bound on chunks the caller can accept
 * @param metadata         - MetadataStore for chunk / target resolution
 */
export function buildFocusedExactResults(
  query: string,
  seedResult: SeedResult,
  maxContextChunks: number,
  metadata: MetadataStore,
): SearchResult[] | null {
  const exactSeeds = seedResult.seeds
    .filter((seed) => isExactSeed(seed) && !isTestFile(seed.filePath))
    .slice(0, 6);
  if (exactSeeds.length === 0) {
    const directNamed = resolveDirectNamedChunks(query, metadata);
    if (directNamed.length > 0) return directNamed;
  }

  const primarySeed = selectPrimarySeed(seedResult, exactSeeds, query);
  if (!primarySeed) {
    const directNamed = resolveDirectNamedChunks(query, metadata);
    if (directNamed.length > 0) return directNamed;
  }
  if (!primarySeed) return null;

  const seenChunkIds = new Set<string>();
  const selected: SearchResult[] = [];

  // Phase 1: gather chunks from seeds in the same file as the primary seed
  for (const seed of [primarySeed, ...exactSeeds.filter((candidate) =>
    candidate.chunkId !== primarySeed.chunkId && candidate.filePath === primarySeed.filePath
  )]) {
    if (selected.length >= Math.min(maxContextChunks, 3)) break;
    if (seenChunkIds.has(seed.chunkId)) continue;
    const chunk = metadata.getChunksByIds([seed.chunkId])[0];
    if (!chunk) continue;
    seenChunkIds.add(seed.chunkId);
    selected.push(chunkToSearchResult(chunk, 3 - selected.length * 0.05 + seed.confidence));
  }

  if (selected.length > 0) return selected;

  // Phase 2: fall back to direct target resolution (endpoints / file_modules)
  const directTargetHits = resolveTargetsForQuery(query, metadata)
    .filter((hit) => (hit.target.kind === "endpoint" || hit.target.kind === "file_module"))
    .filter((hit) => !isTestFile(hit.target.filePath))
    .slice(0, 4);
  if (directTargetHits.length === 0) return null;

  for (const hit of directTargetHits) {
    if (selected.length >= Math.min(maxContextChunks, 2)) break;
    const ownerChunkId = hit.target.ownerChunkId
      ?? metadata.findChunksByFilePath(hit.target.filePath)[0]?.id;
    if (!ownerChunkId || seenChunkIds.has(ownerChunkId)) continue;
    const chunk = metadata.getChunksByIds([ownerChunkId])[0];
    if (!chunk || isTestFile(chunk.filePath)) continue;
    seenChunkIds.add(chunk.id);
    selected.push(chunkToSearchResult(chunk, 3 - selected.length * 0.05 + hit.confidence));
  }

  return selected.length > 0 ? selected : null;
}
