# Changelog

## [0.3.3] — 2026-03-21

### Fixes

- **Session-start wording** — Session instruction now uses tool-neutral wording ("use whichever tool fits") matching CLAUDE.md, instead of prioritizing MCP tools over Grep/Read.
- **Context header directive** — R0 "Only fetch files NOT listed above" directive now conditional on file list being non-empty. Empty results no longer show a misleading directive.
- **"X in Y" seed disambiguator** — Regex now gates on identifier-like capture groups (camelCase, snake_case, PascalCase). No longer fires on natural language like "errors in production" or "logged in user".
- **PreToolUse hook** — Reverted hard deny to soft echo nudge. Agents and subagents no longer blocked; nudge reminds Claude that context was already injected.
- **CLAUDE.md template** — Tool-neutral 3-point instruction chain: answer from context, fill gaps with any tool, avoid redundant searches.
- **R0/R1/R2 context headers** — All routes now include `> Files included:` line listing injected file paths, so Claude (and PreToolUse nudge) can see what's already in context.

### Improvements

- **Intent classifier** — Tightened route thresholds and seed scoring for more accurate R0/R1/R2 classification.
- **Memory dedup** — FTS dedup fix, query expansion fix, working memory timestamps.
- **Arrow function naming** — Object literal arrow functions now named after their property key in the chunker.

## [0.3.0] — 2026-03-21

### Features

- **Memory V1** — Persistent cross-session memory layer for project knowledge, user preferences, conventions, and working state. Memories stored as markdown in `.memory/reporecall-memories/`, indexed with FTS, injected alongside code context. Budget-controlled per memory class (rule/fact/episode/working).
- **7 new MCP tools** — `recall_memories`, `store_memory`, `forget_memory`, `list_memories`, `explain_memory`, `compact_memories`, `clear_working_memory`.
- **Memory runtime** — Automatic memory directory watching, compaction, fact promotion, and working memory generation while daemon runs.
- **Target resolution catalog** — New `TargetStore` indexes symbols, file modules, endpoints, and routes with alias-based lookup. Enables literal-dispatch resolution (e.g., `invoke("generate-image")` resolves to the handler file).
- **Broad workflow search** — New `selectBroadWorkflowBundle` for architecture and inventory queries. Includes corpus-aware term expansion, dominant family detection, and import corroboration.

### Performance

- **Seed resolution cache** — Thread resolved `SeedResult` through all call sites. Eliminates 2-3 redundant `resolveSeeds()` calls per search (~8-15ms saved per query).
- **Query embedding LRU cache** — 50-entry LRU cache on `HybridSearch` for query embeddings. Saves 15-40ms (local) or 50-200ms (Ollama/OpenAI) per cache hit. Cache cleared on `updateStores()` to prevent stale vectors after re-index.

### Fixes

- **System tag stripping** — `sanitizeQuery` now strips `<system-reminder>`, `<task-notification>`, `<tool-result>`, and `antml:*` XML blocks that Claude Code injects into hook payloads. Also strips bare temp-dir paths and "Read the output file" boilerplate.
- **Conversational query skip** — Intent classifier now skips short conversational directives ("ok", "go ahead", "check if it worked") that previously triggered irrelevant retrieval.
- **safeHeaderValue** — X-Memory-Debug headers strip non-printable ASCII to prevent `setHeader` throws.
- **Chunker crash resilience** — Tree-sitter parse errors fall back to whole-file chunks instead of crashing.
- **Deno.serve() handler naming** — Arrow function callbacks named `serve_handler` instead of `<anonymous>`.
- **ollamaUrl validation** — Fixed IPv6 localhost check (`[::1]` -> `::1`).
- **Fallback chunk language** — File-level fallback chunks preserve detected language instead of returning null.

### Refactoring

- **Session-start slimmed** — No longer performs code search on session start; returns only behavior instruction + conventions summary.
- **FTS search strategy overhaul** — Rarest-term anchoring, camelCase compound phrase matching, selective OR with document-frequency filtering, stop word removal.
- **Index format versioning** — Automatic full rebuild on format mismatch.

### Benchmarks

- Route accuracy improved: 81.5% -> 87%
- R2 broad queries improved significantly: NDCG 0.058 -> 0.351
- R0 exact lookup regressed (under investigation — memory-system symbols polluting annotations)

