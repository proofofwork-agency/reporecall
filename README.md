```
██████╗ ███████╗██████╗  ██████╗ ██████╗ ███████╗ ██████╗ █████╗ ██╗     ██╗
██╔══██╗██╔════╝██╔══██╗██╔═══██╗██╔══██╗██╔════╝██╔════╝██╔══██╗██║     ██║
██████╔╝█████╗  ██████╔╝██║   ██║██████╔╝█████╗  ██║     ███████║██║     ██║
██╔══██╗██╔══╝  ██╔═══╝ ██║   ██║██╔══██╗██╔══╝  ██║     ██╔══██║██║     ██║
██║  ██║███████╗██║     ╚██████╔╝██║  ██║███████╗╚██████╗██║  ██║███████╗███████╗
╚═╝  ╚═╝╚══════╝╚═╝      ╚═════╝ ╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝
                              proofofwork
```

Local codebase memory for Claude Code and MCP clients.

It indexes a repository into code chunks, stores metadata and search indexes locally, and injects relevant context into Claude conversations through hooks. It can also expose the same index through MCP tools.

## What It Does

- hybrid retrieval: vector search when embeddings are enabled, plus SQLite FTS5 keyword search
- AST-based chunking with tree-sitter
- call graph extraction for caller/callee lookups
- conventions analysis
- Claude Code hook integration
- MCP server on stdio
- incremental indexing with Merkle-based change detection

Current parser surface:

- 23 languages: TypeScript, TSX, JavaScript, Python, Go, Rust, Java, Ruby, C, C++, C#, PHP, Swift, Kotlin, Scala, Zig, Elixir, Bash, Lua, HTML, Vue, CSS, TOML

The scanner also indexes some non-parser fallback file types by default, including `.json`, `.md`, `.sql`, and `.svelte`, as file-level chunks.

## Quick Start

```bash
# Install globally
npm install -g @proofofwork-agency/reporecall

# Inside your project
reporecall init
reporecall index
reporecall serve
```

Then ask Claude questions normally. The hook daemon injects relevant context before Claude answers.

## Commands

| Command                     | Purpose                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `reporecall init`           | create `.memory/`, Claude hook config, and CLAUDE.md instructions |
| `reporecall index`          | run one-shot indexing                                             |
| `reporecall search <query>` | search the index directly                                         |
| `reporecall serve`          | start daemon, watcher, and HTTP hook server                       |
| `reporecall stats`          | show index and latency stats                                      |
| `reporecall graph <name>`   | show callers/callees for a symbol                                 |
| `reporecall conventions`    | show detected coding conventions                                  |
| `reporecall mcp`            | start MCP server on stdio                                         |
| `reporecall doctor`         | diagnose common local setup problems                              |

Important options:

- `--project <path>` on all main commands
- `reporecall search --limit <n>`
- `reporecall search --budget <tokens>`
- `reporecall search --max-chunks <n>`
- `reporecall serve --port <n>`
- `reporecall serve --mcp`
- `reporecall serve --max-chunks <n>`
- `reporecall serve --debug`
- `reporecall graph --callers | --callees | --both`
- `reporecall conventions --json`
- `reporecall conventions --refresh`
- `reporecall init --embedding-provider local|ollama|openai|keyword`
- `reporecall init --autostart` for macOS launch-agent setup

## How It Works

### Indexing

The indexing pipeline does this:

1. scan files using configured extensions and ignore rules
2. compare file state against the Merkle store
3. parse source files with tree-sitter
4. extract chunks such as functions, methods, classes, interfaces, enums, exports, or language-specific equivalents
5. extract call edges
6. embed chunks unless `embeddingProvider` is `keyword`
7. store results in local databases
8. analyze conventions and stats

Files with no matching extractable AST nodes fall back to a file-level chunk so they can still be retrieved.

### Storage

The engine stores data locally in `.memory/`:

- `metadata.db`: chunk metadata, file tracking, call graph edges, conventions, stats
- `fts.db`: FTS5 keyword index
- `lance/`: vector storage when embeddings are enabled
- `merkle.json`: incremental change tracking

### Retrieval

The search pipeline is:

1. keyword search through FTS5
2. vector search when embeddings are enabled
3. reciprocal-rank fusion with recency weighting
4. code/test/doc/path-aware score adjustment
5. optional graph expansion
6. optional sibling expansion
7. optional reranking
8. context assembly under a token budget

Hook-oriented retrieval intentionally disables graph expansion, sibling expansion, and reranking for prompt-context injection, then prioritizes authoritative implementation chunks before assembling context.

