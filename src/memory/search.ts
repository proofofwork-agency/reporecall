/**
 * MemorySearch — FTS5 keyword search over Claude Code memories
 * with query expansion and RRF-style scoring.
 *
 * No vector/embedding search — memories are short structured text
 * where FTS5 with auto-tagging and synonym expansion outperforms
 * embedding-based retrieval. Benchmarked at 12-50 memories.
 *
 * Scoring signals:
 * - FTS5 keyword match (primary)
 * - Recency decay with 90-day half-life
 * - Access frequency (importance)
 * - Type boost (feedback > user/project > reference)
 */

import type { MemoryStore } from "../storage/memory-store.js";
import {
  type MemoryClass,
  type MemorySearchResult,
  type MemorySearchOptions,
  type MemoryType,
  resolveMemoryClass,
  resolveMemoryStatus,
  resolveMemoryScope,
} from "./types.js";
import { getLogger } from "../core/logger.js";

const RRF_K = 60;
const KEYWORD_WEIGHT = 0.6;
const RECENCY_WEIGHT = 0.15;
const IMPORTANCE_WEIGHT = 0.25;

/** Feedback memories are most actionable — boost them */
const TYPE_BOOSTS: Record<MemoryType, number> = {
  feedback: 1.3,
  user: 1.0,
  project: 1.0,
  reference: 0.9,
};

/**
 * Synonym map for query expansion. When a query contains a key term,
 * the synonyms are added as OR alternatives to broaden FTS5 recall.
 *
 * Only add terms where the semantic gap causes real misses —
 * don't bloat this with every possible synonym.
 */
const SYNONYM_MAP: Record<string, string[]> = {
  security: ["compliance", "encryption", "audit", "vulnerability", "auth"],
  test: ["testing", "spec", "coverage", "mock", "integration"],
  testing: ["test", "spec", "coverage", "mock", "integration"],
  error: ["exception", "throw", "catch", "fault", "failure"],
  log: ["logging", "logger", "pino", "console"],
  logging: ["log", "logger", "pino", "console"],
  style: ["convention", "format"],
  convention: ["style", "format"],
  track: ["tracking", "ticket", "issue", "jira", "linear"],
  bug: ["issue", "defect", "error", "fault"],
  deploy: ["deployment", "release", "ship", "publish"],
  auth: ["authentication", "authorization", "login", "session", "token", "security"],
  performance: ["latency", "speed", "optimization", "profiling", "benchmark"],
  database: ["db", "sql", "query", "migration", "schema"],
  api: ["endpoint", "route", "handler", "request", "response"],
  pr: ["pull request", "review", "merge", "branch"],
};

