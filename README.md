```
██████╗ ███████╗██████╗  ██████╗ ██████╗ ███████╗ ██████╗ █████╗ ██╗     ██╗
██╔══██╗██╔════╝██╔══██╗██╔═══██╗██╔══██╗██╔════╝██╔════╝██╔══██╗██║     ██║
██████╔╝█████╗  ██████╔╝██║   ██║██████╔╝█████╗  ██║     ███████║██║     ██║
██╔══██╗██╔══╝  ██╔═══╝ ██║   ██║██╔══██╗██╔══╝  ██║     ██╔══██║██║     ██║
██║  ██║███████╗██║     ╚██████╔╝██║  ██║███████╗╚██████╗██║  ██║███████╗███████╗
╚═╝  ╚═╝╚══════╝╚═╝      ╚═════╝ ╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝
                              proofofwork
```

**Local codebase memory for Claude Code and MCP clients**

## The Problem

You ask Claude: _"how does the credit refund work when a job fails?"_

Claude doesn't know your codebase. So it starts searching:

```
Grep "refundCredits"       → found credit-utils.ts
Read credit-utils.ts       → ok, but who calls this?
Grep "refundCredits"       → found job-completion.ts
Read job-completion.ts     → found processJobCompletion, but what about failures?
Grep "processJobFailure"   → found another file
Read that file too         → finally has the picture
```

6 tool calls. 4 round-trips. ~15,000 tokens. And it still missed the error handler sites.

## With Reporecall

Same question. Claude asks, Reporecall's hook fires before the prompt reaches Claude:

```
→ Search index: "credit refund job fails"         (5ms, keyword + vector)
→ Top hit: refundCredits()
→ Call graph expansion: who calls refundCredits?
  ├─ processJobCompletion()   (job-completion.ts)
  └─ processJobFailure()     (job-completion.ts)
→ Inject context into prompt                       (~2K tokens)
```

0 tool calls. 1 round-trip. Claude already has the full picture — the function, its callers, and the failure path — before it writes a single word.

```
┌────────────────────┬──────────────────────┬─────────────────┐
│                    │ Without Reporecall   │ With Reporecall │
├────────────────────┼──────────────────────┼─────────────────┤
│ Tool calls         │ 6                    │ 0               │
│ Round-trips        │ 4                    │ 1               │
│ Tokens consumed    │ ~15,000              │ ~2,000          │
│ Latency            │ seconds              │ ~5ms            │
│ Found the callers  │ after 3 extra greps  │ automatically   │
│ Found error sites  │ no                   │ yes (10 files)  │
└────────────────────┴──────────────────────┴─────────────────┘
```

That's what Reporecall does. It builds a local index of your codebase — AST chunks, call graph, keyword + vector search — and injects the right context before Claude even starts thinking. The call graph is the key part: it doesn't just find the function you asked about, it finds the functions that _call_ it and the functions _it calls_. That's the depth that grepping misses.

## What It Solves and What It Doesn't

**Solves:**

- **Grep chains.** Claude doing 4-6 Grep/Read round-trips to understand code before answering. Reporecall eliminates this for code understanding questions — the context is already there.
- **Token cost and API spend.** 3-8x fewer tokens per code question. Each grep/read round-trip resends the full conversation context — on a long session, that's the expensive part. Fewer round-trips means fewer API calls, each carrying less payload.
- **Depth.** Grepping finds the function you asked about. It doesn't tell you who calls it, or what it calls. The call graph surfaces that automatically — no extra rounds needed.
- **Round-trip latency.** One hook injection (~5ms) replaces multiple sequential tool calls (seconds).

**Doesn't solve:**

- **Claude's context window.** Reporecall injects into the same window. Long conversations still hit the limit. Smaller injections (2K vs 15K) help, but it's not infinite memory.
- **Non-code tasks.** File edits, running tests, debugging runtime behavior — Claude still uses tools for those. Reporecall only covers "understand the codebase" questions.
- **Vague queries.** If there's no symbol or keyword to anchor on ("make this faster"), retrieval is weak. The engine needs something concrete to search for.
- **Type-resolved accuracy.** The call graph is name-based, not type-resolved. Two unrelated functions with the same name can produce false edges. Works well for typical codebases, but it's not a compiler.

