import { mkdirSync, readFileSync, rmSync } from "fs";
import { join, relative, resolve } from "path";
import { loadConfig } from "../../src/core/config.js";
import { IndexingPipeline } from "../../src/indexer/pipeline.js";
import { HybridSearch } from "../../src/search/hybrid.js";
import { sanitizeQuery } from "../../src/daemon/server.js";
import { classifyIntent } from "../../src/search/intent.js";
import { resolveSeeds } from "../../src/search/seed.js";
import { handlePromptContextDetailed } from "../../src/hooks/prompt-context.js";
import { computeAllMetrics, mean } from "./metrics.js";

interface ExternalAnnotationQuery {
  id: string;
  query: string;
  expectedRoute: string;
  relevance: Record<string, number>;
}

interface ExternalAnnotationSuite {
  id: string;
  corpus: string;
  projectRoot: string;
  queries: ExternalAnnotationQuery[];
}

interface ExternalAnnotationsFile {
  version: string;
  generatedAt: string;
  suites: ExternalAnnotationSuite[];
}

export interface ExternalQueryMetrics {
  suiteId: string;
  corpus: string;
  id: string;
  query: string;
  expectedRoute: string;
  actualRoute: string;
  routeMatch: boolean;
  ndcg10: number;
  mrr: number;
  averagePrecision: number;
  p5: number;
  p10: number;
  r5: number;
  r10: number;
  familyRecall5: number;
  familyRecall10: number;
  actionableHit: boolean;
  diversityScore: number;
  searchLatencyMs: number;
  retrievedFiles: string[];
}

export interface ExternalSuiteResults {
  suiteId: string;
  corpus: string;
  totalQueries: number;
  meanNDCG10: number;
  meanMRR: number;
  meanMAP: number;
  meanP5: number;
  meanP10: number;
  meanR5: number;
  meanR10: number;
  familyRecall5: number;
  familyRecall10: number;
  actionableHitRate: number;
  avgDiversityScore: number;
  routeAccuracy: number;
  avgLatencyMs: number;
  queries: ExternalQueryMetrics[];
}

export interface ExternalBenchmarkResults {
  version: string;
  suites: ExternalSuiteResults[];
}

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

