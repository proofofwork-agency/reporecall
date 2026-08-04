import type { MemoryConfig } from "../core/config.js";
import type { AssembledContext } from "../search/types.js";
import type { QueryMode } from "../search/intent.js";
import type { MemorySearch } from "../memory/search.js";
import { assembleMemoryContext, type AssembledMemoryContext } from "../memory/context.js";
import type { MemorySearchResult } from "../memory/types.js";
import { getLogger } from "../core/logger.js";
import { assembleWikiContext, type AssembledWikiContext } from "../wiki/context.js";
import { shouldUseCapabilityEvidence } from "../search/capability-evidence.js";
import { readFileSync } from "fs";
const MEMORY_QUERY_RE = /\b(memory|remember|previous|earlier|last time|follow[- ]?up|policy|rule|decision|constraint|benchmark|claim|docs?|documentation|continuity)\b/i;

export async function searchMemories(
  query: string,
  memorySearch: MemorySearch,
  config: MemoryConfig,
  budget: number,
  context?: {
    activeFiles?: string[];
    topCodeFiles?: string[];
    topCodeSymbols?: string[];
    codeFloorRatio?: number;
  }
): Promise<AssembledMemoryContext | null> {
  try {
    const results = await memorySearch.search(query, {
      limit: 8,
      types: ["user", "feedback", "project", "reference"],
      statuses: ["active"],
      minConfidence: 0.55,
      activeFiles: context?.activeFiles,
      topCodeFiles: context?.topCodeFiles,
      topCodeSymbols: context?.topCodeSymbols,
    });
    if (results.length === 0) return null;

    const assembled = assembleMemoryContext(results, budget, {
      codeFloorRatio: context?.codeFloorRatio,
      classBudgets: {
        rule: Math.min(budget, config.memoryHotBudget ?? configAwareBudget(budget, 0.35)),
        working: Math.min(budget, config.memoryWorkingBudget ?? configAwareBudget(budget, 0.2)),
        fact: Math.min(budget, Math.max(0, budget - ((config.memoryHotBudget ?? 0) + (config.memoryWorkingBudget ?? 0)))),
        episode: Math.min(budget, config.memoryEpisodeBudget ?? configAwareBudget(budget, 0.15)),
      },
      maxMemories: 6,
    });
    if (!assembled.text) return null;

    // Record access for included memories (non-fatal)
    for (const mem of assembled.memories) {
      try { memorySearch.recordAccess(mem.id); } catch { /* non-fatal */ }
    }

    return assembled;
  } catch (err) {
    getLogger().warn({ err }, "Memory search failed — continuing without memories");
    return null;
  }
}

function configAwareBudget(totalBudget: number, ratio: number): number {
  return Math.max(0, Math.floor(totalBudget * ratio));
}

export async function searchWikiPages(
  query: string,
  memorySearch: MemorySearch,
  budget: number,
  context: {
    topCodeFiles?: string[];
    topCodeSymbols?: string[];
    maxPages?: number;
    queryMode?: QueryMode;
  }
): Promise<AssembledWikiContext | null> {
  try {
    const requestedLimit = context.maxPages ?? 3;
    const rawResults = await memorySearch.search(query, {
      limit: Math.max(requestedLimit * 3, requestedLimit),
      types: ["wiki"],
      statuses: ["active"],
      minConfidence: 0.5,
      topCodeFiles: context.topCodeFiles,
      topCodeSymbols: context.topCodeSymbols,
    });
    const queryMode = context.queryMode ?? "lookup";
    const includeBusinessPagesForEvidence = shouldUseCapabilityEvidence(queryMode);
    const evidenceResults = includeBusinessPagesForEvidence
      ? rawResults
      : rawResults.filter((result) => !isBusinessWikiResult(result));
    const nonBusinessResults = rawResults.filter((result) => !isBusinessWikiResult(result));
    const promptResults =
      queryMode === "lookup"
        ? nonBusinessResults.filter((result) => isWikiPageAnchoredToCode(result, context.topCodeFiles ?? []))
        : nonBusinessResults;
    if (evidenceResults.length === 0) return null;

    const assembled = assembleWikiContext(promptResults, budget, requestedLimit);
    return assembled
      ? { ...assembled, pages: evidenceResults.slice(0, requestedLimit) }
      : {
          text: "",
          tokenCount: 0,
          pageCount: 0,
          pageNames: [],
          pages: evidenceResults.slice(0, requestedLimit),
        };
  } catch (err) {
    getLogger().warn({ err }, "Wiki search failed — continuing without wiki context");
    return null;
  }
}

export function shouldInjectMemoryIntoPrompt(
  query: string,
  _codeContext: AssembledContext | null,
  memoryContext: AssembledMemoryContext | null
): boolean {
  if (!memoryContext?.text) return false;
  if (!MEMORY_QUERY_RE.test(query)) return false;
  return true;
}

export function shouldUseProductAreaEvidence(query: string, queryMode: QueryMode): boolean {
  if (!shouldUseCapabilityEvidence(queryMode)) return false;
  return queryMode === "trace"
    || queryMode === "architecture"
    || queryMode === "change"
    || /\b(product area|business|capabilit(?:y|ies)|feature|workflow|which files|implement|where .* lives?)\b/i.test(query);
}

function pathsReferToSameFile(left: string, right: string): boolean {
  if (left === right) return true;
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/**
 * A precise lookup ("where is X implemented") is answered by a specific file, so
 * an overview page describing code we are not injecting is pure dilution — a hub
 * page can win the lexical match on a shared token alone. Keep such a page only
 * when it is anchored to one of the code files we actually inject. Pages with no
 * file anchor are left alone: absence of an anchor is not evidence of
 * irrelevance.
 */
function isWikiPageAnchoredToCode(result: MemorySearchResult, topCodeFiles: string[]): boolean {
  const relatedFiles = result.relatedFiles ?? [];
  if (relatedFiles.length === 0 || topCodeFiles.length === 0) return true;
  return relatedFiles.some((relatedFile) =>
    topCodeFiles.some((codeFile) => pathsReferToSameFile(relatedFile, codeFile))
  );
}

function isBusinessWikiResult(result: MemorySearchResult): boolean {
  if (result.name.startsWith("business-")) return true;
  try {
    const raw = readFileSync(result.filePath, "utf-8");
    return /^---[\s\S]*?\npageType:\s*"?business"?/m.test(raw);
  } catch {
    return false;
  }
}

export function shouldSearchMemoryContext(
  query: string,
  _codeContext: AssembledContext | null
): boolean {
  if (!MEMORY_QUERY_RE.test(query)) return false;
  return true;
}
