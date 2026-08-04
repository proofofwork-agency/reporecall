# Reporecall Project Audit Report

**Project:** `@proofofwork-agency/reporecall` (v0.9.0)  
**Date:** 2026-08-04  
**Scope:** Full-repo static review of `src/`, tests, CI/quality gates, packaging, and uncommitted WIP  
**Method:** Architecture review, security-sensitive path analysis, coverage inspection, path-identity audit, release-state review  

---

## Executive summary

Reporecall is a mature local-first context layer for coding agents: indexer → storage → hybrid search → hooks/MCP/CLI → wiki/lens. Engineering quality is generally high — path safety, bearer auth, prepared SQL, ReDoS filtering, claims/evidence gates, and module-cycle checks show intentional hardening.

The **blocking production issue** is incomplete **Windows path identity** handling. Repo-relative paths are treated as portable `/`-separated keys in search and routing, but several write/update paths still emit platform-native separators. That broke the Windows publish gate and is only **partially fixed in uncommitted WIP**. Until that lands and is verified on Windows, **v0.9.0 should not be treated as shippable on npm** (tag exists; npm still on 0.8.1 per internal release notes).

Secondary themes: large CLI/bug-strategy coverage holes, watcher path regression risk, heavy native deps, and release-process blind spots (Ubuntu-only full suite in CI).

| Severity | Count (approx.) | Theme |
|---|---|---|
| **Critical / release-blocking** | 1 cluster | Windows path identity + publish gate |
| **High** | 4 | Incomplete path-normalization migration; CI gap; incomplete release; watcher ignore/identity |
| **Medium** | 8 | Coverage holes; large modules; Merkle edge cases; CDN/offline; silent failures |
| **Low / hygiene** | 6 | Binary alias collision; concept-facts hardcoding; docs/WIP drift; dep weight |

---

## Project snapshot

| Aspect | State |
|---|---|
| Purpose | Local code index + auto-inject hooks + MCP tools + memory/wiki/lens |
| Source modules | ~142 TypeScript files under `src/` |
| Tests | ~101 test files |
| Coverage (committed summary) | **67% statements / 58% branches / 70% lines** |
| Security audit (`npm audit --omit=dev`) | **0 vulnerabilities** (with dependency overrides) |
| Engines | Node `>=22` (breaking vs 0.8.x) |
| Public surface | CLI `reporecall` / `memory`, 6 MCP tools, HTTP daemon on `127.0.0.1` |
| Quality system | `quality/claims.json`, evidence artifacts, module gate, smoke, benchmarks |

---

## Critical / release-blocking

### 1. Windows path identity breaks indexing, routing, and publish

**Status:** Diagnosed; **partial fix present but uncommitted**.

**Root cause:** On Windows, `glob` and `path.relative` produce backslash paths (`lib\util\helper.ts`). Search, fixtures, git, and most identity comparisons use slash form (`lib/util/helper.ts`). Result: empty/weak call graphs, failed trace routing, false “broad search” fallbacks, and failing tests.

**Known failing suite (Windows, from release notes):**

