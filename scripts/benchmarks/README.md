# Benchmark Scripts

Reporecall uses deterministic benchmarks for regression checks and optional live benchmarks for product validation. Prefer deterministic runs before release work; use live runs only when measuring real agent behavior, latency, and cost.

## Core Retrieval

Run the keyword benchmark:

```bash
npm run benchmark -- --provider keyword --output /tmp/reporecall-keyword.json
```

This validates lookup, trace, architecture, bug, and change behavior against the local keyword provider.

Key metrics:

- `ndcgAt10`
- `mrr`
- `routeAccuracy`
- lookup exactness
- file-level recall and precision

## Project Context Audit

Run the project-context audit against a target repository:

```bash
npm run benchmark:project-context -- --project /path/to/repo --reporecall-only --output /tmp/reporecall-project-context
```

This is the best fit for checking capability evidence behavior because it measures whether Reporecall selects the files needed to answer trace and architecture questions.

Watch for:

- context recall
- trace recall
- architecture recall
- lookup recall
- precision
- token pollution

## Production Gate

Run the production gate when validating a broader release candidate:

```bash
npm run benchmark:production
```

The production gate combines multiple checks and should stay deterministic enough to compare across local runs.

## Memory Benchmarks

Run the deterministic memory suite:

```bash
npm run benchmark:memory
```

This covers:

- memory retrieval quality across rules, facts, episodes, and working context
- dual-root imported vs managed memory behavior
- memory route behavior
- watcher freshness on add/change/delete
- compaction, archival, and supersession
- generated working-memory rotation

## Large-Repo Stress

Run the synthetic large-repo stress harness when validating memory pressure, no-change indexing, and Lens extraction on large repositories:

```bash
npm run stress:large-repo -- --files 10000 --changes 1000 --output /tmp/reporecall-large-repo.json
npm run stress:large-repo:ci
```

Useful flags:

- `--files <n>`: number of generated TypeScript modules, default `10000`
- `--changes <n>`: number of files to mutate and re-index, default `1000`
- `--topology-max-chunks <n>`: force the topology guardrail threshold
- `--lens-max-graph-chunks <n>`: force the Lens graph guardrail threshold
- `--sample-interval-ms <n>`: active memory sampling interval, default `250`
- `--max-heap-mb <n>`: fail if peak sampled JS heap exceeds this budget
- `--max-rss-mb <n>`: fail if peak sampled RSS exceeds this budget
- `--max-no-change-files <n>`: fail if a no-change re-index processes more files than this budget
- `--max-lens-ms <n>`: fail if Lens extraction exceeds this budget
- `--quiet`: suppress routine indexing logs in stress output
- `--vacuum-before-close`: run SQLite vacuum before closing stores for diagnosis
- `--keep`: keep the temporary synthetic repository for inspection

The report includes initial index, no-change re-index, changed-file re-index, Lens extraction, active memory samples, and post-close cleanup samples. JS heap is the primary leak indicator; RSS is also reported because native SQLite/vector storage and OS page cache can affect process size.

## Live Memory Benchmark

Run only when you explicitly want a live model-backed validation:

```bash
npm run benchmark:live-memory -- --project . --with-memory-fixtures
```

By default the script writes artifacts to `/tmp`:

- `/tmp/reporecall-memory-v1-<timestamp>.json`
- `/tmp/reporecall-memory-v1-<timestamp>.md`

Supported flags:

- `--project <path>`: repository to benchmark
- `--model <name>`: model name, default `sonnet`
- `--output <path>`: output path prefix
- `--no-judge`: disable the answer-grounding pass
- `--query-set <path>`: custom JSON query set
- `--with-memory-fixtures`: install temporary imported memory fixtures
- `--max-budget-usd <n>`: per-query budget cap

## Recommended Flow

For normal retrieval work:

```bash
npm run lint
npm test -- --run test/search test/hooks test/wiki test/visualize
npm run benchmark -- --provider keyword --output /tmp/reporecall-keyword.json
```

For capability evidence or architecture recall work, add:

```bash
npm run benchmark:project-context -- --project /path/to/repo --reporecall-only --output /tmp/reporecall-project-context
```
