# Production Tasks — Reporecall v0.2.0

**Generated:** March 18, 2026 | **Branch:** feat/v0.2.0-routing-concept-bundles
**Total Tasks:** 18 (5 blocking, 7 high-priority, 6 medium/low)
**Estimated Total Effort:** 20-25 hours

---

## 🚨 BLOCKING (Shipping Gate) — Must Complete Before Release

### BLOCK-1: Fix Reranker Pipeline Type
**File:** `src/indexer/embedder.ts` (reranker instantiation)
**Issue:** `reranker.ts:22` uses `"text-classification"` model type instead of `"feature-extraction"`
**Impact:** Reranking is functionally disabled; results may score incorrectly
**Severity:** 🔴 CRITICAL

**Description:**
The reranker initialization loads the wrong pipeline type. This causes the reranking step to silently fail or return incorrect scores.

**Fix:**
```typescript
// Before (broken):
const pipeline = await Pipeline.from_pretrained('Xenova/ms-marco-MiniLM-L-6-v2', {
  task: 'text-classification'  // ❌ WRONG
});

// After (correct):
const pipeline = await Pipeline.from_pretrained('Xenova/ms-marco-MiniLM-L-6-v2', {
  task: 'feature-extraction'  // ✅ CORRECT
});
```

**Test:**
1. Enable reranking in config: `"reranking": true`
2. Run benchmark: `npm run benchmark`
3. Verify reranked results score higher than pre-reranked results
4. Assertion: `rerankedScore > originalScore` should hold

**Estimated Effort:** 30 minutes
**Acceptance:** Reranking produces monotonically increasing scores; no failures in pipeline initialization

---

### BLOCK-2: Fix Async Race Condition in Pipeline
**File:** `src/indexer/pipeline.ts:521`
**Issue:** `closeAndClearMerkle()` fire-and-forgets async `vectors.close()`, races with `reinit()` in MCP `clear_index`
**Impact:** Vector store may be accessed while being closed; data loss possible
**Severity:** 🔴 CRITICAL

**Description:**
When `clear_index` MCP tool is called, it invokes `closeAndClearMerkle()` which starts an async close operation on the vector store. Meanwhile, `reinit()` is called immediately after, which tries to access/reinitialize the vector store. The async close may not have completed, causing a race condition.

**Current Code:**
```typescript
async closeAndClearMerkle() {
  // This is not awaited:
  this.vectors.close().catch(err => {
    this.logger.error(`Failed to close vectors: ${err.message}`);
  });

  // Merkle cleared immediately (before vectors actually closed):
  this.merkle.clear();
}
```

**Fix:**
```typescript
async closeAndClearMerkle() {
  // Await the close operation:
  await this.vectors.close().catch(err => {
    this.logger.error(`Failed to close vectors: ${err.message}`);
  });

  // Only clear Merkle after vectors are actually closed:
  this.merkle.clear();
}

// Update call sites to await:
// In clear_index MCP tool:
await pipeline.closeAndClearMerkle();
await pipeline.reinit();  // Safe to reinit now
```

**Test:**
1. Write test: concurrent `clear_index` + `search` calls
2. Run 100 times: should not crash or lose data
3. Verify vector store is empty after clear
4. Verify new indexing works after clear+reinit

**Estimated Effort:** 45 minutes
**Acceptance:** No race conditions detected; clear+reinit is atomic from caller perspective

---

### BLOCK-3: Make removeFile() Atomic
**File:** `src/storage/metadata-store.ts:59-63`
**Issue:** Three separate DELETEs (chunks, call_edges, imports) run as auto-commit statements, not in a transaction
**Impact:** Orphaned rows possible if process crashes mid-operation
**Severity:** 🔴 HIGH (Data Consistency)

**Current Code:**
```typescript
async removeFile(filePath: string) {
  // Each is a separate auto-commit transaction:
  await this.chunks.removeByFile(filePath);        // DELETE chunks
  await this.callEdges.removeByFile(filePath);     // DELETE call_edges (orphaned!)
  await this.imports.removeByFile(filePath);       // DELETE imports
}
```

