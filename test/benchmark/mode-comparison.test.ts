import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runBenchmark, printResults, type BenchmarkResults } from "./runner.js";

const BENCHMARK_ROOT = join(tmpdir(), `memory-benchmark-${Date.now()}`);

describe("mode comparison benchmark", { timeout: 300_000 }, () => {
  const allResults: BenchmarkResults[] = [];

  afterAll(() => {
    if (allResults.length > 0) {
      printResults(allResults);
    }
    rmSync(BENCHMARK_ROOT, { recursive: true, force: true });
  });

  for (const size of ["small", "medium", "large"] as const) {
    it(`benchmarks ${size} codebase`, async () => {
      const dir = join(BENCHMARK_ROOT, size);
      mkdirSync(dir, { recursive: true });
      const results = await runBenchmark(size, dir);
      allResults.push(results);

      // ─── Top-level shape ────────────────────────────────────────────────
      expect(results).toBeDefined();
      expect(results.size).toBe(size);
      expect(results.fileCount).toBeGreaterThan(0);
      expect(results.approxLoc).toBeGreaterThan(0);

      // Three modes must always be present: baseline, keyword, semantic
      expect(results.modes).toHaveLength(3);

      const modeNames = results.modes.map((m) => m.mode);
      expect(modeNames).toContain("baseline");
      expect(modeNames).toContain("keyword");
      expect(modeNames).toContain("semantic");

      // ─── Baseline mode ───────────────────────────────────────────────────
      const baseline = results.modes.find((m) => m.mode === "baseline")!;
      expect(baseline).toBeDefined();
      // Baseline does no indexing — all counters must be zero
      expect(baseline.chunksCreated).toBe(0);
      expect(baseline.filesProcessed).toBe(0);
      expect(baseline.indexTimeMs).toBe(0);
      // Every query in baseline returns no results
      expect(baseline.queries.length).toBeGreaterThan(0);
      for (const q of baseline.queries) {
        expect(q.resultsFound).toBe(0);
        expect(q.contextTokens).toBe(0);
      }

      // ─── Keyword mode ────────────────────────────────────────────────────
      const keyword = results.modes.find((m) => m.mode === "keyword")!;
      expect(keyword).toBeDefined();
      // Indexing must have produced at least one chunk from the generated codebase
      expect(keyword.chunksCreated).toBeGreaterThan(0);
      expect(keyword.filesProcessed).toBeGreaterThan(0);
      expect(keyword.indexTimeMs).toBeGreaterThan(0);
      // Query metrics array must match the number of prompts run
      expect(keyword.queries.length).toBeGreaterThan(0);
      // At least one query should have returned results
      const keywordWithResults = keyword.queries.filter((q) => q.resultsFound > 0);
      expect(keywordWithResults.length).toBeGreaterThan(0);
      // Aggregate stats must be non-negative numbers (not NaN)
      expect(keyword.avgSearchLatencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(keyword.avgSearchLatencyMs)).toBe(false);
      expect(Number.isNaN(keyword.avgResultsFound)).toBe(false);
      // v0.2.0 routing stats
      expect(keyword.routeAccuracy).toBeGreaterThanOrEqual(0);
      expect(typeof keyword.routeDistribution).toBe("object");
      expect(Object.keys(keyword.routeDistribution).length).toBeGreaterThanOrEqual(1);

      // ─── Semantic mode ───────────────────────────────────────────────────
      const semantic = results.modes.find((m) => m.mode === "semantic")!;
      expect(semantic).toBeDefined();
      // Indexing must have produced at least one chunk
      expect(semantic.chunksCreated).toBeGreaterThan(0);
      expect(semantic.filesProcessed).toBeGreaterThan(0);
      expect(semantic.indexTimeMs).toBeGreaterThan(0);
      // Query metrics must be present
      expect(semantic.queries.length).toBeGreaterThan(0);
      // At least one query should have returned results
      const semanticWithResults = semantic.queries.filter((q) => q.resultsFound > 0);
      expect(semanticWithResults.length).toBeGreaterThan(0);
      // Aggregate stats must be non-negative, non-NaN numbers
      expect(semantic.avgSearchLatencyMs).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(semantic.avgSearchLatencyMs)).toBe(false);
      expect(Number.isNaN(semantic.avgResultsFound)).toBe(false);
      // v0.2.0 routing stats
      expect(semantic.routeAccuracy).toBeGreaterThanOrEqual(0);
      expect(typeof semantic.routeDistribution).toBe("object");
      expect(Object.keys(semantic.routeDistribution).length).toBeGreaterThanOrEqual(1);

      // ─── Per-query shape ─────────────────────────────────────────────────
      // Every query object for non-baseline modes must have sensible structure
      for (const mode of [keyword, semantic]) {
        for (const q of mode.queries) {
          expect(typeof q.query).toBe("string");
          expect(q.query.length).toBeGreaterThan(0);
          expect(q.searchLatencyMs).toBeGreaterThanOrEqual(0);
          expect(q.resultsFound).toBeGreaterThanOrEqual(0);
          expect(q.top5Hits).toBeGreaterThanOrEqual(0);
          expect(q.top5Hits).toBeLessThanOrEqual(q.top5Expected);
          expect(q.contextTokens).toBeGreaterThanOrEqual(0);
          expect(q.contextChunks).toBeGreaterThanOrEqual(0);
          expect(q.budgetUtilization).toBeGreaterThanOrEqual(0);
          // v0.2.0 routing fields
          expect(typeof q.expectedRoute).toBe("string");
          expect(q.expectedRoute.length).toBeGreaterThan(0);
          expect(typeof q.actualRoute).toBe("string");
          expect(q.actualRoute.length).toBeGreaterThan(0);
          expect(typeof q.routeMatch).toBe("boolean");
        }
      }
    });
  }
});
