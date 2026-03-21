import type { MetadataStore } from "../storage/metadata-store.js";
import type { FTSStore } from "../storage/fts-store.js";
import type { StoredChunk, TargetKind } from "../storage/types.js";
import {
  expandQueryTerms,
  getQueryTermVariants,
  isTestFile,
  STOP_WORDS,
  textMatchesQueryTerm,
  tokenizeQueryTerms,
} from "./utils.js";
import { resolveTargetsForQuery } from "./targets.js";
import { classifyIntent } from "./intent.js";

export interface SeedCandidate {
  chunkId: string;
  name: string;
  filePath: string;
  kind: string;
  confidence: number; // 0-1
  reason: "explicit_target" | "resolved_target" | "fts_exact" | "hybrid_top";
  targetId?: string;
  targetKind?: TargetKind;
  resolvedAlias?: string;
  resolutionSource?: string;
}

export interface SeedResult {
  seeds: SeedCandidate[];
  bestSeed: SeedCandidate | null;
}

interface RankedSeedResult {
  id: string;
  rank: number;
}

// Regex patterns for identifier extraction
// Require lowercase in position 2+ to exclude all-caps acronyms (AST, FTS, MCP, R0...)
const PASCAL_CASE_RE = /\b([A-Z][a-z][a-zA-Z0-9]*)\b/g;
const CAMEL_CASE_RE = /\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g;
const FILE_PATH_RE = /[\w/.-]+\.\w{1,10}/g;
const DOTTED_PATH_RE = /\b([A-Za-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*)\b/g;
const ACRONYM_RE = /\b([A-Z]{3,6})\b/g;
const ACRONYM_BLOCKLIST = new Set([
  "API", "URL", "CSS", "HTML", "HTTP", "JSON", "XML", "SQL",
  "REST", "SDK", "DOM", "CLI", "ENV", "EOF", "SSH", "TLS",
  "SSL", "DNS", "TCP", "UDP", "URI", "RFC", "CORS", "CSRF",
  "AST", "MCP", "JWT", "RSA", "AES", "SHA", "AWS", "GCP",
]);

// Extended stop words for FTS content term filtering (common verbs in navigational queries)
const FTS_STOP_WORDS = new Set([
  ...STOP_WORDS,
  "work", "works", "working", "does", "how", "used", "built",
  "happens", "handle", "handles", "get", "gets", "set", "sets",
  "run", "runs", "call", "calls", "make", "makes", "use", "uses",
]);

// Tree-sitter node types that represent meaningful code constructs
const MEANINGFUL_KINDS = new Set([
  "function_declaration", "method_definition", "class_declaration",
  "interface_declaration", "type_alias_declaration", "export_statement",
]);

// Tiebreak ranking for near-equal confidence seeds: prefer runtime constructs
// over type-only definitions. Allocated once at module level.
const KIND_RANK: Record<string, number> = {
  function_declaration: 4,
  class_declaration: 4,  // classes represent modules; equal priority to functions
  method_definition: 2,  // internal methods are lower-priority seeds
  export_statement: 1,
  interface_declaration: 0,
  type_alias_declaration: 0,
};

function buildFallbackQueries(query: string, queryTermsLower: string[]): string[] {
  const contentTerms = queryTermsLower.filter((term) => !FTS_STOP_WORDS.has(term));
  const expandedTerms = expandQueryTerms(queryTermsLower)
    .filter((term) => term.weight >= 0.58 && !FTS_STOP_WORDS.has(term.term))
    .map((term) => term.term);
  const variants = new Set<string>([query]);

  if (contentTerms.length >= 2) {
    variants.add(contentTerms.join(" "));
  }

  for (const term of [...contentTerms, ...expandedTerms].slice(0, 8)) {
    variants.add(term);
    for (const variant of getQueryTermVariants(term)) {
      variants.add(variant);
    }
  }

  return Array.from(variants);
}

function mergeRankedResults(
  fts: Pick<FTSStore, "search">,
  queries: string[],
  limit: number
): RankedSeedResult[] {
  const bestById = new Map<string, number>();

  for (const query of queries) {
    for (const result of fts.search(query, limit)) {
      const previousRank = bestById.get(result.id);
      if (previousRank === undefined || Math.abs(result.rank) > Math.abs(previousRank)) {
        bestById.set(result.id, result.rank);
      }
    }
  }

  return Array.from(bestById.entries())
    .map(([id, rank]) => ({ id, rank }))
    .sort((a, b) => Math.abs(b.rank) - Math.abs(a.rank));
}

/**
 * Multi-signal FTS confidence scoring.
 * Combines name match, FTS rank, file path overlap, and chunk kind/export signals.
 */
export function scoreFTSCandidate(
  chunk: StoredChunk,
  queryTermsLower: string[],
  rank: number
): number {
  const chunkNameLower = chunk.name.toLowerCase();
  const expandedTerms = expandQueryTerms(queryTermsLower)
    .filter((term) => !FTS_STOP_WORDS.has(term.term));
  const weightedTerms = expandedTerms.length > 0
    ? expandedTerms
    : queryTermsLower
        .filter((term) => !FTS_STOP_WORDS.has(term))
        .map((term) => ({ term, weight: 1 }));
  const totalWeight = weightedTerms.reduce((sum, term) => sum + term.weight, 0) || 1;

  // Signal 1: Name match (0.0 / 0.15 / 0.30)
  // Use filtered terms only: require length ≥ 3 and exclude stop words to prevent
  // short English words like "is" or "of" from partial-matching code names
  // (e.g. "is" would match "isCorrupted" via .includes()).
  const nameMatchTerms = weightedTerms.filter((term) => term.term.length >= 3);
  const isExactMatch = nameMatchTerms.some((term) =>
    getQueryTermVariants(term.term).some((variant) => variant === chunkNameLower)
  );
  const isPartialMatch = !isExactMatch && nameMatchTerms.some(
    (term) => getQueryTermVariants(term.term).some(
      (variant) => chunkNameLower.includes(variant) || variant.includes(chunkNameLower)
    )
  );
  const nameScore = isExactMatch ? 0.30 : isPartialMatch ? 0.15 : 0.0;

  // Signal 2: FTS rank contribution (0 to 0.25)
  const rankContrib = 0.25 * Math.min(1, Math.abs(rank) / 10);

  // Signal 3: File path overlap (0 to 0.20)
  const contentTerms = weightedTerms.filter((term) => term.term.length >= 2);
  let pathContrib = 0;
  if (contentTerms.length > 0) {
    const pathLower = chunk.filePath.toLowerCase();
    const matchingWeight = contentTerms.reduce(
      (sum, term) => sum + (textMatchesQueryTerm(pathLower, term.term) ? term.weight : 0),
      0
    );
    pathContrib = 0.20 * (matchingWeight / totalWeight);
  }

  // Signal 4: Kind + export (0 to 0.25)
  // function_declaration gets a small base bonus over interface/type_alias because
  // most navigational queries ("how does X work?", "what happens when X fires?")
  // want to trace behaviour, not inspect type shapes.
  let kindScore = MEANINGFUL_KINDS.has(chunk.kind) ? 0.15 : 0;
  if (chunk.kind === "function_declaration" || chunk.kind === "method_definition") kindScore += 0.05;
  if (chunk.kind === "export_statement") kindScore = 0.20;
  else if (MEANINGFUL_KINDS.has(chunk.kind) && chunk.content?.includes("export")) kindScore += 0.05;

  // Signal 5: Coverage-based signal scaling — measures how many distinct content
  // terms appear in the candidate's name or file path. When a multi-term query
  // (3+ content terms) matches a candidate on ≤1 terms in name+path, the FTS
  // signals are likely driven by a single high-frequency codebase term (e.g.
  // "flow" dominating "authentication flow" results). Scale ALL signal
  // contributions proportionally instead of applying a small fixed penalty.
  // This is deterministic and language-agnostic — no hardcoded word lists.
  const namePathText = (chunk.name + " " + chunk.filePath).toLowerCase();
  const matchingLocalityWeight = contentTerms.reduce(
    (sum, term) =>
      sum
      + (
        textMatchesQueryTerm(namePathText, term.term)
        || getQueryTermVariants(term.term).some((variant) => variant.includes(chunkNameLower))
          ? term.weight
          : 0
      ),
    0
  );
  const hasLongAnchorMatch = contentTerms.some(
    (term) => term.term.length >= 8 && term.weight >= 0.7 && textMatchesQueryTerm(namePathText, term.term)
  );

  const coverageRatio = matchingLocalityWeight / totalWeight;
  const rawSignals = nameScore + rankContrib + pathContrib + kindScore;
  if (contentTerms.length >= 3 && coverageRatio < 0.5) {
    const coverageScale = hasLongAnchorMatch
      ? coverageRatio < 0.15 ? 0.40 : 0.55
      : coverageRatio < 0.15 ? 0.20 : 0.30;
    return Math.min(0.85, Math.max(0, 0.35 + rawSignals * coverageScale));
  }
  return Math.min(0.85, Math.max(0, 0.35 + rawSignals));
}

/**
 * Extract explicit code identifiers from a natural-language query.
 *
 * Returns de-duplicated identifier strings that look like code symbols
 * (PascalCase classes, camelCase functions, dotted paths, file paths).
 *
 * @param query - The user's query string
 * @returns Array of extracted identifier strings
 */
export function extractExplicitTargets(query: string): string[] {
  const targets = new Set<string>();

  // Dotted paths: split into parts and add each
  for (const match of query.matchAll(DOTTED_PATH_RE)) {
    const group = match[1];
    if (!group) continue;
    const parts = group.split(".");
    for (const part of parts) {
      if (part.length >= 2 && !STOP_WORDS.has(part.toLowerCase())) {
        targets.add(part);
      }
    }
  }

  // PascalCase identifiers
  for (const match of query.matchAll(PASCAL_CASE_RE)) {
    const group = match[1];
    if (group) targets.add(group);
  }

  // camelCase identifiers (must contain at least one uppercase after first char)
  for (const match of query.matchAll(CAMEL_CASE_RE)) {
    const candidate = match[1];
    if (candidate && !STOP_WORDS.has(candidate.toLowerCase())) {
      targets.add(candidate);
    }
  }

  // File paths
  for (const match of query.matchAll(FILE_PATH_RE)) {
    const candidate = match[0];
    // Must contain a slash or look like a real file path (not just "word.word")
    if (candidate.includes("/") || /\.(ts|js|tsx|jsx|py|go|rs|java|rb|cpp|c|h|css|html|json|yaml|yml|toml|md)$/i.test(candidate)) {
      targets.add(candidate);
    }
  }

  // Uppercase acronyms (3-6 chars, all-caps) — e.g. "FTS", "MCP"
  for (const match of query.matchAll(ACRONYM_RE)) {
    const candidate = match[1];
    if (candidate && !ACRONYM_BLOCKLIST.has(candidate)) {
      targets.add(candidate);
    }
  }

  return Array.from(targets);
}

/**
 * Check whether a file path (or part of it) appears in the query.
 */
function filePathMentionedInQuery(filePath: string, query: string): boolean {
  // Check if the full path or a significant suffix appears in the query
  if (query.includes(filePath)) return true;
  // Check last two segments, e.g. "auth/handler.ts"
  const parts = filePath.split("/");
  if (parts.length >= 2) {
    const suffix = parts.slice(-2).join("/");
    if (query.includes(suffix)) return true;
  }
  // Check just the filename
  const filename = parts[parts.length - 1];
  if (filename && query.includes(filename)) return true;
  return false;
}

/**
 * Disambiguate multiple chunk matches for the same identifier name.
 * Returns the chunks sorted by preference (best first).
 */
function disambiguate(chunks: StoredChunk[], query: string): StoredChunk[] {
  return [...chunks].sort((a, b) => {
    // Prefer chunks whose file path is mentioned in the query
    const aPathMatch = filePathMentionedInQuery(a.filePath, query) ? 1 : 0;
    const bPathMatch = filePathMentionedInQuery(b.filePath, query) ? 1 : 0;
    if (aPathMatch !== bPathMatch) return bPathMatch - aPathMatch;

    // Prefer implementation files over test files
    const aIsTest = isTestFile(a.filePath) ? 1 : 0;
    const bIsTest = isTestFile(b.filePath) ? 1 : 0;
    if (aIsTest !== bIsTest) return aIsTest - bIsTest;

    // Prefer non-test kinds (method/function/class) — all equal here, stable sort
    return 0;
  });
}

function compareSeedCandidates(a: SeedCandidate, b: SeedCandidate): number {
  // Explicit targets (direct name matches) beat resolved targets from generic
  // catalog aliases — the user mentioned a specific symbol, trust that over
  // incidental noun matches like "pipeline", "storage", "request".
  const reasonRank = (c: SeedCandidate): number =>
    c.reason === "explicit_target" || c.reason === "fts_exact" ? 1 : 0;
  const reasonDiff = reasonRank(b) - reasonRank(a);
  if (reasonDiff !== 0 && Math.abs(b.confidence - a.confidence) <= 0.20) return reasonDiff;

  const diff = b.confidence - a.confidence;
  if (Math.abs(diff) > 0.03) return diff;
  const targetRank = (candidate: SeedCandidate): number => {
    switch (candidate.targetKind) {
      case "endpoint":
        return 4;
      case "file_module":
        return 3;
      case "symbol":
        return 2;
      case "subsystem":
        return 1;
      default:
        return 0;
    }
  };
  const targetDiff = targetRank(b) - targetRank(a);
  if (targetDiff !== 0) return targetDiff;
  return (KIND_RANK[b.kind] ?? 1) - (KIND_RANK[a.kind] ?? 1);
}

/**
 * Resolve seed candidates for a query using explicit identifier extraction
 * and FTS fallback.
 *
 * @param query - The user's natural-language query
 * @param metadata - MetadataStore for chunk lookups
 * @param fts - FTSStore for full-text search fallback
 * @returns SeedResult with ranked candidates and the best seed (or null)
 */
export function resolveSeeds(
  query: string,
  metadata: Pick<
    MetadataStore,
    | "findChunksByNames"
    | "findChunksByNamePrefixes"
    | "getChunk"
    | "getChunksByIds"
    | "findChunksByFilePath"
    | "resolveTargetAliases"
    | "findTargetById"
  >,
  fts: Pick<FTSStore, "search">
): SeedResult {
  const candidates: SeedCandidate[] = [];
  const seenSeedKeys = new Set<string>();

  const pushCandidate = (candidate: SeedCandidate) => {
    const key = `${candidate.chunkId}:${candidate.reason}:${candidate.targetId ?? ""}`;
    const existingIndex = candidates.findIndex((item) => `${item.chunkId}:${item.reason}:${item.targetId ?? ""}` === key);
    if (existingIndex >= 0) {
      const existing = candidates[existingIndex];
      if (existing && existing.confidence >= candidate.confidence) return;
      candidates.splice(existingIndex, 1, candidate);
      return;
    }
    if (seenSeedKeys.has(key)) return;
    seenSeedKeys.add(key);
    candidates.push(candidate);
  };

  const targetHits = typeof metadata.resolveTargetAliases === "function"
    ? resolveTargetsForQuery(query, metadata)
    : [];
  const broadQuery = classifyIntent(query).prefersBroadContext === true;
  const broadAnchorTerms = broadQuery
    ? expandQueryTerms(query).filter((term) =>
        (term.source === "original" || term.source === "morphological") && !term.generic
      )
    : [];
  const broadAnchorAliases = new Set(
    broadAnchorTerms
      .map((term) => term.term.toLowerCase())
  );
  for (const hit of targetHits) {
    let chunk = hit.target.ownerChunkId
      ? metadata.getChunksByIds([hit.target.ownerChunkId])[0]
      : undefined;
    if (!chunk) {
      chunk = metadata.findChunksByFilePath?.(hit.target.filePath)?.[0];
    }
    if (!chunk || isTestFile(chunk.filePath)) continue;
    if (!broadQuery && hit.target.kind === "subsystem" && hit.confidence < 0.78) continue;
    if (broadQuery && broadAnchorTerms.length > 0) {
      const aliasLower = hit.alias.toLowerCase();
      const targetNameText = `${hit.alias} ${hit.target.canonicalName} ${chunk.name}`.toLowerCase();
      const pathText = hit.target.filePath.toLowerCase();
      const nameMatches = broadAnchorTerms.filter((term) => textMatchesQueryTerm(targetNameText, term.term));
      const pathMatches = broadAnchorTerms.filter((term) => textMatchesQueryTerm(pathText, term.term));
      const allowPathOnly = hit.target.kind === "file_module" || hit.target.kind === "endpoint";
      if (hit.target.kind === "symbol" && !broadAnchorAliases.has(aliasLower) && hit.source !== "query") {
        continue;
      }
      if (nameMatches.length === 0) {
        if (allowPathOnly) {
          if (pathMatches.length === 0) continue;
        } else if (pathMatches.length < 2) {
          continue;
        }
      }
    }
    pushCandidate({
      chunkId: chunk.id,
      name: chunk.name,
      filePath: chunk.filePath,
      kind: chunk.kind,
      confidence: hit.confidence,
      reason: "resolved_target",
      targetId: hit.target.id,
      targetKind: hit.target.kind,
      resolvedAlias: hit.alias,
      resolutionSource: hit.source,
    });
  }

  // Step 1: Extract explicit targets
  const targets = extractExplicitTargets(query);

  if (targets.length > 0) {
    // Separate file paths from identifier names
    const filePaths = targets.filter((t) => t.includes("/") || /\.\w{1,10}$/.test(t));
    const identifierNames = targets.filter((t) => !filePaths.includes(t));

    // Look up identifiers by name
    if (identifierNames.length > 0) {
      let chunks = metadata.findChunksByNames(identifierNames);
      let isPrefixMatch = false;

      // Prefix fallback: if exact match returns nothing, try prefix matching
      // Allow 3-char prefixes for all-caps acronyms (e.g. "FTS" → "FTSStore")
      if (chunks.length === 0 && metadata.findChunksByNamePrefixes) {
        const prefixCandidates = identifierNames.filter((n) => n.length >= 4 || (n.length >= 3 && /^[A-Z]+$/.test(n)));
        if (prefixCandidates.length > 0) {
          chunks = metadata.findChunksByNamePrefixes(prefixCandidates, 20);
          isPrefixMatch = true;
        }
      }

      // Group by name
      const byName = new Map<string, StoredChunk[]>();
      for (const chunk of chunks) {
        const existing = byName.get(chunk.name) ?? [];
        existing.push(chunk);
        byName.set(chunk.name, existing);
      }

      for (const matchedChunks of byName.values()) {
        if (matchedChunks.length === 1) {
          // Single match — high confidence (lower for prefix matches)
          const chunk = matchedChunks[0];
          if (!chunk) continue;
          pushCandidate({
            chunkId: chunk.id,
            name: chunk.name,
            filePath: chunk.filePath,
            kind: chunk.kind,
            confidence: isPrefixMatch ? 0.80 : 0.95,
            reason: "explicit_target",
          });
        } else {
          // Multiple matches — disambiguate
          const sorted = disambiguate(matchedChunks, query);
          const top = sorted[0];
          if (!top) continue;
          pushCandidate({
            chunkId: top.id,
            name: top.name,
            filePath: top.filePath,
            kind: top.kind,
            confidence: isPrefixMatch ? 0.70 : 0.85,
            reason: "explicit_target",
          });
          // Add remaining as lower-confidence alternatives
          for (let i = 1; i < sorted.length; i++) {
            const alt = sorted[i];
            if (!alt) continue;
            pushCandidate({
              chunkId: alt.id,
              name: alt.name,
              filePath: alt.filePath,
              kind: alt.kind,
              confidence: isPrefixMatch ? 0.60 : 0.7,
              reason: "explicit_target",
            });
          }
        }
      }

    }

    // For file paths extracted from the query, use FTS to find matching chunks
    if (filePaths.length > 0 && candidates.length === 0) {
      for (const fp of filePaths) {
        const ftsResults = fts.search(fp, 5);
        const ftsIds = ftsResults.map((r) => r.id);
        const chunks = metadata.getChunksByIds
          ? metadata.getChunksByIds(ftsIds)
          : ftsIds.map((id) => metadata.getChunk(id)).filter((c): c is StoredChunk => c !== undefined);
        const chunksById = new Map(chunks.map((c) => [c.id, c]));
        for (const ftsResult of ftsResults) {
          const chunk = chunksById.get(ftsResult.id);
          if (!chunk) continue;
          // Check if the chunk actually lives in the mentioned file
          if (chunk.filePath === fp || chunk.filePath.endsWith(fp) || fp.endsWith(chunk.filePath)) {
            pushCandidate({
              chunkId: chunk.id,
              name: chunk.name,
              filePath: chunk.filePath,
              kind: chunk.kind,
              confidence: 0.85,
              reason: "explicit_target",
            });
          } else {
            pushCandidate({
              chunkId: chunk.id,
              name: chunk.name,
              filePath: chunk.filePath,
              kind: chunk.kind,
              confidence: 0.6,
              reason: "hybrid_top",
            });
          }
        }
      }
    }
  }

  // Step 2: FTS fallback (if no explicit target found with sufficient confidence)
  const hasStrongExplicit = candidates.some((c) => c.confidence >= 0.7);

  if (!hasStrongExplicit) {
    const queryTermsLower = tokenizeQueryTerms(query);
    const ftsResults = mergeRankedResults(
      fts,
      buildFallbackQueries(query, queryTermsLower),
      10
    );

    if (ftsResults.length > 0) {
      const nonTestCandidates: SeedCandidate[] = [];
      const testFallbackCandidates: SeedCandidate[] = [];

      // Batch-fetch all chunks in one query instead of N individual getChunk calls
      const ftsIds = ftsResults.map((r) => r.id);
      const ftsChunks = metadata.getChunksByIds
        ? metadata.getChunksByIds(ftsIds)
        : ftsIds.map((id) => metadata.getChunk(id)).filter((c): c is StoredChunk => c !== undefined);
      const ftsChunksById = new Map(ftsChunks.map((c) => [c.id, c]));

      for (const ftsResult of ftsResults) {
        const chunk = ftsChunksById.get(ftsResult.id);
        if (!chunk) continue;
        if (chunk.kind === "file") continue;
        if (chunk.name === "<anonymous>") continue;

        const confidence = scoreFTSCandidate(chunk, queryTermsLower, ftsResult.rank);
        const chunkNameLower = chunk.name.toLowerCase();
        const isExactMatch = expandQueryTerms(queryTermsLower).some((term) => term.term === chunkNameLower);
        const reason: SeedCandidate["reason"] = isExactMatch ? "fts_exact" : "hybrid_top";
        const candidate: SeedCandidate = {
          chunkId: chunk.id,
          name: chunk.name,
          filePath: chunk.filePath,
          kind: chunk.kind,
          confidence,
          reason,
        };

        if (isTestFile(chunk.filePath)) {
          testFallbackCandidates.push(candidate);
        } else {
          nonTestCandidates.push(candidate);
        }
      }

      const rankedNonTest = [...nonTestCandidates]
        .sort(compareSeedCandidates)
        .slice(0, 8);
      for (const candidate of rankedNonTest) pushCandidate(candidate);
      if (rankedNonTest.length === 0) {
        for (const candidate of [...testFallbackCandidates].sort(compareSeedCandidates).slice(0, 3)) {
          pushCandidate(candidate);
        }
      }
    }
  }

  // Step 3: Sort by confidence and determine bestSeed.
  // Near-tie tiebreak: within 0.03 confidence, prefer runtime constructs
  // (function_declaration, method_definition) over type-only definitions
  // (interface_declaration, type_alias_declaration) — execution queries want
  // to trace behaviour, not data shapes.
  candidates.sort(compareSeedCandidates);

  const bestSeed = candidates.find((c) => c.confidence >= 0.55) ?? null;

  return {
    seeds: candidates,
    bestSeed,
  };
}
