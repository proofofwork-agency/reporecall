import type { AssembledContext } from "../search/types.js";
import type { QueryMode } from "../search/intent.js";
import type { MetadataStore } from "../storage/metadata-store.js";
import { detectExecutionSurfaces, STOP_WORDS, textMatchesQueryTerm, type ExecutionSurface } from "../search/utils.js";
import { normalizeTargetText } from "../search/targets.js";
import type { CapabilityEvidenceFile } from "../search/capability-evidence.js";
import type { PromptContextResult } from "./prompt-context-types.js";
export function inferVanishedSelectedFileEvidence(
  selectedFiles: NonNullable<PromptContextResult["selectedFiles"]>,
  context: AssembledContext | null,
  metadata?: MetadataStore
): string[] {
  if (!metadata || typeof metadata.findChunksByFilePath !== "function") return [];
  const emittedFiles = new Set(context?.chunks.map((chunk) => chunk.filePath) ?? []);
  const issues: string[] = [];
  for (const file of selectedFiles) {
    if (emittedFiles.has(file.filePath)) continue;
    try {
      const chunks = metadata.findChunksByFilePath(file.filePath);
      if (chunks.length === 0) {
        issues.push(`Selected evidence for ${file.filePath} is no longer present in the index; run refresh_context before relying on it.`);
      }
    } catch {
      issues.push(`Selected evidence for ${file.filePath} could not be verified in the index; run refresh_context if it looks stale.`);
    }
    if (issues.length >= 3) break;
  }
  return issues;
}

export function finalizePromptContextResult(
  query: string,
  result: PromptContextResult
): PromptContextResult {
  const context = result.context;
  const selectedFileRecords = prunePromptSelectedFiles(
    query,
    result.resolvedQueryMode,
    result.selectedFiles ?? Array.from(new Set(context?.chunks.map((chunk) => chunk.filePath) ?? [])).map((filePath) => ({
      filePath,
      selectionSource: "context_chunk",
    })),
    context
  );
  const selectedFiles = selectedFileRecords.map((file) => file.filePath);
  const executionSurface = inferDominantExecutionSurface(context);
  const evidenceConfidence = inferEvidenceConfidence(
    result.resolvedQueryMode,
    result.deliveryMode,
    context,
    result.familyConfidence
  );
  const contextStrength = inferContextStrength(
    result.resolvedQueryMode,
    result.deliveryMode,
    context,
    selectedFiles,
    evidenceConfidence
  );
  const recommendedNextReads = uniqueStrings([
    ...(result.recommendedNextReads ?? []),
    ...selectedFiles.slice(0, Math.min(contextStrength === "weak" ? 2 : 3, selectedFiles.length)),
  ]);
  const missingEvidence = uniqueStrings([
    ...(result.missingEvidence ?? []),
    ...inferMissingEvidence(result.resolvedQueryMode, contextStrength, result.deliveryMode, selectedFiles, result.deferredReason),
  ]);
  return {
    ...result,
    selectedFiles: selectedFileRecords,
    contextStrength,
    executionSurface,
    evidenceConfidence,
    missingEvidence,
    recommendedNextReads,
    advisoryText: buildReporecallAdvisory(result.resolvedQueryMode, contextStrength, selectedFiles, missingEvidence, context?.compression),
  };
}

export function prunePromptSelectedFiles(
  query: string,
  queryMode: QueryMode,
  selectedFiles: NonNullable<PromptContextResult["selectedFiles"]>,
  context: AssembledContext | null
): NonNullable<PromptContextResult["selectedFiles"]> {
  if (queryMode === "lookup" || selectedFiles.length <= 1) return selectedFiles;
  const limit =
    queryMode === "trace" ? 5
      : queryMode === "bug" ? 8
        : queryMode === "architecture" || queryMode === "change" ? 6
          : selectedFiles.length;
  if (selectedFiles.length <= limit) return selectedFiles;

  const contextOrder = new Map<string, number>();
  for (const [index, chunk] of (context?.chunks ?? []).entries()) {
    if (!contextOrder.has(chunk.filePath)) contextOrder.set(chunk.filePath, index);
  }
  return [...selectedFiles]
    .sort((a, b) => {
      const diff = scorePromptSelectedFile(query, b, contextOrder) - scorePromptSelectedFile(query, a, contextOrder);
      if (Math.abs(diff) > 0.001) return diff;
      return (contextOrder.get(a.filePath) ?? 999) - (contextOrder.get(b.filePath) ?? 999);
    })
    .slice(0, limit);
}