**Fix:**
```typescript
async removeFile(filePath: string) {
  // Wrap all deletes in a single transaction:
  const transaction = this.db.transaction(() => {
    // All three deletes now execute atomically:
    this.db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
    this.db.prepare('DELETE FROM call_edges WHERE source_chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)').run(filePath);
    this.db.prepare('DELETE FROM imports WHERE file_path = ?').run(filePath);
  });

  transaction();
}
```

Or simpler:
```typescript
async removeFile(filePath: string) {
  this.db.transaction(() => {
    this.chunks.removeByFile(filePath);
    this.callEdges.removeByFile(filePath);
    this.imports.removeByFile(filePath);
  })();
}
```

**Test:**
1. Create file, index it (creates chunks, edges, imports)
2. Remove file
3. Verify all three tables are empty for that file
4. Verify no orphaned edges or imports

**Estimated Effort:** 15 minutes
**Acceptance:** All related rows deleted atomically; no partial deletes possible

---

### BLOCK-4: Make FTS Upsert Atomic
**File:** `src/storage/fts-store.ts:72-87`
**Issue:** Single-chunk `upsert()` runs DELETE + INSERT without transaction boundary
**Impact:** FTS index can become inconsistent if crash occurs between operations
**Severity:** 🔴 HIGH (Data Consistency)

**Current Code:**
```typescript
upsert(id: string, name: string, content: string, filePath: string, kind: string) {
  // Two separate statements, not in a transaction:
  this.deleteStmt.run(id);
  this.insertStmt.run(id, name, content, filePath, kind);
}
```

**Fix:**
```typescript
upsert(id: string, name: string, content: string, filePath: string, kind: string) {
  this.db.transaction(() => {
    this.deleteStmt.run(id);
    this.insertStmt.run(id, name, content, filePath, kind);
  })();
}
```

**Test:**
1. Index file with FTS
2. Upsert chunk (DELETE + INSERT)
3. Query FTS with terms from inserted content
4. Verify search returns correct results (not partially indexed)

**Estimated Effort:** 15 minutes
**Acceptance:** FTS upsert produces consistent index; queries return expected results

---

### BLOCK-5: Verify All Fixes with Full Test Suite
**Action:** Run full test suite after each fix to catch regressions

```bash
npm test
```

**Expected:** 525/525 tests passing

**Estimated Effort:** 10 minutes per run (run after each of blocks 1-4)

---

## 🔴 HIGH-PRIORITY (Complete for v0.2.1) — Next 7 Tasks

### HP-1: Fix N+1 Query in Seed Resolution
**File:** `src/search/seed.ts:338, 381`
**Issue:** FTS fallback loop calls `metadata.getChunk(ftsResult.id)` per result (~10 queries)
**Impact:** ~50ms latency on hot search path
**Effort:** 30 minutes

**Current:**
```typescript
for (const ftsResult of ftsResults.slice(0, 10)) {
  const chunk = metadata.getChunk(ftsResult.id);  // 1 SELECT per result
  // ...process chunk...
}
```

**Fix:**
```typescript
const ids = ftsResults.slice(0, 10).map(r => r.id);
const chunks = metadata.getChunksByIds(ids);  // 1 batched SELECT

for (const chunk of chunks) {
  // ...process chunk...
}
```

**Test:** Benchmark seed resolution latency before/after; verify ≥20ms improvement

---

### HP-2: Add Composite Index for Chunk Sorting
**File:** `src/storage/chunk-store.ts` (schema init)
**Issue:** `findChunksByFilePath()` query `ORDER BY start_line` not covered by index
**Impact:** 5-10ms improvement in file chunk retrieval
**Effort:** 20 minutes

**Fix:**
```sql
CREATE INDEX IF NOT EXISTS idx_chunks_file_line
  ON chunks(file_path, start_line);
```

Add to the `initializeSchema()` function after existing index creation.

**Test:** Run test suite; verify no breakage

---

### HP-3: Optimize Stats Pruning Query
**File:** `src/storage/stats-store.ts:40-55`
**Issue:** `NOT IN` subquery is O(n); runs on every latency recording
**Impact:** Reduces write amplification
**Effort:** 20 minutes