export class MemorySearch {
  private store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /**
   * Search memories using FTS5 keyword search with query expansion.
   */
  async search(
    query: string,
    options?: MemorySearchOptions
  ): Promise<MemorySearchResult[]> {
    const log = getLogger();
    const limit = options?.limit ?? 10;

    const keywordResults = this.keywordSearch(buildContextualQuery(query, options), Math.max(limit, 20));

    log.debug(
      {
        query: query.slice(0, 100),
        keywordHits: keywordResults.length,
      },
      "memory retrieval complete"
    );

    if (keywordResults.length === 0) {
      return [];
    }

    // Fetch full memories
    const memoriesById = new Map<string, ReturnType<MemoryStore["get"]>>();
    for (const r of keywordResults) {
      const memory = this.store.get(r.id);
      if (memory) memoriesById.set(r.id, memory);
    }

    // Score with RRF + boosts
    const scores = new Map<string, number>();

    for (let i = 0; i < keywordResults.length; i++) {
      const item = keywordResults[i];
      if (!item) continue;
      const rank = i + 1;
      scores.set(item.id, KEYWORD_WEIGHT * (1 / (RRF_K + rank)));
    }

    // Recency + importance + type boosts
    const now = Date.now();
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;

    for (const [id, score] of scores) {
      const memory = memoriesById.get(id);
      if (!memory) continue;

      let adjusted = score;
      const resolvedClass = resolveMemoryClass(memory);
      const resolvedStatus = resolveMemoryStatus(memory);
      const resolvedConfidence = typeof memory.confidence === "number" ? memory.confidence : 1.0;
      const allowedStatuses = options?.statuses ?? ["active"];
      const activeFiles = options?.activeFiles ?? [];
      const topCodeFiles = options?.topCodeFiles ?? [];
      const topCodeSymbols = options?.topCodeSymbols ?? [];

      if (!allowedStatuses.includes(resolvedStatus)) {
        continue;
      }

      // Recency boost
      const age = now - new Date(memory.fileMtime).getTime();
      const recencyScore = Math.min(1.0, Math.max(0, 1 - age / ninetyDays));
      adjusted += RECENCY_WEIGHT * recencyScore;

      // Importance boost based on access frequency
      const accessBoost = Math.min(1.0, (memory.accessCount ?? 0) / 10);
      adjusted += IMPORTANCE_WEIGHT * accessBoost * (1 / (RRF_K + 1));

      // Contextual boost from active files and top code symbols.
      if (matchesAny(memory.filePath, activeFiles) || matchesAny(memory.filePath, topCodeFiles)) {
        adjusted += 0.08;
      }
      if (matchesAny(memory.name, topCodeSymbols) || matchesAny(memory.description, topCodeSymbols) || matchesAny(memory.tags ?? "", topCodeSymbols)) {
        adjusted += 0.05;
      }

      // Memory-class routing boosts the hot set while keeping code retrieval primary.
      adjusted += CLASS_BOOSTS[resolvedClass] ?? 0;

      if (options?.minConfidence && resolvedConfidence < options.minConfidence) {
        scores.set(id, 0);
        continue;
      }

      // Type boost
      adjusted *= TYPE_BOOSTS[memory.type] ?? 1.0;

      scores.set(id, adjusted);
    }

    // Sort by score and apply filters
    let results = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    // Type filter
    if (options?.types && options.types.length > 0) {
      const typeSet = new Set(options.types);
      results = results.filter(([id]) => {
        const memory = memoriesById.get(id);
        return memory && typeSet.has(memory.type);
      });
    }

    if (options?.classes && options.classes.length > 0) {
      const classSet = new Set(options.classes);
      results = results.filter(([id]) => {
        const memory = memoriesById.get(id);
        return !!memory && classSet.has(resolveMemoryClass(memory));
      });
    }

    if (options?.scopes && options.scopes.length > 0) {
      const scopeSet = new Set(options.scopes);
      results = results.filter(([id]) => {
        const memory = memoriesById.get(id);
        return !!memory && scopeSet.has(resolveMemoryScope(memory));
      });
    }

    if (options?.statuses && options.statuses.length > 0) {
      const statusSet = new Set(options.statuses);
      results = results.filter(([id]) => {
        const memory = memoriesById.get(id);
        return !!memory && statusSet.has(resolveMemoryStatus(memory));
      });
    }

    // Apply relative score threshold after category filters so it operates
    // within the filtered set — prevents cross-class score dominance.
    if (results.length > 1) {
      const topScore = results[0]![1];
      const minThreshold = topScore * 0.7;
      results = results.filter(([, score]) => score >= minThreshold);
    }

    // Min score filter
    if (options?.minScore) {
      results = results.filter(([, score]) => score >= options.minScore!);
    }

    // Build results
    return results
      .map(([id, score]): MemorySearchResult | null => {
        const memory = memoriesById.get(id);
        if (!memory) return null;
        return {
          id,
          score,
          name: memory.name,
          description: memory.description,
          type: memory.type,
          class: memory.class ?? resolveMemoryClass(memory),
          scope: resolveMemoryScope(memory),
          status: resolveMemoryStatus(memory),
          summary: memory.summary ?? memory.description,
          sourceKind: memory.sourceKind ?? "claude_auto",
          fingerprint: memory.fingerprint ?? "",
          pinned: memory.pinned ?? false,
          relatedFiles: memory.relatedFiles ?? [],
          relatedSymbols: memory.relatedSymbols ?? [],
          supersedesId: memory.supersedesId ?? "",
          confidence: memory.confidence ?? 1.0,
          reason: memory.reason ?? "",
          content: memory.content,
          filePath: memory.filePath,
          indexedAt: memory.indexedAt,
          fileMtime: memory.fileMtime,
          accessCount: memory.accessCount ?? 0,
          lastAccessed: memory.lastAccessed ?? "",
          importance: memory.importance ?? 1.0,
          tags: memory.tags ?? "",
        };
      })
      .filter((r): r is MemorySearchResult => r !== null);
  }

  recordAccess(id: string): void {
    this.store.recordAccess(id);
  }

  /**
   * FTS5 keyword search with query expansion via synonym map.
   */
  private keywordSearch(query: string, limit: number): Array<{ id: string; rank: number }> {
    try {
      // First try the original query
      const results = this.store.search(query, limit);

      // If we got enough results, return them
      if (results.length >= 3) return results;

      // If original query returned nothing, don't expand — the query
      // is probably about code, not memories. Synonym expansion on
      // unrelated queries just returns noise.
      if (results.length === 0) return results;

      // Expand query with synonyms and retry
      const expanded = expandQuery(query);
      if (expanded === query) return results;

      const expandedResults = this.store.search(expanded, limit);

      // Merge: original results first, then expanded (deduplicated)
      const seen = new Set(results.map((r) => r.id));
      const merged = [...results];
      for (const r of expandedResults) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          merged.push(r);
        }
      }
      return merged.slice(0, limit);
    } catch (err) {
      getLogger().warn({ err }, "Memory keyword search failed");
      return [];
    }
  }
}

/**
 * Expand a query with synonyms from the synonym map.
 * "what are the security requirements" → adds "compliance OR encryption OR audit"
 */
export function expandQuery(query: string): string {
  const lower = query.toLowerCase();
  const words = lower.split(/\s+/).filter((w) => w.length > 2);
  const additions = new Set<string>();

  for (const word of words) {
    const synonyms = SYNONYM_MAP[word];
    if (synonyms) {
      for (const syn of synonyms) {
        if (!lower.includes(syn)) {
          additions.add(syn);
        }
      }
    }
  }

  if (additions.size === 0) return query;

  // Return original + synonyms joined with spaces (FTS5 OR behavior)
  return query + " " + Array.from(additions).join(" ");
}

const CLASS_BOOSTS: Record<MemoryClass, number> = {
  rule: 0.08,
  working: 0.06,
  fact: 0.03,
  episode: 0.01,
};

function buildContextualQuery(query: string, _options?: MemorySearchOptions): string {
  // Only search with the actual query terms.
  // Active files and top code symbols are used for contextual boosting
  // in the scoring phase (lines 146-151), not for FTS query expansion.
  // Appending file names to the FTS query caused broad OR matches that
  // pulled in unrelated memories (BUG: memory noise — 5-6 irrelevant per query).
  return query;
}

function matchesAny(text: string, candidates: string[]): boolean {
  const lower = text.toLowerCase();
  return candidates.some((candidate) => {
    const normalized = candidate.toLowerCase();
    return normalized.length > 0 && lower.includes(normalized);
  });
}