## [0.2.5] — 2026-03-19

### Fixes

- **Kotlin parser** — Grammar doesn't expose `name` field on declarations. Added fallback in `extractName()` to scan for `simple_identifier`/`type_identifier` children. All Kotlin classes, objects, interfaces, and functions now produce named chunks instead of `<anonymous>`.
- **Zig parser** — `extractableTypes` listed non-existent node names (`FnProto`, `TestDecl`, `ContainerDecl`). Fixed to `function_declaration`, `test_declaration` matching the actual tree-sitter-zig grammar.
- **Lua parser** — Same issue: `function_declaration`/`local_function` don't exist in tree-sitter-lua. Fixed to `function_definition_statement`, `local_function_definition_statement`.
- **Zig test names** — `test_declaration` nodes now extract the test name from the string child instead of producing `<anonymous>`.
- **Kotlin parent names** — `extractParentName()` now uses `extractName()` for consistent name resolution, and recognizes `object_declaration` as a parent container.
- **`object_declaration` container** — Added to `CONTAINER_TYPES` so methods inside Kotlin objects are extracted as individual chunks.

### Improvements

- Chunk count increased (745 → 755 on self-index) due to Zig/Lua now producing proper function-level chunks instead of whole-file fallbacks.
- Benchmark scores improved: NDCG 0.530 → 0.548 (+3.4%), MRR 0.750 → 0.777 (+3.6%).

### Tests

- 618 tests across 45 test files (up from 594/44)
- **22-language chunker tests** — fixture files and assertions for every supported language: TypeScript, TSX, JavaScript, Python, Go, Rust, Java, Ruby, C, C++, C#, PHP, Swift, Kotlin, Scala, Zig, Bash, Lua, HTML, Vue, CSS, TOML. Plus cross-language invariant checks (stable IDs, required fields).
- **22-language full pipeline integration tests** — end-to-end index → FTS search → chunk retrieval for every language, verifying chunks are not just parseable but actually searchable and retrievable.

## [0.2.4] — 2026-03-19

### Fixes

- **Graph expansion in hook context** — `searchWithContext()` now enables graph expansion (`graphTopN: 5`), surfacing callers/callees in hook-injected context. Previously hardcoded to `graphExpansion: false`.
- **Test file penalty unification** — Replaced directory-only regex with `isTestFile()` utility (catches `.test.ts`/`.spec.ts` suffixes). Replaced hardcoded `TEST_PENALTY = 0.35` with `config.testPenaltyFactor`.
- **Score floor ratio** — Lowered from 0.7 to 0.55 to compensate for generally lower scores after new penalties.

### Improvements

- **Length penalty in RRF fusion** — Chunks >80 lines now penalized at the fusion stage (formula: `80 / (lineCount * 0.8 + 16)`), not just in hook priority. Prevents large chunks from dominating early ranking.
- Added `chunkLineRanges` to `ScoringMaps` and `ChunkScoringInfo` for length-aware ranking.
- Added `graphTopN` option to `SearchOptions` for configurable graph expansion limits.

## [0.2.3] — 2026-03-18

### Fixes

- **Retrieval quality regression fix** — Large AST chunks (500+ line functions) no longer dominate search results. Added `MAX_CHUNK_LINES = 200` truncation in chunker and length penalty in hook priority scoring.
- **pnpm/yarn wasm resolution** — Tree-sitter grammar loading now uses `createRequire` as primary resolution strategy, fixing AST parsing in pnpm and yarn PnP projects.

## [0.2.1] — 2026-03-18

### Fixes

- Fix peer dependency conflict: downgrade `apache-arrow` from `^21.1.0` to `^18.1.0` (lancedb only supports `<=18.1.0`)
- Bump `@lancedb/lancedb` from `^0.26.2` to `^0.27.0`

## [0.2.0] — 2026-03-18

### Features

