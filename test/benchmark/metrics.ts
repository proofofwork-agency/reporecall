/**
 * Community-standard IR metrics for search evaluation.
 *
 * Pure math — zero Reporecall dependencies. Follows TREC / CodeSearchNet conventions.
 * Relevance grades: 0 = not relevant, 1 = marginally, 2 = relevant, 3 = highly relevant.
 */

/** Discounted Cumulative Gain: Σ (2^rel_i - 1) / log2(i + 2) */
export function dcg(relevances: number[], k: number): number {
  let sum = 0;
  const limit = Math.min(relevances.length, k);
  for (let i = 0; i < limit; i++) {
    sum += (Math.pow(2, relevances[i]) - 1) / Math.log2(i + 2);
  }
  return sum;
}

/** Normalized DCG: DCG / idealDCG. Returns 0 if no relevant docs exist. Capped at 1.0. */
export function ndcg(retrieved: number[], ideal: number[], k: number): number {
  const idealDCG = dcg(ideal.slice().sort((a, b) => b - a), k);
  if (idealDCG === 0) return 0;
  return Math.min(1, dcg(retrieved, k) / idealDCG);
}

/** Mean Reciprocal Rank: 1 / rank of first relevant result (grade >= 1). */
export function mrr(results: number[]): number {
  for (let i = 0; i < results.length; i++) {
    if (results[i] >= 1) return 1 / (i + 1);
  }
  return 0;
}

/** Average Precision: Σ (P@k × rel_k) / totalRelevant. */
export function averagePrecision(results: number[], totalRelevant: number): number {
  if (totalRelevant === 0) return 0;
  let sum = 0;
  let relevantSeen = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i] >= 1) {
      relevantSeen++;
      sum += relevantSeen / (i + 1);
    }
  }
  return sum / totalRelevant;
}

/** Precision at k: relevant-in-top-k / k. */
export function precisionAtK(results: number[], k: number): number {
  const topK = results.slice(0, k);
  const relevant = topK.filter((r) => r >= 1).length;
  return relevant / k;
}

/** Recall at k: relevant-in-top-k / totalRelevant. */
export function recallAtK(results: number[], k: number, totalRelevant: number): number {
  if (totalRelevant === 0) return 0;
  const topK = results.slice(0, k);
  const relevant = topK.filter((r) => r >= 1).length;
  return relevant / totalRelevant;
}

export interface AllMetrics {
  ndcg10: number;
  mrr: number;
  map: number;
  p5: number;
  p10: number;
  r5: number;
  r10: number;
}

/** Convenience wrapper — computes all standard metrics in one call. */
export function computeAllMetrics(
  retrieved: number[],
  ideal: number[],
): AllMetrics {
  const totalRelevant = ideal.filter((r) => r >= 1).length;
  return {
    ndcg10: ndcg(retrieved, ideal, 10),
    mrr: mrr(retrieved),
    map: averagePrecision(retrieved, totalRelevant),
    p5: precisionAtK(retrieved, 5),
    p10: precisionAtK(retrieved, 10),
    r5: recallAtK(retrieved, 5, totalRelevant),
    r10: recallAtK(retrieved, 10, totalRelevant),
  };
}
