#!/usr/bin/env npx tsx
/**
 * Reporecall v0.2 Benchmark / Evaluation Suite
 *
 * Runs a set of queries through the full retrieval pipeline and measures:
 * - Route accuracy (actual vs expected)
 * - Latency per query
 * - Tokens and chunks injected
 * - Seed resolution details
 *
 * Usage:
 *   npx tsx benchmark/v02-eval.ts --project .
 *   npx tsx benchmark/v02-eval.ts --project /path/to/repo --json
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import { detectProjectRoot } from "../src/core/project.js";
import { loadConfig } from "../src/core/config.js";
import { IndexingPipeline } from "../src/indexer/pipeline.js";
import { HybridSearch } from "../src/search/hybrid.js";
import { sanitizeQuery } from "../src/daemon/server.js";
import { classifyIntent, deriveRoute } from "../src/search/intent.js";
import type { RouteDecision } from "../src/search/intent.js";
import { resolveSeeds } from "../src/search/seed.js";
import { handlePromptContextDetailed } from "../src/hooks/prompt-context.js";

// ── Types ──────────────────────────────────────────────────────────

interface BenchmarkQuery {
  query: string;
  expectedRoute: string;
  category: string;
  description: string;
}

interface QueryResult {
  query: string;
  description: string;
  category: string;
  expectedRoute: string;
  actualRoute: string;
  match: boolean;
  latencyMs: number;
  tokens: number;
  chunks: number;
  seedName: string | null;
  seedConfidence: number | null;
  error: string | null;
}

interface BenchmarkSummary {
  totalQueries: number;
  routeAccuracy: number;
  routeAccuracyPct: string;
  matchCount: number;
  avgLatencyMs: number;
  avgLatencyByRoute: Record<string, number>;
  avgTokensByRoute: Record<string, number>;
  avgChunksByRoute: Record<string, number>;
  skipCount: number;
  skipRate: string;
  errorCount: number;
  byCategory: Record<string, { total: number; correct: number; accuracy: string }>;
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseArgs(): { projectPath: string; jsonOutput: boolean; queriesPath: string } {
  const args = process.argv.slice(2);
  let projectPath = ".";
  let jsonOutput = false;
  let queriesPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) {
      projectPath = args[i + 1];
      i++;
    } else if (args[i] === "--json") {
      jsonOutput = true;
    } else if (args[i] === "--queries" && args[i + 1]) {
      queriesPath = args[i + 1];
      i++;
    }
  }

  if (!queriesPath) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    queriesPath = resolve(__dirname, "queries.json");
  }

  return { projectPath: resolve(projectPath), jsonOutput, queriesPath: resolve(queriesPath) };
}

function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { projectPath, jsonOutput, queriesPath } = parseArgs();

  // Load queries
  if (!existsSync(queriesPath)) {
    console.error(`Query file not found: ${queriesPath}`);
    process.exit(1);
  }
  const queries: BenchmarkQuery[] = JSON.parse(readFileSync(queriesPath, "utf-8"));

  // Detect project and load config
  const projectRoot = detectProjectRoot(projectPath);
  const config = loadConfig(projectRoot);

  // Force keyword mode (no embedding model needed for CI)
  config.embeddingProvider = "keyword";

  // Check for index
  const metadataPath = resolve(config.dataDir, "metadata.db");
  const hasIndex = existsSync(metadataPath);

  if (!hasIndex && !jsonOutput) {
    console.error(
      `No index found at ${config.dataDir}.\n` +
      `Run "reporecall index" first, then re-run the benchmark.\n` +
      `Proceeding with route classification only (no retrieval).\n`
    );
  }

  // Initialize pipeline (only if index exists)
  let pipeline: IndexingPipeline | null = null;
  let search: HybridSearch | null = null;
  let metadataStore: import("../src/storage/metadata-store.js").MetadataStore | null = null;
  let ftsStore: import("../src/storage/fts-store.js").FTSStore | null = null;

  if (hasIndex) {
    try {
      pipeline = new IndexingPipeline(config);
      search = new HybridSearch(
        pipeline.getEmbedder(),
        pipeline.getVectorStore(),
        pipeline.getFTSStore(),
        pipeline.getMetadataStore(),
        config,
      );
      metadataStore = pipeline.getMetadataStore();
      ftsStore = pipeline.getFTSStore();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!jsonOutput) {
        console.error(
          `Failed to initialize pipeline (index may be from an older version):\n  ${msg}\n` +
          `Proceeding with route classification only (no retrieval).\n`
        );
      }
      // Fall through: pipeline/search remain null, benchmark runs classification-only
    }
  }

  // Run benchmark
  const results: QueryResult[] = [];

  for (const q of queries) {
    const start = performance.now();
    let actualRoute: RouteDecision = "skip";
    let tokens = 0;
    let chunks = 0;
    let seedName: string | null = null;
    let seedConfidence: number | null = null;
    let error: string | null = null;

    try {
      // Step 1: Sanitize
      const sanitized = sanitizeQuery(q.query);

      // Step 2: Classify intent
      const intent = classifyIntent(sanitized || q.query);
      actualRoute = deriveRoute(intent);

      // Step 3: For navigational queries, try seed resolution to upgrade route
      if (intent.needsNavigation && actualRoute === "R0" && ftsStore && metadataStore) {
        const seedResult = resolveSeeds(sanitized || q.query, metadataStore, ftsStore);
        if (seedResult.bestSeed) {
          seedName = seedResult.bestSeed.name;
          seedConfidence = seedResult.bestSeed.confidence;
        }
        actualRoute = deriveRoute(intent, seedResult.bestSeed?.confidence ?? null);
      }

      // Step 4: Run retrieval (if index exists and route is not skip)
      if (actualRoute !== "skip" && search) {
        const promptContext = await handlePromptContextDetailed(
          sanitized || q.query,
          search,
          config,
          undefined, // activeFiles
          undefined, // signal
          actualRoute,
          metadataStore ?? undefined,
          ftsStore ?? undefined,
        );
        actualRoute = promptContext.resolvedRoute;
        const context = promptContext.context;

        if (context) {
          tokens = context.tokenCount;
          chunks = context.chunks.length;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const latencyMs = performance.now() - start;

    results.push({
      query: q.query,
      description: q.description,
      category: q.category,
      expectedRoute: q.expectedRoute,
      actualRoute,
      match: actualRoute === q.expectedRoute,
      latencyMs,
      tokens,
      chunks,
      seedName,
      seedConfidence,
      error,
    });
  }

  // Cleanup
  if (pipeline) {
    pipeline.close();
  }

  // Compute summary
  const summary = computeSummary(results);

  // Output
  if (jsonOutput) {
    console.log(JSON.stringify({ results, summary }, null, 2));
  } else {
    printTable(results, summary);
  }

  // Exit with non-zero if accuracy is below threshold
  if (summary.routeAccuracy < 0.8) {
    process.exit(1);
  }
}

function computeSummary(results: QueryResult[]): BenchmarkSummary {
  const matchCount = results.filter((r) => r.match).length;
  const errorCount = results.filter((r) => r.error !== null).length;
  const skipCount = results.filter((r) => r.actualRoute === "skip").length;

  // Latency by route
  const latencyByRoute: Record<string, number[]> = {};
  const tokensByRoute: Record<string, number[]> = {};
  const chunksByRoute: Record<string, number[]> = {};
  const byCategory: Record<string, { total: number; correct: number }> = {};

  for (const r of results) {
    // Route stats
    if (!latencyByRoute[r.actualRoute]) latencyByRoute[r.actualRoute] = [];
    latencyByRoute[r.actualRoute].push(r.latencyMs);

    if (!tokensByRoute[r.actualRoute]) tokensByRoute[r.actualRoute] = [];
    tokensByRoute[r.actualRoute].push(r.tokens);

    if (!chunksByRoute[r.actualRoute]) chunksByRoute[r.actualRoute] = [];
    chunksByRoute[r.actualRoute].push(r.chunks);

    // Category stats
    if (!byCategory[r.category]) byCategory[r.category] = { total: 0, correct: 0 };
    byCategory[r.category].total++;
    if (r.match) byCategory[r.category].correct++;
  }

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const avgLatencyByRoute: Record<string, number> = {};
  for (const [route, latencies] of Object.entries(latencyByRoute)) {
    avgLatencyByRoute[route] = Math.round(avg(latencies));
  }

  const avgTokensByRoute: Record<string, number> = {};
  for (const [route, tokens] of Object.entries(tokensByRoute)) {
    avgTokensByRoute[route] = Math.round(avg(tokens));
  }

  const avgChunksByRoute: Record<string, number> = {};
  for (const [route, chunks] of Object.entries(chunksByRoute)) {
    avgChunksByRoute[route] = Math.round(avg(chunks));
  }

  const byCategoryFormatted: Record<string, { total: number; correct: number; accuracy: string }> = {};
  for (const [cat, stats] of Object.entries(byCategory)) {
    byCategoryFormatted[cat] = {
      ...stats,
      accuracy: `${((stats.correct / stats.total) * 100).toFixed(0)}%`,
    };
  }

  const totalLatency = results.reduce((sum, r) => sum + r.latencyMs, 0);

  return {
    totalQueries: results.length,
    routeAccuracy: results.length ? matchCount / results.length : 0,
    routeAccuracyPct: `${((matchCount / results.length) * 100).toFixed(1)}%`,
    matchCount,
    avgLatencyMs: Math.round(totalLatency / results.length),
    avgLatencyByRoute,
    avgTokensByRoute,
    avgChunksByRoute,
    skipCount,
    skipRate: `${((skipCount / results.length) * 100).toFixed(1)}%`,
    errorCount,
    byCategory: byCategoryFormatted,
  };
}

function printTable(results: QueryResult[], summary: BenchmarkSummary): void {
  console.log("");
  console.log("Reporecall v0.2 Benchmark Results");
  console.log("==================================");
  console.log("");

  // Header
  const cols = [
    pad("Query", 42),
    pad("Expected", 10),
    pad("Actual", 8),
    pad("Match", 7),
    pad("Latency", 9),
    pad("Tokens", 8),
    pad("Chunks", 8),
    pad("Seed", 20),
  ];
  console.log(cols.join("| "));
  console.log("-".repeat(cols.join("| ").length));

  // Rows
  for (const r of results) {
    const matchStr = r.match ? "Y" : "N";
    const seedStr = r.seedName
      ? `${r.seedName} (${r.seedConfidence?.toFixed(2) ?? "?"})`
      : "-";
    const errorStr = r.error ? ` [ERR]` : "";

    const row = [
      pad(r.query.slice(0, 40) + errorStr, 42),
      pad(r.expectedRoute, 10),
      pad(r.actualRoute, 8),
      pad(matchStr, 7),
      pad(formatMs(r.latencyMs), 9),
      pad(formatNum(r.tokens), 8),
      pad(String(r.chunks), 8),
      pad(seedStr.slice(0, 18), 20),
    ];
    console.log(row.join("| "));
  }

  // Summary
  console.log("");
  console.log("Summary");
  console.log("-------");
  console.log(`  Route accuracy:     ${summary.matchCount}/${summary.totalQueries} (${summary.routeAccuracyPct})`);
  console.log(`  Errors:             ${summary.errorCount}`);
  console.log(`  Skip rate:          ${summary.skipCount}/${summary.totalQueries} (${summary.skipRate})`);
  console.log(`  Avg latency:        ${formatMs(summary.avgLatencyMs)}`);
  console.log("");

  // Per-route stats
  console.log("  Per-route averages:");
  for (const route of ["skip", "R0", "R1", "R2"]) {
    if (summary.avgLatencyByRoute[route] !== undefined) {
      console.log(
        `    ${pad(route, 6)} latency=${formatMs(summary.avgLatencyByRoute[route])}  ` +
        `tokens=${formatNum(summary.avgTokensByRoute[route] ?? 0)}  ` +
        `chunks=${summary.avgChunksByRoute[route] ?? 0}`
      );
    }
  }

  console.log("");
  console.log("  Per-category accuracy:");
  for (const [cat, stats] of Object.entries(summary.byCategory)) {
    console.log(`    ${pad(cat, 16)} ${stats.correct}/${stats.total} (${stats.accuracy})`);
  }

  console.log("");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