function scorePromptSelectedFile(
  query: string,
  file: NonNullable<PromptContextResult["selectedFiles"]>[number],
  contextOrder: Map<string, number>
): number {
  const terms = tokenizeQueryTerms(query)
    .map((term) => normalizeTargetText(term))
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
  const text = normalizeTargetText(`${file.filePath} ${file.selectionSource} ${file.selectionReason ?? ""}`);
  let score = 0;
  for (const term of terms) {
    if (textMatchesQueryTerm(text, term)) score += 24;
  }
  const order = contextOrder.get(file.filePath);
  if (order !== undefined) score += Math.max(0, 18 - order * 2);
  const source = file.selectionSource;
  if (source === "direct_match" || source === "flow_chunk" || source === "workflow_bundle" || source === "inventory_bundle") score += 28;
  if (source === "mandatory_flow_step") score += 46;
  if (source === "wiki_capability") score += 48;
  if (source === "trace_seed") score += 18;
  if (source === "trace_hint") score += 6;
  if (isNoiseLikeFlowSeed(file.filePath)) score -= 100;
  return score;
}

function inferDominantExecutionSurface(context: AssembledContext | null): ExecutionSurface | "mixed" {
  if (!context || context.chunks.length === 0) return "mixed";
  const counts = new Map<ExecutionSurface, number>();
  for (const chunk of context.chunks.slice(0, 5)) {
    for (const surface of detectExecutionSurfaces(chunk.filePath, chunk.name, chunk.content)) {
      counts.set(surface, (counts.get(surface) ?? 0) + 1);
    }
  }
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return "mixed";
  if ((ranked[0]?.[1] ?? 0) === (ranked[1]?.[1] ?? -1)) return "mixed";
  return ranked[0]?.[0] ?? "mixed";
}

function inferContextStrength(
  queryMode: QueryMode,
  deliveryMode: "code_context" | "summary_only" | undefined,
  context: AssembledContext | null,
  selectedFiles: string[],
  evidenceConfidence: number
): "sufficient" | "partial" | "weak" {
  if (!context || context.chunks.length === 0) return "weak";
  if (deliveryMode === "summary_only") return "weak";
  if (queryMode === "lookup") return selectedFiles.length >= 1 ? "sufficient" : "partial";
  if (queryMode === "trace" || queryMode === "bug") {
    return evidenceConfidence >= 0.75 ? "sufficient" : "partial";
  }
  if (
    (queryMode === "architecture" || queryMode === "change")
    && evidenceConfidence >= 0.75
    && new Set(context.chunks.map((chunk) => chunk.filePath)).size >= 4
  ) {
    return "sufficient";
  }
  return selectedFiles.length > 0 ? "partial" : "weak";
}

function inferEvidenceConfidence(
  queryMode: QueryMode,
  deliveryMode: "code_context" | "summary_only" | undefined,
  context: AssembledContext | null,
  familyConfidence?: number
): number {
  if (!context || context.chunks.length === 0) return 0;
  if (deliveryMode === "summary_only") return 0.35;

  const fileCount = new Set(context.chunks.map((chunk) => chunk.filePath)).size;
  const surfaces = new Set(
    context.chunks.flatMap((chunk) =>
      detectExecutionSurfaces(chunk.filePath, chunk.name, chunk.content)
    )
  ).size;
  let structuralConfidence: number;

  switch (queryMode) {
    case "lookup":
      structuralConfidence = fileCount >= 1 ? 0.9 : 0;
      break;
    case "trace":
    case "bug":
      structuralConfidence =
        fileCount <= 1 ? 0.62
          : fileCount === 2 ? 0.72
            : Math.min(0.92, 0.78 + Math.min(3, fileCount - 3) * 0.04 + (surfaces >= 2 ? 0.02 : 0));
      break;
    case "architecture":
    case "change":
      structuralConfidence =
        fileCount <= 2 ? 0.62
          : fileCount === 3 || surfaces < 2 ? 0.72
            : Math.min(0.92, 0.78 + Math.min(3, fileCount - 4) * 0.035 + Math.min(2, surfaces - 2) * 0.02);
      break;
    case "skip":
      structuralConfidence = 0;
      break;
  }

  const calibrated = familyConfidence === undefined
    ? structuralConfidence
    : Math.min(familyConfidence, structuralConfidence);
  return Math.round(calibrated * 1000) / 1000;
}

function inferMissingEvidence(
  queryMode: QueryMode,
  contextStrength: "sufficient" | "partial" | "weak",
  deliveryMode: "code_context" | "summary_only" | undefined,
  selectedFiles: string[],
  deferredReason?: string
): string[] {
  const issues: string[] = [];
  if (deliveryMode === "summary_only") {
    issues.push("Reporecall deferred broad code injection because subsystem cohesion was weak.");
  }
  if ((queryMode === "bug" || queryMode === "trace") && contextStrength !== "sufficient") {
    issues.push("Runtime caller or orchestrator coverage is still incomplete.");
  }
  if ((queryMode === "architecture" || queryMode === "change") && selectedFiles.length < 2) {
    issues.push("Representative subsystem coverage is still thin.");
  }
  if (deferredReason) {
    issues.push(`Deferred reason: ${deferredReason}.`);
  }
  return issues;
}