- **Intent-based query routing (R0/R1/R2)** — Queries are classified by intent and routed through specialized pipelines: R0 (exact lookup), R1 (targeted search with seed resolution), R2 (broad exploration). Routing is automatic based on query structure.
- **Concept bundles** — 8 built-in concept bundles (AST, call graph, search pipeline, storage, daemon, embedding, CLI, context assembly) that inject relevant symbol definitions when queries match a bundle pattern. User-configurable via `.memory/config.json`.
- **Flow tree construction** — `build_stack_tree` MCP tool and `explain` CLI command for visualizing call chains (callers/callees) as tree structures with cycle detection and coverage scoring.
- **Import graph analysis** — New `ImportStore` tracks cross-file imports. `get_imports` and `find_callers` MCP tools leverage import edges for more accurate call graph traversal.
- **Seed resolution** — Explicit target extraction from queries (e.g., `"how does createParser work"` → seeds on `createParser` symbol). Seeds boost retrieval precision for targeted questions.
- **Deep route context assembly** — R1/R2 routes assemble context using graph expansion, sibling chunks, and concept bundles for richer, more relevant context windows.
- **`explain` CLI command** — Interactive call-chain explorer: `reporecall explain functionName` shows callers, callees, or full stack trees.
- **`stats` CLI command** — Quick summary of indexed files, chunks, and storage size.
- **Dynamic context budget** — Context token budget now auto-scales based on index size: `clamp(1500 + chunks × 2.5, 2000, 6000)`. Small projects get lean context (~2K tokens), large projects get richer context (~4-6K tokens). User override via `contextBudget` in `.memory/config.json` is always respected. Set to `0` (new default) for auto-scaling.

### Security

- Path traversal prevention in `resolveImportPath` — resolved paths validated against project root
- Absolute path injection guard in import resolution
- `ollamaUrl` restricted to localhost via Zod `.refine()` — prevents SSRF
- ReDoS protection for both `factExtractors` and `conceptBundles` patterns via `safe-regex2`
- Symlink escape prevention in MCP `isPathSafe` via `realpathSync`
- Zod `.int().min(1)` validation on all MCP tool numeric parameters
- `Cache-Control: no-store` on all JSON responses
- Shell injection prevention in `init` command path interpolation
- Log injection fix: raw query used in log hooks instead of user-controlled input
- Silent catch blocks replaced with `log.warn` for error visibility

### Improvements

- Prepared statement caching in `ImportStore`, `CallEdgeStore`, `FTSStore` — reduces SQLite overhead
- `ConceptContextKind` broadened to 8 explicit kinds + extensible `(string & {})`
- Iterative BFS for down-traversal in tree builder (was recursive)
- `STOP_WORDS` consolidated into single shared constant
- `drain()` race condition fixed in `IndexScheduler` — checks both `processing` and `flushScheduled`
- Dead exported types removed (`EmbeddingResult`, `VectorRecord`)
- Redundant `freeEncoder()` call removed from `serve.ts` (already in `pipeline.closeAsync()`)
- Unreachable null guard removed from `buildDeepRouteContext`
- `SELF_REFS` set hoisted to module scope in `resolve.ts`
- Hook log write failures now logged instead of silently swallowed
- `--budget [tokens]` CLI flag now accepts optional value — omit for auto-scaling, pass a number for explicit override
- README accuracy fixes: score floors, language count, latency numbers, benchmark claims
- Removed redundant `SETUP.md` — content consolidated into `README.md`

### Tests

- 572 tests across 43 test files (up from base v0.1.0 suite)
- New test suites: `resolve.test.ts`, `imports.test.ts`, `seed.test.ts`, `tree-builder.test.ts`, `intent.test.ts`, `flow-context.test.ts`, `routing.test.ts`, `import-store.test.ts`, `mcp-server.test.ts`, `explain.test.ts`, `reranker.test.ts`, `prompt-context-routes.test.ts`
- Self/super receiver test cases added
- Reranker test reliability improved with proper timeouts

## [0.1.0] — 2026-03-17

Initial release. Local codebase memory engine for Claude Code and MCP.

- 22-language Tree-sitter parsing with call extraction
- Hybrid search (vector + keyword + recency via RRF)
- SQLite FTS5 full-text search
- LanceDB vector store with local embeddings
- MCP server with 6 tools (search_code, index_codebase, get_stats, clear_index, find_callers, find_callees)
- File watcher with debounced incremental indexing
- Claude Code hook integration (`prompt_context`, `session_start`)
- Configurable via `.memory/config.json`
