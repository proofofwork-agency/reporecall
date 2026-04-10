/**
 * Trace-specific search strategy helpers.
 *
 * Extracted from HybridSearch so they can be reused (and tested) independently.
 * Every function is stateless -- callers supply the data they need.
 */

import type { SearchResult } from "./types.js";
import type { ExpandedQueryTerm } from "./utils.js";
import type { StoredChunk } from "../storage/types.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import {
  expandQueryTerms,
  GENERIC_QUERY_ACTION_TERMS,
  isTestFile,
  STOP_WORDS,
  tokenizeQueryTerms,
} from "./utils.js";
import { normalizeTargetText } from "./targets.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TRACE_NOISE_TERMS = new Set([
  "path", "page", "pages", "include", "includes", "including",
  "start", "first", "then", "full", "intent",
]);

const ADJACENT_WORKFLOW_FAMILIES: Record<string, string[]> = {
  auth: ["routing", "permissions"],
  routing: ["auth", "permissions"],
  billing: ["auth", "generation"],
  storage: ["auth", "generation"],
  generation: ["storage", "queue", "billing", "workflow"],
  queue: ["generation"],
  workflow: ["generation", "queue"],
  bot: ["webhook", "daemon"],
};

const MODE_EXPLICIT_LOGGING_RE =
  /\b(log|logger|logging|audit|instrument|instrumentation|telemetry|metrics?)\b/i;
const MODE_EXPLICIT_WEBHOOK_RE =
  /\b(webhook|signature|payload|delivery|event)\b/i;

// ---------------------------------------------------------------------------
// Helpers shared with the extraction pipeline
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

function isImplementationPath(
  filePath: string,
  implementationPaths?: string[],
): boolean {
  const lowerPath = filePath.toLowerCase();
  const implPaths = implementationPaths ?? ["src/", "lib/", "bin/"];
  if (implPaths.some((prefix) => lowerPath.startsWith(prefix.toLowerCase()))) return true;
  return /(?:^|\/)(src|lib|bin|app|server|api|functions|handlers|controllers|services|supabase)\//.test(lowerPath);
}

// ---------------------------------------------------------------------------
// Focused expanded terms (trace mode)
// ---------------------------------------------------------------------------

export function getTraceFocusedExpandedTerms(query: string): ExpandedQueryTerm[] {
  const expanded = expandQueryTerms(query);
  const explicitLogging = MODE_EXPLICIT_LOGGING_RE.test(query);
  const explicitWebhook = MODE_EXPLICIT_WEBHOOK_RE.test(query);
  const familyScores = new Map<string, number>();

  for (const term of expanded) {
    if (!term.family) continue;
    if (term.source !== "original" && term.source !== "morphological") continue;
    const normalized = normalizeTargetText(term.term);
    if (GENERIC_QUERY_ACTION_TERMS.has(normalized)) continue;
    familyScores.set(term.family, (familyScores.get(term.family) ?? 0) + term.weight);
  }

  const rankedFamilies = Array.from(familyScores.entries()).sort((a, b) => b[1] - a[1]);
  const topScore = rankedFamilies[0]?.[1] ?? 0;
  const allowedFamilies = new Set<string>();
  for (const [family, score] of rankedFamilies) {
    if (score < Math.max(0.86, topScore * 0.55)) continue;
    allowedFamilies.add(family);
    for (const adjacent of ADJACENT_WORKFLOW_FAMILIES[family] ?? []) {
      allowedFamilies.add(adjacent);
    }
  }
  if (!explicitLogging) allowedFamilies.delete("logging");
  if (!explicitWebhook && (allowedFamilies.has("auth") || allowedFamilies.has("routing"))) {
    allowedFamilies.delete("webhook");
  }

  return expanded.filter((term) => {
    const normalized = normalizeTargetText(term.term);
    if (GENERIC_QUERY_ACTION_TERMS.has(normalized)) return false;
    if (TRACE_NOISE_TERMS.has(normalized)) return false;
    if (!term.family) {
      return term.source === "original" || term.source === "morphological" || !term.generic;
    }
    if (allowedFamilies.size === 0) {
      if (term.family === "logging" && !explicitLogging) return false;
      if (term.family === "webhook" && !explicitWebhook) return false;
      return true;
    }
    if (allowedFamilies.has(term.family)) return true;
    return false;
  });
}

