import { STOP_WORDS } from "./utils.js";

export interface RankedItem {
  id: string;
  vectorRank?: number;
  keywordRank?: number;
  indexedAt?: string;
  score: number;
}

export function reciprocalRankFusion(
  vectorResults: Array<{ id: string; score: number }>,
  keywordResults: Array<{ id: string; rank: number }>,
  options: {
    vectorWeight: number;
    keywordWeight: number;
    recencyWeight: number;
    k: number;
    chunkDates?: Map<string, string>;
    activeFiles?: Set<string>;
    chunkFilePaths?: Map<string, string>;
    chunkKinds?: Map<string, string>;
    codeBoostFactor?: number;
    chunkNames?: Map<string, string>;
    testPenaltyFactor?: number;
    anonymousPenaltyFactor?: number;
    queryTerms?: string[];
    chunkLineRanges?: Map<string, { startLine: number; endLine: number }>;
  }
): RankedItem[] {
  const { vectorWeight, keywordWeight, recencyWeight, k, chunkDates, activeFiles, chunkFilePaths, chunkKinds, codeBoostFactor, chunkNames, testPenaltyFactor, anonymousPenaltyFactor, queryTerms, chunkLineRanges } =
    options;
  const scores = new Map<string, RankedItem>();

  // Vector scores — standard RRF: 1/(k + rank) with 1-indexed rank
  for (let i = 0; i < vectorResults.length; i++) {
    const item = vectorResults[i];
    if (!item) continue;
    const rank = i + 1; // 1-indexed
    const existing = scores.get(item.id) ?? {
      id: item.id,
      score: 0,
    };
    existing.vectorRank = rank;
    existing.score += vectorWeight * (1 / (k + rank));
    scores.set(item.id, existing);
  }

  // Keyword scores — standard RRF: 1/(k + rank) with 1-indexed rank
  for (let i = 0; i < keywordResults.length; i++) {
    const item = keywordResults[i];
    if (!item) continue;
    const rank = i + 1; // 1-indexed
    const existing = scores.get(item.id) ?? {
      id: item.id,
      score: 0,
    };
    existing.keywordRank = rank;
    existing.score += keywordWeight * (1 / (k + rank));
    scores.set(item.id, existing);
  }

  // Recency boost (uses file mtime when available, falls back to indexedAt)
  if (chunkDates && recencyWeight > 0) {
    const now = Date.now();
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;

    for (const [id, item] of scores) {
      const dateStr = chunkDates.get(id);
      if (dateStr) {
        const age = now - new Date(dateStr).getTime();
        const recencyScore = Math.max(0, 1 - age / ninetyDays);
        item.score += recencyWeight * recencyScore;
        item.indexedAt = dateStr;
      }
    }
  }

  // Active files boost (1.5x multiplier)
  if (activeFiles && activeFiles.size > 0 && chunkFilePaths) {
    for (const [id, item] of scores) {
      const filePath = chunkFilePaths.get(id);
      if (filePath && activeFiles.has(filePath)) {
        item.score *= 1.5;
      }
    }
  }

  // Code-kind boost: prioritize actual code over documentation chunks
  if (chunkKinds && codeBoostFactor && codeBoostFactor !== 1.0) {
    const DOC_KINDS = new Set(["file"]);
    for (const [id, item] of scores) {
      const kind = chunkKinds.get(id);
      if (kind && !DOC_KINDS.has(kind)) {
        item.score *= codeBoostFactor;
      }
    }
  }

  // Test file penalty: demote chunks from test/spec/benchmark paths
  if (chunkFilePaths && testPenaltyFactor != null && testPenaltyFactor !== 1.0) {
    const TEST_PATH_RE = /(?:^|\/)(test|spec|__tests__|__fixtures__|fixtures|benchmark|examples)\/|\.(?:test|spec)\.|(?:^|\/)(?:benchmark|demo)\.[^/]+$/;
    for (const [id, item] of scores) {
      const filePath = chunkFilePaths.get(id);
      if (filePath && TEST_PATH_RE.test(filePath)) {
        item.score *= testPenaltyFactor;
      }
    }
  }

  // Anonymous chunk penalty: demote unnamed chunks
  if (chunkNames && anonymousPenaltyFactor != null && anonymousPenaltyFactor !== 1.0) {
    for (const [id, item] of scores) {
      const name = chunkNames.get(id);
      if (name === "<anonymous>") {
        item.score *= anonymousPenaltyFactor;
      }
    }
  }

  // Query-term filename/symbol boost: if query terms appear in file basename or chunk name, boost
  if (queryTerms && queryTerms.length > 0 && chunkFilePaths) {
    const terms = queryTerms
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

    if (terms.length > 0) {
      for (const [id, item] of scores) {
        const filePath = chunkFilePaths.get(id) ?? "";
        const basename = filePath.split("/").pop()?.replace(/\.[^.]+$/, "").toLowerCase() ?? "";
        const chunkName = (chunkNames?.get(id) ?? "").toLowerCase();

        let matchCount = 0;
        for (const term of terms) {
          if (basename.includes(term) || chunkName.includes(term)) {
            matchCount++;
          }
        }

        if (matchCount > 0) {
          // 1.3x per matching term, compounding
          item.score *= Math.pow(1.3, matchCount);
        }
      }
    }
  }

  // Length penalty: demote disproportionately large chunks early in the pipeline
  if (chunkLineRanges) {
    for (const [id, item] of scores) {
      const range = chunkLineRanges.get(id);
      if (range) {
        const lineCount = range.endLine - range.startLine + 1;
        if (lineCount > 80) {
          item.score *= 80 / (lineCount * 0.8 + 16);
        }
      }
    }
  }

  return Array.from(scores.values()).sort((a, b) => b.score - a.score);
}
