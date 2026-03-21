import { describe, expect, it } from "vitest";
import { existsSync } from "fs";
import { resolve } from "path";
import { validateMemoryV1Report, type MemoryV1LiveBenchmarkReport } from "../../scripts/benchmarks/memory-v1-live-lib.js";

const shouldRunLive =
  process.env.REPORECALL_RUN_LIVE_MEMORY_BENCH === "1" &&
  existsSync(resolve(process.cwd(), "package.json"));

describe("Memory V1 live benchmark wrapper", { timeout: 600_000 }, () => {
  it.skipIf(!shouldRunLive)("runs the live benchmark and validates soft floors", async () => {
    const { runMemoryV1LiveBenchmark } = await import("../../scripts/benchmarks/memory-v1-live-lib.js");
    const report = await runMemoryV1LiveBenchmark({
      projectRoot: process.cwd(),
      model: process.env.REPORECALL_BENCH_MODEL ?? "sonnet",
      judgeEnabled: process.env.REPORECALL_BENCH_JUDGE !== "0",
      withMemoryFixtures: true,
      maxBudgetUsd: Number(process.env.REPORECALL_BENCH_MAX_BUDGET_USD ?? "0.75"),
    });

    expect(report.results.length).toBeGreaterThan(0);
    expect(report.aggregate.avgInputTokenReductionPct).toBeGreaterThanOrEqual(0.35);
    expect(report.aggregate.memoryUsefulnessRate).toBeGreaterThanOrEqual(0.7);
    expect(report.aggregate.memoryOverreachRate).toBeLessThanOrEqual(0.2);
    expect(report.aggregate.codeCertaintyScore).toBeGreaterThanOrEqual(0.7);
  });

  it("validates report schema and soft floors locally", () => {
    const report: MemoryV1LiveBenchmarkReport = {
      timestamp: "2026-03-20T00:00:00.000Z",
      project: "/tmp/project",
      model: "sonnet",
      gitSha: "deadbeef",
      querySet: "built-in default query set",
      outputJson: "/tmp/report.json",
      outputMarkdown: "/tmp/report.md",
      judgeEnabled: true,
      scenarios: [
        {
          label: "reporecall_plus_memory_v1",
          description: "test",
          queryCount: 1,
          completedQueries: 1,
          avgInputTokens: 100,
          avgOutputTokens: 40,
          avgCacheReadTokens: 0,
          avgCacheWriteTokens: 0,
          avgCostUsd: 0.01,
          avgLatencyMs: 25,
          avgMemoryTokens: 80,
          avgCodeTokens: 220,
        },
      ],
      results: [
        {
          scenario: "reporecall_plus_memory_v1",
          queryGroup: "mixed",
          queryId: "q1",
          query: "how is code certainty computed",
          route: "R1",
          memoryRoute: "M2",
          codeTokens: 220,
          memoryTokens: 80,
          totalInputTokens: 300,
          totalOutputTokens: 40,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          latencyMs: 25,
          costUsd: 0.01,
          selectedMemories: ["memory_v1_certainty"],
          droppedMemories: [],
          memoryPrecisionAtK: 1,
          memoryRecallAtK: 1,
          retrievalCertaintyScore: 0.85,
          answerGroundingScore: 0.8,
          codeCertaintyScore: 0.83,
          promptCompleteness: 0.9,
          codeFloorPreserved: true,
          expectedMemoryHit: true,
          generatedWorkingHit: false,
          overreach: false,
          answerText: "Code certainty is a weighted combination.",
        },
      ],
      aggregate: {
        avgInputTokenReductionPct: 0.4,
        avgCostReductionPct: 0.38,
        avgLatencyDeltaMs: 2,
        memoryUsefulnessRate: 0.8,
        continuityWinRate: 0.75,
        memoryOverreachRate: 0.1,
        codeCertaintyScore: 0.83,
      },
      validation: {
        schemaValid: true,
        softFloorsEnabled: true,
        softFloorsPassed: true,
        softFloorFailures: [],
      },
    };

    const validation = validateMemoryV1Report(report.results, report.aggregate);
    expect(validation.schemaValid).toBe(true);
    expect(validation.softFloorsPassed).toBe(true);
  });
});
