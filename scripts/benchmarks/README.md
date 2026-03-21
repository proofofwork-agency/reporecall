# Benchmark Scripts

Reporecall now uses two benchmark layers for Memory V1:

- Deterministic local benchmarks for CI and regression checks
- Live Claude benchmarks for product validation on a real repo

Use the deterministic suite to gate changes. Use the live script to measure usefulness, continuity, and code certainty on your machine.

## Deterministic Benchmark

Run the local Memory V1 benchmark and watcher/runtime coverage:

```bash
npm run benchmark:memory
```

This runs:

- `test/benchmark/metrics.test.ts`
- `test/benchmark/memory-benchmark.test.ts`
- `test/daemon/memory-runtime.test.ts`
- `test/benchmark/live-memory-benchmark.test.ts`

What it validates:

- retrieval quality across `rule`, `fact`, `episode`, and `working`
- dual-root import vs managed memory behavior
- `M0`, `M1`, and `M2` routing
- summary-first memory assembly
- watcher freshness on add/change/delete
- compaction, archival, and supersession
- generated working-memory rotation

Core deterministic metrics:

- `memoryPrecisionAt3`
- `memoryRecallAt5`
- `memoryMRR`
- `memoryNDCG10`
- `memoryHitRate`
- `summaryCompressionRatio`
- `memoryTokenUsage`
- `codeTokenUsage`
- `codeFloorPreservedRate`
- `tokenReductionPct`
- `freshnessLatencyMs`
- `compactionArchivedCount`
- `compactionSupersededCount`
- `workingMemoryRotationPass`

## Live Memory V1 Benchmark

Run the live benchmark against a repo with real Claude calls:

```bash
npm run benchmark:live-memory -- --project . --with-memory-fixtures
```

By default the script writes both artifacts to `/tmp`:

- `/tmp/reporecall-memory-v1-<timestamp>.json`
- `/tmp/reporecall-memory-v1-<timestamp>.md`

Supported flags:

- `--project <path>`: repo to benchmark
- `--model <name>`: Claude model, default `sonnet`
- `--output <path>`: output path prefix
- `--no-judge`: disable the answer-grounding pass
- `--query-set <path>`: custom JSON query set
- `--with-memory-fixtures`: install temporary imported memory fixtures
- `--max-budget-usd <n>`: per-query Claude budget cap

Scenarios:

- `baseline_tools`: raw Claude without Reporecall
- `reporecall_code_only`: Reporecall code retrieval only
- `reporecall_plus_imported_memory`: code retrieval plus imported memory
- `reporecall_plus_memory_v1`: code retrieval plus imported memory and generated working memory

Query groups:

- `code_only`
- `memory_only`
- `mixed`
- `continuity`

## Live Metrics

The live report includes per-query rows and aggregate metrics.

Per-query fields:

- `scenario`
- `queryGroup`
- `query`
- `route`
- `memoryRoute`
- `codeTokens`
- `memoryTokens`
- `totalInputTokens`
- `totalOutputTokens`
- `latencyMs`
- `costUsd`
- `selectedMemories`
- `droppedMemories`
- `memoryPrecisionAtK`
- `memoryRecallAtK`
- `retrievalCertaintyScore`
- `answerGroundingScore`
- `codeCertaintyScore`

Aggregate product metrics:

- `avgInputTokenReductionPct`
- `avgCostReductionPct`
- `avgLatencyDeltaMs`
- `memoryUsefulnessRate`
- `continuityWinRate`
- `memoryOverreachRate`
- `codeCertaintyScore`

Definitions:

- `memoryUsefulnessRate`: memory-sensitive queries where expected memory was selected without crowding out code
- `continuityWinRate`: continuity queries where generated working memory beats code-only retrieval
- `memoryOverreachRate`: queries that injected memory even though expected memory relevance was zero
- `codeCertaintyScore`: `60%` retrieval certainty plus `40%` answer grounding

## Validation Flow

Recommended validation sequence:

```bash
npm run benchmark:memory
npm run benchmark:live-memory -- --project . --with-memory-fixtures
```

The live benchmark wrapper test is skipped by default. Enable it explicitly when you want a full live validation run:

```bash
REPORECALL_RUN_LIVE_MEMORY_BENCH=1 npm test -- --run test/benchmark/live-memory-benchmark.test.ts
```

## Older Scripts

The older scripts remain useful for version and cost comparisons:

- `scripts/benchmarks/cost-comparison.sh`
- `scripts/benchmarks/version-comparison.sh`
- `scripts/benchmarks/matrix-comparison.sh`
- `scripts/benchmarks/auto-budget-test.sh`

Those scripts are still useful for broader product checks, but Memory V1 claims should come from the deterministic suite and the dedicated live memory benchmark.
