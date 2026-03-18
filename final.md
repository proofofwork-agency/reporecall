# Reporecall v0.2.0 — Implementation Tracker

**Started:** 2026-03-18 | **Branch:** feat/v0.2.0-routing-concept-bundles
**Source:** verdict.md + PRODUCTION_TASKS.md
**Build:** tsc --noEmit clean (0 errors) | **Tests:** 548/548 passing

---

## Tier 0 — Ship Blockers — 8/8 COMPLETE

- [x] **T0-1**: Fix reranker pipeline type `text-classification` → `feature-extraction` — `src/search/reranker.ts:22`
- [x] **T0-2**: Fix MCP tool name in R2 header `resolve_seeds` → `resolve_seed` — `src/search/context-assembler.ts:524`
- [x] **T0-3**: Pass rwLock as 5th arg to createMCPServer — `src/cli/serve.ts:269-273`
- [x] **T0-4**: Wrap MetadataStore.removeFile in single db.transaction() — `src/storage/metadata-store.ts:59`
- [x] **T0-5**: Wrap FTS upsert() DELETE+INSERT in transaction — `src/storage/fts-store.ts:72-87`
- [x] **T0-6**: Make closeAndClearMerkle async; await closeAsync() — `src/indexer/pipeline.ts:521`
- [x] **T0-7**: Gate _debug response field behind debugMode flag — `src/daemon/server.ts`
- [x] **T0-8**: Fix hook skip response format: use nested hookSpecificOutput — `src/daemon/server.ts:499,629`

## Tier 1 — Pre-Release — 19/19 COMPLETE

- [x] **T1-1**: Thread SeedResult through call chain; eliminate redundant resolveSeeds — `server.ts, prompt-context.ts, hybrid.ts`
- [x] **T1-2**: Make logHook writes fire-and-forget (drop await) — `src/daemon/server.ts`
- [x] **T1-3**: Add WAL pragmas: synchronous=NORMAL, cache_size=-65536, temp_store=MEMORY, mmap_size=268435456 — `src/storage/sqlite-utils.ts`
- [x] **T1-4**: Cache prepared statements as class fields in all stores — `src/storage/*.ts`
- [x] **T1-5**: Batch getChunk calls in seed FTS fallback (N+1 → 1) — `src/search/seed.ts:338,381`
- [x] **T1-6**: Add idx_call_edges_file index — `src/storage/call-edge-store.ts`
- [x] **T1-7**: Use bulkUpsert for FTS + chunks in indexChanged — `src/indexer/pipeline.ts:391-399`
- [x] **T1-8**: Add z.string().min(1) to MCP tool query schemas (6 fields) — `src/daemon/mcp-server.ts`
- [x] **T1-9**: Add destructiveHint: true to index_codebase — `src/daemon/mcp-server.ts`
- [x] **T1-10**: Wrap index_codebase tool body in lock.withWrite() — `src/daemon/mcp-server.ts:121`
- [x] **T1-11**: Add retry limit (max 3) to scheduler with dead-letter logging — `src/daemon/scheduler.ts:62`
- [x] **T1-12**: Fix `if (options.maxChunks)` falsy check to `!== undefined` — `serve.ts:63, search.ts:38`
- [x] **T1-13**: Fix maxContextChunks NaN guard in serve.ts — `src/cli/serve.ts:64`
- [x] **T1-14**: Fix standalone mcp.ts to use closeAsync() + pass ReadWriteLock — `src/cli/mcp.ts`
- [x] **T1-15**: Extract shared isTestPath() utility — `src/search/utils.ts (new)`
- [x] **T1-16**: Add UNIQUE constraint to imports table — `src/storage/import-store.ts`
- [x] **T1-17**: Emit freeEncoder() in pipeline shutdown — `src/indexer/pipeline.ts`
- [x] **T1-18**: Fix --autostart platform guard — error on non-macOS — `src/cli/init.ts`
- [x] **T1-19**: Update ftsInitialized flag after recovery re-index — `src/cli/serve.ts`

## Tier 2 — v0.2.1 Patch — 24/24 COMPLETE

- [x] **T2-1**: Rewrite init.test.ts to test real initCommand — `test/cli/init.test.ts`
- [x] **T2-2**: Add integration test for concept bundle path — `test/integration/routing.test.ts`
- [x] **T2-3**: Add test for reranker success path — `test/search/reranker.test.ts`
- [x] **T2-4**: Add assertions to mode-comparison.test.ts — `test/benchmark/mode-comparison.test.ts`
- [x] **T2-5**: Fix tautological assertion in seed.test.ts:355 — `test/search/seed.test.ts`
- [x] **T2-6**: Fix routing.test.ts state-sharing across it() blocks — `test/integration/routing.test.ts`
- [x] **T2-7**: Atomic stat increment SQL (INSERT ON CONFLICT DO UPDATE) — `stats-store.ts, server.ts`
- [x] **T2-8**: Remove contentTerms2 duplicate in seed.ts:153 — `src/search/seed.ts`
- [x] **T2-9**: Move KIND_RANK to module-level constant — `src/search/seed.ts`
- [x] **T2-10**: Add kind to findCallers JOIN result — `src/storage/call-edge-store.ts`
- [x] **T2-11**: Add R2 queries to benchmark (at least 3) — `benchmark/`
- [x] **T2-12**: Enable PRAGMA foreign_keys = ON + schema constraints — `src/storage/sqlite-utils.ts`
- [x] **T2-13**: Enable noUncheckedIndexedAccess in tsconfig + fix guards — `tsconfig.json`
- [x] **T2-14**: Add Zod validation to conventions-store.ts:15 JSON.parse — `src/storage/conventions-store.ts`
- [x] **T2-15**: Add shape guard to merkle.ts:31 JSON.parse — `src/indexer/merkle.ts`
- [x] **T2-16**: Fix `(h: any)` to `(h: unknown)` in init.ts:123 — `src/cli/init.ts`
- [x] **T2-17**: Make concept bundles configurable (MemoryConfig) — `hybrid.ts, config.ts`
- [x] **T2-18**: Add .mcp.json example to project root — `project root`
- [x] **T2-19**: Add MCP test coverage for get_imports and resolve_seed — `test/daemon/mcp-server.test.ts`
- [x] **T2-20**: Adopt PRAGMA user_version for schema versioning — `src/storage/*.ts`
- [x] **T2-21**: Add init --port option — `src/cli/init.ts`
- [x] **T2-22**: Use fs.stat mtime pre-filter in Merkle hash computation — `src/indexer/merkle.ts`
- [x] **T2-23**: Pre-warm local embedder during daemon startup — `src/cli/serve.ts`
- [x] **T2-24**: Batch getChunksByIds per-level in tree traversal — `src/search/tree-builder.ts`

---

**Progress:** 51/51 COMPLETE | 548/548 tests passing | 0 TypeScript errors
**Status:** ALL TASKS DONE

## Fleet Summary

**24 specialized agents deployed:**
- 8x developer agents — core fixes and features
- 3x test-engineer agents — test rewrites and coverage
- 2x typescript-pro agents — type safety and strictness
- 2x database-optimization agents — SQLite performance
- 1x mcp-expert agent — MCP validation and annotations
- 1x sql-pro agent — query atomicity
- 1x code-issue-fixer agent — post-integration test repairs
- 6x additional agents for remaining tasks

**Files modified:** 40+ source files across src/, test/, and config
**Tests added:** 23 new tests (548 total, up from 525)
