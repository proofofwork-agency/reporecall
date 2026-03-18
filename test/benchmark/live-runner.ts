/**
 * Live-repo benchmark runner — evaluates search quality against the Reporecall
 * codebase itself using graded relevance annotations and community-standard IR metrics.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { mkdirSync } from "fs";
import { loadConfig } from "../../src/core/config.js";
import { IndexingPipeline } from "../../src/indexer/pipeline.js";
import { HybridSearch } from "../../src/search/hybrid.js";
import { sanitizeQuery } from "../../src/daemon/server.js";
import { classifyIntent, deriveRoute } from "../../src/search/intent.js";
import { resolveSeeds } from "../../src/search/seed.js";
import { handlePromptContextDetailed } from "../../src/hooks/prompt-context.js";
import { computeAllMetrics } from "./metrics.js";

// ─── Types ───

export interface LiveQueryMetrics {
  id: string;
  query: string;
  category: string;
  expectedRoute: string;
  actualRoute: string;
  routeMatch: boolean;
  // IR metrics
  ndcg10: number;
  mrr: number;
  averagePrecision: number;
  p5: number;
  p10: number;
  r5: number;
  r10: number;
  // Operational
  searchLatencyMs: number;
  resultsFound: number;
  seedName: string | null;
  seedConfidence: number | null;
  // Debug
  retrievedNames: string[];
}

export interface LiveBenchmarkResults {
  corpus: string;
  mode: "keyword" | "semantic";
  totalQueries: number;
  // Aggregate IR
  meanNDCG10: number;
  meanMRR: number;
  meanMAP: number;
  meanP5: number;
  meanP10: number;
  meanR5: number;
  meanR10: number;
  // Breakdowns
  byRoute: Record<string, { count: number; ndcg10: number; mrr: number }>;
  byCategory: Record<string, { count: number; ndcg10: number; mrr: number }>;
  // Operational
  routeAccuracy: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  queries: LiveQueryMetrics[];
}

// ─── Annotation types ───

interface AnnotationQuery {
  id: string;
  query: string;
  category: string;
  expectedRoute: string;
  relevance: Record<string, number>;
}

interface AnnotationsFile {
  corpus: string;
  version: string;
  annotatedAt: string;
  scale: Record<string, string>;
  queries: AnnotationQuery[];
}

// ─── Helpers ───

function makeBenchmarkConfig(
  projectRoot: string,
  dataDir: string,
  provider: "keyword" | "local"
) {
  const baseConfig = loadConfig(projectRoot);
  return {
    ...baseConfig,
    dataDir,
    embeddingProvider: provider,
    ignorePatterns: [...baseConfig.ignorePatterns, "benchmark", "scripts"],
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function lookupGrade(
  resultName: string,
  resultFilePath: string,
  relevance: Record<string, number>
): number {
  // 1. Exact match on name
  if (resultName in relevance) return relevance[resultName];
  // 2. Qualified match: filePath:name
  const qualified = `${resultFilePath}:${resultName}`;
  if (qualified in relevance) return relevance[qualified];
  // 3. Default: not relevant
  return 0;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ─── Main runner ───

export async function runLiveBenchmark(
  mode: "keyword" | "semantic" = "keyword"
): Promise<LiveBenchmarkResults> {
  const projectRoot = process.cwd();
  const annotationsPath = join(projectRoot, "benchmark", "annotations.json");
  const annotations: AnnotationsFile = JSON.parse(
    readFileSync(annotationsPath, "utf-8")
  );

  // Index the project
  const dataDir = join(projectRoot, `.memory-live-benchmark-${Date.now()}`);
  mkdirSync(dataDir, { recursive: true });

  const provider = mode === "keyword" ? "keyword" as const : "local" as const;
  const config = makeBenchmarkConfig(projectRoot, dataDir, provider);

  const pipeline = new IndexingPipeline(config);
  await pipeline.indexAll();

  const search = new HybridSearch(
    pipeline.getEmbedder(),
    pipeline.getVectorStore(),
    pipeline.getFTSStore(),
    pipeline.getMetadataStore(),
    config
  );

  const metadata = pipeline.getMetadataStore();
  const fts = pipeline.getFTSStore();

  // Check for orphaned annotations
  const allChunkNames = new Set<string>();
  const allChunks = metadata.getAllChunks();
  for (const chunk of allChunks) {
    allChunkNames.add(chunk.name);
  }

  for (const aq of annotations.queries) {
    for (const name of Object.keys(aq.relevance)) {
      const baseName = name.includes(":") ? name.split(":").pop()! : name;
      if (!allChunkNames.has(baseName) && aq.relevance[name] > 0) {
        console.warn(
          `[warn] Orphaned annotation: "${name}" in query "${aq.id}" not found in index`
        );
      }
    }
  }

  // Run queries
  const queryMetrics: LiveQueryMetrics[] = [];

  for (const aq of annotations.queries) {
    const searchStart = performance.now();

    let actualRoute = "skip";
    let seedName: string | null = null;
    let seedConfidence: number | null = null;
    let retrievedNames: string[] = [];
    let retrievedGrades: number[] = [];
    let resultsFound = 0;

    const sanitized = sanitizeQuery(aq.query);
    const queryText = sanitized || aq.query;
    const intent = classifyIntent(queryText);
    let route = deriveRoute(intent);

    if (intent.needsNavigation && route === "R0") {
      const seedResult = resolveSeeds(queryText, metadata, fts);
      if (seedResult.bestSeed) {
        seedName = seedResult.bestSeed.name;
        seedConfidence = seedResult.bestSeed.confidence;
      }
      route = deriveRoute(intent, seedResult.bestSeed?.confidence ?? null);
    }

    if (route !== "skip") {
      const promptContext = await handlePromptContextDetailed(
        queryText, search, config, undefined, undefined, route, metadata, fts
      );
      actualRoute = promptContext.resolvedRoute;
      if (promptContext.context) {
        retrievedNames = promptContext.context.chunks.map((r) => r.name);
        retrievedGrades = promptContext.context.chunks.map((r) =>
          lookupGrade(r.name, r.filePath, aq.relevance)
        );
        resultsFound = promptContext.context.chunks.length;
      }
    } else {
      actualRoute = "skip";
    }

    const searchLatencyMs =
      Math.round((performance.now() - searchStart) * 100) / 100;

    // Build ideal ranking from annotations
    const idealGrades = Object.values(aq.relevance)
      .filter((g) => g > 0)
      .sort((a, b) => b - a);

    // Skip IR metrics for skip queries but still measure route accuracy
    const isSkip = aq.expectedRoute === "skip";
    const rawMetrics = isSkip
      ? { ndcg10: 0, mrr: 0, map: 0, p5: 0, p10: 0, r5: 0, r10: 0 }
      : computeAllMetrics(retrievedGrades, idealGrades);

    // Guard against NaN from edge cases (e.g. path format mismatches)
    const metrics = Object.fromEntries(
      Object.entries(rawMetrics).map(([k, v]) => [k, isNaN(v) ? 0 : v])
    ) as typeof rawMetrics;

    queryMetrics.push({
      id: aq.id,
      query: aq.query,
      category: aq.category,
      expectedRoute: aq.expectedRoute,
      actualRoute,
      routeMatch: actualRoute === aq.expectedRoute,
      ndcg10: metrics.ndcg10,
      mrr: metrics.mrr,
      averagePrecision: metrics.map,
      p5: metrics.p5,
      p10: metrics.p10,
      r5: metrics.r5,
      r10: metrics.r10,
      searchLatencyMs,
      resultsFound,
      seedName,
      seedConfidence,
      retrievedNames,
    });
  }

  pipeline.close();

  // Clean up temp data dir
  const { rmSync } = await import("fs");
  rmSync(dataDir, { recursive: true, force: true });

  // Aggregate
  const irQueries = queryMetrics.filter(
    (q) => q.expectedRoute !== "skip"
  );
  const latencies = queryMetrics
    .map((q) => q.searchLatencyMs)
    .sort((a, b) => a - b);

  // By route breakdown
  const byRoute: Record<string, { count: number; ndcg10: number; mrr: number }> = {};
  for (const q of queryMetrics) {
    const route = q.expectedRoute;
    if (!byRoute[route]) byRoute[route] = { count: 0, ndcg10: 0, mrr: 0 };
    byRoute[route].count++;
    if (route !== "skip") {
      byRoute[route].ndcg10 += q.ndcg10;
      byRoute[route].mrr += q.mrr;
    }
  }
  for (const [route, data] of Object.entries(byRoute)) {
    if (route !== "skip" && data.count > 0) {
      data.ndcg10 = Math.round((data.ndcg10 / data.count) * 1000) / 1000;
      data.mrr = Math.round((data.mrr / data.count) * 1000) / 1000;
    }
  }

  // By category breakdown
  const byCategory: Record<string, { count: number; ndcg10: number; mrr: number }> = {};
  for (const q of irQueries) {
    if (!byCategory[q.category])
      byCategory[q.category] = { count: 0, ndcg10: 0, mrr: 0 };
    byCategory[q.category].count++;
    byCategory[q.category].ndcg10 += q.ndcg10;
    byCategory[q.category].mrr += q.mrr;
  }
  for (const data of Object.values(byCategory)) {
    if (data.count > 0) {
      data.ndcg10 = Math.round((data.ndcg10 / data.count) * 1000) / 1000;
      data.mrr = Math.round((data.mrr / data.count) * 1000) / 1000;
    }
  }

  const routeAccuracy =
    Math.round(
      (queryMetrics.filter((q) => q.routeMatch).length /
        queryMetrics.length) *
        1000
    ) / 10;

  return {
    corpus: annotations.corpus,
    mode,
    totalQueries: queryMetrics.length,
    meanNDCG10: Math.round(mean(irQueries.map((q) => q.ndcg10)) * 1000) / 1000,
    meanMRR: Math.round(mean(irQueries.map((q) => q.mrr)) * 1000) / 1000,
    meanMAP: Math.round(mean(irQueries.map((q) => q.averagePrecision)) * 1000) / 1000,
    meanP5: Math.round(mean(irQueries.map((q) => q.p5)) * 1000) / 1000,
    meanP10: Math.round(mean(irQueries.map((q) => q.p10)) * 1000) / 1000,
    meanR5: Math.round(mean(irQueries.map((q) => q.r5)) * 1000) / 1000,
    meanR10: Math.round(mean(irQueries.map((q) => q.r10)) * 1000) / 1000,
    byRoute,
    byCategory,
    routeAccuracy,
    avgLatencyMs:
      Math.round(mean(latencies) * 100) / 100,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    queries: queryMetrics,
  };
}

// ─── Output formatting ───

function pad(s: string, len: number): string {
  return s.padEnd(len);
}

export function printLiveResults(results: LiveBenchmarkResults): void {
  const w = 63;
  console.log("╔" + "═".repeat(w) + "╗");
  console.log(
    "║  " +
      pad(
        `Reporecall Live Benchmark (${results.mode}, ${results.totalQueries} queries)`,
        w - 2
      ) +
      "║"
  );
  console.log("╠" + "═".repeat(w) + "╣");
  console.log(
    "║  " +
      pad(
        `NDCG@10: ${results.meanNDCG10.toFixed(3)}    MRR: ${results.meanMRR.toFixed(3)}    MAP: ${results.meanMAP.toFixed(3)}`,
        w - 2
      ) +
      "║"
  );
  console.log(
    "║  " +
      pad(
        `P@5: ${results.meanP5.toFixed(3)}  P@10: ${results.meanP10.toFixed(3)}  R@5: ${results.meanR5.toFixed(3)}  R@10: ${results.meanR10.toFixed(3)}`,
        w - 2
      ) +
      "║"
  );
  console.log("╠" + "═".repeat(w) + "╣");
  console.log(
    "║  " +
      pad("By Route        Count   NDCG@10   MRR", w - 2) +
      "║"
  );

  for (const [route, data] of Object.entries(results.byRoute)) {
    if (route === "skip") {
      console.log(
        "║    " +
          pad(`${route}`, 14) +
          pad(String(data.count), 8) +
          pad("—", 10) +
          pad("—", w - 34) +
          "║"
      );
    } else {
      console.log(
        "║    " +
          pad(`${route}`, 14) +
          pad(String(data.count), 8) +
          pad(data.ndcg10.toFixed(3), 10) +
          pad(data.mrr.toFixed(3), w - 34) +
          "║"
      );
    }
  }

  console.log("╠" + "═".repeat(w) + "╣");
  console.log(
    "║  " +
      pad(
        `Route accuracy: ${results.routeAccuracy}%  Avg latency: ${results.avgLatencyMs}ms (P50: ${results.p50LatencyMs}ms)`,
        w - 2
      ) +
      "║"
  );
  console.log("╚" + "═".repeat(w) + "╝");

  // Category breakdown
  console.log("\n  By Category:");
  for (const [cat, data] of Object.entries(results.byCategory)) {
    console.log(
      `    ${pad(cat, 16)} Count: ${pad(String(data.count), 4)} NDCG@10: ${pad(data.ndcg10.toFixed(3), 8)} MRR: ${data.mrr.toFixed(3)}`
    );
  }
}
