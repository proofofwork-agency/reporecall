import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import type { MemoryConfig } from "../../src/core/config.js";
import { IndexingPipeline } from "../../src/indexer/pipeline.js";
import { HybridSearch } from "../../src/search/hybrid.js";
import {
  generateSmallCodebase,
  generateMediumCodebase,
  generateLargeCodebase,
} from "./codebases.js";
import { promptsBySize, type BenchmarkPrompt } from "./prompts.js";

// ─── Types ───

export type CodebaseSize = "small" | "medium" | "large";
export type Mode = "baseline" | "keyword" | "semantic";

export interface ModeMetrics {
  mode: Mode;
  indexTimeMs: number;
  filesProcessed: number;
  chunksCreated: number;
  queries: QueryMetrics[];
  avgSearchLatencyMs: number;
  p50SearchLatencyMs: number;
  p95SearchLatencyMs: number;
  avgResultsFound: number;
  top1Accuracy: number;
  top5Recall: number;
  avgContextTokens: number;
  avgContextChunks: number;
  avgBudgetUtilization: number;
}

export interface QueryMetrics {
  query: string;
  category: string;
  searchLatencyMs: number;
  resultsFound: number;
  top1Hit: boolean;
  top5Hits: number;
  top5Expected: number;
  contextTokens: number;
  contextChunks: number;
  budgetUtilization: number;
}

export interface BenchmarkResults {
  size: CodebaseSize;
  fileCount: number;
  approxLoc: number;
  modes: ModeMetrics[];
}

// ─── Helpers ───

function makeConfig(
  projectRoot: string,
  dataDir: string,
  provider: MemoryConfig["embeddingProvider"]
): MemoryConfig {
  return {
    projectRoot,
    dataDir,
    embeddingProvider: provider,
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    embeddingDimensions: provider === "keyword" ? 384 : 384,
    ollamaUrl: "http://localhost:11434",
    extensions: [
      ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java",
      ".c", ".cpp", ".h", ".hpp", ".rb", ".swift", ".kt", ".scala",
      ".vue", ".svelte", ".css", ".scss", ".sql", ".sh", ".bash",
      ".yaml", ".yml", ".toml", ".json", ".md",
    ],
    ignorePatterns: [
      "node_modules", ".git", ".memory", "dist", "build", "target",
      "__pycache__", ".next", ".nuxt", "vendor", "coverage",
      "*.min.js", "*.min.css", "*.map", "*.lock", "package-lock.json",
    ],
    maxFileSize: 100 * 1024,
    batchSize: 32,
    contextBudget: 4000,
    maxContextChunks: 5,
    sessionBudget: 2000,
    searchWeights: { vector: 0.5, keyword: 0.3, recency: 0.2 },
    rrfK: 60,
    graphExpansion: true,
    graphDiscountFactor: 0.6,
    siblingExpansion: true,
    siblingDiscountFactor: 0.4,
    reranking: false,
    rerankingModel: "Xenova/ms-marco-MiniLM-L-6-v2",
    rerankTopK: 25,
    codeBoostFactor: 1.5,
    testPenaltyFactor: 0.3,
    anonymousPenaltyFactor: 0.5,
    debounceMs: 2000,
    port: 37222,
    implementationPaths: ["src/", "lib/", "bin/"],
    factExtractors: [],
  };
}