export function buildReporecallAdvisory(
  queryMode: QueryMode,
  contextStrength: "sufficient" | "partial" | "weak",
  selectedFiles: string[],
  missingEvidence: string[],
  compression?: AssembledContext["compression"]
): string | undefined {
  if (selectedFiles.length === 0) return undefined;
  const lines = [
    "## Reporecall Guidance",
    "",
    `Reporecall classified this as a \`${queryMode}\` query and already selected likely files: ${selectedFiles.slice(0, 4).join(", ")}${selectedFiles.length > 4 ? ` (+${selectedFiles.length - 4} more)` : ""}.`,
  ];
  if (contextStrength === "sufficient") {
    lines.push("Prefer answering from these files first. Use extra read/search tools only to fill a clearly missing gap.");
  } else if (contextStrength === "partial") {
    lines.push("Start from these files first. If you need more evidence, prefer narrow targeted reads instead of broad codebase exploration.");
  } else {
    lines.push("The injected context is weak. If you expand, prefer the listed files first and keep exploration narrow.");
  }
  if (compression?.compressedChunks) {
    lines.push(
      `Compressed ${compression.compressedChunks} secondary chunks, saving ${compression.tokensSaved} tokens. Use Reporecall MCP search_code with action=read_chunk and chunkId for full source.`
    );
  }
  if (missingEvidence.length > 0) {
    lines.push(`Missing evidence: ${missingEvidence.join(" ")}`);
  }
  return lines.join("\n");
}

export function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value && value.trim().length > 0))];
}

export function tokenizeQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
}

export function countQueryMatches(queryTerms: string[], ...texts: Array<string | undefined>): number {
  if (queryTerms.length === 0) return 0;
  const haystack = texts
    .filter((text): text is string => !!text)
    .join(" ")
    .toLowerCase()
    .replace(/[_-]/g, " ");
  let count = 0;
  for (const term of queryTerms) {
    const prefix = term.length >= 6 ? term.slice(0, 4) : term;
    if (haystack.includes(term) || (prefix.length >= 4 && haystack.includes(prefix))) count++;
  }
  return count;
}

export function isNoiseLikeFlowSeed(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return /(?:^|\/)(migrations?|fixtures?|examples?|docs?|reports?)\//.test(lower)
    || /(?:^|\/)(__tests__|tests?|specs?|e2e|mocks?)\//.test(lower)
    || /\.(test|spec)\.[jt]sx?$/i.test(lower)
    || /\.(md|mdx|txt|sql)$/i.test(lower);
}

export function directlyMentionsSeed(normalizedQuery: string, candidate?: string): boolean {
  if (!candidate) return false;
  const normalizedCandidate = normalizeTargetText(candidate);
  if (!normalizedCandidate || normalizedCandidate.length < 3) return false;
  return normalizedQuery.includes(normalizedCandidate);
}

export function mergeCapabilitySelectedFiles(
  base: PromptContextResult["selectedFiles"],
  evidenceFiles?: CapabilityEvidenceFile[]
): PromptContextResult["selectedFiles"] {
  const merged = new Map<string, NonNullable<PromptContextResult["selectedFiles"]>[number]>();
  for (const file of base ?? []) {
    merged.set(file.filePath, file);
  }
  for (const file of evidenceFiles ?? []) {
    const existing = merged.get(file.filePath);
    if (!existing) {
      merged.set(file.filePath, {
        filePath: file.filePath,
        selectionSource: file.selectionSource,
        selectionReason: file.selectionReason,
        wikiPagesUsed: file.wikiPagesUsed,
      });
      continue;
    }
    if (existing.selectionSource === "workflow_bundle" || existing.selectionSource === "flow_chunk") {
      merged.set(file.filePath, {
        ...existing,
        selectionReason: existing.selectionReason ?? file.selectionReason,
        wikiPagesUsed: uniqueStrings([...(existing.wikiPagesUsed ?? []), ...file.wikiPagesUsed]),
      });
    }
  }
  return Array.from(merged.values());
}

export function mergePromptContextChunks(
  primary: AssembledContext["chunks"],
  secondary: AssembledContext["chunks"]
): AssembledContext["chunks"] {
  const byFilePath = new Map<string, AssembledContext["chunks"][number]>();
  for (const chunk of [...primary, ...secondary]) {
    const existing = byFilePath.get(chunk.filePath);
    if (!existing || (chunk.hookScore ?? chunk.score) > (existing.hookScore ?? existing.score)) {
      byFilePath.set(chunk.filePath, chunk);
    }
  }
  return Array.from(byFilePath.values()).sort((a, b) =>
    (b.hookScore ?? b.score) - (a.hookScore ?? a.score)
    || b.score - a.score
    || a.filePath.localeCompare(b.filePath)
  );
}