function collectModeCompoundSemanticTerms(focusedExpanded: ExpandedQueryTerm[]): string[] {
  return focusedExpanded
    .filter((term) =>
      term.source === "semantic"
      && !!term.family
      && !term.generic
      && term.weight >= 0.72
      && (
        /[A-Z_]/.test(term.term)
        || normalizeTargetText(term.term).split(" ").filter(Boolean).length > 1
      )
      && normalizeTargetText(term.term).split(" ").filter(Boolean).length <= 2
    )
    .flatMap((term) => normalizeTargetText(term.term).split(" ").filter(Boolean))
    .filter((term) =>
      term.length >= 3
      && !STOP_WORDS.has(term)
      && !GENERIC_QUERY_ACTION_TERMS.has(term)
      && !TRACE_NOISE_TERMS.has(term)
    );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function extractTraceSalientTerms(query: string): string[] {
  const focusedExpanded = getTraceFocusedExpandedTerms(query);
  const semanticTerms = collectModeCompoundSemanticTerms(focusedExpanded);
  const originalTerms = focusedExpanded
    .filter((term) => term.source === "original" || term.source === "morphological")
    .flatMap((term) => normalizeTargetText(term.term).split(" ").filter(Boolean));
  const rawTerms = tokenizeQueryTerms(query)
    .flatMap((term) => normalizeTargetText(term).split(" ").filter(Boolean))
    .filter((term) =>
      term.length >= 3
      && !STOP_WORDS.has(term)
      && !GENERIC_QUERY_ACTION_TERMS.has(term)
      && !TRACE_NOISE_TERMS.has(term)
    );

  return Array.from(new Set([
    ...originalTerms,
    ...semanticTerms,
    ...rawTerms,
  ])).slice(0, 12);
}

export function buildTraceRetrievalQuery(query: string): string {
  return extractTraceSalientTerms(query).join(" ") || query;
}

export function isInfrastructureTracePrompt(query: string): boolean {
  const lower = query.toLowerCase();
  return /^(trace|follow)\b/.test(lower)
    && /\bfrom\b.+\bto\b.+/.test(lower)
    && /\b(mcp|stdio|cli|command|transport|registration|hook|daemon|server|http|endpoint|socket)\b/.test(lower);
}

export function prependTraceTargetResults(
  query: string,
  results: SearchResult[],
  metadata: MetadataStore,
  implementationPaths?: string[],
): SearchResult[] {
  if (!metadata.resolveTargetAliases) return results;

  const traceTerms = extractTraceSalientTerms(query)
    .map((term) => normalizeTargetText(term))
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
  if (traceTerms.length === 0) return results;

  const aliases = Array.from(new Set(traceTerms));
  const hits = [
    ...metadata.resolveTargetAliases(aliases, 40, ["file_module", "endpoint"]),
    ...metadata.resolveTargetAliases(aliases, 60, ["symbol"]),
  ];
  if (hits.length === 0) return results;

  const byId = new Map(results.map((result) => [result.id, result]));
  const topScore = results[0]?.score ?? 1;
  const seenFiles = new Set<string>();

  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index];
    if (!hit) continue;
    const filePath = hit.target.filePath;
    if (!filePath || isTestFile(filePath) || !isImplementationPath(filePath, implementationPaths)) continue;
    if (seenFiles.has(filePath)) continue;

    const ownerChunkId = hit.target.ownerChunkId
      ?? metadata.findChunksByFilePath(filePath)[0]?.id;
    if (!ownerChunkId) continue;
    const chunk = metadata.getChunksByIds([ownerChunkId])[0];
    if (!chunk) continue;

    const aliasText = normalizeTargetText(`${hit.alias} ${hit.normalizedAlias}`);
    const infrastructureBonus =
      /\b(mcp|stdio|cli|command|transport|registration|hook|daemon|server)\b/.test(aliasText)
        ? 1.2
        : 0.45;
    const boostedScore = topScore + 1.8 + infrastructureBonus - index * 0.001;
    const existing = byId.get(chunk.id);
    byId.set(
      chunk.id,
      existing
        ? { ...existing, score: Math.max(existing.score, boostedScore) }
        : chunkToSearchResult(chunk, boostedScore)
    );
    seenFiles.add(filePath);
    if (seenFiles.size >= 4) break;
  }

  return Array.from(byId.values()).sort((a, b) => b.score - a.score);
}
