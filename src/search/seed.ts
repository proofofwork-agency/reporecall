import type { MetadataStore } from "../storage/metadata-store.js";
import type { FTSStore } from "../storage/fts-store.js";
import type { StoredChunk } from "../storage/types.js";

export interface SeedCandidate {
  chunkId: string;
  name: string;
  filePath: string;
  kind: string;
  confidence: number; // 0-1
  reason: "explicit_target" | "fts_exact" | "hybrid_top";
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

// Common English words to filter out of camelCase false positives
const STOP_WORDS = new Set([
  "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "need",
  "dare", "ought", "used", "to", "of", "in", "for", "on",
  "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off",
  "over", "under", "again", "further", "then", "once", "here",
  "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some",
  "such", "no", "nor", "not", "only", "own", "same", "so",
  "than", "too", "very", "just", "because", "but", "and",
  "if", "or", "while", "about", "what", "which", "who",
  "whom", "this", "that", "these", "those", "am", "an", "a",
  "it", "its", "my", "your", "his", "her", "our", "their",
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

function tokenizeQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((term) => term.length >= 2);
}

function buildFallbackQueries(query: string, queryTermsLower: string[]): string[] {
  const contentTerms = queryTermsLower.filter((term) => !FTS_STOP_WORDS.has(term));
  const variants = new Set<string>([query]);

  if (contentTerms.length >= 2) {
    variants.add(contentTerms.join(" "));
  }

  for (const term of contentTerms.slice(0, 4)) {
    variants.add(term);
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

  // Signal 1: Name match (0.0 / 0.15 / 0.30)
  // Use filtered terms only: require length ≥ 3 and exclude stop words to prevent
  // short English words like "is" or "of" from partial-matching code names
  // (e.g. "is" would match "isCorrupted" via .includes()).
  const nameMatchTerms = queryTermsLower.filter((t) => t.length >= 3 && !FTS_STOP_WORDS.has(t));
  const isExactMatch = nameMatchTerms.some((term) => term === chunkNameLower);
  const isPartialMatch = !isExactMatch && nameMatchTerms.some(
    (term) => chunkNameLower.includes(term) || term.includes(chunkNameLower)
  );
  const nameScore = isExactMatch ? 0.30 : isPartialMatch ? 0.15 : 0.0;

  // Signal 2: FTS rank contribution (0 to 0.25)
  const rankContrib = 0.25 * Math.min(1, Math.abs(rank) / 10);

  // Signal 3: File path overlap (0 to 0.20)
  const contentTerms = queryTermsLower.filter((t) => t.length >= 2 && !FTS_STOP_WORDS.has(t));
  let pathContrib = 0;
  if (contentTerms.length > 0) {
    const pathLower = chunk.filePath.toLowerCase();
    const matchingTerms = contentTerms.filter((term) => pathLower.includes(term));
    pathContrib = 0.20 * (matchingTerms.length / contentTerms.length);
  }

  // Signal 4: Kind + export (0 to 0.25)
  // function_declaration gets a small base bonus over interface/type_alias because
  // most navigational queries ("how does X work?", "what happens when X fires?")
  // want to trace behaviour, not inspect type shapes.
  let kindScore = MEANINGFUL_KINDS.has(chunk.kind) ? 0.15 : 0;
  if (chunk.kind === "function_declaration" || chunk.kind === "method_definition") kindScore += 0.05;
  if (chunk.kind === "export_statement") kindScore = 0.20;
  else if (MEANINGFUL_KINDS.has(chunk.kind) && chunk.content?.includes("export")) kindScore += 0.05;

  // Signal 5: Locality penalty (-0.10) — if no content term appears in either the
  // chunk's name or its file path, this is likely a content-only FTS false positive
  // (e.g. an English word like "overall" matching a code field name). Penalise it so
  // chunks that are in the right module or have a relevant name rank above noise.
  const contentTerms2 = queryTermsLower.filter((t) => t.length >= 2 && !FTS_STOP_WORDS.has(t));
  const hasNameLocality = contentTerms2.some(
    (t) => chunk.name.toLowerCase().includes(t) || t.includes(chunk.name.toLowerCase())
  );
  const hasPathLocality = contentTerms2.some((t) => chunk.filePath.toLowerCase().includes(t));
  const localityPenalty = hasNameLocality || hasPathLocality ? 0 : 0.10;

  return Math.min(0.85, Math.max(0, 0.35 + nameScore + rankContrib + pathContrib + kindScore - localityPenalty));
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
    const parts = match[1].split(".");
    for (const part of parts) {
      if (part.length >= 2 && !STOP_WORDS.has(part.toLowerCase())) {
        targets.add(part);
      }
    }
  }

  // PascalCase identifiers
  for (const match of query.matchAll(PASCAL_CASE_RE)) {
    targets.add(match[1]);
  }

  // camelCase identifiers (must contain at least one uppercase after first char)
  for (const match of query.matchAll(CAMEL_CASE_RE)) {
    const candidate = match[1];
    if (!STOP_WORDS.has(candidate.toLowerCase())) {
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

  return Array.from(targets);
}

/**
 * Test file detection heuristic.
 */
function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return /(?:^|\/)(test|spec|__tests__|__fixtures__|fixtures|benchmark|examples)\//.test(lower)
    || /\.(test|spec)\.[^.]+$/.test(lower);
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
  metadata: Pick<MetadataStore, "findChunksByNames" | "getChunk">,
  fts: Pick<FTSStore, "search">
): SeedResult {
  const candidates: SeedCandidate[] = [];

  // Step 1: Extract explicit targets
  const targets = extractExplicitTargets(query);

  if (targets.length > 0) {
    // Separate file paths from identifier names
    const filePaths = targets.filter((t) => t.includes("/") || /\.\w{1,10}$/.test(t));
    const identifierNames = targets.filter((t) => !filePaths.includes(t));

    // Look up identifiers by name
    if (identifierNames.length > 0) {
      const chunks = metadata.findChunksByNames(identifierNames);

      // Group by name
      const byName = new Map<string, StoredChunk[]>();
      for (const chunk of chunks) {
        const existing = byName.get(chunk.name) ?? [];
        existing.push(chunk);
        byName.set(chunk.name, existing);
      }

      for (const matchedChunks of byName.values()) {
        if (matchedChunks.length === 1) {
          // Single match — high confidence
          const chunk = matchedChunks[0];
          candidates.push({
            chunkId: chunk.id,
            name: chunk.name,
            filePath: chunk.filePath,
            kind: chunk.kind,
            confidence: 0.95,
            reason: "explicit_target",
          });
        } else {
          // Multiple matches — disambiguate
          const sorted = disambiguate(matchedChunks, query);
          candidates.push({
            chunkId: sorted[0].id,
            name: sorted[0].name,
            filePath: sorted[0].filePath,
            kind: sorted[0].kind,
            confidence: 0.85,
            reason: "explicit_target",
          });
          // Add remaining as lower-confidence alternatives
          for (let i = 1; i < sorted.length; i++) {
            candidates.push({
              chunkId: sorted[i].id,
              name: sorted[i].name,
              filePath: sorted[i].filePath,
              kind: sorted[i].kind,
              confidence: 0.7,
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
        for (const ftsResult of ftsResults) {
          const chunk = metadata.getChunk?.(ftsResult.id);
          if (!chunk) continue;
          // Check if the chunk actually lives in the mentioned file
          if (chunk.filePath === fp || chunk.filePath.endsWith(fp) || fp.endsWith(chunk.filePath)) {
            candidates.push({
              chunkId: chunk.id,
              name: chunk.name,
              filePath: chunk.filePath,
              kind: chunk.kind,
              confidence: 0.85,
              reason: "explicit_target",
            });
          } else {
            candidates.push({
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

      for (const ftsResult of ftsResults) {
        const chunk = metadata.getChunk?.(ftsResult.id);
        if (!chunk) continue;
        if (chunk.kind === "file") continue;
        if (chunk.name === "<anonymous>") continue;

        const confidence = scoreFTSCandidate(chunk, queryTermsLower, ftsResult.rank);
        const chunkNameLower = chunk.name.toLowerCase();
        const isExactMatch = queryTermsLower.some((term) => term === chunkNameLower);
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

        if (nonTestCandidates.length >= 8) break;
      }

      candidates.push(...nonTestCandidates);
      if (nonTestCandidates.length === 0) {
        candidates.push(...testFallbackCandidates.slice(0, 3));
      }
    }
  }

  // Step 3: Sort by confidence and determine bestSeed.
  // Near-tie tiebreak: within 0.03 confidence, prefer runtime constructs
  // (function_declaration, method_definition) over type-only definitions
  // (interface_declaration, type_alias_declaration) — execution queries want
  // to trace behaviour, not data shapes.
  const KIND_RANK: Record<string, number> = {
    function_declaration: 4,
    class_declaration: 4,  // classes represent modules; equal priority to functions
    method_definition: 2,  // internal methods are lower-priority seeds
    export_statement: 1,
    interface_declaration: 0,
    type_alias_declaration: 0,
  };
  candidates.sort((a, b) => {
    const diff = b.confidence - a.confidence;
    if (Math.abs(diff) > 0.03) return diff;
    return (KIND_RANK[b.kind] ?? 1) - (KIND_RANK[a.kind] ?? 1);
  });

  const bestSeed = candidates.find((c) => c.confidence >= 0.55) ?? null;

  return {
    seeds: candidates,
    bestSeed,
  };
}
