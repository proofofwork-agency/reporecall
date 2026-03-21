import { describe, it, expect } from "vitest";
import {
  dcg,
  ndcg,
  mrr,
  averagePrecision,
  codeCertaintyScore,
  compressionRatio,
  computeExpectedSetMetrics,
  precisionAtK,
  recallAtK,
  computeAllMetrics,
  computeBenchmarkSuiteMetrics,
  mean,
  percentile,
  rate,
  reductionPct,
  retrievalCertaintyScore,
} from "./metrics.js";

describe("IR metrics", () => {
  // Hand-computed example from TREC literature: [3,2,0,1,0]
  const retrieved = [3, 2, 0, 1, 0];
  const ideal = [3, 2, 1, 0, 0]; // sorted descending

  it("dcg computes correctly for [3,2,0,1,0] at k=5", () => {
    // (2^3-1)/log2(2) + (2^2-1)/log2(3) + (2^0-1)/log2(4) + (2^1-1)/log2(5) + (2^0-1)/log2(6)
    // = 7/1 + 3/1.585 + 0/2 + 1/2.322 + 0/2.585
    // = 7 + 1.893 + 0 + 0.431 + 0 = 9.324
    const result = dcg(retrieved, 5);
    expect(result).toBeCloseTo(9.324, 2);
  });

  it("ndcg normalizes against ideal ranking", () => {
    const result = ndcg(retrieved, ideal, 5);
    // idealDCG for [3,2,1,0,0] = 7 + 1.893 + 0.5 + 0 + 0 = 9.393
    // NDCG = 9.324 / 9.393 ≈ 0.993
    expect(result).toBeCloseTo(0.993, 2);
  });

  it("ndcg returns 0 when no relevant docs exist", () => {
    expect(ndcg([0, 0, 0], [0, 0, 0], 3)).toBe(0);
  });

  it("mrr returns reciprocal of first relevant rank", () => {
    expect(mrr([0, 0, 3, 1])).toBeCloseTo(1 / 3, 5);
    expect(mrr([3, 0, 0])).toBe(1);
    expect(mrr([0, 0, 0])).toBe(0);
  });

  it("averagePrecision computes standard MAP component", () => {
    // [3,2,0,1,0]: relevant at positions 0,1,3
    // P@1=1/1, P@2=2/2, P@4=3/4
    // AP = (1 + 1 + 0.75) / 3 = 0.917
    expect(averagePrecision(retrieved, 3)).toBeCloseTo(0.917, 2);
  });

  it("averagePrecision returns 0 when totalRelevant is 0", () => {
    expect(averagePrecision([0, 0], 0)).toBe(0);
  });

  it("precisionAtK counts relevant in top k", () => {
    // [3,2,0,1,0] → top 5: 3 relevant out of 5
    expect(precisionAtK(retrieved, 5)).toBeCloseTo(0.6, 5);
    // top 2: 2 relevant out of 2
    expect(precisionAtK(retrieved, 2)).toBe(1);
  });

  it("recallAtK computes relevant in top k / total relevant", () => {
    // 3 relevant total, top 2 has 2 → 2/3
    expect(recallAtK(retrieved, 2, 3)).toBeCloseTo(2 / 3, 5);
    // top 5 has 3 → 3/3
    expect(recallAtK(retrieved, 5, 3)).toBe(1);
    // 0 total relevant → 0
    expect(recallAtK([0, 0], 2, 0)).toBe(0);
  });

  it("computeAllMetrics returns all metrics together", () => {
    const m = computeAllMetrics(retrieved, ideal);
    expect(m.ndcg10).toBeGreaterThan(0);
    expect(m.mrr).toBe(1); // first result is relevant
    expect(m.map).toBeGreaterThan(0);
    expect(m.p5).toBeCloseTo(0.6, 5);
    expect(m.r5).toBe(1);
  });

  it("perfect ranking gives ndcg = 1", () => {
    const perfect = [3, 2, 1, 0, 0];
    expect(ndcg(perfect, perfect, 5)).toBeCloseTo(1, 5);
  });

  it("worst ranking gives low ndcg", () => {
    const worst = [0, 0, 0, 1, 3];
    const idealRanking = [3, 1, 0, 0, 0];
    const result = ndcg(worst, idealRanking, 5);
    expect(result).toBeLessThan(0.5);
  });

  it("computeExpectedSetMetrics handles binary expected-set retrieval", () => {
    const metrics = computeExpectedSetMetrics(
      ["a", "x", "b", "y", "z"],
      ["a", "b", "c"]
    );
    expect(metrics.precisionAt3).toBeCloseTo(2 / 3, 5);
    expect(metrics.recallAt5).toBeCloseTo(2 / 3, 5);
    expect(metrics.mrr).toBe(1);
    expect(metrics.ndcg10).toBeGreaterThan(0.7);
    expect(metrics.hit).toBe(true);
  });

  it("reductionPct reports relative savings", () => {
    expect(reductionPct(100, 70)).toBeCloseTo(0.3, 5);
    expect(reductionPct(0, 0)).toBe(0);
    expect(reductionPct(100, 120)).toBe(0);
  });

  it("compressionRatio reports summary compression", () => {
    expect(compressionRatio(100, 55)).toBeCloseTo(0.45, 5);
    expect(compressionRatio(0, 0)).toBe(0);
    expect(compressionRatio(50, 60)).toBe(0);
  });

  it("mean and rate handle aggregate reporting", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBe(0);
    expect(rate([true, false, true])).toBeCloseTo(2 / 3, 5);
    expect(rate([])).toBe(0);
  });

  it("percentile uses nearest-rank semantics", () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([10, 30, 20, 40], 0)).toBe(10);
    expect(percentile([10, 30, 20, 40], 0.5)).toBe(20);
    expect(percentile([10, 30, 20, 40], 0.95)).toBe(40);
  });

  it("computeBenchmarkSuiteMetrics aggregates deterministic benchmark cases", () => {
    const suite = computeBenchmarkSuiteMetrics([
      {
        retrieved: [3, 2, 0, 0],
        ideal: [3, 2, 0, 0],
        latencyMs: 4,
        routeMatched: true,
        freshnessMatched: true,
      },
      {
        retrieved: [0, 3, 0, 0],
        ideal: [3, 0, 0, 0],
        latencyMs: 10,
        routeMatched: false,
        freshnessMatched: true,
      },
    ]);

    expect(suite.ndcg10).toBeGreaterThan(0.75);
    expect(suite.mrr).toBeCloseTo(0.75, 5);
    expect(suite.recall).toBe(1);
    expect(suite.avgLatencyMs).toBe(7);
    expect(suite.p95LatencyMs).toBe(10);
    expect(suite.routeAccuracy).toBe(0.5);
    expect(suite.freshnessAccuracy).toBe(1);
  });

  it("retrievalCertaintyScore weights the expected signals", () => {
    const score = retrievalCertaintyScore({
      expectedHitCoverage: 0.8,
      codeFloorPreserved: true,
      routeAppropriate: true,
      promptCompleteness: 0.75,
    });
    expect(score).toBeCloseTo(0.88, 2);
  });

  it("codeCertaintyScore combines retrieval and answer grounding", () => {
    expect(codeCertaintyScore(0.8, 0.7)).toBeCloseTo(0.76, 5);
    expect(codeCertaintyScore(0.8, null)).toBeCloseTo(0.8, 5);
  });
});