## How It Works

You ask Claude a question. Before Claude sees it, Reporecall's hook:

1. Classifies intent (rule-based, zero LLM tokens, <1ms)
2. Searches the index (hybrid keyword + vector, ~5ms)
3. Expands results through the call graph (callers and callees of top hits)
4. Filters test files, penalizes oversized chunks, enforces a token budget
5. Injects assembled context into the prompt

Claude answers with full codebase context. No tool calls needed for the common case.

### What it indexes

- **AST chunks**: Tree-sitter parses 22 languages into functions, classes, methods, interfaces, exports
- **Call graph**: Which functions call which — extracted from static AST, no language server needed
- **Import graph**: File-level dependency relationships
- **Keyword index**: FTS5 with Porter stemming and camelCase splitting
- **Vector embeddings**: Optional semantic search (local ONNX, Ollama, or OpenAI)
- **Conventions**: Detected coding patterns and naming conventions

Everything stays on your machine. No cloud, no API calls during retrieval, no telemetry.

## Supported Languages

22 languages: TypeScript, TSX, JavaScript, Python, Go, Rust, Java, Ruby, C, C++, C#, PHP, Swift, Kotlin, Scala, Zig, Bash, Lua, HTML, Vue, CSS, TOML

The scanner also indexes non-parser fallback file types by default: `.json`, `.md`, `.sql`, `.svelte` (as file-level chunks).

## Team Collaboration

Reporecall uses a **three-tier configuration pattern** designed for teams:

| Tier               | Location                             | Scope                        | Committed to Git | Purpose                                          |
| ------------------ | ------------------------------------ | ---------------------------- | ---------------- | ------------------------------------------------ |
| **Global**         | `~/.claude/settings.json`            | All projects on your machine | ✗                | Personal preferences (model, theme, keybindings) |
| **Project Shared** | `.claude/settings.json`, `.mcp.json` | Current project              | ✓                | Team-wide hooks, MCP config, instructions        |
| **Local**          | `.claude/settings.local.json`        | Your machine                 | ✗                | Custom daemon port, proxy, tokens, etc.          |

**Setup for teams:**

```bash
git clone <repo>
cd <repo>
reporecall init    # Creates .claude/settings.json + .mcp.json (committed)
reporecall index
```

Claude Code automatically merges `.claude/settings.local.json` over shared settings, so each team member can customize locally without affecting the shared config.

**Key benefit:** Hooks use **`$CLAUDE_PROJECT_DIR`** (provided by Claude Code at runtime) so they resolve correctly on any machine—no re-running init needed.

