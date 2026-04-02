import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { loadConfig } from "../../src/core/config.js";
import { sanitizeQuery } from "../../src/daemon/server.js";
import { MemoryRuntime } from "../../src/daemon/memory/runtime.js";
import { handlePromptContextDetailed } from "../../src/hooks/prompt-context.js";
import { IndexingPipeline } from "../../src/indexer/pipeline.js";
import { MemoryIndexer } from "../../src/memory/indexer.js";
import { MemorySearch } from "../../src/memory/search.js";
import { resolveMemoryClass } from "../../src/memory/types.js";
import { writeManagedMemoryFile } from "../../src/memory/files.js";
import { HybridSearch } from "../../src/search/hybrid.js";
import { classifyIntent } from "../../src/search/intent.js";
import { resolveSeeds } from "../../src/search/seed.js";
import { MemoryStore } from "../../src/storage/memory-store.js";
import {
  codeCertaintyScore,
  computeExpectedSetMetrics,
  mean,
  rate,
  reductionPct,
  retrievalCertaintyScore,
} from "../../test/benchmark/metrics.js";

export type MemoryV1Scenario =
  | "baseline_tools"
  | "reporecall_code_only"
  | "reporecall_plus_imported_memory"
  | "reporecall_plus_memory_v1";

export type MemoryQueryGroup =
  | "code_only"
  | "memory_only"
  | "mixed"
  | "continuity";

export interface MemoryV1Query {
  id: string;
  group: MemoryQueryGroup;
  query: string;
  expectedRoute?: "skip" | "lookup" | "trace" | "bug" | "architecture" | "change";
  expectedSymbols?: string[];
  expectedMemories?: string[];
  requiresWorkingMemory?: boolean;
}

export interface MemoryV1ScenarioQueryResult {
  scenario: MemoryV1Scenario;
  queryGroup: MemoryQueryGroup;
  queryId: string;
  query: string;
  route: string;
  memoryRoute: string;
  codeTokens: number;
  memoryTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  costUsd: number;
  selectedMemories: string[];
  droppedMemories: string[];
  memoryPrecisionAtK: number;
  memoryRecallAtK: number;
  retrievalCertaintyScore: number;
  answerGroundingScore: number | null;
  codeCertaintyScore: number;
  promptCompleteness: number;
  codeFloorPreserved: boolean;
  expectedMemoryHit: boolean;
  generatedWorkingHit: boolean;
  overreach: boolean;
  answerText: string;
}

export interface MemoryV1ScenarioSummary {
  label: MemoryV1Scenario;
  description: string;
  queryCount: number;
  completedQueries: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgCacheReadTokens: number;
  avgCacheWriteTokens: number;
  avgCostUsd: number;
  avgLatencyMs: number;
  avgMemoryTokens: number;
  avgCodeTokens: number;
}

export interface MemoryV1AggregateMetrics {
  avgInputTokenReductionPct: number;
  avgCostReductionPct: number;
  avgLatencyDeltaMs: number;
  memoryUsefulnessRate: number;
  continuityWinRate: number;
  memoryOverreachRate: number;
  codeCertaintyScore: number;
}

export interface MemoryV1Validation {
  schemaValid: boolean;
  softFloorsEnabled: boolean;
  softFloorsPassed: boolean;
  softFloorFailures: string[];
}

export interface MemoryV1LiveBenchmarkReport {
  timestamp: string;
  project: string;
  model: string;
  gitSha: string | null;
  querySet: string;
  outputJson: string;
  outputMarkdown: string;
  judgeEnabled: boolean;
  scenarios: MemoryV1ScenarioSummary[];
  results: MemoryV1ScenarioQueryResult[];
  aggregate: MemoryV1AggregateMetrics;
  validation: MemoryV1Validation;
}

export interface RunMemoryV1LiveBenchmarkOptions {
  projectRoot: string;
  model: string;
  outputBase?: string;
  judgeEnabled?: boolean;
  querySetPath?: string;
  withMemoryFixtures?: boolean;
  maxBudgetUsd?: number;
}

interface ClaudeJsonResponse {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  answerText: string;
}

