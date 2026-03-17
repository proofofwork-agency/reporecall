# Reporecall v0.2 — Task List

## Phase 1: Skip Gate + Observability
- [x] Task 1: Intent classifier (`src/search/intent.ts`) — 75 tests
- [x] Task 2: Skip gate hook integration (`src/daemon/server.ts`)
- [x] Task 3: Observability — route stats, token accounting, debug records
- [x] Task 4: `reporecall explain` CLI command

## Phase 2: Call Graph Quality
- [x] Task 5: Receiver capture in call edge extraction
- [x] Task 6: TS/JS import tracking — 20 tests
- [x] Task 7: Call target resolution + is_exported — 8 tests

## Phase 3: Flow-Aware Retrieval
- [x] Task 8: Seed resolution (`src/search/seed.ts`) — 15 tests
- [x] Task 9: Bidirectional tree builder (`src/search/tree-builder.ts`) — 11 tests
- [x] Task 10: Flow bundle assembly + route integration — 18 tests
- [x] Task 11: Stack discovery MCP tools — 3 new tools

## Phase 4: Testing + Validation
- [x] Task 12: Integration tests — 22 tests
- [x] Task 13: Benchmark suite + regression guard — 28 queries