**Current:**
```sql
DELETE FROM search_latencies
WHERE id NOT IN (
  SELECT id FROM search_latencies
  ORDER BY id DESC LIMIT 1000
)
```

**Fix:**
```sql
DELETE FROM search_latencies
WHERE id < (
  SELECT MIN(id) FROM (
    SELECT id FROM search_latencies
    ORDER BY id DESC LIMIT 1000
  )
)
```

**Test:** Verify latencies are still capped at 1000 rows; query is faster

---

### HP-4: Cache Prepared Statements
**Files:** `src/storage/chunk-store.ts`, `src/storage/fts-store.ts`
**Issue:** Frequent `db.prepare()` calls rely on internal better-sqlite3 cache
**Impact:** 1-2ms per search on large indexes
**Effort:** 1 hour

**Example (ChunkStore):**
```typescript
class ChunkStore {
  private readonly selectByIdStmt: Statement;
  private readonly getChunkScoringInfoStmt: Statement;

  constructor(db: Database) {
    this.selectByIdStmt = db.prepare('SELECT * FROM chunks WHERE id = ?');
    this.getChunkScoringInfoStmt = db.prepare(
      'SELECT id, name, file_path, kind, start_line, end_line, depth FROM chunks WHERE id IN (...)'
    );
  }

  getChunk(id: string): StoredChunk {
    return this.selectByIdStmt.get(id) as StoredChunk;
  }
}
```

**Test:** Verify search latency; should see 1-2ms improvement

---

### HP-5: Enable Foreign Key Constraints
**File:** `src/storage/sqlite-utils.ts`
**Issue:** No FOREIGN KEY constraint between chunks and files; orphaned chunks possible
**Impact:** Catch orphaned chunks at insert time
**Effort:** 30 minutes

**Fix:**
```typescript
// In initializePragmas():
this.db.pragma('foreign_keys = ON');

// In chunk-store.ts initializeSchema():
ALTER TABLE chunks ADD CONSTRAINT fk_chunks_files
  FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE;
```

**Test:** Attempt to insert chunk with non-existent file_path; should fail with FOREIGN KEY constraint error

---

### HP-6: Tune WAL Pragmas for Performance
**File:** `src/storage/sqlite-utils.ts`
**Issue:** WAL pragmas not optimized; full re-index throughput suboptimal
**Impact:** 10-20% improvement in re-index throughput
**Effort:** 30 minutes

**Current:**
```typescript
this.db.pragma('journal_mode = WAL');
this.db.pragma('busy_timeout = 5000');
```

**Add:**
```typescript
// In initializePragmas():
this.db.pragma('synchronous = NORMAL');      // Safe with WAL; faster than FULL
this.db.pragma('cache_size = -32000');       // 32MB instead of 2MB default
this.db.pragma('temp_store = MEMORY');       // Temp tables in memory
this.db.pragma('mmap_size = 30000000');      // Memory-mapped I/O for large datasets
```

**Test:** Benchmark full re-index before/after; verify throughput improvement

---

### HP-7: Deduplicate isTestFile() Function
**Files:** `src/search/seed.ts`, `src/search/tree-builder.ts`
**Issue:** `isTestFile()` copied verbatim in two places
**Impact:** Maintainability; inconsistent updates risk
**Effort:** 20 minutes

**Fix:** Extract to `src/core/test-utils.ts`:
```typescript
export function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return /(?:^|\/)(test|spec|__tests__|__fixtures__|fixtures|benchmark|examples)\//.test(lower)
    || /\.(test|spec)\.[^.]+$/.test(lower);
}
```

Then import in both files.

**Test:** Verify existing tests still pass

---

## 🟡 MEDIUM PRIORITY (v0.3+) — 6 Tasks

### MP-1: Extract Long Functions
- `daemon/server.ts:770` — Prompt-context handler (240 lines)
- `indexer/pipeline.ts` — File cleanup loop
- Extract route handlers for readability

**Effort:** 3-4 hours

### MP-2: Fix Flaky Tests (5 files)
- `rwlock.test.ts`, `scheduler.test.ts`, `rate-limit.test.ts`, `server.test.ts` — Timing-based assertions
- Replace sleep-based assertions with condition polling or test harness

**Effort:** 2 hours