### Hooks

The daemon serves:

- `POST /hooks/session-start`
- `POST /hooks/prompt-context`
- `GET /health`
- `GET /ready`

Hook responses use `hookSpecificOutput`, not a raw top-level `additionalContext` payload.

Session start injects project conventions and memory-engine instructions. Prompt submit injects targeted code context for the current query.

### MCP

The current MCP tools are:

- `search_code`
- `index_codebase`
- `get_stats`
- `clear_index`
- `find_callers`
- `find_callees`

These names are authoritative for the current implementation.

## Configuration

Config lives in `.memory/config.json`. All fields are optional.

| Field                   |                           Default | Description                                    |
| ----------------------- | --------------------------------: | ---------------------------------------------- |
| `embeddingProvider`     |                         `"local"` | `local`, `ollama`, `openai`, or `keyword`      |
| `embeddingModel`        |       `"Xenova/all-MiniLM-L6-v2"` | embedding model name                           |
| `embeddingDimensions`   |                             `384` | vector dimensions                              |
| `ollamaUrl`             |        `"http://localhost:11434"` | Ollama base URL                                |
| `contextBudget`         |                            `4000` | prompt-context token budget                    |
| `maxContextChunks`      |                               `0` | dynamic cap based on token budget (`0` = auto) |
| `sessionBudget`         |                            `2000` | session-start token budget                     |
| `searchWeights.vector`  |                             `0.5` | vector weight                                  |
| `searchWeights.keyword` |                             `0.3` | keyword weight                                 |
| `searchWeights.recency` |                             `0.2` | recency weight                                 |
| `batchSize`             |                              `32` | embedding batch size                           |
| `maxFileSize`           |                          `102400` | skip larger files                              |
| `port`                  |                           `37222` | daemon port                                    |
| `debounceMs`            |                            `2000` | watcher debounce                               |
| `rrfK`                  |                              `60` | RRF constant                                   |
| `graphExpansion`        |                            `true` | enable graph expansion                         |
| `graphDiscountFactor`   |                             `0.6` | graph expansion discount                       |
| `siblingExpansion`      |                            `true` | enable sibling expansion                       |
| `siblingDiscountFactor` |                             `0.4` | sibling expansion discount                     |
| `reranking`             |                           `false` | enable local reranking                         |
| `rerankingModel`        | `"Xenova/ms-marco-MiniLM-L-6-v2"` | reranker model                                 |
| `rerankTopK`            |                              `25` | rerank candidate count                         |

## Best Practices

### Keep the index warm

Run `reporecall serve` during development so the watcher keeps the index current. Use `reporecall index` for CI or one-shot refreshes.

### Scope the repo deliberately

Use `.memoryignore` to exclude generated code, vendored code, fixtures, or large irrelevant files. The scanner already respects `.gitignore`, `.memoryignore`, and built-in ignore patterns.

### Prefer natural-language search queries

Hybrid search works better on descriptive queries than short tokens. Keyword search handles exact identifiers; vector search helps with semantic and cross-cutting questions.

### Treat call graph as name-based, not type-resolved

Caller/callee results are useful, but they are based on symbol names and extracted calls, not full type analysis.

### Use `keyword` mode when you want zero embedding dependencies

`embeddingProvider: "keyword"` skips vectors entirely and still gives you local FTS-based retrieval.

### Use `--debug` when validating hook behavior

`reporecall serve --debug` logs hook requests, sanitized queries, retrieval counts, and context assembly details. Use it to verify that Claude actually received memory context.

### Keep claims disciplined

The included benchmark is synthetic. It is useful for regression detection, not for strong public claims about universal retrieval quality on arbitrary repositories.

## Operational Notes

- the daemon binds to `127.0.0.1`
- non-health/readiness routes require a bearer token
- API keys should come from environment variables, not config files
- `clear_index` resets the on-disk stores and Merkle state
- stale-store recovery forces a full rebuild when Merkle says “no changes” but the stores are empty

## Benchmark

Run:

```bash
npm run benchmark
```

The benchmark compares baseline, keyword-only, and semantic modes on generated small, medium, and large codebases. It reports:

- index time
- search latency
- top-1 accuracy
- top-5 recall
- context tokens
- budget utilization

Results are written to [benchmark-results.json](benchmark-results.json).

## Development

```bash
npm install
npm run build
npm run dev
npm test
npm run lint
npm run benchmark
```

## Status

Current validated state in this repo:

- build, lint, tests, benchmark, and integration script pass
- the current 23-language parser surface passes black-box indexing/search validation
- normal Claude + Reporecall works