function normalizeFixturePath(projectRoot: string, filePath: string): string {
  const normalized = filePath.replace(/^\.\//, "");
  return normalized.startsWith(projectRoot) ? relative(projectRoot, normalized) : normalized;
}

function lookupGrade(filePath: string, relevance: Record<string, number>): number {
  const normalized = filePath.replace(/^\.\//, "");
  if (normalized in relevance) return relevance[normalized] ?? 0;
  const suffix = Object.entries(relevance).find(([expected]) => normalized.endsWith(expected));
  return suffix?.[1] ?? 0;
}

function computeFamilyRecall(
  retrievedFiles: string[],
  relevance: Record<string, number>,
  k: number
): number {
  const relevantFiles = Object.entries(relevance)
    .filter(([, grade]) => grade >= 1)
    .map(([file]) => file);
  if (relevantFiles.length === 0) return 0;

  const topFiles = new Set(retrievedFiles.slice(0, k));
  const hits = relevantFiles.filter((file) => topFiles.has(file)).length;
  return hits / relevantFiles.length;
}

function detectWorkflowLayer(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (/(?:^|\/)(pages|components|screens|views|app)\//.test(lower)) return "ui";
  if (/(?:^|\/)(hooks|store|state|context|providers?|session)\//.test(lower)) return "state";
  if (/\b(route|router|callback|redirect|guard|middleware)\b/.test(lower)) return "routing";
  if (/(?:^|\/)(api|server|controllers?|handlers?|functions?|supabase|backend)\//.test(lower)) return "backend";
  if (/(?:^|\/)(lib|shared|core|utils?)\//.test(lower)) return "shared";
  return "core";
}

function computeDiversityScore(retrievedFiles: string[]): number {
  if (retrievedFiles.length === 0) return 0;
  const layers = new Set(retrievedFiles.slice(0, 8).map((filePath) => detectWorkflowLayer(filePath)));
  return Math.min(1, layers.size / Math.min(5, retrievedFiles.slice(0, 8).length));
}

function computeActionableHit(retrievedFiles: string[], relevance: Record<string, number>): boolean {
  const relevantFiles = Object.entries(relevance)
    .filter(([, grade]) => grade >= 2)
    .map(([file]) => file);
  if (relevantFiles.length === 0) return false;

  const topFiles = new Set(retrievedFiles.slice(0, 5));
  const hits = relevantFiles.filter((file) => topFiles.has(file)).length;
  return hits >= Math.min(3, relevantFiles.length) || hits / relevantFiles.length >= 0.6;
}

export async function runExternalBenchmark(
  mode: "keyword" | "semantic" = "keyword",
  fixturePath: string = join(process.cwd(), "benchmark", "external-queries.json")
): Promise<ExternalBenchmarkResults> {
  const annotations: ExternalAnnotationsFile = JSON.parse(readFileSync(fixturePath, "utf-8"));
  const suites: ExternalSuiteResults[] = [];

  for (const suite of annotations.suites) {
    const projectRoot = resolve(process.cwd(), suite.projectRoot);
    const dataDir = join(projectRoot, `.memory-external-benchmark-${Date.now()}`);
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
    const queryMetrics: ExternalQueryMetrics[] = [];

    for (const annotation of suite.queries) {
      const start = performance.now();
      const sanitized = sanitizeQuery(annotation.query);
      const queryText = sanitized || annotation.query;
      const intent = classifyIntent(queryText);
      const queryMode = intent.queryMode;

      const promptContext = await handlePromptContextDetailed(
        queryText,
        search,
        config,
        undefined,
        undefined,
        queryMode,
        metadata,
        fts
      );

      const uniqueFiles = Array.from(
        new Set(
          (promptContext.context?.chunks ?? [])
            .map((chunk) => normalizeFixturePath(projectRoot, chunk.filePath))
        )
      );
      const retrievedGrades = uniqueFiles.map((filePath) => lookupGrade(filePath, annotation.relevance));
      const idealGrades = Object.values(annotation.relevance)
        .filter((grade) => grade >= 1)
        .sort((a, b) => b - a);
      const metrics = computeAllMetrics(retrievedGrades, idealGrades);

      queryMetrics.push({
        suiteId: suite.id,
        corpus: suite.corpus,
        id: annotation.id,
        query: annotation.query,
        expectedRoute: annotation.expectedRoute,
        actualRoute: promptContext.resolvedQueryMode,
        routeMatch: promptContext.resolvedQueryMode === annotation.expectedRoute,
        ndcg10: metrics.ndcg10,
        mrr: metrics.mrr,
        averagePrecision: metrics.map,
        p5: metrics.p5,
        p10: metrics.p10,
        r5: metrics.r5,
        r10: metrics.r10,
        familyRecall5: computeFamilyRecall(uniqueFiles, annotation.relevance, 5),
        familyRecall10: computeFamilyRecall(uniqueFiles, annotation.relevance, 10),
        actionableHit: computeActionableHit(uniqueFiles, annotation.relevance),
        diversityScore: computeDiversityScore(uniqueFiles),
        searchLatencyMs: Math.round((performance.now() - start) * 100) / 100,
        retrievedFiles: uniqueFiles,
      });
    }

    pipeline.close();
    rmSync(dataDir, { recursive: true, force: true });

    suites.push({
      suiteId: suite.id,
      corpus: suite.corpus,
      totalQueries: queryMetrics.length,
      meanNDCG10: Math.round(mean(queryMetrics.map((query) => query.ndcg10)) * 1000) / 1000,
      meanMRR: Math.round(mean(queryMetrics.map((query) => query.mrr)) * 1000) / 1000,
      meanMAP: Math.round(mean(queryMetrics.map((query) => query.averagePrecision)) * 1000) / 1000,
      meanP5: Math.round(mean(queryMetrics.map((query) => query.p5)) * 1000) / 1000,
      meanP10: Math.round(mean(queryMetrics.map((query) => query.p10)) * 1000) / 1000,
      meanR5: Math.round(mean(queryMetrics.map((query) => query.r5)) * 1000) / 1000,
      meanR10: Math.round(mean(queryMetrics.map((query) => query.r10)) * 1000) / 1000,
      familyRecall5: Math.round(mean(queryMetrics.map((query) => query.familyRecall5)) * 1000) / 1000,
      familyRecall10: Math.round(mean(queryMetrics.map((query) => query.familyRecall10)) * 1000) / 1000,
      actionableHitRate: Math.round(mean(queryMetrics.map((query) => (query.actionableHit ? 1 : 0))) * 1000) / 1000,
      avgDiversityScore: Math.round(mean(queryMetrics.map((query) => query.diversityScore)) * 1000) / 1000,
      routeAccuracy: Math.round(mean(queryMetrics.map((query) => (query.routeMatch ? 1 : 0))) * 1000) / 1000,
      avgLatencyMs: Math.round(mean(queryMetrics.map((query) => query.searchLatencyMs)) * 100) / 100,
      queries: queryMetrics,
    });
  }

  return {
    version: annotations.version,
    suites,
  };
}

export function printExternalResults(results: ExternalBenchmarkResults): void {
  for (const suite of results.suites) {
    console.log(`\nExternal Broad-Workflow Eval: ${suite.corpus} (${suite.totalQueries} queries)`);
    console.log(
      `  NDCG@10 ${suite.meanNDCG10.toFixed(3)}  MRR ${suite.meanMRR.toFixed(3)}  MAP ${suite.meanMAP.toFixed(3)}`
    );
    console.log(
      `  Recall@5 ${suite.meanR5.toFixed(3)}  Recall@10 ${suite.meanR10.toFixed(3)}  Family@5 ${suite.familyRecall5.toFixed(3)}  Family@10 ${suite.familyRecall10.toFixed(3)}`
    );
    console.log(
      `  Actionable hit ${suite.actionableHitRate.toFixed(3)}  Diversity ${suite.avgDiversityScore.toFixed(3)}  Route accuracy ${suite.routeAccuracy.toFixed(3)}  Avg latency ${suite.avgLatencyMs}ms`
    );
  }
}
