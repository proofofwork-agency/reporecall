import {
  type ExpandedQueryTerm,
  expandQueryTerms,
  getQueryTermVariants,
  isTestFile,
  STOP_WORDS,
} from "./utils.js";

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
    expandedQueryTerms?: ExpandedQueryTerm[];
    broadQuery?: boolean;
    chunkLineRanges?: Map<string, { startLine: number; endLine: number }>;
  }
): RankedItem[] {
  const { vectorWeight, keywordWeight, recencyWeight, k, chunkDates, activeFiles, chunkFilePaths, chunkKinds, codeBoostFactor, chunkNames, testPenaltyFactor, anonymousPenaltyFactor, queryTerms, expandedQueryTerms, broadQuery, chunkLineRanges } =
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
    for (const [id, item] of scores) {
      const filePath = chunkFilePaths.get(id);
      if (filePath && isTestFile(filePath)) {
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

  // Query-term filename/symbol boost: if query terms appear in file basename or chunk name, boost.
  // CamelCase identifier terms (e.g. "saveFlow" → "saveflow") get a stronger 1.7x boost because
  // they are explicit code references, not incidental word matches like "work" in "workflow".
  if (queryTerms && queryTerms.length > 0 && chunkFilePaths) {
    const terms = queryTerms
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
    const expandedTerms = (expandedQueryTerms && expandedQueryTerms.length > 0
      ? expandedQueryTerms
      : expandQueryTerms(terms))
      .filter((term) => term.term.length >= 2 && !STOP_WORDS.has(term.term));
    const totalExpandedWeight = expandedTerms.reduce((sum, term) => sum + term.weight, 0) || 1;

    // Detect which lowercased terms came from camelCase identifiers in the original query.
    const camelTerms = new Set(
      queryTerms
        .filter((t) => /[a-z][A-Z]/.test(t))
        .map((t) => t.toLowerCase())
    );

    if (terms.length > 0) {
      for (const [id, item] of scores) {
        const filePath = (chunkFilePaths.get(id) ?? "").toLowerCase();
        const chunkName = (chunkNames?.get(id) ?? "").toLowerCase();

        let matchCount = 0;
        let matchedWeight = 0;
        let matchBoost = 1.0;
        let hasLongAnchorMatch = false;
        const matchedFamilies = new Set<string>();
        let onlyGenericMatches = true;

        for (const term of expandedTerms) {
          const variants = getQueryTermVariants(term.term);
          if (variants.some((variant) => filePath.includes(variant) || chunkName.includes(variant))) {
            matchCount++;
            matchedWeight += term.weight;
            matchBoost *= camelTerms.has(term.term) ? 1.7 : term.term.length >= 8 ? 1.45 : term.weight >= 0.7 ? 1.3 : 1.18;
            if (term.term.length >= 8 && term.weight >= 0.7) hasLongAnchorMatch = true;
            if (term.family) matchedFamilies.add(term.family);
            if (!term.generic) onlyGenericMatches = false;
          }
        }

        if (matchCount > 0) {
          const coverageRatio = matchedWeight / totalExpandedWeight;
          if (terms.length >= 3 && coverageRatio < 0.5) {
            if (hasLongAnchorMatch) {
              item.score *= 1 + (matchBoost - 1) * coverageRatio;
            } else {
              item.score *= Math.max(0.65, 0.55 + coverageRatio * 0.5);
            }
          } else {
            item.score *= matchBoost;
          }

          if (broadQuery) {
            if (matchedFamilies.size > 0) {
              item.score *= 1 + Math.min(0.32, matchedFamilies.size * 0.11);
            }
            if (onlyGenericMatches) {
              item.score *= 0.6;
            }
          }
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
