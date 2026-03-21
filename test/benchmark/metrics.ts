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

export interface ExpectedSetMetrics {
  precisionAt3: number;
  recallAt5: number;
  mrr: number;
  ndcg10: number;
  hit: boolean;
}

export interface RetrievalCertaintyInputs {
  expectedHitCoverage: number;
  codeFloorPreserved: boolean;
  routeAppropriate: boolean;
  promptCompleteness: number;
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

export interface BenchmarkCaseMetrics {
  retrieved: number[];
  ideal: number[];
  latencyMs?: number;
  routeMatched?: boolean;
  freshnessMatched?: boolean;
}

export interface BenchmarkSuiteMetrics extends AllMetrics {
  recall: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  routeAccuracy: number;
  freshnessAccuracy: number;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Nearest-rank percentile.
 * Accepts p in [0, 1] where 0.95 = p95.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (p <= 0) return Math.min(...values);
  if (p >= 1) return Math.max(...values);

  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))] ?? 0;
}

export function computeBenchmarkSuiteMetrics(
  cases: BenchmarkCaseMetrics[],
): BenchmarkSuiteMetrics {
  if (cases.length === 0) {
    return {
      ndcg10: 0,
      mrr: 0,
      map: 0,
      p5: 0,
      p10: 0,
      r5: 0,
      r10: 0,
      recall: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      routeAccuracy: 0,
      freshnessAccuracy: 0,
    };
  }

  const perCase = cases.map((testCase) => {
    const base = computeAllMetrics(testCase.retrieved, testCase.ideal);
    const totalRelevant = testCase.ideal.filter((rel) => rel >= 1).length;
    return {
      ...base,
      recall: recallAtK(testCase.retrieved, testCase.retrieved.length, totalRelevant),
    };
  });

  const latencies = cases
    .map((testCase) => testCase.latencyMs)
    .filter((latency): latency is number => typeof latency === "number");
  const routeChecks = cases
    .map((testCase) => testCase.routeMatched)
    .filter((matched): matched is boolean => typeof matched === "boolean");
  const freshnessChecks = cases
    .map((testCase) => testCase.freshnessMatched)
    .filter((matched): matched is boolean => typeof matched === "boolean");

  return {
    ndcg10: mean(perCase.map((metric) => metric.ndcg10)),
    mrr: mean(perCase.map((metric) => metric.mrr)),
    map: mean(perCase.map((metric) => metric.map)),
    p5: mean(perCase.map((metric) => metric.p5)),
    p10: mean(perCase.map((metric) => metric.p10)),
    r5: mean(perCase.map((metric) => metric.r5)),
    r10: mean(perCase.map((metric) => metric.r10)),
    recall: mean(perCase.map((metric) => metric.recall)),
    avgLatencyMs: mean(latencies),
    p95LatencyMs: percentile(latencies, 0.95),
    routeAccuracy: routeChecks.length === 0
      ? 0
      : mean(routeChecks.map((matched) => (matched ? 1 : 0))),
    freshnessAccuracy: freshnessChecks.length === 0
      ? 0
      : mean(freshnessChecks.map((matched) => (matched ? 1 : 0))),
  };
}

export function rate(values: boolean[]): number {
  if (values.length === 0) return 0;
  return values.filter(Boolean).length / values.length;
}

export function reductionPct(baseline: number, candidate: number): number {
  if (baseline <= 0) return 0;
  return Math.max(0, (baseline - candidate) / baseline);
}

export function compressionRatio(fullTokens: number, compressedTokens: number): number {
  if (fullTokens <= 0) return 0;
  return Math.max(0, 1 - compressedTokens / fullTokens);
}

export function computeExpectedSetMetrics(
  retrievedIds: string[],
  expectedIds: string[],
): ExpectedSetMetrics {
  const expectedSet = new Set(expectedIds);
  const binaryRelevance = retrievedIds.map((id) => (expectedSet.has(id) ? 1 : 0));
  const ideal = expectedIds.map(() => 1);
  const totalRelevant = expectedSet.size;

  return {
    precisionAt3: precisionAtK(binaryRelevance, 3),
    recallAt5: recallAtK(binaryRelevance, 5, totalRelevant),
    mrr: mrr(binaryRelevance),
    ndcg10: ndcg(binaryRelevance, ideal, 10),
    hit: binaryRelevance.some((grade) => grade >= 1),
  };
}

export function retrievalCertaintyScore(inputs: RetrievalCertaintyInputs): number {
  const expectedHitCoverage = clamp01(inputs.expectedHitCoverage);
  const promptCompleteness = clamp01(inputs.promptCompleteness);
  const codeFloor = inputs.codeFloorPreserved ? 1 : 0;
  const routeAppropriate = inputs.routeAppropriate ? 1 : 0;

  return round3(
    expectedHitCoverage * 0.35 +
      codeFloor * 0.25 +
      routeAppropriate * 0.2 +
      promptCompleteness * 0.2
  );
}

export function codeCertaintyScore(
  retrievalScore: number,
  answerGroundingScore?: number | null
): number {
  const retrieval = clamp01(retrievalScore);
  if (answerGroundingScore === undefined || answerGroundingScore === null) {
    return round3(retrieval);
  }
  const answer = clamp01(answerGroundingScore);
  return round3(retrieval * 0.6 + answer * 0.4);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