### MP-3: Add Reranker Success-Path Test Coverage
- `reranker.test.ts` currently only tests failure path
- Add test for successful re-ranking with valid inputs

**Effort:** 1 hour

### MP-4: Fix Test Regex Divergence
- `ranker.ts:97`, `hybrid.ts:383,411` — Different test-path patterns
- Standardize on single `isTestFile()` pattern (see HP-7)

**Effort:** 30 minutes

### MP-5: Add Composite Indexes for Other Hot Queries
- `idx_call_edges_source` already covers callees; verify with EXPLAIN QUERY PLAN
- Consider adding `idx_imports_name_file` if not present

**Effort:** 1 hour

### MP-6: Improve Error Handling
- Replace string-match error classification with typed error classes
- Example: `msg.includes('embedding')` → `error instanceof EmbeddingError`

**Effort:** 2-3 hours

---

## 📚 Documentation Tasks (LP-1 to LP-4)

### LP-1: Hook System Integration Guide
- Document how Claude Code calls the daemon
- Example: POST /hooks/prompt-context flow
- Debugging guide for hook issues

**Effort:** 2 hours

### LP-2: Route Decision Documentation
- Flowchart: when R0 vs R1 vs R2
- Seed confidence thresholds
- Fallback semantics

**Effort:** 1 hour

### LP-3: MCP Tool Examples
- Expected inputs/outputs for each tool
- Error handling examples
- Integration examples

**Effort:** 2 hours

### LP-4: Troubleshooting Guide
- Common issues and remediation
- Debug mode usage
- Performance profiling tips

**Effort:** 1.5 hours

---

## 🔧 CI/CD & Automation (LP-5, LP-6)

### LP-5: Add Performance Regression CI
- GitHub Actions: run `npm run benchmark` on every PR
- Track: top-1 accuracy, latency p50/p95, token usage
- Fail on regression > threshold

**Effort:** 3 hours

### LP-6: Pre-Commit Hook
- Run linter + type check + unit tests
- Block commit on failures

**Effort:** 1 hour

---

## ✅ Rollout Plan

### Phase 1: Blocking Fixes (2 hours) — Week of 3/18
```bash
# BLOCK-1 through BLOCK-5
npm test  # 525/525 must pass
npm run lint && npm run build  # No errors
```

### Phase 2: v0.2.1 Release (8-10 hours) — Week of 3/25
```bash
# HP-1 through HP-7
npm test
npm run benchmark
# Compare benchmark results; verify improvements
```

### Phase 3: v0.3 Release (10+ hours) — Week of 4/1+
```bash
# MP-1 through MP-6
# LP-1 through LP-6
```

---

## Success Criteria

### Before Shipping v0.2.0
- [ ] BLOCK-1 through BLOCK-5 completed
- [ ] 525/525 tests passing
- [ ] Build succeeds (npm run build)
- [ ] No TypeScript errors (npm run lint)
- [ ] Manual testing on real codebase (≥1000 LOC)
- [ ] Benchmark results stable (no regressions)
- [ ] Release notes document critical fixes

### Before Shipping v0.2.1
- [ ] HP-1 through HP-7 completed
- [ ] Performance benchmark shows improvements (≥20ms for N+1 fix)
- [ ] All 525 tests still passing
- [ ] No new issues introduced

### Before Shipping v0.3
- [ ] All MP and LP tasks completed
- [ ] Zero flaky tests
- [ ] 100% of security tests passing
- [ ] Performance regression CI in place and tracking

---

## Estimated Timeline

| Phase | Tasks | Effort | Target Date |
|-------|-------|--------|-------------|
| 1 | BLOCK-1 to BLOCK-5 | 2 hours | 2026-03-19 |
| 2 | HP-1 to HP-7 | 8-10 hours | 2026-03-26 |
| 3 | MP-1 to MP-6 + LP-1 to LP-6 | 15-20 hours | 2026-04-02 |

**Total: 25-32 hours of engineering work**

---

## Approved By
- [ ] Code Owner
- [ ] Release Manager
- [ ] QA Lead

**Document Version:** 1.0
**Last Updated:** 2026-03-18
**Next Review:** 2026-03-25