const generators = {
  small: generateSmallCodebase,
  medium: generateMediumCodebase,
  large: generateLargeCodebase,
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function evaluateResults(
  resultNames: string[],
  expected: string[]
): { top1Hit: boolean; top5Hits: number } {
  const top1Hit = expected.some((e) =>
    resultNames[0]?.toLowerCase().includes(e.toLowerCase())
  );
  const top5 = resultNames.slice(0, 5);
  const top5Hits = expected.filter((e) =>
    top5.some((r) => r.toLowerCase().includes(e.toLowerCase()))
  ).length;
  return { top1Hit, top5Hits };
}

// ─── Benchmark runner for a single mode ───

async function benchmarkMode(
  mode: Mode,
  codebaseDir: string,
  prompts: BenchmarkPrompt[]
): Promise<ModeMetrics> {
  // Baseline mode: no memory, return zeros
  if (mode === "baseline") {
    return {
      mode: "baseline",
      indexTimeMs: 0,
      filesProcessed: 0,
      chunksCreated: 0,
      queries: prompts.map((p) => ({
        query: p.query,
        category: p.category,
        searchLatencyMs: 0,
        resultsFound: 0,
        top1Hit: false,
        top5Hits: 0,
        top5Expected: p.expectedChunks.length,
        contextTokens: 0,
        contextChunks: 0,
        budgetUtilization: 0,
      })),
      avgSearchLatencyMs: 0,
      p50SearchLatencyMs: 0,
      p95SearchLatencyMs: 0,
      avgResultsFound: 0,
      top1Accuracy: 0,
      top5Recall: 0,
      avgContextTokens: 0,
      avgContextChunks: 0,
      avgBudgetUtilization: 0,
    };
  }

  const provider = mode === "keyword" ? "keyword" : "local";
  const dataDir = join(codebaseDir, `.memory-${mode}`);
  mkdirSync(dataDir, { recursive: true });

  const config = makeConfig(codebaseDir, dataDir, provider);

  // Index
  const indexStart = performance.now();
  const pipeline = new IndexingPipeline(config);
  const indexResult = await pipeline.indexAll();
  const indexTimeMs = Math.round(performance.now() - indexStart);

  // Set up search
  const search = new HybridSearch(
    pipeline.getEmbedder(),
    pipeline.getVectorStore(),
    pipeline.getFTSStore(),
    pipeline.getMetadataStore(),
    config
  );

  // Run queries
  const queryMetrics: QueryMetrics[] = [];
  const TOKEN_BUDGET = config.contextBudget;

  for (const prompt of prompts) {
    const searchStart = performance.now();
    const context = await search.searchWithContext(prompt.query, TOKEN_BUDGET);
    const searchLatencyMs = Math.round((performance.now() - searchStart) * 100) / 100;

    const resultNames = context.chunks.map((r) => r.name);
    const { top1Hit, top5Hits } = evaluateResults(resultNames, prompt.expectedChunks);

    queryMetrics.push({
      query: prompt.query,
      category: prompt.category,
      searchLatencyMs,
      resultsFound: context.chunks.length,
      top1Hit,
      top5Hits,
      top5Expected: prompt.expectedChunks.length,
      contextTokens: context.tokenCount,
      contextChunks: context.chunks.length,
      budgetUtilization:
        Math.round((context.tokenCount / TOKEN_BUDGET) * 10000) / 100,
    });
  }

  pipeline.close();

  // Aggregate
  const latencies = queryMetrics
    .map((q) => q.searchLatencyMs)
    .sort((a, b) => a - b);
  const totalQueries = queryMetrics.length;

  return {
    mode,
    indexTimeMs,
    filesProcessed: indexResult.filesProcessed,
    chunksCreated: indexResult.chunksCreated,
    queries: queryMetrics,
    avgSearchLatencyMs:
      Math.round(
        (latencies.reduce((s, v) => s + v, 0) / totalQueries) * 100
      ) / 100,
    p50SearchLatencyMs: percentile(latencies, 50),
    p95SearchLatencyMs: percentile(latencies, 95),
    avgResultsFound:
      Math.round(
        (queryMetrics.reduce((s, q) => s + q.resultsFound, 0) / totalQueries) *
          100
      ) / 100,
    top1Accuracy:
      Math.round(
        (queryMetrics.filter((q) => q.top1Hit).length / totalQueries) * 10000
      ) / 100,
    top5Recall:
      Math.round(
        (queryMetrics.reduce((s, q) => s + q.top5Hits / q.top5Expected, 0) /
          totalQueries) *
          10000
      ) / 100,
    avgContextTokens: Math.round(
      queryMetrics.reduce((s, q) => s + q.contextTokens, 0) / totalQueries
    ),
    avgContextChunks:
      Math.round(
        (queryMetrics.reduce((s, q) => s + q.contextChunks, 0) /
          totalQueries) *
          100
      ) / 100,
    avgBudgetUtilization:
      Math.round(
        (queryMetrics.reduce((s, q) => s + q.budgetUtilization, 0) /
          totalQueries) *
          100
      ) / 100,
  };
}

// ─── Main benchmark ───

export async function runBenchmark(
  size: CodebaseSize,
  baseDir: string
): Promise<BenchmarkResults> {
  const codebaseDir = join(baseDir, "codebase");
  mkdirSync(codebaseDir, { recursive: true });

  const gen = generators[size];
  const codebase = gen(codebaseDir);
  const prompts = promptsBySize[size];

  const modes: ModeMetrics[] = [];
  for (const mode of ["baseline", "keyword", "semantic"] as const) {
    console.log(`  [${size}] Running ${mode} mode...`);
    const metrics = await benchmarkMode(mode, codebaseDir, prompts);
    modes.push(metrics);
  }

  return {
    size,
    fileCount: codebase.fileCount,
    approxLoc: codebase.approxLoc,
    modes,
  };
}

// ─── Output formatting ───

function pad(s: string, len: number, align: "left" | "right" = "left"): string {
  if (align === "right") return s.padStart(len);
  return s.padEnd(len);
}

function formatRow(cells: string[], widths: number[]): string {
  return (
    "║ " +
    cells.map((c, i) => pad(c, widths[i])).join(" │ ") +
    " ║"
  );
}

function formatSeparator(widths: number[], style: "top" | "mid" | "bot" | "inner"): string {
  const chars = {
    top: { left: "╔", mid: "╦", right: "╗", fill: "═" },
    mid: { left: "╠", mid: "╬", right: "╣", fill: "═" },
    bot: { left: "╚", mid: "╩", right: "╝", fill: "═" },
    inner: { left: "╠", mid: "┼", right: "╣", fill: "─" },
  }[style];

  return (
    chars.left +
    widths.map((w) => chars.fill.repeat(w + 2)).join(chars.mid) +
    chars.right
  );
}

export function printResults(allResults: BenchmarkResults[]): void {
  console.log("\n");

  for (const result of allResults) {
    const widths = [22, 10, 14, 14];
    const baseline = result.modes.find((m) => m.mode === "baseline")!;
    const keyword = result.modes.find((m) => m.mode === "keyword")!;
    const semantic = result.modes.find((m) => m.mode === "semantic")!;

    console.log(
      formatSeparator(widths, "top")
    );
    const title = `MODE COMPARISON: ${result.size} (${result.fileCount} files, ~${result.approxLoc} LOC)`;
    const totalWidth = widths.reduce((s, w) => s + w, 0) + widths.length * 3 + 1;
    console.log(
      "║ " + pad(title, totalWidth - 4) + " ║"
    );
    console.log(formatSeparator(widths, "mid"));
    console.log(formatRow(["Metric", "Baseline", "Keyword", "Semantic"], widths));
    console.log(formatSeparator(widths, "inner"));

    const rows: [string, string, string, string][] = [
      [
        "Index time",
        "N/A",
        `${keyword.indexTimeMs}ms`,
        `${semantic.indexTimeMs}ms`,
      ],
      [
        "Chunks created",
        "0",
        String(keyword.chunksCreated),
        String(semantic.chunksCreated),
      ],
      [
        "Avg search latency",
        "N/A",
        `${keyword.avgSearchLatencyMs}ms`,
        `${semantic.avgSearchLatencyMs}ms`,
      ],
      [
        "P50 search latency",
        "N/A",
        `${keyword.p50SearchLatencyMs}ms`,
        `${semantic.p50SearchLatencyMs}ms`,
      ],
      [
        "P95 search latency",
        "N/A",
        `${keyword.p95SearchLatencyMs}ms`,
        `${semantic.p95SearchLatencyMs}ms`,
      ],
      [
        "Avg results found",
        "0",
        String(keyword.avgResultsFound),
        String(semantic.avgResultsFound),
      ],
      [
        "Top-1 accuracy",
        "0%",
        `${keyword.top1Accuracy}%`,
        `${semantic.top1Accuracy}%`,
      ],
      [
        "Top-5 recall",
        "0%",
        `${keyword.top5Recall}%`,
        `${semantic.top5Recall}%`,
      ],
      [
        "Avg context tokens",
        "0",
        String(keyword.avgContextTokens),
        String(semantic.avgContextTokens),
      ],
      [
        "Avg context chunks",
        "0",
        String(keyword.avgContextChunks),
        String(semantic.avgContextChunks),
      ],
      [
        "Budget utilization",
        "0%",
        `${keyword.avgBudgetUtilization}%`,
        `${semantic.avgBudgetUtilization}%`,
      ],
    ];

    for (const row of rows) {
      console.log(formatRow(row, widths));
    }

    console.log(formatSeparator(widths, "bot"));

    // Per-category breakdown
    console.log(`\n  Per-category Top-5 recall (${result.size}):`);
    const categories = [
      "exact",
      "concept",
      "cross-cutting",
      "debugging",
      "architecture",
      "refactoring",
    ];
    for (const cat of categories) {
      const kwQueries = keyword.queries.filter((q) => q.category === cat);
      const semQueries = semantic.queries.filter((q) => q.category === cat);
      if (kwQueries.length === 0) continue;

      const kwRecall =
        Math.round(
          (kwQueries.reduce((s, q) => s + q.top5Hits / q.top5Expected, 0) /
            kwQueries.length) *
            10000
        ) / 100;
      const semRecall =
        Math.round(
          (semQueries.reduce((s, q) => s + q.top5Hits / q.top5Expected, 0) /
            semQueries.length) *
            10000
        ) / 100;

      console.log(
        `    ${pad(cat, 15)} Keyword: ${pad(kwRecall + "%", 8)} Semantic: ${semRecall}%`
      );
    }
    console.log("");
  }
}

export function resultsToJson(
  allResults: BenchmarkResults[]
): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    results: allResults.map((r) => ({
      size: r.size,
      fileCount: r.fileCount,
      approxLoc: r.approxLoc,
      modes: r.modes.map((m) => ({
        mode: m.mode,
        indexTimeMs: m.indexTimeMs,
        chunksCreated: m.chunksCreated,
        avgSearchLatencyMs: m.avgSearchLatencyMs,
        p50SearchLatencyMs: m.p50SearchLatencyMs,
        p95SearchLatencyMs: m.p95SearchLatencyMs,
        avgResultsFound: m.avgResultsFound,
        top1Accuracy: m.top1Accuracy,
        top5Recall: m.top5Recall,
        avgContextTokens: m.avgContextTokens,
        avgContextChunks: m.avgContextChunks,
        avgBudgetUtilization: m.avgBudgetUtilization,
        queries: m.queries,
      })),
    })),
  };
}