See [CLAUDE.md](./CLAUDE.md#team-collaboration) for detailed team collaboration guide.

## Privacy & Data

Reporecall runs **entirely on your machine**:

- No external API calls during retrieval
- No telemetry or data collection
- No cloud dependency or uploads
- All code stays local in `.memory/` folder
- Works offline after initial setup

This means you can use Reporecall on proprietary code without exposing it to third parties.

## Cost & License

- **Open source**: MIT license
- **No ongoing costs**: One-time npm install
- **No subscription**: Use indefinitely
- **No API fees**: All processing local

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

### Daily Workflow

**Morning:** Start Reporecall

```bash
reporecall serve
```

✓ Daemon wakes up and watches your code folder
✓ Connected to Claude, ready to help
✓ Stays running in background all day

**During Development:** Ask Questions

```
Developer: "Why is my test failing? Here's the error..."
↓
Claude: Instantly has your test structure, error handling patterns,
        testing conventions. Gives smarter answer.

Developer: "Who calls the validateUserInput() function?"
↓
Claude: Shows all callers in context, with surrounding code.

Developer: "Help me refactor the authentication flow"
↓
Claude: Shows entire auth flow, suggests improvements based on YOUR
        actual code patterns.
```

**End of Day:** Everything Syncs Automatically

```
✓ If you edited files today, Reporecall noticed and updated
✓ If teammates changed code, Reporecall learned it
✓ Everything stays local and private
```

## Architecture

Reporecall runs entirely on your machine - no external API calls during retrieval, no telemetry, no cloud dependency.

```mermaid
flowchart TB
    Dev["Developer"]
    CC["Claude Code"]
    Hook["Pre-submit Hook<br/>POST /hooks/prompt-context"]
    Daemon["Daemon :37222<br/>(bearer-token auth,<br/>localhost-only)"]
    IC["Intent Classifier<br/>(rule-based,<br/>zero LLM tokens)"]

    subgraph Routes["Retrieval Routes"]
        R0["R0 - Fast Path<br/>hybrid search"]
        R1["R1 - Flow Path<br/>call-tree traversal"]
        R2["R2 - Deep Path<br/>broad semantic search"]
        SK["SKIP<br/>(greeting / meta-AI / chat)"]
    end

    subgraph Storage[".memory/ (local)"]
        Meta["metadata.db<br/>chunks · call graph<br/>· conventions"]
        FTS["fts.db<br/>FTS5 keyword index"]
        Lance["lance/<br/>vector store<br/>(optional)"]
    end

    MCP["MCP tools (stdio)"]

    Dev --> CC
    CC -->|"UserPromptSubmit hook"| Hook
    Hook --> Daemon
    Daemon --> IC
    IC --> R0 & R1 & R2 & SK
    R0 & R1 & R2 --> Storage
    Storage -->|"assembled context"| CC
    CC <-->|"tool calls"| MCP
    MCP --> Storage
```

**Design decision:** the daemon binds only to `127.0.0.1` and requires a bearer token on all non-health routes. The intent classifier is rule-based - it uses zero LLM tokens and adds no latency to the hook path.

## Commands

| Command                      | Purpose                                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| `reporecall init`            | create `.memory/`, Claude hook config, and CLAUDE.md instructions |
| `reporecall index`           | run one-shot indexing                                             |
| `reporecall search <query>`  | search the index directly                                         |
| `reporecall serve`           | start daemon, watcher, and HTTP hook server                       |
| `reporecall stats`           | show index and latency stats                                      |
| `reporecall graph <name>`    | show callers/callees for a symbol                                 |
| `reporecall conventions`     | show detected coding conventions                                  |
| `reporecall explain <query>` | show route decision, seed, and retrieved context for a query      |
| `reporecall mcp`             | start MCP server on stdio                                         |
| `reporecall doctor`          | diagnose common local setup problems                              |

Important options:

- `--project <path>` on all main commands
- `reporecall search --limit <n>`
- `reporecall search --budget [tokens]` (omit value for auto)
- `reporecall search --max-chunks <n>`
- `reporecall serve --port <n>`
- `reporecall serve --mcp`
- `reporecall serve --max-chunks <n>`
- `reporecall serve --debug`
- `reporecall graph --callers | --callees | --both`
- `reporecall conventions --json`
- `reporecall conventions --refresh`
- `reporecall explain --json`
- `reporecall init --embedding-provider local|ollama|openai|keyword`
- `reporecall init --autostart` for macOS launch-agent setup

## How It Works

### Indexing

```mermaid
flowchart TD
    FS["File Scanner<br/>(extensions +<br/>ignore rules)"]
    MC{"Merkle check<br/>(xxHash64<br/>per file)"}
    Skip["skip - no change"]
    TS["Tree-sitter parser<br/>(22-language<br/>WASM grammars)"]
    Chunks["AST Chunks<br/>fn · class · method<br/>interface · enum · export<br/>↳ file-level fallback<br/>if no nodes"]
    CE["Call Edge extraction<br/>source_chunk →<br/>target_name"]
    IA["Import analysis"]
    Embed{"Embedding"}
    NullEmbed["NullEmbedder<br/>(keyword-only<br/>mode)"]
    ONNX["all-MiniLM-L6-v2<br/>384-dim q8 ONNX<br/>~10ms warm inference"]
    Write["Parallel write"]
    FTS5["fts.db - FTS5<br/>Porter stemmer +<br/>camelCase splitting"]
    LanceDB["lance/ - LanceDB<br/>vector store"]
    MetaDB["metadata.db<br/>chunks · call graph<br/>· stats"]
    Watch["File Watcher<br/>(chokidar,<br/>debounce 2s)"]

    FS --> MC
    MC -->|"unchanged"| Skip
    MC -->|"changed"| TS
    TS --> Chunks --> CE --> IA --> Embed
    Embed -->|"keyword provider"| NullEmbed
    Embed -->|"local/ollama/openai"| ONNX
    NullEmbed & ONNX --> Write
    Write --> FTS5 & LanceDB & MetaDB
    Watch -->|"file saved"| FS
```

**Design decision:** xxHash64 per-file Merkle tracking gives O(1) change detection so the watcher never re-parses unchanged files. Tree-sitter WASM grammars are deterministic and safe for untrusted files with no runtime language-server dependency. `all-MiniLM-L6-v2` at 384 dimensions runs locally in-process at ~10 ms warm - 768-dim models give marginal quality gain at 2× compute. `keyword` mode (NullEmbedder) skips vectors entirely, useful for CI, air-gapped, or resource-constrained environments. FTS5 lives in a separate file from `metadata.db` so the two can recover from corruption independently; Porter stemmer plus camelCase identifier splitting lets `validateToken` match on `validate` and `token`.

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

#### Route Decision

Every hook query passes through a rule-based classifier before any storage is touched.

```mermaid
flowchart TD
    Q["Query"]
    San["sanitizeQuery()<br/>strip code blocks +<br/>inline spans"]
    Empty{"empty or<br/>too short?"}
    NonCode{"NON_CODE_PATTERNS?<br/>greetings · meta-AI · chat"}
    Nav{"NAVIGATION_PATTERNS?<br/>how/why/trace/debug/<br/>flow/arch/who calls"}
    SK["SKIP<br/>no retrieval"]
    R0["R0 - Fast Path<br/>hybrid search"]
    Seed["resolveSeeds()<br/>PascalCase/camelCase<br/>extraction → FTS<br/>confidence 0–1"]
    LowConf{"confidence<br/>< 0.55?"}
    R2["R2 - Deep Path<br/>broad semantic search"]
    R1check{"tree nodeCount ≤ 1<br/>or empty flow<br/>context?"}
    R1["R1 - Flow Path ✓<br/>call-tree traversal"]

    Q --> San --> Empty
    Empty -->|"yes"| SK
    Empty -->|"no"| NonCode
    NonCode -->|"yes"| SK
    NonCode -->|"no"| Nav
    Nav -->|"no"| R0
    Nav -->|"yes"| Seed
    Seed -->|"no viable seed"| R2
    Seed --> LowConf
    LowConf -->|"yes"| R2
    LowConf -->|"no"| R1check
    R1check -->|"yes - degrade"| R2
    R1check -->|"no"| R1
```

**Design decision:** the classifier uses zero LLM tokens - rule matching adds under 1 ms to the hook path. The default assumption is `isCodeQuery = true`; a false-positive skip (missing relevant context) is far worse than over-retrieving. The 0.55 confidence threshold means ambiguous seeds (common words that match many symbols) fall to R2 broad search rather than producing a wrong call tree.

### Understanding the Three Search Modes

Reporecall automatically chooses the best search strategy for your question:

**R0 — Fast Mode (Hybrid Search)**

- Use when: Looking for something specific by name or exact term
- Example: "What does validateEmail do?"
- How it works: Searches both exact keywords AND semantic meaning simultaneously
- Result: ~10ms response time

**R1 — Flow Mode (Call Tree Traversal)**

- Use when: Understanding how a feature works end-to-end
- Example: "Walk me through the payment flow" or "Help me debug this checkout"
- How it works: Traces which functions call which other functions (bidirectional)
- Result: Shows complete call chain with context

**R2 — Deep Search (Semantic)**

- Use when: Looking for related code across the codebase by concept
- Example: "Find all error handling" or "Show me authentication patterns"
- How it works: Searches by meaning, not just keywords
- Result: Finds related code even if names don't match

#### Concept Bundles _(v0.2.0)_

For broad architectural questions like "what is the storage layer?" or "how does the AST pipeline work?", Reporecall uses **concept bundles** — predefined groups of symbols that represent a subsystem. When a query matches a bundle's pattern, the engine short-circuits to the relevant symbols without relying on keyword matching alone.

Default bundles (8):

| Kind               | Pattern Example                                     | Symbols                                                            |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------ |
| `ast`              | "ast", "tree-sitter"                                | `initTreeSitter`, `chunkFileWithCalls`, `walkForExtractables`, ... |
| `call_graph`       | "call graph", "who calls", "callers"                | `extractCallEdges`, `buildStackTree`, ...                          |
| `search_pipeline`  | "search pipeline", "hybrid search", "query routing" | `classifyIntent`, `deriveRoute`, `searchWithContext`, ...          |
| `storage`          | "storage layer", "data stores"                      | `MetadataStore`, `FTSStore`, `ChunkStore`, ...                     |
| `daemon`           | "daemon", "http server"                             | `createDaemonServer`, `sanitizeQuery`, `IndexScheduler`, ...       |
| `embedding`        | "embedding provider", "embedder"                    | `LocalEmbedder`, `NullEmbedder`, `OllamaEmbedder`, ...             |
| `cli`              | "cli", "command line"                               | `createCLI`, `initCommand`, `serveCommand`, ...                    |
| `context_assembly` | "token budget", "context assembly"                  | `assembleContext`, `assembleConceptContext`, `countTokens`, ...    |

Bundles are configurable via `.memory/config.json` and validated for ReDoS safety.

#### R0 - Fast Path: Hybrid Search & Context Assembly

```mermaid
flowchart LR
    Q2["Query"]
    FTS5S["FTS5 keyword search<br/>phrase → AND →<br/>OR fallback"]
    VEC["Vector search<br/>cosine ANN<br/>(LanceDB)"]
    RRF["Reciprocal Rank<br/>Fusion<br/>1/(k+rank), k=60"]
    Adj["Score adjustments<br/>impl +50% · test penalty<br/>recency 90d half-life<br/>active-file +50%<br/>query-term match +30%/term<br/>length penalty >80 lines"]
    Floor["Score floor filter<br/>≥ 55% of top score"]
    Budget["Token budget<br/>assembly<br/>tiktoken gpt-4o<br/>counting<br/>auto-scaled budget"]
    Ctx["Assembled context<br/>markdown code blocks<br/>+ Direct Facts section"]

    Q2 --> FTS5S & VEC
    FTS5S & VEC --> RRF --> Adj --> Floor --> Budget --> Ctx
```

**Design decision:** RRF fuses BM25 (FTS5) and cosine-similarity (LanceDB) scores without normalization - the two score spaces are incomparable, but rank positions are. k=60 follows the established RRF literature default. A length penalty demotes chunks over 80 lines (80-line chunk = 1.0x, 150 lines = 0.59x, 300 lines = 0.32x) to prevent large chunks from dominating the token budget. The 55% score floor prevents low-signal noise chunks from bloating context with irrelevant code.

#### R1 - Flow Path: Bidirectional Call Tree

```mermaid
flowchart LR
    Seed2["Seed symbol<br/>best-matched<br/>(name · file · kind)"]
    Up["Up-tree BFS<br/>callers of seed<br/>callers of callers<br/>maxDepth=2<br/>maxBranchFactor=3"]
    Down["Down-tree BFS<br/>callees of seed<br/>callees of callees<br/>maxDepth=2<br/>maxBranchFactor=3"]
    ImpFallback["Import-graph fallback<br/>if call graph<br/>has no edges"]
    Bundle["Flow Bundle<br/>assembly<br/>callers depth-desc →<br/>seed → callees<br/>depth-asc →<br/>token budget trim"]
    Cover{"nodeCount ≤ 1<br/>or empty<br/>context?"}
    R2D["degrade to R2"]
    R1Out["R1 context ✓"]

    Seed2 --> Up & Down
    Up & Down -->|"no call edges"| ImpFallback
    Up & Down & ImpFallback --> Bundle --> Cover
    Cover -->|"yes"| R2D
    Cover -->|"no"| R1Out
```

**Design decision:** call graph edges are extracted from static AST - no runtime execution needed, no language server per language. Full data-flow analysis would require a per-language type server, which is too heavyweight. Name-based edges are sufficient for most flow, debug, and architecture questions. The import-graph fallback ensures a useful tree even for files where call extraction found no edges.

The search pipeline is:

1. keyword search through FTS5
2. vector search when embeddings are enabled
3. reciprocal-rank fusion with recency weighting
4. code/test/doc/path-aware score adjustment
5. optional graph expansion
6. optional sibling expansion
7. optional reranking
8. context assembly under a token budget

Hook-oriented retrieval enables graph expansion (top 5 results, `graphDiscountFactor` applied) but disables sibling expansion and reranking for prompt-context injection, then prioritizes authoritative implementation chunks before assembling context.

### Hooks

The daemon serves:

- `POST /hooks/session-start`
- `POST /hooks/prompt-context`
- `GET /health`
- `GET /ready`
- `GET /metrics` — uptime, request counts, error counts, latency summaries, heap/RSS/event-loop-lag
- `GET /status` — index statistics and last-indexed timestamp

Hook responses use `hookSpecificOutput`, not a raw top-level `additionalContext` payload.

Session start injects project conventions and memory-engine instructions. Prompt submit injects targeted code context for the current query.

### MCP

The current MCP tools are:

- `search_code` - hybrid search returning ranked code chunks
- `index_codebase` - trigger a full or incremental index
- `get_stats` - index counts, latency stats, and storage sizes
- `clear_index` - reset on-disk stores and Merkle state
- `find_callers` - callers of a named symbol
- `find_callees` - callees of a named symbol
- `resolve_seed` - resolve a query to a best-matched seed symbol _(v0.2.0)_
- `build_stack_tree` - build a bidirectional call tree from a seed _(v0.2.0)_
- `get_imports` - import edges for a file _(v0.2.0)_
- `get_symbol` - fetch a specific chunk by symbol name or ID _(v0.2.0)_
- `explain_flow` - assemble a flow-oriented context bundle (R1 path) _(v0.2.0)_

These names are authoritative for the current implementation.

## Configuration

Config lives in `.memory/config.json`. All fields are optional.

| Field                   |                           Default | Description                                    |
| ----------------------- | --------------------------------: | ---------------------------------------------- |
| `embeddingProvider`     |                         `"local"` | `local`, `ollama`, `openai`, or `keyword`      |
| `embeddingModel`        |       `"Xenova/all-MiniLM-L6-v2"` | embedding model name                           |
| `embeddingDimensions`   |                             `384` | vector dimensions                              |
| `ollamaUrl`             |        `"http://localhost:11434"` | Ollama base URL                                |
| `contextBudget`         |                               `0` | prompt-context token budget (`0` = auto-scale) |
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

The live-repo benchmark (NDCG@10: 0.530, MRR: 0.750 in keyword mode) provides honest, community-standard numbers measured through the production pipeline (`handlePromptContextDetailed` with seed boosting, concept bundles, and hook priority scoring). See the [Benchmark section](#benchmark) for full analysis.

## Operational Notes

### Security & Access Control

- The daemon binds only to `127.0.0.1` (localhost only, not accessible from network)
- All non-health/readiness routes require bearer token authentication (timing-safe comparison)
- API keys should come from environment variables, not committed to config files
- Intent classifier runs rule-based (zero LLM tokens), adding <1ms to hook latency
- Request body size capped at 1MB with stream destruction on overflow
- Rate limiting: sliding window per client IP (100 req/10s for authenticated endpoints, 1000/10s for health/ready probes)
- Request timeouts: 30s for hook endpoints, 10s for probe endpoints
- User-supplied regex patterns validated with `safe-regex2` to prevent ReDoS
- `ollamaUrl` restricted to localhost to prevent SSRF
- All SQL queries use parameterized statements (no string concatenation of user input)
- Path traversal prevention on file operations and MCP tool inputs
- Symlink escape detection prevents indexing files outside the project root

### Data Management

- `clear_index` resets on-disk stores and Merkle state
- Stale-store recovery forces full rebuild when Merkle says “no changes” but stores are empty
- `.memory/` folder contains all local data (metadata.db, fts.db, lance/, merkle.json)
- Tree-sitter WASM parsers are deterministic and safe for untrusted files

### Daemon Lifecycle

- PID file locking prevents concurrent daemon instances
- Stale PID detection: checks if the process is still alive before claiming a port conflict
- Graceful shutdown on SIGTERM/SIGINT with 10-step ordered sequence:
  1. Stop HTTP server (5s drain for in-flight requests)
  2. Stop scheduler and drain pending indexing jobs
  3. Stop file watcher
  4. Close MCP server (if running)
  5. Destroy metrics collector
  6. Close all stores (FTS, metadata, vector — includes freeing tiktoken encoder)
  7. Clean up SQLite WAL sidecar files
  8. Release PID file lock
  9. Remove token file
  10. Flush pino logger
- Force-exit timeout (10s) prevents indefinite hangs

### Indexing Strategy

- Merkle-based change detection (xxHash64 per file) with mtime pre-filtering: unchanged files are detected in O(1) via filesystem mtime without re-reading or re-hashing
- Only unchanged files are skipped during incremental indexing
- File watcher debounces for 2s to batch rapid saves
- Embedding runs at ~10ms per batch (local ONNX model)

## Benchmark

### Overview

The benchmark measures production search quality on the Reporecall codebase itself using community-standard IR metrics with **graded relevance annotations** (0-3 scale, following CodeSearchNet/TREC conventions). 54 queries across 5 categories (exact_lookup, architecture, flow, debugging, meta), each with human-graded relevance judgments. It runs the full production pipeline (`handlePromptContextDetailed`) — the same code path users experience through the Claude Code hook.

### How to run

```bash
npm run benchmark                                     # keyword mode (fast, ~1s)
npm run benchmark -- --provider semantic              # with vector embeddings
npm run benchmark -- --output results.json            # custom output path
```

### Current results (keyword mode, v0.2.4)

```
╔═══════════════════════════════════════════════════════════════╗
║  Reporecall Live Benchmark (keyword, 54 queries)              ║
╠═══════════════════════════════════════════════════════════════╣
║  NDCG@10: 0.530    MRR: 0.750    MAP: 0.278                   ║
║  P@5: 0.226  P@10: 0.113  R@5: 0.291  R@10: 0.291             ║
╠═══════════════════════════════════════════════════════════════╣
║  By Route        Count   NDCG@10   MRR                        ║
║    R0             20      0.706    0.950                      ║
║    R1             24      0.443    0.667                      ║
║    skip            7       —        —                         ║
║    R2              3      0.058    0.083                      ║
╠═══════════════════════════════════════════════════════════════╣
║  Route accuracy: 81.5%  Avg latency: 4.79ms (P50: 3.69ms)     ║
╚═══════════════════════════════════════════════════════════════╝
```

### What the numbers mean

| Metric             | Value | What it measures                                      | Interpretation                                                  |
| ------------------ | ----- | ----------------------------------------------------- | --------------------------------------------------------------- |
| **NDCG@10**        | 0.530 | Ranking quality of top 10 results (0-1)               | Competitive (CodeSearchNet SOTA: 0.4–0.7)                       |
| **MRR**            | 0.750 | How quickly the first relevant result appears (0-1)   | Strong — first relevant result typically at rank 1              |
| **MAP**            | 0.278 | Average precision across all relevant documents (0-1) | Moderate — room for improvement in recall                       |
| **Route accuracy** | 81.5% | Correct routing (skip/R0/R1/R2) classification        | Good — intent classifier works with zero LLM tokens             |
| **P@5**            | 0.226 | Fraction of top 5 that are relevant                   | Solid — concept bundles and seed boosting surface relevant code |
| **R@10**           | 0.291 | Fraction of all relevant chunks found in top 10       | Moderate — recall improves with semantic embeddings             |

### What this tells us

**R0 queries are strong** (NDCG@10: 0.706, MRR: 0.950) — direct lookups and concept queries benefit most from seed boosting, length penalty, and call graph expansion. The right symbol lands at rank 1 nearly every time.

**R1 flow queries are solid** (NDCG@10: 0.443, MRR: 0.667) — flow tree assembly provides relevant call graph context, though sparse edges limit recall.

**Architecture queries now work** (NDCG@10: 0.564, MRR: 0.750) — concept bundles map broad questions like "what is the storage layer?" directly to the relevant symbols without needing exact keyword matches.

**Remaining gap:** Keyword mode still struggles with queries that have no symbol name anchors at all. Semantic embeddings should close this gap.

**By category:**

| Category     | Count | NDCG@10 | MRR   | Notes                                                                        |
| ------------ | ----- | ------- | ----- | ---------------------------------------------------------------------------- |
| exact_lookup | 14    | 0.753   | 0.929 | Strong — seed boosting surfaces the right symbol at rank 1                   |
| architecture | 7     | 0.564   | 0.750 | Good — concept bundles short-circuit broad questions to relevant code        |
| flow         | 18    | 0.438   | 0.722 | Good — flow tree assembly provides call graph context                        |
| debugging    | 8     | 0.319   | 0.500 | Moderate — length penalty and test filtering improve signal                  |
| meta         | 7     | —       | —     | Skip route validation — greetings, thanks, meta-AI queries correctly skipped |

### What the benchmark does NOT measure

- **Semantic mode quality**: These numbers are keyword-only. Vector embeddings should further improve queries where meaning matters more than exact terms.
- **End-to-end helpfulness**: Whether Claude's answers are actually better with Reporecall context is not measured by IR metrics.

### Methodology

The benchmark:

1. Indexes the Reporecall codebase from scratch (~125 files → ~630 chunks)
2. Runs each query through the full production pipeline: `sanitizeQuery` → `classifyIntent` → `deriveRoute` → `resolveSeeds` → `handlePromptContextDetailed()` (with seed boosting, concept bundles, graph/sibling expansion, and hook priority scoring)
3. Maps each result's chunk name to a human-annotated relevance grade (0-3)
4. Computes standard IR metrics against the ideal ranking

Annotations use the **0-3 graded relevance scale** from CodeSearchNet:

- **3** = highly relevant (the exact function/class being asked about)
- **2** = relevant (directly related code, e.g., a caller or type definition)
- **1** = marginally relevant (tangentially related, might provide useful context)
- **0** = not relevant (default for unannotated results)

Chunk matching uses **symbol names** (not content hashes), disambiguated with `filePath:name` where names collide (e.g., `constructor` appears in many classes).

Results are written to [benchmark-results.json](benchmark-results.json).

## Development

```bash
npm install
npm run build
npm run dev
npm test
npm run lint
npm run benchmark
npm run smoke
```

### Smoke test

`npm run smoke` runs `scripts/smoke-test.mjs` - an end-to-end test of all 10 CLI commands and 11 MCP tools against the current project's `.memory/` index. It exits 0 only when every check passes.

Requirements before running:

```bash
npm run build                          # compile dist/
node dist/memory.js index --project .  # populate .memory/ (if not already indexed)
npm run smoke
```

### Benchmark

See the [Benchmark section](#benchmark) for full methodology and results. Quick reference:

```bash
npm run benchmark                              # keyword mode (~1s)
npm run benchmark -- --provider semantic       # with vector embeddings
npm run benchmark -- --output out.json         # custom output path
```

To update relevance annotations after code changes:

```bash
npx tsx benchmark/annotate.ts --project .       # generates benchmark/annotations-draft.json
# manually grade results 0-3, save as benchmark/annotations.json
```
