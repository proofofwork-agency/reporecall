# RepoRecall — Full-Project Flaw & Issue Audit

**Project:** `@proofofwork-agency/reporecall` v0.9.0 (local-first context + memory layer for coding agents)
**Scope:** entire `src/` tree (142 TS files) + `bin/`, with supporting config/quality checks
**Branch:** `main` (HEAD `2c0e616`, plus uncommitted `toPosixPath` Windows-portability work)
**Date:** Aug 2026

---

## 0. Executive summary

The codebase is in **good engineering shape** at the static-analysis and test level, but contains **several latent, high-impact bugs** that its current test suite cannot catch. The most damaging are:

1. **`docstringCoverage` schema mismatch silently disables the entire conventions feature** for any real project (produces 0–100, validates `max(1)`). *(verified)*
2. **Python docstrings are never extracted** — wrong AST traversal. *(verified)*
3. **Lens HTML dashboard has a stored-XSS bypass** via incomplete `</script>` escaping. *(verified)*
4. **Windows path-portability migration is incomplete** — the chunker re-derives backslash paths, undoing the scanner's new POSIX normalization, which breaks cross-store lookups on Windows. *(verified; directly related to the uncommitted work in the working tree)*
5. **Non-atomic `persistWindow`** can delete chunks/edges/FTS rows then fail to re-insert them mid-window. *(verified)*

Everything below is substantiated with code evidence. Items marked **[VERIFIED]** were re-read and confirmed against source by the reviewer; items marked **[REPORTED]** come from focused subsystem audits and are cited with `file:line` for follow-up.

---

## 1. Baseline health (automated gates)

| Gate | Command | Result |
|------|---------|--------|
| Type-check | `npm run typecheck` | ✅ clean |
| Lint (0 warnings) | `npm run lint` | ✅ clean |
| Unit/integration tests | `npm test -- --run` | ✅ 949/949 pass (82 files) |