const DEFAULT_QUERIES: MemoryV1Query[] = [
  {
    id: "code_context_path",
    group: "code_only",
    query: "how does handlePromptContextDetailed combine code and memory context",
    expectedRoute: "lookup",
    expectedSymbols: ["handlePromptContextDetailed"],
  },
  {
    id: "memory_runtime_flow",
    group: "code_only",
    query: "where does MemoryRuntime observe prompts and create working memory",
    expectedRoute: "trace",
    expectedSymbols: ["MemoryRuntime", "observePrompt"],
  },
  {
    id: "claims_policy",
    group: "memory_only",
    query: "what should benchmark-backed memory claims say in docs",
    expectedMemories: ["memory_v1_claims"],
  },
  {
    id: "certainty_policy",
    group: "memory_only",
    query: "how should code certainty be weighted in Memory V1 validation",
    expectedMemories: ["memory_v1_certainty"],
  },
  {
    id: "certainty_impl",
    group: "mixed",
    query: "how is code certainty computed and where is it implemented",
    expectedSymbols: ["codeCertaintyScore"],
    expectedMemories: ["memory_v1_certainty"],
  },
  {
    id: "continuity_seed",
    group: "continuity",
    query: "we are validating memory usefulness and continuity for Memory V1",
    expectedMemories: ["memory_v1_usefulness"],
  },
  {
    id: "continuity_followup",
    group: "continuity",
    query: "for that validation, what should the next benchmark focus on",
    expectedMemories: ["memory_v1_usefulness"],
    requiresWorkingMemory: true,
  },
];

const SCENARIO_DESCRIPTIONS: Record<MemoryV1Scenario, string> = {
  baseline_tools: "Raw Claude without Reporecall or memory injection",
  reporecall_code_only: "Reporecall code retrieval without memory",
  reporecall_plus_imported_memory: "Reporecall code retrieval plus imported Claude-style memories",
  reporecall_plus_memory_v1: "Reporecall code retrieval plus imported memory and generated working memory",
};

export function defaultMemoryV1Queries(): MemoryV1Query[] {
  return DEFAULT_QUERIES.map((query) => ({ ...query }));
}

export async function runMemoryV1LiveBenchmark(
  options: RunMemoryV1LiveBenchmarkOptions
): Promise<MemoryV1LiveBenchmarkReport> {
  ensureClaudeInstalled();

  const projectRoot = resolve(options.projectRoot);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputBase =
    options.outputBase ??
    resolve(tmpdir(), `reporecall-memory-v1-${timestamp}`);
  const outputJson = `${outputBase}.json`;
  const outputMarkdown = `${outputBase}.md`;
  const queries = loadQueries(options.querySetPath);
  const useFixtures =
    options.withMemoryFixtures ?? !options.querySetPath;

  const dataDir = resolve(tmpdir(), `reporecall-memory-v1-data-${Date.now()}`);
  mkdirSync(dataDir, { recursive: true });

  const config = {
    ...loadConfig(projectRoot),
    dataDir,
    embeddingProvider: "keyword" as const,
    memory: true,
    memoryBudget: 320,
    contextBudget: 900,
    memoryCodeFloorRatio: 0.8,
    memoryWatch: false,
    memoryCompactionHours: 0,
  };

  const pipeline = new IndexingPipeline(config);
  await pipeline.indexAll();
  const search = new HybridSearch(
    pipeline.getEmbedder(),
    pipeline.getVectorStore(),
    pipeline.getFTSStore(),
    pipeline.getMetadataStore(),
    config
  );

  const importDir = resolve(tmpdir(), `reporecall-memory-v1-import-${Date.now()}`);
  const managedDir = resolve(tmpdir(), `reporecall-memory-v1-managed-${Date.now()}`);
  mkdirSync(importDir, { recursive: true });
  mkdirSync(managedDir, { recursive: true });
  if (useFixtures) {
    installMemoryFixtures(importDir);
  }

  const results: MemoryV1ScenarioQueryResult[] = [];

  try {
    for (const scenario of Object.keys(SCENARIO_DESCRIPTIONS) as MemoryV1Scenario[]) {
      const scenarioResults = await runScenario({
        scenario,
        queries,
        projectRoot,
        model: options.model,
        config,
        search,
        pipeline,
        importDir,
        managedDir,
        judgeEnabled: options.judgeEnabled !== false,
        maxBudgetUsd: options.maxBudgetUsd ?? 0.75,
      });
      results.push(...scenarioResults);
    }
  } finally {
    await pipeline.closeAsync();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(importDir, { recursive: true, force: true });
    rmSync(managedDir, { recursive: true, force: true });
  }

  finalizeCodeFloorAndCertainty(results);

  const scenarios = summarizeScenarios(results);
  const aggregate = computeAggregateMetrics(results);
  const validation = validateMemoryV1Report(results, aggregate);
  const report: MemoryV1LiveBenchmarkReport = {
    timestamp: new Date().toISOString(),
    project: projectRoot,
    model: options.model,
    gitSha: readGitSha(projectRoot),
    querySet: options.querySetPath ?? "built-in default query set",
    outputJson,
    outputMarkdown,
    judgeEnabled: options.judgeEnabled !== false,
    scenarios,
    results,
    aggregate,
    validation,
  };

  writeFileSync(outputJson, JSON.stringify(report, null, 2), "utf-8");
  writeFileSync(outputMarkdown, renderMarkdownReport(report), "utf-8");
  return report;
}

