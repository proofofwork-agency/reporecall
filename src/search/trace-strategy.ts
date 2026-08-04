/**
 * Trace-specific search strategy helpers.
 *
 * Extracted from HybridSearch so they can be reused (and tested) independently.
 * Every function is stateless -- callers supply the data they need.
 */

import type { SearchResult } from "./types.js";
import type { ExpandedQueryTerm } from "./utils.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import type { SeedCandidate, SeedResult } from "./seed.js";
import {
  expandQueryTerms,
  GENERIC_QUERY_ACTION_TERMS,
  isTestFile,
  STOP_WORDS,
  tokenizeQueryTerms,
} from "./utils.js";
import { normalizeTargetText } from "./targets.js";
import { TRACE_NOISE_TERMS, ADJACENT_WORKFLOW_FAMILIES } from "./shared/workflow-families.js";
import { chunkToSearchResult, isImplementationPath } from "./shared/mappers.js";

export { TRACE_NOISE_TERMS } from "./shared/workflow-families.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODE_EXPLICIT_LOGGING_RE =
  /\b(log|logger|logging|audit|instrument|instrumentation|telemetry|metrics?)\b/i;
const MODE_EXPLICIT_WEBHOOK_RE =
  /\b(webhook|signature|payload|delivery|event)\b/i;

// ---------------------------------------------------------------------------
// Helpers shared with the extraction pipeline
// ---------------------------------------------------------------------------

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

function traceTargetText(seed: SeedCandidate): string {
  const fileName = seed.filePath.split("/").filter(Boolean).at(-2) ?? seed.filePath;
  return normalizeTargetText(`${seed.name} ${seed.resolvedAlias ?? ""} ${fileName}`);
}

function traceTargetConcept(seed: SeedCandidate): string {
  const alias = normalizeTargetText(seed.resolvedAlias ?? "");
  if (alias.split(" ").filter(Boolean).length >= 2) return alias;
  const fileName = normalizeTargetText(seed.filePath.split("/").filter(Boolean).at(-2) ?? "");
  if (fileName.split(" ").filter(Boolean).length >= 2) return fileName;
  return normalizeTargetText(seed.name);
}

function isDirectTraceSeed(query: string, seed: SeedCandidate): boolean {
  if (isTestFile(seed.filePath)) return false;
  const normalizedQuery = normalizeTargetText(query);
  const normalizedName = normalizeTargetText(seed.name);
  const normalizedAlias = normalizeTargetText(seed.resolvedAlias ?? "");
  const endpointName = normalizeTargetText(seed.filePath.split("/").filter(Boolean).at(-2) ?? "");
  const nameTokens = normalizedName.split(" ").filter(Boolean);
  const nameMentioned =
    normalizedName.length >= 3
    && (
      seed.reason === "explicit_target"
      || nameTokens.length >= 2
    )
    && (
      normalizedQuery === normalizedName
      || normalizedQuery.startsWith(`${normalizedName} `)
      || normalizedQuery.endsWith(` ${normalizedName}`)
      || normalizedQuery.includes(` ${normalizedName} `)
    );
  const aliasTokens = normalizedAlias.split(" ").filter(Boolean);
  const aliasMentioned =
    aliasTokens.length >= 2
    && normalizedQuery.includes(normalizedAlias);
  const endpointMentioned =
    endpointName.split(" ").filter(Boolean).length >= 2
    && normalizedQuery.includes(endpointName);
  return nameMentioned
    || aliasMentioned
    || endpointMentioned
    || (seed.reason === "explicit_target" && nameMentioned);
}

function isBackendTracePath(filePath: string): boolean {
  return /(?:^|\/)(?:supabase\/functions|functions|api|server|backend|controllers?|handlers?)\//i.test(filePath);
}

function isRootEntryPath(filePath: string): boolean {
  return /(?:^|\/)(?:App|_app|Root|Main|Layout)\.[jt]sx?$/i.test(filePath);
}

function uniqueTraceFiles(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const result of results) {
    if (seen.has(result.filePath) || isTestFile(result.filePath)) continue;
    seen.add(result.filePath);
    unique.push(result);
  }
  return unique;
}