**Important implication:** every issue in this report is a **latent defect that the existing tests do not cover**. The two most impactful bugs (#1 and #4) are missed for concrete, fixable reasons — see §6 "Test gaps".

---

## 2. Findings — High severity

### H1. `docstringCoverage` schema mismatch silently breaks the conventions feature  **[VERIFIED]**
- **Producer** `src/analysis/conventions.ts:110-112` — emits a **percentage (0–100)**:
  ```ts
  const docstringCoverage = totalDocstringable > 0
    ? Math.round((totalWithDocstring / totalDocstringable) * 100)
    : 0;
  ```
- **Validator** `src/storage/conventions-store.ts:10` — validates as a **fraction (0–1)**:
  ```ts
  docstringCoverage: z.number().min(0).max(1),
  ```
- **Effect:** `setConventions()` stores e.g. `{"docstringCoverage": 50, ...}`. `getConventions()` runs `ConventionsSchema.parse(...)`, which throws for any value > 1; the surrounding `catch { return undefined }` (line 33) **silently swallows** it. Result: every consumer — `src/cli/conventions.ts`, `src/hooks/session-start.ts`, `src/daemon/mcp-server.ts` — receives `undefined` for **any project that has at least one docstring**. The conventions feature is effectively dead in production.
- **Why tests miss it:** `test/integration/full-pipeline.test.ts` uses a fixture whose single function has no docstring (coverage = 0, which fits `max(1)`); `test/hooks/handlers.test.ts` uses `75` but mocks the metadata store, bypassing the schema.
- **Fix:** `conventions-store.ts:10` → `z.number().min(0).max(100)`. Add a round-trip test with coverage > 1.

### H2. Python docstrings are never extracted  **[VERIFIED]**
- `src/parser/chunker.ts:133-142` `extractDocstring` only inspects `node.previousNamedSibling`:
  ```ts
  const prev = node.previousNamedSibling;
  if (prev && docTypes.includes(prev.type)) return prev.text;
  ```
- For Python, `docstringTypes: ["expression_statement"]` (`src/parser/languages.ts:60`). But a Python docstring is the **first child of the function/class `block`**, not a previous sibling. `previousNamedSibling` for a `function_definition` returns whatever precedes it (usually nothing), never the inner docstring.
- All other supported languages use comment-style docstrings placed *above* the declaration, where `previousNamedSibling` is correct — **Python is the lone exception**.
- **Impact:** Python `docstringCoverage` is structurally 0% (compounds H1); Python chunk embeddings never include docstring text, degrading semantic search quality on Python repos.
- **Fix:** When `node.type` is `function_definition`/`class_definition`, descend into `node.childForFieldName("body")` and inspect its first named child for an `expression_statement` holding a string literal.

### H3. Lens HTML dashboard — stored-XSS via incomplete `</script>` escaping  **[VERIFIED]**
- `src/visualize/html-template.ts:15`:
  ```ts
  const dataJSON = JSON.stringify(data).replace(/<\/script>/gi, "<\\/script>");
  ```
- Per the HTML spec, a `<script>` element is terminated by `</script` followed by **any** of TAB/LF/FF/CR/SPACE/`>`/`/`. The regex only matches the literal `</script>`. Sequences like `</script\n>`, `</script\t>`, `</script/>`, `</script >` **do** terminate the block but are **not** escaped.
- **Trigger:** index a repo (including a cloned/third-party one) containing a file path, code chunk, or wiki body with such a sequence; opening `lens.html` executes attacker-controlled JS in the browser under a `file://` origin.
- **Note:** the *client-side* DOM rendering (textContent assignments, `renderMarkdownSafe`) is correctly safe — the only vector is the JSON→`<script>` embedding.
- **Fix:** standard safe-embedding:
  ```ts
  JSON.stringify(data)
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  ```

### H4. Windows path-portability migration is incomplete — chunker re-introduces backslashes  **[VERIFIED]**
- The uncommitted `toPosixPath` work correctly normalizes the **scanner** (`src/indexer/file-scanner.ts:101` → `relativePath: safePath.posixRelativePath`) so the Merkle key is POSIX.
- But `src/parser/chunker.ts:221` **re-derives** the relative path from the absolute path:
  ```ts
  const relPath = relative(projectRoot, filePath);
  ```
  On Windows, `path.relative` returns **backslash** paths. This `relPath` becomes `chunk.filePath` (line 235) and the hash key (line 232). Consequently:
  - Merkle key (POSIX, from scanner) ≠ `chunks.filePath` (backslash, from chunker)
  - `findChunksByFilePath("src/foo.ts")` misses rows stored as `src\foo.ts`
  - `removeFiles` (called with POSIX) fails to match backslash rows → stale chunks accumulate; cross-store inconsistency (chunks vs targets/edges/FTS/vectors derived from those chunks).
- **Why tests miss it:** CI runs on POSIX (Node 22/24, Linux/macOS shards); `path.relative` returns `/`-paths there, so the divergence never surfaces.
- **Fix:** thread the already-canonicalized POSIX relative path into `chunkFileWithCalls` instead of recomputing it, or `toPosixPath(relPath)` before use. Audit every other `relative(projectRoot, ...)` call site for the same pattern.

### H5. `persistWindow` deletes before it upserts, without a surrounding transaction  **[VERIFIED]**
- `src/indexer/pipeline-core.ts:460-485`:
  ```ts
  for (const filePath of filePaths) {
    this.metadata.removeChunksForFile(filePath);   // committed (own tx each)
    this.metadata.removeCallEdgesForFile(filePath);
    this.metadata.removeImportsForFile(filePath);
  }
  this.fts.bulkRemoveByFiles(filePaths);           // committed
  await this.vectors.removeByFiles(filePaths);     // committed
  ...
  this.metadata.bulkUpsertChunks(metadataChunks);  // can throw
  this.fts.bulkUpsert(...);
  ```
- If `bulkUpsertChunks` (or any later step) throws — `SQLITE_BUSY` after `busy_timeout`, OOM, schema drift — the chunks/edges/FTS/vectors for the entire window are already deleted but never re-inserted. Queries return incomplete results until the next full re-index.
- **Mitigating:** Merkle state for the window isn't committed on failure (`successfulFiles` is only appended after `persistWindow` returns), so the next run reprocesses — but between failure and next run the index is partial.
- **Fix:** wrap the metadata-side remove+insert in one `metadata.getDb().transaction(() => { … })()`. (FTS/vectors live in separate DBs and can't share it, but the metadata mutation should be atomic.)

### H6. macOS `--autostart` launch-agent label can collide across distinct project roots  **[VERIFIED]**
- `src/cli/init.ts:361`:
  ```ts
  const label = `com.proofofworks.reporecall.${projectRoot.replace(/[/\\]/g, '-').replace(/^-/, '')}`
  ```
- Two distinct roots that collapse to the same string after `replace` (e.g. paths differing only in characters the regex strips, or symlinked roots) overwrite each other's `~/Library/LaunchAgents/<label>.plist`. The plist body uses `escapeXml` (good), so this is a local integrity/collision issue, not RCE.
- **Fix:** incorporate a short hash of `realpathSync(projectRoot)` into the label; refuse to proceed if a plist already exists pointing at a different `WorkingDirectory`.

---

## 3. Findings — Medium severity

### M1. `cascadeDeleteFileGraphData` does not batch `IN (?)` placeholders — can exceed SQLite variable limit  **[VERIFIED]**
- `src/storage/metadata-store.ts:151-165`. The `community_surprises` delete binds **`2 * chunkIds.length`** values (`...chunkIds, ...chunkIds`) with no batching. Every other store batches at `SQLITE_PARAM_LIMIT = 900`. For a file with > ~499 chunks (legacy 999-limit SQLite) or > ~16 383 (modern 32 766 limit) this throws `too many SQL variables`; it propagates through `removeFile`/`removeFiles` (which *is* transactional, so the whole removal rolls back and the file is never deleted from the index).
- **Fix:** batch `chunkIds` in groups of ≤ 450 (doubled binding), reusing the existing batching pattern; also memoize the prepared statements.

### M2. `getLanguage` caches a rejected promise if `initTreeSitter()` fails — non-recoverable without restart  **[VERIFIED]**
- `src/parser/tree-sitter.ts:60-77`. The IIFE's `catch` (line 69) only wraps `Parser.Language.load`, **not** the `await initTreeSitter()` on line 62. If init rejects (its own `.catch` resets `initPromise` so init *can* recover), the per-language IIFE rejects and the **rejected promise stays in `loadedLanguages`** forever — every subsequent `getLanguage(name)` returns the same rejection and the language never loads again until process restart.
- **Fix:** attach `.catch(() => loadedLanguages.delete(languageName))` to the stored promise, mirroring `initTreeSitter`'s self-reset.

### M3. `business.ts hasAny` uses bidirectional substring matching — false-positive capability classification  **[VERIFIED]**
- `src/wiki/business.ts:841-849` tests both `term.includes(candidate)` **and** `candidate.includes(term)`. Short candidates match far too broadly: `"api"` matches `rapid`, `mapping`, `capital`; `"bot"` matches `robot`, `bottom`; `"flow"` matches `flower`, `overflow`. This function feeds `deriveDecisionPoints`, `deriveSideEffects`, `deriveBusinessTerms`, `deriveUserActions`, `deriveDataConcepts`, `deriveExternalSystems`, and title/actor/trigger/outcome derivation — so false positives pollute the generated business narrative.
- **Fix:** drop the bidirectional branch (rely on exact token match; tokens are already camelCase-split), or require `candidate.length >= 5` before allowing `term.includes(candidate)` (matching the guard already used in `product-areas.ts:356` `overlapScore`).

### M4. NaN propagates through architecture-layer score normalization  **[REPORTED]**
- `src/search/architecture/layer-5.ts:363-366` and `src/search/architecture/layer-6.ts:523-526`:
  ```ts
  const topSelectedScore = Math.max(0, ...finalChunks.map(c => Math.max(c.result.score, c.score)));
  ```
- `Math.max(0, NaN) === NaN` (not `0`). A single `NaN` candidate score (the codebase's own `ranker.ts:108-111` documents this exact failure mode for dates) makes `topSelectedScore` `NaN`, which then corrupts every downstream `backboneScore` and the final `b.score - a.score` sort comparator (non-transitive with `NaN`). Note `ranker.ts` itself is well-defended (`Number.isFinite(time)` guard) — these two call sites are not.
- **Fix:** filter non-finite scores before the max: `.filter(Number.isFinite)`.

### M5. Token budget can be silently exceeded when the header alone exceeds budget  **[REPORTED]**
- `src/search/context-assembler.ts:100-103, 143-166`: the header is unconditionally added to `totalTokens`, then the chunk loop guards against `totalTokens + … > tokenBudget - SUMMARY_RESERVE`. With a very tight budget (e.g. a hook budget), the guard correctly excludes chunks but the function still returns the header whose `finalTokenCount` exceeds `tokenBudget`. Same shape in `assembleFlowContext` (seed always included) and `assembleDeepRouteContext`.
- **Fix:** after assembly, if `finalTokenCount > tokenBudget`, truncate or return summary-only with a warning, rather than returning an over-budget result silently.

### M6. Recency metadata (`indexedAt`) dropped entirely when `recencyWeight === 0`  **[VERIFIED]**
- `src/search/ranker.ts:100`: `item.indexedAt = dateStr` sits *inside* `if (chunkDates && recencyWeight > 0)`. Callers that disable recency by setting the weight to 0 lose the `indexedAt` field on every `RankedItem`, even though the data is available.
- **Fix:** populate `indexedAt` unconditionally; gate only the score addition on `recencyWeight > 0`.

### M7. `VectorStore.upsert` "restore re-add" retries the identical `add` — can create duplicate LanceDB rows  **[REPORTED]**
- `src/storage/vector-store.ts:211-227`: on `add` failure it calls `table.add(normalizedRecords)` **again** with the same records. LanceDB has no upsert primitive / unique constraint and does not guarantee atomicity of `add`; if the first `add` partially succeeded, the retry duplicates the rows that landed. The function re-throws the original error regardless, so the retry's only possible effect is duplication.
- **Fix:** remove the retry (it cannot help and re-throws anyway), or guard with per-ID existence checks.

### M8. Other Medium items (concise)
- **`MetadataStore.resetIndexData` is not transactional** (`metadata-store.ts:403-410`): six `clearAll()` calls; a mid-clear failure leaves a half-cleared DB. Self-heals next run (version stays old) but is inconsistent meanwhile. Wrap in one `db.transaction`.
- **`VACUUM` silently fails under cross-process access** (`pipeline-runtime.ts:336-362`): the JS-level `ReadWriteLock` doesn't block a *separate process* holding a SQLite connection; `SQLITE_LOCKED` is caught + logged. Best-effort today; document or add a file lock.
- **`close()` doesn't await `vectors.close()`** (`pipeline-runtime.ts:364-371`): floating `.catch()`; on fast CLI exit LanceDB native handles may not flush. Prefer `closeAsync()`.
- **`ensureIndexFormat` clears stores but not `stats`** (`pipeline-core.ts:202-213`): `lastIndexedAt`/`indexedCommit` survive a format-version reset even though all chunks are gone. Self-heals via the "stores empty" guard, but logically incomplete.
- **Dead-code tag check** (`search/bug/layer-5.ts:106`): `tagTerms.includes("validation")` — there is no `"validation"` tag in `BUG_SUBJECT_TAG_RULES` (`bug/model.ts:82-90`); the branch is always false. Intended tag is likely `"schema"` or a new `"validation"` tag.
- **N+1 query in persistWindow** (`pipeline-core.ts:524-531`): one `findCallers` query per chunk per window (two LEFT JOINs + LIMIT). Add a batched `findCallerCountsForChunks`.
- **scheduleAutoRefresh re-arms with stale `freshness`** (`daemon/server-runtime.ts:60-96`): the `finally` re-arm passes the *original* request's freshness, not the most recent. Cosmetic (log/telemetry correlation) — not remotely reachable (bearer-gated).
- **`timingSafeEqual` length short-circuit** (`server-runtime.ts:199-205`): unequal lengths skip the comparison entirely, leaking the expected token *length* via timing. Token is 32 random bytes, so not brute-forceable — defense-in-depth only.
- **`MetadataStore` constructor runs 7 `initSchema()` calls without a wrapping transaction** (`metadata-store.ts:86-93`): a mid-init failure leaves half-initialized stores. Wrap in one transaction.

---

## 4. Findings — Low severity / code quality

| ID | Location | Issue |
|----|----------|-------|
| L1 | `storage/chunk-store.ts:244-253` | `findChunksByNamePrefixes` doesn't escape LIKE wildcards (`%`/`_`) in prefix args; also no batching at the 900-limit. Wrong prefix semantics, not injection (parameterized). |
| L2 | `wiki/generator.ts:413` | `new RegExp(\`^${key}:…\`)` interpolates `key` unescaped into a regex. Safe today (internal constants), but diverges from the project's own `escapeRegExp`. |
| L3 | `memory/parser.ts:57,66` | Frontmatter parser is `\n`-only (CRLF/bare-CR edge cases) and value group `(.+)` silently drops empty (`key:`) values — can cause spurious fingerprint mismatches/re-indexing. |
| L4 | `wiki/business.ts:886-898`, `wiki/generator.ts:84-101` | Determinism rests on undocumented DB row order; no explicit `sort()` on member/related-file lists before serialization → fingerprint churn if store ordering shifts. |
| L5 | `search/seed.ts:190,242-250` | `scoreFTSCandidate` doesn't guard `NaN` from malformed FTS `rank`; `Math.max(0, NaN)` → `NaN` confidence → non-transitive seed sort. |
| L6 | `search/context-chunks.ts:18-22` | `formatChunk` doesn't guard `undefined` content → emits literal `undefined` into assembled context. |
| L7 | `memory/indexer.ts:360` | `regenerateIndex` interpolates raw filename + `description` into a markdown link — unescaped `]`/`[`/`)`/`(`/newlines corrupt `MEMORY.md`. |
| L8 | `analysis/semantic-features.ts:22` | `STORAGE_RE` matches `from(` → flags `Array.from`/`Buffer.from` as storage writes; also bare `select\|insert\|update\|delete` match comments/strings. |
| L9 | `parser/chunker.ts:192-211` | `walkForExtractables` recursion has no depth guard (sibling `walkForCallNodes` was deliberately made iterative for this reason). Stack-overflow risk on pathological deeply-nested input. |
| L10 | `parser/chunker.ts:288` | A new `Parser` is created + `delete()`d per file; should be cached per language (perf). |
| L11 | `indexer/merkle.ts:110-118` | mtime+ctime fast-path can be defeated by deliberate timestamp reset (`touch -r`, macOS `setattrlist`); no periodic full-rehash sweep. |
| L12 | `storage/metadata-store.ts:214` | `getStorageStats` reports only main `.db` size, omits `-wal`/`-shm` sidecars → understates disk usage (feeds `vacuumIfNeeded`). |
| L13 | `daemon/scheduler.ts:104-115` | `IndexScheduler` dead-letters after `MAX_RETRIES` via `log.error` but records no visible stat; operators can't see dropped files in `stats`. |
| L14 | `daemon/watcher.ts:60-68` | Ignore-pattern transform (`p.startsWith("*") ? \`**/${p}\` : \`**/${p}/**\``) turns `*` into "ignore nothing" and `*.ts` into "watch no .ts" — footgun (indexer's own scanner still filters, so not data-corrupting). |
| L15 | `cli/doctor.ts:115-129` | `fetch(\`${config.ollamaUrl}/api/tags\`)` — hostname is schema-locked to localhost, but port/path are attacker-controllable from a trusted `config.json`; pin `new URL("/api/tags", …)`. |
| L16 | `indexer/embedder.ts:163-168,232-239` | Embedder error messages echo the raw upstream body verbatim; a malicious local Ollama could inject `"database"/"corrupt"` substrings to mislabel daemon error codes. Truncate + sanitize. |
| L17 | `core/rwlock.ts:43-56` | Queued-writer hand-off correctness relies on `this.writing = true` being set in `releaseRead` *before* `next()`; fragile for future refactors. Add an invariant assert. |
| L18 | `storage/memory-store.ts:715-716` | `compact` dedup loop has a dead `memory.id === keep.id` branch (`slice(1)` already excludes `keep`). |
| L19 | `parser/chunker.ts` & `indexer/merkle.ts` | Two separate module-level `getHasher()` promises each load `xxhash-wasm` once; extract a shared `core/hasher.ts`. |

---

## 5. Security posture (verified correct controls)

The daemon/hook surface is well-hardened. The following were confirmed correct and are **not** problems:

- **HTTP server binds to localhost only** (`cli/serve.ts:376`, `cli/lens.ts:63`).
- **Bearer auth on every non-probe route** — 32 random bytes, persisted `0o600`, removed on shutdown (`server-runtime.ts:40,195-212`).
- **Rate limiting** that explicitly does **not** trust `X-Forwarded-For` (`server-runtime.ts:183`).
- **Request body capped at 1 MiB** with `req.destroy()` on overflow (`server-support.ts:228-249`); **timeout on every handler**; **Zod `safeParse` on all hook bodies** (`hook-schemas.ts`).
- **All SQL is parameterized** — no user-data string concatenation anywhere in `src/storage/`. The `${placeholders}` interpolations (`metadata-store.ts:156,159,163`; `chunk-store.ts:250`; `target-store.ts:313`) build `?`-lists from internal array lengths. FTS5 query terms are control-char-stripped and double-quoted (`fts-store.ts:137`).
- **Path traversal defenses** via `resolveProjectPath` (realpath + containment) at every user-path boundary (`mcp-server.ts:221,558`; `mcp-memory-tool.ts:375-381`; `watcher.ts:88-96`); memory slugs go through `safeMemorySlug` (`memory/files.ts:37-45`).
- **No shell injection** — `init.ts` hook builder validates paths against `/^[-\w./]+$/` and uses `toPosixPath`; plist body uses `escapeXml`; Windows path rejects `["%^&|<>!]`; all `child_process` callers use arg arrays.
- **SSRF locked down** — `ollamaUrl` schema-refined to `localhost`/`127.0.0.1`/`::1` (`config.ts:113-116`); OpenAI URL hardcoded.
- **Regex DoS guarded** — `safe-regex2` over all user-supplied `factExtractor`/`conceptBundle` patterns (`config.ts:427,439`).
- **Bounded buffers/queues** everywhere (scheduler 50k, watcher 10k with 10% backpressure, metrics ring 200, FTS doc-freq cache 256); graph recursion bounded (`maxDepth`/`maxNodes`).
- **No secrets logged**; `openaiApiKey` in config is explicitly rejected by the strict schema with a security warning (`config.ts:359-361`).
- **Error responses don't leak stack traces** (`server-runtime.ts:850` extracts only `err.message`).

The one genuine security defect is **H3 (Lens XSS)**. Everything else in the daemon/MCP path is solid.

---

## 6. Cross-cutting themes

1. **Test coverage has structural blind spots.**
   - H1 (`docstringCoverage`) is missed because the integration fixture has no docstring and the hook test mocks the store.
   - H4 (Windows paths) is missed because CI is POSIX-only.
   - H5 (non-atomic persist) is missed because no test injects a mid-window failure.
   - **Recommendation:** add a round-trip `setConventions`/`getConventions` test with coverage > 1; add a Windows-separator unit test that feeds `\`-paths through scanner+chunker and asserts a single canonical key; add a fault-injection test for `persistWindow`.

2. **The Windows portability work (uncommitted) is half-done.** `file-scanner.ts` and `init.ts` were migrated to `toPosixPath`, but `chunker.ts:221` (and any other `relative(projectRoot, …)` recomputation) was not — see H4. A repo-wide grep for `relative(projectRoot` / `relative(canonicalRoot` is warranted before this lands.

3. **Transaction discipline is good inside individual stores but breaks at facades.** `bulkXxx` methods are transactional; `MetadataStore.resetIndexData` (M8) and `pipeline-core.persistWindow` (H5) are not. Adopt a rule: any method that mutates > 1 store, or > 1 table without a clear single-statement semantic, runs inside `db.transaction`.

4. **NaN hygiene is inconsistent.** `ranker.ts` defends against `NaN` from malformed dates; `architecture/layer-5/6` (M4) and `search/seed.ts` (L5) do not. Standardize on `Number.isFinite` guards (or a `safeMax`/`safeNumber` helper) at every score-composition boundary.

5. **Prepared-statement caching is inconsistent.** `ChunkStore`/`TargetStore`/`CallEdgeStore` cache statements; `cascadeDeleteFileGraphData` (M1), `setWikiLinks`, and several `metadata-store.ts` calls re-`prepare` per call. Hoist them.

---

## 7. Recommended fix priority

| Priority | Item | Effort | Why |
|----------|------|--------|-----|
| 🔴 P0 | H1 `docstringCoverage` schema `max(1)`→`max(100)` | trivial | Feature is silently dead in production; one-line fix + 1 test. |
| 🔴 P0 | H4 Windows chunker path re-derivation | small | Blocks the in-flight Windows work; corrupts the index on Windows. |
| 🔴 P0 | H3 Lens `</script>` XSS escaping | small | Only genuine security defect; affects anyone opening `lens.html` from an indexed third-party repo. |
| 🟠 P1 | H2 Python docstring extraction | medium | Compounds H1; degrades Python search quality. |
| 🟠 P1 | H5 non-atomic `persistWindow` | medium | Data-integrity window-of-failure on real errors. |
| 🟠 P1 | M2 `getLanguage` cached-rejection leak | small | Makes the indexer non-recoverable after a transient WASM-init failure. |
| 🟡 P2 | M1 cascade-delete batching; M3 `hasAny`; M4 NaN; M6 recency metadata | small each | Correctness/quality of generated narrative and ranking. |
| 🟢 P3 | L1–L19 + remaining M8 items | small each | Hardening, determinism, perf, observability. |
| 🔵 | H6 macOS launch-agent label collision | small | Local-only integrity; do alongside `--autostart` rework. |

---

## 8. Verification legend

- **[VERIFIED]** — reviewer re-read the cited source and confirmed the defect exactly as described. (H1, H2, H3, H4, H5, H6, M1, M2, M3, M6, and all security controls in §5.)
- **[REPORTED]** — surfaced by focused subsystem audits with `file:line` evidence; cited for direct confirmation before acting. (M4, M5, M7, M8 items, L1–L19.)

*Authored by glm-5.2 following a full `src/` review. Baseline gates (typecheck, lint, 949 tests) all pass; every finding here is a latent defect the current suite does not exercise.*
