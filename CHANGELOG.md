# Changelog

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
- README accuracy fixes: score floors, language count, latency numbers, benchmark claims

### Tests

- 561 tests across 43 test files (up from base v0.1.0 suite)
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