function hydrateDirectTraceSeeds(
  query: string,
  seedResult: SeedResult,
  metadata: MetadataStore
): SearchResult[] {
  const directSeeds = seedResult.seeds
    .filter((seed) => isDirectTraceSeed(query, seed))
    .sort((a, b) => {
      const aExplicit = a.reason === "explicit_target" ? 1 : 0;
      const bExplicit = b.reason === "explicit_target" ? 1 : 0;
      const aEndpoint = a.targetKind === "endpoint" ? 1 : 0;
      const bEndpoint = b.targetKind === "endpoint" ? 1 : 0;
      const aMention = normalizeTargetText(query).includes(traceTargetText(a)) ? 1 : 0;
      const bMention = normalizeTargetText(query).includes(traceTargetText(b)) ? 1 : 0;
      return bExplicit - aExplicit || bMention - aMention || bEndpoint - aEndpoint || b.confidence - a.confidence;
    });
  const chunks = new Map(
    metadata
      .getChunksByIds(directSeeds.map((seed) => seed.chunkId))
      .map((chunk) => [chunk.id, chunk])
  );
  return uniqueTraceFiles(directSeeds.flatMap((seed) => {
    const chunk = chunks.get(seed.chunkId);
    return chunk ? [chunkToSearchResult(chunk, 1)] : [];
  }));
}

function findTraceCandidate(
  candidates: SearchResult[],
  predicate: (result: SearchResult) => boolean,
  excludedFiles: Set<string>
): SearchResult | undefined {
  return candidates.find((candidate) =>
    !excludedFiles.has(candidate.filePath)
    && predicate(candidate)
  );
}

/**
 * Convert broad trace candidates into a compact answer-first bundle.
 *
 * A trace asks for the boundary around a concrete target, not an inventory of
 * every file in the same semantic family. The selector therefore keeps the
 * directly named target, then fills only the roles implied by the prompt
 * (caller state/root, service, controller, or downstream endpoint).
 */
