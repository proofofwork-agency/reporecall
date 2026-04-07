/**
 * Lookup-specific search strategy helpers.
 *
 * Extracted from HybridSearch so they can be reused (and tested) independently.
 * Every function is stateless -- callers supply the data they need.
 */

import type { SearchResult } from "./types.js";
import type { SeedResult, SeedCandidate } from "./seed.js";
import type { StoredChunk } from "../storage/types.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import { isTestFile } from "./utils.js";
import { resolveTargetsForQuery } from "./targets.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunkToSearchResult(chunk: StoredChunk, score: number): SearchResult {
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

// ---------------------------------------------------------------------------
// Seed filtering helpers
// ---------------------------------------------------------------------------

function isExactSeed(seed: SeedCandidate): boolean {
  return seed.reason === "explicit_target" || seed.reason === "resolved_target";
}

function selectPrimarySeed(
  seedResult: SeedResult,
  exactSeeds: SeedCandidate[],
): SeedCandidate | null {
  if (
    seedResult.bestSeed
    && isExactSeed(seedResult.bestSeed)
    && !isTestFile(seedResult.bestSeed.filePath)
  ) {
    return seedResult.bestSeed;
  }
  return exactSeeds[0] ?? null;
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
  if (exactSeeds.length === 0) return null;

  const primarySeed = selectPrimarySeed(seedResult, exactSeeds);
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