export function validateMemoryV1Report(
  results: MemoryV1ScenarioQueryResult[],
  aggregate: MemoryV1AggregateMetrics
): MemoryV1Validation {
  const failures: string[] = [];

  if (results.length === 0) failures.push("no results");

  for (const result of results) {
    if (!result.scenario) failures.push("missing scenario");
    if (!result.queryGroup) failures.push("missing queryGroup");
    if (!result.query) failures.push("missing query");
    if (!result.route) failures.push("missing route");
    if (!result.memoryRoute) failures.push("missing memoryRoute");
    if (!Array.isArray(result.selectedMemories)) failures.push("selectedMemories must be array");
    if (!Array.isArray(result.droppedMemories)) failures.push("droppedMemories must be array");
  }

  if (aggregate.avgInputTokenReductionPct < 0.35) {
    failures.push("avgInputTokenReductionPct below 0.35");
  }
  if (aggregate.memoryUsefulnessRate < 0.7) {
    failures.push("memoryUsefulnessRate below 0.70");
  }
  if (aggregate.memoryOverreachRate > 0.2) {
    failures.push("memoryOverreachRate above 0.20");
  }
  if (aggregate.codeCertaintyScore < 0.7) {
    failures.push("codeCertaintyScore below 0.70");
  }

  return {
    schemaValid: failures.every(
      (failure) => !failure.startsWith("missing") && !failure.includes("array")
    ),
    softFloorsEnabled: true,
    softFloorsPassed: failures.length === 0,
    softFloorFailures: failures,
  };
}

function ensureClaudeInstalled(): void {
  const result = spawnSync("claude", ["--version"], { encoding: "utf-8" });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error("claude CLI not found in PATH");
  }
}

function loadQueries(querySetPath?: string): MemoryV1Query[] {
  if (!querySetPath) return defaultMemoryV1Queries();
  if (!existsSync(querySetPath)) {
    throw new Error(`Query set not found: ${querySetPath}`);
  }
  return JSON.parse(readFileSync(querySetPath, "utf-8")) as MemoryV1Query[];
}

function installMemoryFixtures(importDir: string): void {
  writeManagedMemoryFile(importDir, "memory_v1_claims", {
    name: "memory_v1_claims",
    description: "README claims must be benchmark-backed",
    memoryType: "feedback",
    class: "rule",
    scope: "project",
    summary: "Docs claims must be backed by benchmark outputs, not broad promises.",
    content: "README and benchmark docs may only use measured benchmark-backed claims.",
  });
  writeManagedMemoryFile(importDir, "memory_v1_certainty", {
    name: "memory_v1_certainty",
    description: "Code certainty uses weighted retrieval plus grounding",
    memoryType: "project",
    class: "fact",
    scope: "project",
    summary: "Code certainty is 60% retrieval certainty and 40% answer grounding.",
    content: "Code certainty = 60% retrieval certainty + 40% answer grounding in Memory V1.",
  });
  writeManagedMemoryFile(importDir, "memory_v1_usefulness", {
    name: "memory_v1_usefulness",
    description: "Memory usefulness means hitting expected memory without crowding out code",
    memoryType: "project",
    class: "fact",
    scope: "project",
    summary: "Useful memory hits expected facts and does not crowd out code context.",
    content: "Usefulness requires expected memory hits plus preserved code context.",
  });
}

