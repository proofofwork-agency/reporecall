---
id: configuration
title: Configuration
sidebar_position: 5
---

# Configuration

Reporecall reads its configuration from **`.memory/config.json`** in the project root (created by `reporecall init`). All keys are optional — anything you omit falls back to a built-in default. Unknown keys are rejected by a strict schema, and the effective config is validated on load.

A minimal config from `init`:

```json
{
  "embeddingProvider": "local"
}
```

> The tables below cover the commonly-tuned keys. `src/core/config.ts` is the authoritative, full list of options and defaults.

## Embedding providers

`embeddingProvider` selects the retrieval backend:

| Value | Behavior |
| --- | --- |
| `local` (default) | Local vector embeddings via `Xenova/all-MiniLM-L6-v2` (384 dims). No external service. |
| `keyword` | FTS-only, no vectors and no model download. Fastest to set up. |
| `ollama` | Embeddings from a local Ollama server (`ollamaUrl`, default `http://localhost:11434`). |
| `openai` | OpenAI embeddings. Requires the `OPENAI_API_KEY` env var (see security note). |

Related keys:

| Key | Default | Description |
| --- | --- | --- |
| `embeddingModel` | `"Xenova/all-MiniLM-L6-v2"` | Embedding model id. |
| `embeddingDimensions` | `384` | Vector dimensionality. |
| `ollamaUrl` | `"http://localhost:11434"` | Must resolve to localhost (`localhost`, `127.0.0.1`, or `[::1]`). |

## Search & ranking

| Key | Default | Description |
| --- | --- | --- |
| `searchWeights` | `{ vector: 0.5, keyword: 0.3, recency: 0.2 }` | Fusion weights; should sum to ~1.0. `doctor` warns if the sum drifts. |
| `rrfK` | `60` | Reciprocal Rank Fusion constant. |
| `graphExpansion` | `true` | Expand candidates along the call/import graph. |
| `graphDiscountFactor` | `0.6` | Score discount applied to graph-expanded neighbors. |
| `siblingExpansion` | `true` | Include sibling chunks. |
| `siblingDiscountFactor` | `0.4` | Score discount for siblings. |
| `reranking` | `false` | Enable cross-encoder reranking. |
| `rerankTopK` | `25` | Candidates to rerank when enabled. |
| `codeBoostFactor` | `1.5` | Boost for code chunks. |
| `testPenaltyFactor` | `0.3` | Penalty for test files (unless the query asks for tests). |

## Context budgets & compression

| Key | Default | Description |
| --- | --- | --- |
| `contextBudget` | `0` (auto) | Token budget for assembled context. `0` computes a dynamic budget from chunk count (clamped 2000–6000). |
| `maxContextChunks` | `0` (dynamic) | Max chunks per context bundle. |
| `sessionBudget` | `2000` | Per-session token budget. |
| `contextCompressionEnabled` | `true` | Compress secondary code evidence. |
| `contextCompressionMode` | `"auto"` | `off`, `auto`, or `always`. |
| `contextCompressionPreserveTopChunks` | `1` | Top chunks kept as full source before compressing. |
| `contextCompressionMinChunkTokens` | `100` | Minimum chunk size before compression is attempted. |
| `contextCompressionTargetRatio` | `0.75` | Max compressed/full token ratio accepted. |

Compressed evidence carries a `chunkId`; it is reversible via MCP `search_code action=read_chunk`.

## Wiki, capability evidence & topology

| Key | Default | Description |
| --- | --- | --- |
| `wikiBudget` | `400` | Max tokens for wiki injection per prompt. |
| `wikiMaxPages` | `3` | Max wiki pages injected per prompt. |
| `capabilityEvidence` | `true` | Use code/wiki/graph evidence to select related files for trace/architecture/change prompts. |
| `genericCapabilityHydration` | `true` | Hydrate broad inventory evidence for "which files implement…" questions. |
| `topologyEnabled` | `true` | Run topology/community analysis after indexing. |
| `topologyMaxChunks` | `50000` | Skip full topology graph construction above this indexed chunk count. |
| `autoRefresh` | `true` | Background-refresh the index when stale drift is detected. |

## Memory

| Key | Default | Description |
| --- | --- | --- |
| `memory` | `true` | Enable the memory layer. |
| `memoryBudget` | `500` | Token budget for memory injection per prompt. |
| `memoryDirs` | `[]` | Additional directories to scan for memory `.md` files. |
| `memoryWatch` | `true` | Watch memory directories live while the daemon runs. |
| `memoryWritableDir` | `".memory/reporecall-memories"` | Writable managed memory directory. |
| `memoryArchiveDays` | `30` | Archive episode memories older than this. |
| `memoryCompactionHours` | `6` | Run compaction every N hours. |
| `memoryAutoCreate` | `true` | Allow deterministic automatic memory creation. |
| `memoryFactPromotionThreshold` | `3` | Repeated retrievals before promoting a fact. |

See [Memory](./memory.md) for the full model.

## Fact extractors

`factExtractors` lets you register keyword-anchored regex patterns that pull structured facts from code. Each entry is `{ keyword, pattern, label }`:

```json
{
  "factExtractors": [
    { "keyword": "env", "pattern": "process\\.env\\.([A-Z_]+)", "label": "env-var" }
  ]
}
```

Patterns are validated on load: invalid regex and patterns flagged as ReDoS-prone (via `safe-regex2`) are rejected with a warning and dropped.

## Ignore patterns & `.memoryignore`

Two mechanisms exclude files from indexing:

1. **`ignorePatterns`** in `config.json` — replaces the default list if you set it. The defaults already exclude `node_modules`, `.git`, `.memory`, `dist`, `build`, `target`, `coverage`, minified assets, lockfiles, and — importantly — **assistant/client instruction files** (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.mcp.json`, `.claude/**`, `.codex/**`, `.cursor/**`, …) and common test **fixture** directories.

2. **`.memoryignore`** in the project root — uses `.gitignore` syntax and is created empty by `init`:

   ```text
   # Add patterns to exclude from memory indexing
   # Uses same syntax as .gitignore
   build/generated/**
   *.snap
   ```

## Environment variables

| Variable | Used by | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | `openai` embedding provider | The **only** accepted source for the OpenAI key. |
| `CLAUDE_PROJECT_DIR` | Claude Code hooks | Project directory used by the generated curl hooks; falls back to `$PWD`. |

## Security note: `OPENAI_API_KEY`

When `embeddingProvider` is `openai`, the API key **must** come from the `OPENAI_API_KEY` environment variable. An `openaiApiKey` placed in `config.json` is **intentionally ignored** — the strict config schema rejects it, and Reporecall logs a warning telling you to use the env var instead. This keeps secrets out of a file that is easy to commit accidentally.

```bash
export OPENAI_API_KEY=sk-...   # illustrative placeholder only
reporecall index
```

`reporecall doctor` reports whether `OPENAI_API_KEY` is set when the OpenAI provider is selected.