- `test/indexer/file-scanner.test.ts` — relative path separators  
- `test/cli/init.test.ts` — hook shell path with `\`  
- `test/cli/explain.test.ts` — inventory diagnostics  
- `test/integration/routing.test.ts` — 4 trace/flow cases  
- `test/search/trace-strategy.test.ts` — 4 cases + EBUSY cleanup  

**Uncommitted WIP addresses:**

| Area | Fix direction |
|---|---|
| `src/core/path-safety.ts` | `toPosixPath()`, `posixRelativePath` on `SafeProjectPath` |
| `src/indexer/file-scanner.ts` | Emit `posixRelativePath`; normalize before `ignore` |
| `src/cli/init.ts` | Force `/` in hook shell snippets |
| `test/search/trace-strategy.test.ts` | Close SQLite stores before `rmSync` (EBUSY) |

**Still incomplete after WIP** (see High):

- `src/daemon/watcher.ts` still uses platform `relativePath` for ignore + pending paths  
- `src/indexer/pipeline-runtime.ts` `indexChanged` / `removeFiles` still store platform `relativePath`  
- `src/analysis/imports.ts` uses unconditional `.replace(/\\/g, "/")` (differs from careful `toPosixPath` semantics)

**Impact:** Windows users get wrong/incomplete indexes. **npm publish for 0.9.0 is blocked** until Windows release verification is green.

**Recommendation:**

1. Finish a single identity contract: **all repo-relative identities = `posixRelativePath`**.  
2. Use platform `relativePath` only for filesystem I/O.  
3. Run the full suite on `windows-latest` in `ci.yml`, not only in `publish.yml`.  
4. Land WIP, re-cut release if needed, then publish.

---

## High severity

### 2. Incomplete path-normalization migration (residual Windows bugs)

Even with the scanner fix, incremental and watcher paths can re-introduce backslash identities:

```text
file-scanner  →  posixRelativePath   ✅ (WIP)
watcher       →  relativePath        ❌ (platform)
pipeline-runtime indexChanged/remove → relativePath  ❌
imports resolveProjectFile           → replace \\ → / always
```

**Risk:** Full index on Windows may look fixed while **live daemon updates** store mixed separators, fragmenting Merkle keys and FTS/`file_path` rows.

**Recommendation:** Grep-audit every assignment of “repo-relative identity” and route through `posixRelativePath` / `toPosixPath`. Add a Windows-or-separator unit test that fails on macOS if any scanner/watcher path contains `\`.

### 3. CI does not run the full test suite on Windows

From `.github/workflows/ci.yml`:

- **Quality job:** Ubuntu only (typecheck, lint, coverage, smoke, quality).  
- **Multi-OS matrix:** native install + packed demo only (Ubuntu / macOS / Windows × Node 22 / lts).  
- **Full suite on Windows** appears only in `publish.yml` release verification.

That is why the Windows regression shipped into the tagged 0.9.0 cut: PR CI was green without exercising product paths on Windows.

**Recommendation:** Add a Windows quality job (or extend matrix) that runs `vitest run` (and ideally smoke). Packed demo is necessary but not sufficient.

### 4. Release state is inconsistent

| Artifact | State (per internal release notes) |
|---|---|
| Git tag `v0.9.0` | Exists |
| GitHub release | Created |
| npm package | Still **0.8.1** (publish blocked) |
| Local WIP | Path fixes + website redesign + retrieval-gates evidence **not on main** |

**Risk:** Docs/README claim 0.9.0 capabilities and measured numbers while consumers installing from npm get 0.8.1. Trust-contract messaging is strong in-repo but undermined by distribution lag.

**Recommendation:** Either finish Windows fix → publish 0.9.0, or temporarily clarify “0.9.0 is pre-release / not on npm yet” in README/site until publish succeeds.

### 5. FileWatcher path / ignore behavior on Windows

`src/daemon/watcher.ts`:

- Uses `safePath.relativePath` (platform separators).  
- Passes that string to `ig.ignores(relPath)`. The `ignore` package expects gitignore-style **forward slashes**. On Windows, directory patterns like `node_modules/**` can **silently miss**.  
- Queues those paths for re-index, compounding High #2.

Also: macOS uses polling (`usePolling: true`) for shutdown safety — correct tradeoff, but higher CPU on large repos; document or make configurable if users report load.

---

## Medium severity

### 6. Large coverage holes in critical surfaces

Overall ~67% statements is acceptable for a CLI product, but several high-value surfaces are effectively untested:

| Module | Lines coverage | Risk |
|---|---|---|
| Almost all CLI entrypoints (`serve`, `mcp`, `stats`, `doctor`, `search`, `index-cmd`, …) | **0%** | Lifecycle / PID / MCP stdio regressions |
| `src/daemon/watcher.ts` | **~18%** | Incremental index correctness |
| `src/search/bug/layer-*.ts` (esp. 1,2,5,6) | **0–14%** | Bug-mode retrieval quality is mostly ununit-tested |
| `src/search/context-concept-facts.ts` | **0%** | Dead or orphaned concept path |
| `src/wiki/generator.ts` / `auto-capture.ts` / `staleness.ts` | **~0–1%** | Wiki correctness |
| `src/daemon/mcp-memory-tool.ts` | **~40%** | Memory store/forget edge cases |
| `src/analysis/imports.ts` | **~46%** | Multi-lang import resolution |

**Recommendation:** Prioritize tests for (1) watcher + path identity, (2) `serve`/PID lock smoke, (3) bug-strategy golden fixtures, (4) wiki generator smoke.

### 7. Search subsystem complexity and maintainability

Largest modules (line counts):

| File | ~LOC |
|---|---|
| `search/context-assembler.ts` | 911 |
| `daemon/server-runtime.ts` | 904 |
| `wiki/business.ts` | 917 |
| `search/utils.ts` | 863 |
| `search/capability-evidence.ts` | 860 |
| `search/seed.ts` | 857 |
| Bug/architecture layer files | 350–680 each |

Module gate allows 800 non-comment lines (500 for façades). Several files sit near the ceiling. Bug and architecture strategies are multi-layer heuristic engines with large regex/term tables — high change cost, hard to reason about regressions without golden benchmarks.

**Recommendation:** Keep behavior-preserving extraction; expand fixture-driven retrieval tests rather than more ad-hoc heuristics.

### 8. Merkle mtime+ctime caching — Windows semantics risk

`src/indexer/merkle.ts` skips re-hash when both `mtimeMs` and `ctimeMs` match. On POSIX, ctime catches content rewrites that preserve mtime (`git checkout`, `touch -r`). On Windows, ctime/mtime semantics differ (ctime often tracks metadata differently; some tools can confuse the cache).

There are good regression tests in `test/indexer/merkle-ctime.test.ts`, but they run on the host OS. A false “unchanged” on Windows would skip re-index of changed files.

**Recommendation:** On Windows, either always re-hash when size changes, or treat ctime as weaker and include size in the cache key (`size` + mtime + hash fallback).

### 9. Lens HTML depends on CDN D3

`src/visualize/html-template.ts` loads:

```html
<script src="https://d3js.org/d3.v7.min.js"></script>
```

Issues:

- Offline / air-gapped use fails for interactive charts.  
- Supply-chain trust for a “local-first” product.  
- Product marketing emphasizes local/offline; Lens is a partial exception.

**Recommendation:** Vendor D3 into the generated HTML (or optional offline bundle) for full local-first parity.

### 10. Silent error swallowing in hot paths

Widespread empty `catch` / non-fatal swallows (hooks, rotating log, scanner, Merkle save, FTS failures returning `[]`). Many are intentional for daemon resilience, but they can hide systemic failure (e.g. embedding permanently degraded, FTS always empty) behind “empty results.”

**Mitigations already present:** readiness probe, degradation logging for empty vectors, Trust Contract staleness banners.

**Gap:** No single **health score** aggregating FTS empty, vector corruption, embedding circuit-open, watcher drop rate. `get_stats` / doctor should surface these more aggressively.

### 11. Concept facts appear product-hardcoded and untested

`src/search/context-concept-facts.ts` embeds Reporecall-internal symbol names (`chunkFileWithCalls`, `createDaemonServer`, …). That is useful for *this* repo but odd as a general product path, and coverage is 0%. If wired only for self-demo, document it; if meant for user concepts via `conceptBundles`, the hard-coded map is a maintainability smell.

### 12. Memory paths can point outside the project

Config allows absolute `memoryDirs` / `memoryWritableDir` (resolved outside project root intentionally for shared memory). Writes use slugified filenames (good path-injection hygiene) but **no project-boundary check** on the directory itself. That is a feature for power users and a footgun for config mistakes / malicious shared config.

**Recommendation:** Document clearly; optionally require absolute extra-project dirs to be allowlisted or confirmed at `init`.

### 13. Pre-tool-use is advisory-only

`evaluatePreToolUse` always returns `permissionDecision: "allow"`. It steers the agent with text but never blocks. Fine for Claude hook model today, but easy to over-claim as “guardrails.” Docs should stay clear that this is **guidance**, not enforcement.

### 14. Uncommitted surface area is large

Current dirty tree (high level):

- Path-safety / scanner / init / tests (release-critical)  
- `quality/claims.json` + `retrieval-gates` evidence + benchmark script  
- Website CSS/homepage rewrite (~1k lines)  
- README claim updates  

**Risk:** Mixing a release-blocker fix with a website redesign in one change set complicates review and rollback.

**Recommendation:** Land path/Windows fixes first; ship site polish separately.

---

## Low severity / hygiene

### 15. Binary name collision

`package.json` bins: `reporecall` and `memory`. README already warns `memory` may collide. Prefer documenting `reporecall` only in install instructions; consider deprecating the short alias later.

### 16. Heavy dependencies

| Package | Approx. install weight |
|---|---|
| `@lancedb/lancedb` | ~93MB |
| `@huggingface/transformers` | ~70MB |

Acceptable for local embedding/vector search, but first-install experience is heavy. Keyword-only mode helps; ensure docs lead with “works offline / keyword fallback” and optional model download cost.

### 17. Imports resolution still incomplete coverage

`src/analysis/imports.ts` ~46% lines / ~35% branches. Multi-language import graphs drive call resolution and communities. Gaps here degrade Lens/topology quality more than unit tests currently prove.

### 18. Rate limiter is process-local

In-memory sliding window is fine for a single local daemon. Document that it is not multi-process or reverse-proxy aware (also correctly ignores `X-Forwarded-For` — good).

### 19. PID lock is best-effort

`serve` uses exclusive open of `daemon.pid` + liveness check. Race windows exist under concurrent starts; generally OK for local use. On Windows, stale file + open handles can be messier (related to EBUSY test issues).

### 20. Module gate counts non-comment lines only

Large files can still grow via comments/whitespace. Gate is useful but not a substitute for cohesion reviews of bug/architecture layers.

---

## Security review (summary)

### Strengths

| Control | Where |
|---|---|
| Bind to loopback only | `serve` / `lens` → `127.0.0.1` |
| Bearer token + `timingSafeEqual` | `server-runtime.ts` |
| Token file mode `0o600` | daemon start |
| Rate limiting (socket IP only) | `server-support.ts` |
| Body size cap 1MB | `readBody` |
| CORS preflight rejected | OPTIONS → 403 |
| Project path containment + realpath | `path-safety.ts` |
| SQL via prepared statements | SQLite stores |
| LanceDB filter escaping | `escapeSqlString` |
| ReDoS filter on user regex config | `safe-regex2` in `config.ts` |
| Query sanitization / contamination strip | `sanitizeQuery` |
| Prod `npm audit` clean | overrides for transitive advisories |

### Residual concerns

| Issue | Severity | Notes |
|---|---|---|
| Incomplete path identity on Windows | High | Not classic RCE; integrity/confidentiality of *which* files enter context |
| Memory dirs outside project | Low–Med | Config-driven write surface |
| CDN script in Lens | Low | Supply chain / offline |
| Unauthenticated `/health` `/ready` | Info | Expected for local probes; rate-limited |
| Hook token readable by same-user processes | Info | Local-trust model; correct for single-user daemon |
| Error messages may leak internal paths | Low | Local tool; still avoid in shared logs if multi-user |

No remote code execution pattern stood out in `src/` (shell use is `execFile` / `spawnSync` with fixed commands, not shell-interpolated user queries). SQL injection surface is largely closed via prepared statements and FTS term quoting/stripping.

---

## Architecture observations

```text
CLI / Hooks / MCP
       │
       ▼
┌──────────────┐     ┌─────────────┐
│ Daemon HTTP  │────▶│ HybridSearch│──▶ strategies (lookup/trace/bug/arch)
│ + MCP server │     └─────────────┘
└──────────────┘            │
       │                    ▼
       │            Context assembly + compression
       ▼
 Indexer pipeline ◀── Watcher / Scheduler
       │
       ▼
 SQLite (meta/FTS/memory) + LanceDB vectors + Merkle state
       │
       ▼
 Wiki / Business / Lens visualization
```

**Good design choices:**

- Explicit Trust Contract (freshness banners, empty-index handling).  
- Small public MCP surface (6 tools).  
- Façade modules (`pipeline.ts`, `server.ts`, `prompt-context.ts`) with decomposed internals.  
- Evidence/claims system so marketing numbers are reproducible.  
- Keyword-only embedding path for zero-model operation.

**Structural tensions:**

- Retrieval quality is a large heuristic graph (bug + architecture layers) — hard to evolve safely.  
- Dual storage (SQLite + Lance) increases corruption/recovery paths (partially handled).  
- Hooks depend on daemon uptime; cold start / stale index UX is good but auto-refresh races need ongoing care.

---

## Test & quality gate health

| Gate | Assessment |
|---|---|
| Unit/integration tests | Strong on core search/storage; weak on CLI lifecycle & bug layers |
| Coverage thresholds | ~67% stmt — room to raise for CLI/watcher |
| `quality:check` / claims | Solid discipline; new `retrieval_gates` claim in WIP |
| Module cycle gate | Present and useful |
| Smoke / packed demo | Multi-OS — good for install, not for path identity |
| Nightly stress/benchmarks | Present (`nightly.yml`) — keep as regression bar |
| Windows full suite | **Only on publish path** — primary process flaw |

---

## Uncommitted WIP assessment

| Change | Verdict |
|---|---|
| Path-safety + scanner + init POSIX paths | **Must land** for 0.9.0 |
| Trace-strategy store close | **Must land** (Windows hygiene) |
| Retrieval-gates evidence + claims | Good; keep reproducible artifacts |
| Website CSS/homepage large rewrite | Separate PR preferred |
| README claim text updates | Align with published npm version |

---

## Prioritized action plan

### P0 — Ship / unblock release

1. Complete **posix identity** migration: watcher, pipeline-runtime, imports, any remaining `relativePath` identity uses.  
2. Close stores in all temp-dir tests that open SQLite on Windows.  
3. Run full test suite on Windows (local or CI job) until green.  
4. Publish 0.9.0 (or re-tag after fix) and verify `npm view … version`.

### P1 — Prevent recurrence

5. Add Windows job to `ci.yml` that runs `vitest run` (not only packed demo).  
6. Add invariant tests: scanned/watched relative paths never contain `\` when `sep === '\\'`.  
7. Surface embedding/FTS/vector degradation in `doctor` / `get_stats`.

### P2 — Quality & maintainability

8. CLI lifecycle tests (`serve` PID lock, `mcp` stdio smoke, `stats` JSON).  
9. Bug-strategy golden fixtures (even a small frozen set).  
10. Vendor D3 for offline Lens.  
11. Split near-limit modules only when behavior-preserving extractions are cheap.  
12. Document memory absolute-dir security model.

### P3 — Product hygiene

13. Deprecate or demote `memory` binary alias.  
14. Clarify concept-facts purpose or remove dead path.  
15. Split website redesign from release-critical path fixes.

---

## Positive findings (keep doing)

- Local-first security model is thoughtful (loopback, token, path containment).  
- Trust Contract and “insufficient evidence” culture match the product story.  
- Prepared statements + ReDoS filters + sanitizeQuery show security-aware coding.  
- Claims/evidence/pilot quality system is rare and valuable for an OSS agent tool.  
- Module façades + cycle gate keep structure from collapsing despite growth.  
- Recent wiki pollution fix for lookup precision shows real retrieval discipline.  
- Dependency overrides and Node 22 floor are pragmatic responses to ecosystem pain.

---

## Conclusion

Reporecall is **engineering-strong and product-clear**, with a credible Trust Contract and local security posture. The outstanding flaw is not “bad architecture” but an incomplete **cross-platform path identity contract**, amplified by **CI that does not fully exercise Windows** until publish time. That single cluster blocks a clean 0.9.0 release and can silently degrade Windows user experience.

Finish the path-normalization migration, gate it in CI, publish, then invest in coverage for CLI lifecycle, watcher, and bug-mode retrieval. Everything else is secondary.

---

*Generated by full-project static audit. Not a substitute for running the Windows suite or dynamic penetration testing.*