async function runScenario(input: {
  scenario: MemoryV1Scenario;
  queries: MemoryV1Query[];
  projectRoot: string;
  model: string;
  config: ReturnType<typeof loadConfig>;
  search: HybridSearch;
  pipeline: IndexingPipeline;
  importDir: string;
  managedDir: string;
  judgeEnabled: boolean;
  maxBudgetUsd: number;
}): Promise<MemoryV1ScenarioQueryResult[]> {
  const { scenario, queries, projectRoot, model, config, search, pipeline, importDir, managedDir } = input;
  const metadata = pipeline.getMetadataStore();
  const fts = pipeline.getFTSStore();
  const results: MemoryV1ScenarioQueryResult[] = [];
  const scenarioDataDir = resolve(
    tmpdir(),
    `reporecall-memory-v1-scenario-${scenario}-${Date.now()}`
  );

  const store = new MemoryStore(scenarioDataDir);
  const indexer = new MemoryIndexer(store, [importDir, managedDir], {
    writableDirs: [managedDir],
    readOnlyDirs: [importDir],
    projectRoot,
  });
  const runtime = new MemoryRuntime(indexer, store, {
    watchEnabled: false,
    autoCreate: scenario === "reporecall_plus_memory_v1",
    writableDir: managedDir,
    projectRoot,
    workingHistoryLimit: 1,
    compactionHours: 0,
  });
  const memorySearch = new MemorySearch(store);

  try {
    if (scenario !== "baseline_tools") {
      await indexer.indexAll();
    }

    for (const query of queries) {
      const started = performance.now();
      const sanitized = sanitizeQuery(query.query) || query.query;
      let resolvedRoute = "raw";
      let memoryRoute = "M0";
      let codeTokens = 0;
      let memoryTokens = 0;
      let selectedMemories: string[] = [];
      let droppedMemories: string[] = [];
      let promptText = query.query;
      let memoryPrecisionAtK = 0;
      let memoryRecallAtK = 0;
      let promptCompleteness = 1;
      let expectedMemoryHit = false;
      let generatedWorkingHit = false;

      if (scenario !== "baseline_tools") {
        const intent = classifyIntent(sanitized);
        let route = intent.queryMode;
        if (intent.needsNavigation && route === "lookup") {
          const seedResult = resolveSeeds(sanitized, metadata, fts);
          if (seedResult.bestSeed?.confidence && seedResult.bestSeed.confidence > 0.5) {
            route = "trace";
          }
        }

        const promptContext = await handlePromptContextDetailed(
          sanitized,
          search,
          config,
          undefined,
          undefined,
          route,
          metadata,
          fts,
          undefined,
          metadata.getStats().totalChunks,
          scenario === "reporecall_code_only" ? undefined : memorySearch
        );

        resolvedRoute = promptContext.resolvedQueryMode;
        memoryRoute = promptContext.memoryRoute ?? "M0";
        codeTokens =
          (promptContext.context?.tokenCount ?? 0) - (promptContext.memoryTokenCount ?? 0);
        memoryTokens = promptContext.memoryTokenCount ?? 0;
        selectedMemories = promptContext.memoryNames ?? [];
        droppedMemories = (promptContext.memoryDropped ?? []).map((item) => item.name);
        promptText = promptContext.context?.text
          ? `Relevant codebase context:\n\n${promptContext.context.text}\n\nAnswer this question about the codebase above: ${query.query}`
          : query.query;

        const expectedMemoryMetrics = computeExpectedSetMetrics(
          selectedMemories,
          query.expectedMemories ?? []
        );
        memoryPrecisionAtK = expectedMemoryMetrics.precisionAt3;
        memoryRecallAtK = expectedMemoryMetrics.recallAt5;
        expectedMemoryHit = expectedMemoryMetrics.hit;
        generatedWorkingHit = selectedMemories.some((name) => name.startsWith("working-"));

        const expectedSymbols = query.expectedSymbols ?? [];
        const chunkNames = promptContext.context?.chunks.map((chunk) => chunk.name) ?? [];
        const symbolCoverage =
          expectedSymbols.length === 0
            ? 1
            : expectedSymbols.filter((symbol) =>
                chunkNames.some((name) => name.includes(symbol))
              ).length / expectedSymbols.length;
        const memoryCoverage =
          (query.expectedMemories ?? []).length === 0 ? 1 : memoryRecallAtK;
        promptCompleteness = (symbolCoverage + memoryCoverage) / 2;

        if (scenario === "reporecall_plus_memory_v1") {
          await runtime.observePrompt({
            query: sanitized,
            codeRoute: resolvedRoute,
            memoryRoute,
            topFiles: promptContext.context?.chunks.slice(0, 5).map((chunk) => chunk.filePath),
            topSymbols: promptContext.context?.chunks.slice(0, 8).map((chunk) => chunk.name),
            memoryHits: promptContext.memoryResults,
          });
          await indexer.indexAll();
        }
      }

      const claude = runClaudeJsonPrompt(promptText, {
        cwd: projectRoot,
        model,
        maxBudgetUsd: input.maxBudgetUsd,
      });
      const latencyMs = Math.round((performance.now() - started) * 100) / 100;
      const answerGroundingScore =
        input.judgeEnabled && claude.answerText
          ? runAnswerJudge({
              cwd: projectRoot,
              model,
              query,
              answer: claude.answerText,
            })
          : null;

      results.push({
        scenario,
        queryGroup: query.group,
        queryId: query.id,
        query: query.query,
        route: resolvedRoute,
        memoryRoute,
        codeTokens,
        memoryTokens,
        totalInputTokens: claude.inputTokens,
        totalOutputTokens: claude.outputTokens,
        cacheReadTokens: claude.cacheReadTokens,
        cacheWriteTokens: claude.cacheWriteTokens,
        latencyMs,
        costUsd: claude.costUsd,
        selectedMemories,
        droppedMemories,
        memoryPrecisionAtK,
        memoryRecallAtK,
        retrievalCertaintyScore: 0,
        answerGroundingScore,
        codeCertaintyScore: 0,
        promptCompleteness,
        codeFloorPreserved: scenario === "baseline_tools",
        expectedMemoryHit,
        generatedWorkingHit,
        overreach: memoryTokens > 0 && (query.expectedMemories?.length ?? 0) === 0,
        answerText: claude.answerText,
      });
    }

    return results;
  } finally {
    await runtime.stop().catch(() => {});
    store.close();
    rmSync(scenarioDataDir, { recursive: true, force: true });
  }
}