export function selectFocusedTraceBundle(
  query: string,
  prioritized: SearchResult[],
  workflowBundle: SearchResult[],
  seedResult: SeedResult,
  metadata: MetadataStore,
  maxContextChunks: number
): SearchResult[] {
  const direct = hydrateDirectTraceSeeds(query, seedResult, metadata);
  if (direct.length === 0) return [];
  const initialPrimary = direct[0] ?? workflowBundle[0] ?? prioritized[0];
  const structuralCandidates: SearchResult[] = [];
  if (initialPrimary) {
    for (const record of metadata.findImportByName(initialPrimary.name)) {
      if (!isRootEntryPath(record.filePath) || isTestFile(record.filePath)) continue;
      const chunk = metadata.findChunksByFilePath(record.filePath)
        .find((candidate) => candidate.kind !== "file");
      if (chunk) structuralCandidates.push(chunkToSearchResult(chunk, 0.8));
    }
    for (const record of metadata.getImportsForFile(initialPrimary.filePath)) {
      const chunks = record.resolvedPath
        ? metadata.findChunksByFilePath(record.resolvedPath)
        : metadata.findChunksByNames([record.importedName]);
      const chunk = chunks.find((candidate) => candidate.kind !== "file" && !isTestFile(candidate.filePath));
      if (chunk) structuralCandidates.push(chunkToSearchResult(chunk, 0.75));
    }
  }
  const candidates = uniqueTraceFiles([
    ...workflowBundle,
    ...structuralCandidates,
    ...prioritized,
  ]);
  const primary = direct[0] ?? candidates[0];
  if (!primary) return [];

  const normalizedQuery = normalizeTargetText(query);
  const authFamily = /\b(auth|authentication|login|signin|session|callback|redirect|protected|guard)\b/.test(normalizedQuery);
  const billingFamily = /\b(billing|checkout|portal|subscription|invoice|payment|stripe|plan)\b/.test(normalizedQuery);
  const generationFamily = /\b(storyboard|image|generation|generate|regenerate|shot|render)\b/.test(normalizedQuery);
  const callerToEndpoint =
    /\b(call|calls|invoke|invokes|invoking)\b/.test(normalizedQuery)
    && /\b(edge|endpoint|function|api)\b/.test(normalizedQuery);
  const focusedRequestAuth =
    /\bauthenticat\w*\b/.test(normalizedQuery)
    && /\b(request|requests|header|token)\b/.test(normalizedQuery);
  const selected: SearchResult[] = [];
  const selectedFiles = new Set<string>();
  const limit = Math.max(1, Math.min(maxContextChunks, 4));
  const add = (result: SearchResult | undefined) => {
    if (!result || selected.length >= limit || selectedFiles.has(result.filePath)) return;
    selected.push(result);
    selectedFiles.add(result.filePath);
  };

  if (callerToEndpoint) {
    const store = findTraceCandidate(
      candidates,
      (candidate) =>
        /(?:^|\/)(?:store|stores|state)\//i.test(candidate.filePath)
        && (!generationFamily || /\b(storyboard|image|generation|generate|shot|render)\b/.test(
          normalizeTargetText(`${candidate.filePath} ${candidate.name}`)
        )),
      selectedFiles
    );
    const hook = findTraceCandidate(
      candidates,
      (candidate) =>
        /(?:^|\/)hooks?\//i.test(candidate.filePath)
        && (!generationFamily || /\b(storyboard|image|generation|generate|shot|render)\b/.test(
          normalizeTargetText(`${candidate.filePath} ${candidate.name}`)
        )),
      selectedFiles
    );
    add(store);
    add(hook);
    add(primary);
  } else if (isBackendTracePath(primary.filePath)) {
    add(primary);

    const directConcept = traceTargetConcept(seedResult.seeds.find((seed) => seed.filePath === primary.filePath) ?? {
      chunkId: primary.id,
      name: primary.name,
      filePath: primary.filePath,
      kind: primary.kind,
      confidence: 1,
      reason: "explicit_target",
    });
    for (const candidate of direct.slice(1)) {
      const candidateSeed = seedResult.seeds.find((seed) => seed.filePath === candidate.filePath);
      if (candidateSeed && traceTargetConcept(candidateSeed) === directConcept) add(candidate);
    }

    if (!focusedRequestAuth && generationFamily) {
      const primaryText = normalizeTargetText(primary.filePath);
      const wantsGenerateEndpoint = /\bstoryboard controller\b/.test(primaryText);
      const relatedBackend = findTraceCandidate(
        candidates,
        (candidate) => {
          if (!isBackendTracePath(candidate.filePath)) return false;
          const text = normalizeTargetText(`${candidate.filePath} ${candidate.name}`);
          if (!/\b(storyboard|image|generation|generate|shot|render|controller|orchestrator)\b/.test(text)) {
            return false;
          }
          return wantsGenerateEndpoint
            ? /\bgenerate image\b/.test(text)
            : /\bcontroller|orchestrator\b/.test(text);
        },
        selectedFiles
      );
      add(relatedBackend);
    }

    if (!focusedRequestAuth && billingFamily && selected.length < limit && selected.length < 2) {
      const service = findTraceCandidate(
        candidates,
        (candidate) =>
          /(?:^|\/)services?\//i.test(candidate.filePath)
          && /\b(stripe|billing|payment|subscription)\b/.test(
            normalizeTargetText(`${candidate.filePath} ${candidate.name}`)
          ),
        selectedFiles
      );
      add(service);
      if (/\b(plan|change|upgrade)\b/.test(normalizedQuery)) {
        const planUi = findTraceCandidate(
          candidates,
          (candidate) =>
            /(?:^|\/)(?:components|pages|views|screens)\//i.test(candidate.filePath)
            && /\b(plan|upgrade|subscription|option)\b/.test(
              normalizeTargetText(`${candidate.filePath} ${candidate.name}`)
            ),
          selectedFiles
        );
        add(planUi);
      }
    }
  } else {
    add(primary);
    if (authFamily) {
      const state = findTraceCandidate(
        candidates,
        (candidate) =>
          /(?:^|\/)(?:hooks|store|stores|state|context|providers?)\//i.test(candidate.filePath)
          && /\b(auth|session|login|signin)\b/.test(normalizeTargetText(`${candidate.filePath} ${candidate.name}`)),
        selectedFiles
      );
      const root = findTraceCandidate(candidates, (candidate) => isRootEntryPath(candidate.filePath), selectedFiles);
      add(state);
      add(root);
    }
  }

  if (selected.length === 0) add(primary);
  return selected.map((result, index) => ({
    ...result,
    score: Math.max(0.6, 1 - index * 0.08),
    hookScore: Math.max(0.6, 1 - index * 0.08),
    selectionSource: "focused_trace",
    selectionReason: index === 0 ? "direct_trace_target" : "trace_role",
  }));
}
