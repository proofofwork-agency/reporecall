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

**Index the target repository first.** The audit measures retrieval quality; it
does not build the index it measures.

```bash
node dist/memory.js init  --project /path/to/repo
node dist/memory.js index --project /path/to/repo
npm run benchmark:project-context -- --project /path/to/repo --reporecall-only --output /tmp/reporecall-project-context
```

Skip the indexing step and the audit still completes and still writes a report —
it just measures an empty index, and the result looks like a convincing quality
regression rather than a setup mistake. This is what an unindexed run of the same
repository and the same fixture printed, next to its real result:

```text
unindexed  FAIL  route 100%  precision 41%  recall 33%  freshness 0%
indexed    PASS  route 100%  precision 92%  recall 96%  freshness 100%
```

Freshness is the tell. At 0% nothing was answering at all, which is a different
failure from retrieval getting worse. Confirm before believing any FAIL:

```bash
node -p "require('/tmp/reporecall-project-context.json').health"
```

`explainRunnable: false`, `daemonHealthy: false`, or a `blockedReasons` array
containing `explain_failed` means the numbers describe your setup, not the code.

## Token + Trust Evidence

```bash
npm run benchmark:tokens -- --project /path/to/repo
```

Reports:
- Real freshness / trust contract data (`indexedCommit`, dirty files, banner)
- Uses actual hook injection stats when an index exists
- Reports end-to-end token savings as `insufficient_evidence` unless a paired
  agentic task artifact exists; it never invents a baseline or fallback number

## Context Cost (paired, no model calls)

```bash
npm run benchmark:context-cost -- --project /path/to/repo --output ./context-cost.json
```

Measures the tokens needed to put the answering evidence in front of the model
versus reading the known-relevant files whole. Deterministic and reproducible —
it makes no model calls. A query counts only when Reporecall delivered every
`mustInclude` file, so omitting evidence cannot register as a saving, and the
baseline counts only known-relevant files, making the result a floor. Exits
non-zero when no query produced complete evidence.

Scope: context-assembly cost only. It excludes reasoning tokens, tool-call
overhead and multi-turn exploration, and is not an end-to-end agent measurement.

See `trust-and-tokens.md` for methodology and how to contribute real measurements.

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