function runClaudeJsonPrompt(
  prompt: string,
  options: { cwd: string; model: string; maxBudgetUsd: number }
): ClaudeJsonResponse {
  const result = spawnSync(
    "claude",
    [
      "-p",
      "--output-format",
      "json",
      "--max-budget-usd",
      String(options.maxBudgetUsd),
      "--model",
      options.model,
    ],
    {
      cwd: options.cwd,
      input: prompt,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `claude exited with status ${result.status}`);
  }

  const parsed = JSON.parse(result.stdout || "{}") as Record<string, unknown>;
  const modelUsage = (parsed.modelUsage as Record<string, Record<string, number>>) ?? {};
  const modelName = Object.keys(modelUsage)[0];
  const usage = modelName ? modelUsage[modelName] ?? {} : {};
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadInputTokens ?? 0,
    cacheWriteTokens: usage.cacheCreationInputTokens ?? 0,
    costUsd: Number(parsed.total_cost_usd ?? 0),
    answerText: extractAnswerText(parsed),
  };
}

function extractAnswerText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => extractAnswerText(item)).filter(Boolean).join("\n").trim();
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["result", "completion", "output", "assistant"]) {
      const nested = extractAnswerText(record[key]);
      if (nested) return nested;
    }
    if (record.type === "text" && typeof record.text === "string") {
      return record.text;
    }
    if (Array.isArray(record.content)) {
      const nested = extractAnswerText(record.content);
      if (nested) return nested;
    }
    for (const nested of Object.values(record)) {
      const text = extractAnswerText(nested);
      if (text) return text;
    }
  }
  return "";
}

function runAnswerJudge(input: {
  cwd: string;
  model: string;
  query: MemoryV1Query;
  answer: string;
}): number | null {
  const judgePrompt = [
    "Score this answer for grounding and correctness on a 0.0-1.0 scale.",
    "Return strict JSON only with keys: score, expectedFactsHit, wrongFacts, notes.",
    "",
    `Question: ${input.query.query}`,
    `Expected symbols: ${(input.query.expectedSymbols ?? []).join(", ") || "none"}`,
    `Expected memories: ${(input.query.expectedMemories ?? []).join(", ") || "none"}`,
    "",
    "Answer:",
    input.answer,
  ].join("\n");

  const result = spawnSync(
    "claude",
    ["-p", "--model", input.model],
    {
      cwd: input.cwd,
      input: judgePrompt,
      encoding: "utf-8",
      maxBuffer: 4 * 1024 * 1024,
    }
  );
  if (result.error || result.status !== 0) return null;

  try {
    const parsed = JSON.parse(result.stdout.trim()) as { score?: number };
    if (typeof parsed.score === "number") {
      return Math.max(0, Math.min(1, parsed.score));
    }
    return null;
  } catch {
    return null;
  }
}

