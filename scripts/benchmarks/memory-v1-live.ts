#!/usr/bin/env tsx

import { Command } from "commander";
import {
  runMemoryV1LiveBenchmark,
  validateMemoryV1Report,
} from "./memory-v1-live-lib.js";

const program = new Command()
  .name("memory-v1-live")
  .description("Run the Memory V1 live benchmark against a local project")
  .option("--project <path>", "Project root path", process.cwd())
  .option("--model <name>", "Claude model name", process.env.REPORECALL_BENCH_MODEL ?? "sonnet")
  .option("--output <path>", "Output path prefix (writes .json and .md)")
  .option("--no-judge", "Disable the answer-grounding judge pass")
  .option("--query-set <path>", "Path to a JSON query-set file")
  .option("--with-memory-fixtures", "Install temporary imported memory fixtures for the benchmark")
  .option("--max-budget-usd <n>", "Max Claude budget per query", "0.75");

program.parse(process.argv);

const options = program.opts<{
  project: string;
  model: string;
  output?: string;
  judge: boolean;
  querySet?: string;
  withMemoryFixtures?: boolean;
  maxBudgetUsd: string;
}>();

const report = await runMemoryV1LiveBenchmark({
  projectRoot: options.project,
  model: options.model,
  outputBase: options.output,
  judgeEnabled: options.judge,
  querySetPath: options.querySet,
  withMemoryFixtures: options.withMemoryFixtures,
  maxBudgetUsd: Number(options.maxBudgetUsd),
});

console.log(`Memory V1 live benchmark written to:`);
console.log(`  JSON: ${report.outputJson}`);
console.log(`  Markdown: ${report.outputMarkdown}`);
console.log("");
console.log(`Aggregate metrics:`);
console.log(`  avgInputTokenReductionPct: ${report.aggregate.avgInputTokenReductionPct.toFixed(3)}`);
console.log(`  avgCostReductionPct: ${report.aggregate.avgCostReductionPct.toFixed(3)}`);
console.log(`  avgLatencyDeltaMs: ${report.aggregate.avgLatencyDeltaMs.toFixed(2)}`);
console.log(`  memoryUsefulnessRate: ${report.aggregate.memoryUsefulnessRate.toFixed(3)}`);
console.log(`  continuityWinRate: ${report.aggregate.continuityWinRate.toFixed(3)}`);
console.log(`  memoryOverreachRate: ${report.aggregate.memoryOverreachRate.toFixed(3)}`);
console.log(`  codeCertaintyScore: ${report.aggregate.codeCertaintyScore.toFixed(3)}`);

const validation = validateMemoryV1Report(report.results, report.aggregate);
if (!validation.softFloorsPassed) {
  console.error("");
  console.error("Validation failures:");
  for (const failure of validation.softFloorFailures) {
    console.error(`  - ${failure}`);
  }
  process.exitCode = 1;
}
