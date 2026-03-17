#!/usr/bin/env npx tsx
/**
 * 3-way benchmark: v0.2.0 vs v0.1.0 vs no-memory
 *
 * Usage:
 *   npx tsx benchmark/compare.ts --project .
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ── v0.2.0 imports (from src/) ─────────────────────────────────────
import { detectProjectRoot } from "../src/core/project.js";
import { loadConfig } from "../src/core/config.js";
import { IndexingPipeline } from "../src/indexer/pipeline.js";
import { HybridSearch } from "../src/search/hybrid.js";
import { sanitizeQuery } from "../src/daemon/server.js";
import { classifyIntent, deriveRoute } from "../src/search/intent.js";
import { resolveSeeds } from "../src/search/seed.js";
import { handlePromptContextDetailed } from "../src/hooks/prompt-context.js";

// ── v0.1.0 imports (from tarball) ─────────────────────────────────
// Dynamic import to avoid module conflicts
const V1_PATH = "/tmp/v01-extract/package/dist/index.js";

// ── Types ──────────────────────────────────────────────────────────

interface BenchmarkQuery {
  query: string;
  expectedRoute: string;
  category: string;
  description: string;
}

interface RowResult {
  query: string;
  category: string;
  v2Route: string;
  v2Tokens: number;
  v2Chunks: number;
  v2LatencyMs: number;
  v1Tokens: number;
  v1Chunks: number;
  v1LatencyMs: number;
  noMemTokens: number;
  noMemLatencyMs: number;
}

// ── Helpers ────────────────────────────────────────────────────────

function pad(str: string, len: number): string {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function winner(v2: number, v1: number, lower_is_better = true): string {
  if (v2 === v1) return "tie";
  if (lower_is_better) return v2 < v1 ? "v0.2" : "v0.1";
  return v2 > v1 ? "v0.2" : "v0.1";
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let projectPath = ".";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { projectPath = args[i + 1]; i++; }
  }
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const queriesPath = resolve(__dirname, "queries.json");
  const queries: BenchmarkQuery[] = JSON.parse(readFileSync(queriesPath, "utf-8"));

  // ── v0.2.0 setup ──────────────────────────────────────────────────
  const root = detectProjectRoot(resolve(projectPath));
  const config = loadConfig(root);
  config.embeddingProvider = "keyword";

  const metadataPath = resolve(config.dataDir, "metadata.db");
  if (!existsSync(metadataPath)) {
    console.error(`No index found at ${config.dataDir}. Run "reporecall index" first.`);
    process.exit(1);
  }

  const pipeline = new IndexingPipeline(config);
  const searchV2 = new HybridSearch(
    pipeline.getEmbedder(),
    pipeline.getVectorStore(),
    pipeline.getFTSStore(),
    pipeline.getMetadataStore(),
    config,
  );
  const metadataStore = pipeline.getMetadataStore();
  const ftsStore = pipeline.getFTSStore();

  // ── v0.1.0 setup ──────────────────────────────────────────────────
  const v1 = await import(V1_PATH) as any;
  const configV1 = v1.loadConfig(root);
  configV1.embeddingProvider = "keyword";
  const pipelineV1 = new v1.IndexingPipeline(configV1);
  const searchV1 = new v1.HybridSearch(
    pipelineV1.getEmbedder(),
    pipelineV1.getVectorStore(),
    pipelineV1.getFTSStore(),
    pipelineV1.getMetadataStore(),
    configV1,
  );

  // ── Run queries ────────────────────────────────────────────────────
  const rows: RowResult[] = [];

  for (const q of queries) {
    const sanitized = sanitizeQuery(q.query) || q.query;

    // ── v0.2.0 ──────────────────────────────────────────────────────
    const t2start = performance.now();
    let v2Route = "skip";
    let v2Tokens = 0;
    let v2Chunks = 0;

    const intent = classifyIntent(sanitized);
    let route = deriveRoute(intent);

    if (intent.needsNavigation && route === "R0") {
      const seedResult = resolveSeeds(sanitized, metadataStore, ftsStore);
      route = deriveRoute(intent, seedResult.bestSeed?.confidence ?? null);
    }

    if (route !== "skip") {
      const ctx = await handlePromptContextDetailed(
        sanitized, searchV2, config, undefined, undefined, route, metadataStore, ftsStore
      );
      v2Route = ctx.resolvedRoute;
      v2Tokens = ctx.context?.tokenCount ?? 0;
      v2Chunks = ctx.context?.chunks?.length ?? 0;
    }
    const v2LatencyMs = Math.round(performance.now() - t2start);

    // ── v0.1.0 ── always injects (no skip logic in v0.1) ─────────────
    const t1start = performance.now();
    let v1Tokens = 0;
    let v1Chunks = 0;
    try {
      const ctx1 = await searchV1.searchWithContext(sanitized, config.contextBudget);
      v1Tokens = ctx1?.tokenCount ?? 0;
      v1Chunks = ctx1?.chunks?.length ?? 0;
    } catch { /* ignore */ }
    const v1LatencyMs = Math.round(performance.now() - t1start);

    // ── no memory ─────────────────────────────────────────────────────
    rows.push({
      query: q.query,
      category: q.category,
      v2Route,
      v2Tokens,
      v2Chunks,
      v2LatencyMs,
      v1Tokens,
      v1Chunks,
      v1LatencyMs,
      noMemTokens: 0,
      noMemLatencyMs: 0,
    });
  }

  // ── Print per-query table ─────────────────────────────────────────
  console.log("\nQuery-by-Query Comparison\n" + "=".repeat(130));
  console.log(
    pad("Query", 44) + "| " +
    pad("Cat", 13) + "| " +
    pad("v0.2 route", 10) + "| " +
    pad("v0.2 tok", 9) + "| " +
    pad("v0.2 ms", 8) + "| " +
    pad("v0.1 tok", 9) + "| " +
    pad("v0.1 ms", 8) + "| " +
    pad("no-mem tok", 10) + "| tok winner"
  );
  console.log("-".repeat(130));

  for (const r of rows) {
    const tokWinner = r.v2Tokens === 0 && r.v1Tokens === 0
      ? "tie"
      : r.v2Tokens === 0
        ? "v0.2 (skip)"
        : winner(r.v2Tokens, r.v1Tokens, true);
    console.log(
      pad(r.query, 44) + "| " +
      pad(r.category, 13) + "| " +
      pad(r.v2Route, 10) + "| " +
      pad(fmt(r.v2Tokens), 9) + "| " +
      pad(r.v2LatencyMs + "ms", 8) + "| " +
      pad(fmt(r.v1Tokens), 9) + "| " +
      pad(r.v1LatencyMs + "ms", 8) + "| " +
      pad("0", 10) + "| " +
      tokWinner
    );
  }

  // ── Summary stats ─────────────────────────────────────────────────
  const nonSkip = rows.filter(r => r.v2Route !== "skip");
  const skipped = rows.filter(r => r.v2Route === "skip");

  const v2AvgTok = Math.round(avg(nonSkip.map(r => r.v2Tokens)));
  const v1AvgTok = Math.round(avg(rows.map(r => r.v1Tokens)));  // v0.1 never skips
  const v2AvgLat = Math.round(avg(nonSkip.map(r => r.v2LatencyMs)));
  const v1AvgLat = Math.round(avg(rows.map(r => r.v1LatencyMs)));
  const v2TotalTok = nonSkip.reduce((s, r) => s + r.v2Tokens, 0);
  const v1TotalTok = rows.reduce((s, r) => s + r.v1Tokens, 0);
  const v2AvgChunks = (nonSkip.reduce((s, r) => s + r.v2Chunks, 0) / Math.max(nonSkip.length, 1)).toFixed(1);
  const v1AvgChunks = (rows.reduce((s, r) => s + r.v1Chunks, 0) / rows.length).toFixed(1);

  // Max token outlier
  const v2MaxRow = rows.reduce((best, r) => r.v2Tokens > best.v2Tokens ? r : best, rows[0]);
  const v1MaxRow = rows.reduce((best, r) => r.v1Tokens > best.v1Tokens ? r : best, rows[0]);

  // Route distribution (v0.2 only)
  const routeCounts: Record<string, number> = {};
  for (const r of rows) routeCounts[r.v2Route] = (routeCounts[r.v2Route] ?? 0) + 1;

  console.log("\n" + "=".repeat(80));
  console.log("Summary");
  console.log("=".repeat(80));

  console.log(`\n  Queries total:       ${rows.length}`);
  console.log(`  v0.2 skipped:        ${skipped.length} queries (${(skipped.length / rows.length * 100).toFixed(0)}%)`);
  console.log(`  v0.1 skipped:        0 queries (no skip logic)`);

  console.log(`\n  Avg tokens injected (non-skip queries)`);
  console.log(`    v0.2.0:            ${fmt(v2AvgTok)} tokens   ${v2AvgTok < v1AvgTok ? "✓ WINNER" : ""}`);
  console.log(`    v0.1.0:            ${fmt(v1AvgTok)} tokens   ${v1AvgTok < v2AvgTok ? "✓ WINNER" : ""}`);
  console.log(`    no-memory:         0 tokens       (no context)`);

  console.log(`\n  Total tokens across all queries`);
  console.log(`    v0.2.0:            ${fmt(v2TotalTok)}`);
  console.log(`    v0.1.0:            ${fmt(v1TotalTok)}`);
  console.log(`    no-memory:         0`);
  console.log(`    v0.2 saves vs v0.1: ${fmt(v1TotalTok - v2TotalTok)} tokens (${((1 - v2TotalTok / v1TotalTok) * 100).toFixed(1)}%)`);

  console.log(`\n  Avg chunks injected (non-skip)`);
  console.log(`    v0.2.0:            ${v2AvgChunks} chunks`);
  console.log(`    v0.1.0:            ${v1AvgChunks} chunks`);

  console.log(`\n  Avg latency (non-skip queries)`);
  console.log(`    v0.2.0:            ${v2AvgLat}ms   ${v2AvgLat < v1AvgLat ? "✓ WINNER" : ""}`);
  console.log(`    v0.1.0:            ${v1AvgLat}ms   ${v1AvgLat < v2AvgLat ? "✓ WINNER" : ""}`);
  console.log(`    no-memory:         0ms            ✓ WINNER (trivially)`);

  console.log(`\n  Max token query`);
  console.log(`    v0.2.0:            ${fmt(v2MaxRow.v2Tokens)} tokens — "${v2MaxRow.query.slice(0, 50)}"`);
  console.log(`    v0.1.0:            ${fmt(v1MaxRow.v1Tokens)} tokens — "${v1MaxRow.query.slice(0, 50)}"`);

  console.log(`\n  v0.2.0 route distribution`);
  for (const [route, count] of Object.entries(routeCounts).sort()) {
    console.log(`    ${pad(route, 6)} ${count} queries`);
  }

  // Per-category token comparison
  const categories = [...new Set(rows.map(r => r.category))];
  console.log(`\n  Per-category avg tokens`);
  console.log(`    ${pad("Category", 16)} ${pad("v0.2", 10)} ${pad("v0.1", 10)} winner`);
  console.log(`    ${"-".repeat(48)}`);
  for (const cat of categories) {
    const catRows = rows.filter(r => r.category === cat);
    const cv2 = Math.round(avg(catRows.map(r => r.v2Tokens)));
    const cv1 = Math.round(avg(catRows.map(r => r.v1Tokens)));
    const w = cv2 === 0 && cv1 === 0 ? "tie" : cv2 <= cv1 ? "v0.2" : "v0.1";
    console.log(`    ${pad(cat, 16)} ${pad(fmt(cv2), 10)} ${pad(fmt(cv1), 10)} ${w}`);
  }

  console.log("\n" + "=".repeat(80));
  console.log("Winner Summary");
  console.log("=".repeat(80));
  const v2TokWins = rows.filter(r => r.v2Tokens < r.v1Tokens || (r.v2Tokens === 0 && r.v1Tokens > 0)).length;
  const v1TokWins = rows.filter(r => r.v1Tokens < r.v2Tokens).length;
  console.log(`  Token efficiency:    v0.2 wins ${v2TokWins}/${rows.length}, v0.1 wins ${v1TokWins}/${rows.length}`);
  console.log(`  Total token cost:    ${v2TotalTok < v1TotalTok ? "v0.2 ✓" : "v0.1 ✓"} (${fmt(Math.abs(v2TotalTok - v1TotalTok))} token difference)`);
  console.log(`  Avg latency:         ${v2AvgLat < v1AvgLat ? "v0.2 ✓" : v2AvgLat === v1AvgLat ? "tie" : "v0.1 ✓"}`);
  console.log(`  Skip intelligence:   v0.2 ✓ (skips ${skipped.length} trivial queries, v0.1 injects context for all)`);
  console.log(`  Speed (trivial):     no-memory ✓ (0ms, but no codebase context)`);
  console.log("");
}

main().catch((err) => { console.error(err); process.exit(1); });