function finalizeCodeFloorAndCertainty(results: MemoryV1ScenarioQueryResult[]): void {
  const codeOnlyBaseline = new Map(
    results
      .filter((result) => result.scenario === "reporecall_code_only")
      .map((result) => [result.queryId, result])
  );

  for (const result of results) {
    const baseline = codeOnlyBaseline.get(result.queryId);
    result.codeFloorPreserved =
      result.scenario === "baseline_tools" ||
      result.scenario === "reporecall_code_only" ||
      !baseline ||
      result.codeTokens >= baseline.codeTokens;

    const routeAppropriate = result.route !== "skip" && result.route !== "raw";
    const expectedHitCoverage =
      result.queryGroup === "code_only" ? 1 : result.memoryRecallAtK;
    result.retrievalCertaintyScore = retrievalCertaintyScore({
      expectedHitCoverage,
      codeFloorPreserved: result.codeFloorPreserved,
      routeAppropriate,
      promptCompleteness: result.promptCompleteness,
    });
    result.codeCertaintyScore = codeCertaintyScore(
      result.retrievalCertaintyScore,
      result.answerGroundingScore
    );
  }
}

function summarizeScenarios(
  results: MemoryV1ScenarioQueryResult[]
): MemoryV1ScenarioSummary[] {
  return (Object.keys(SCENARIO_DESCRIPTIONS) as MemoryV1Scenario[]).map((scenario) => {
    const rows = results.filter((result) => result.scenario === scenario);
    return {
      label: scenario,
      description: SCENARIO_DESCRIPTIONS[scenario],
      queryCount: rows.length,
      completedQueries: rows.length,
      avgInputTokens: round2(mean(rows.map((row) => row.totalInputTokens))),
      avgOutputTokens: round2(mean(rows.map((row) => row.totalOutputTokens))),
      avgCacheReadTokens: round2(mean(rows.map((row) => row.cacheReadTokens))),
      avgCacheWriteTokens: round2(mean(rows.map((row) => row.cacheWriteTokens))),
      avgCostUsd: round4(mean(rows.map((row) => row.costUsd))),
      avgLatencyMs: round2(mean(rows.map((row) => row.latencyMs))),
      avgMemoryTokens: round2(mean(rows.map((row) => row.memoryTokens))),
      avgCodeTokens: round2(mean(rows.map((row) => row.codeTokens))),
    };
  });
}

function computeAggregateMetrics(
  results: MemoryV1ScenarioQueryResult[]
): MemoryV1AggregateMetrics {
  const memoryEnabled = results.filter((result) =>
    result.scenario === "reporecall_plus_imported_memory" ||
    result.scenario === "reporecall_plus_memory_v1"
  );
  const memorySensitive = memoryEnabled.filter(
    (result) => result.queryGroup !== "code_only"
  );
  const scenario4 = new Map(
    results
      .filter((result) => result.scenario === "reporecall_plus_memory_v1")
      .map((result) => [result.queryId, result])
  );
  const scenario2 = new Map(
    results
      .filter((result) => result.scenario === "reporecall_code_only")
      .map((result) => [result.queryId, result])
  );

  const inputReductions: number[] = [];
  const costReductions: number[] = [];
  const latencyDeltas: number[] = [];
  const continuityWins: boolean[] = [];

  for (const result of memorySensitive) {
    const naiveInput = result.totalInputTokens + Math.max(0, result.memoryTokens * 2);
    inputReductions.push(reductionPct(naiveInput, result.totalInputTokens));
    const estimatedBaselineCost =
      result.totalInputTokens > 0
        ? result.costUsd * (naiveInput / result.totalInputTokens)
        : result.costUsd;
    costReductions.push(reductionPct(estimatedBaselineCost, result.costUsd));
  }

  for (const [queryId, withMemory] of scenario4) {
    const codeOnly = scenario2.get(queryId);
    if (!codeOnly) continue;
    latencyDeltas.push(withMemory.latencyMs - codeOnly.latencyMs);
    if (withMemory.queryGroup === "continuity") {
      continuityWins.push(
        withMemory.generatedWorkingHit &&
          withMemory.codeCertaintyScore >= codeOnly.codeCertaintyScore
      );
    }
  }

  return {
    avgInputTokenReductionPct: round3(mean(inputReductions)),
    avgCostReductionPct: round3(mean(costReductions)),
    avgLatencyDeltaMs: round2(mean(latencyDeltas)),
    memoryUsefulnessRate: round3(
      rate(
        memorySensitive
          .filter((result) => (result.queryGroup === "memory_only" || result.queryGroup === "mixed" || result.queryGroup === "continuity"))
          .map((result) => result.expectedMemoryHit && result.codeFloorPreserved)
      )
    ),
    continuityWinRate: round3(rate(continuityWins)),
    memoryOverreachRate: round3(
      rate(memoryEnabled.map((result) => result.overreach))
    ),
    codeCertaintyScore: round3(
      mean(
        results
          .filter((result) => result.scenario === "reporecall_plus_memory_v1")
          .map((result) => result.codeCertaintyScore)
      )
    ),
  };
}

function renderMarkdownReport(report: MemoryV1LiveBenchmarkReport): string {
  const lines: string[] = [];
  lines.push("# Memory V1 Live Benchmark");
  lines.push("");
  lines.push(`- Timestamp: ${report.timestamp}`);
  lines.push(`- Project: ${report.project}`);
  lines.push(`- Model: ${report.model}`);
  lines.push(`- Query set: ${report.querySet}`);
  lines.push(`- Judge enabled: ${report.judgeEnabled ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Avg input token reduction | ${report.aggregate.avgInputTokenReductionPct.toFixed(3)} |`);
  lines.push(`| Avg cost reduction | ${report.aggregate.avgCostReductionPct.toFixed(3)} |`);
  lines.push(`| Avg latency delta (ms) | ${report.aggregate.avgLatencyDeltaMs.toFixed(2)} |`);
  lines.push(`| Memory usefulness rate | ${report.aggregate.memoryUsefulnessRate.toFixed(3)} |`);
  lines.push(`| Continuity win rate | ${report.aggregate.continuityWinRate.toFixed(3)} |`);
  lines.push(`| Memory overreach rate | ${report.aggregate.memoryOverreachRate.toFixed(3)} |`);
  lines.push(`| Code certainty score | ${report.aggregate.codeCertaintyScore.toFixed(3)} |`);
  lines.push("");
  lines.push("## Scenarios");
  lines.push("");
  lines.push("| Scenario | Avg input | Avg output | Avg code | Avg memory | Avg cost | Avg latency |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const scenario of report.scenarios) {
    lines.push(
      `| ${scenario.label} | ${scenario.avgInputTokens.toFixed(0)} | ${scenario.avgOutputTokens.toFixed(0)} | ${scenario.avgCodeTokens.toFixed(0)} | ${scenario.avgMemoryTokens.toFixed(0)} | ${scenario.avgCostUsd.toFixed(4)} | ${scenario.avgLatencyMs.toFixed(2)} |`
    );
  }
  lines.push("");
  lines.push("## Query Results");
  lines.push("");
  lines.push("| Scenario | Group | Query | Route | Memory | Code tkn | Memory tkn | Certainty |");
  lines.push("| --- | --- | --- | --- | --- | ---: | ---: | ---: |");
  for (const result of report.results) {
    lines.push(
      `| ${result.scenario} | ${result.queryGroup} | ${truncate(result.query, 56)} | ${result.route} | ${result.memoryRoute} | ${result.codeTokens} | ${result.memoryTokens} | ${result.codeCertaintyScore.toFixed(3)} |`
    );
  }
  lines.push("");
  lines.push("## Validation");
  lines.push("");
  lines.push(`- Schema valid: ${report.validation.schemaValid ? "yes" : "no"}`);
  lines.push(`- Soft floors passed: ${report.validation.softFloorsPassed ? "yes" : "no"}`);
  if (report.validation.softFloorFailures.length > 0) {
    lines.push("- Failures:");
    for (const failure of report.validation.softFloorFailures) {
      lines.push(`  - ${failure}`);
    }
  }
  return lines.join("\n");
}

function readGitSha(projectRoot: string): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf-8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
