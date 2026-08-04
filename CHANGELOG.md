# Changelog

## [0.9.0](https://github.com/proofofwork-agency/reporecall/compare/v0.8.1...v0.9.0) (2026-08-04)


### ⚠ BREAKING CHANGES

* minimum supported runtime is now Node 22 (was Node 20).

### Features

* **benchmark:** measure and publish context-assembly token cost ([2c0e616](https://github.com/proofofwork-agency/reporecall/commit/2c0e6168af06f06cac210fef06b1283f5b136dc5))
* require Node 22, and fix coverage OOM + publish gate parity ([d7b8717](https://github.com/proofofwork-agency/reporecall/commit/d7b8717ddfef0828819a23e194eabd8ecab7c8b9))


### Bug Fixes

* **ci:** cap vitest fork concurrency in CI to stop coverage OOM ([6d54534](https://github.com/proofofwork-agency/reporecall/commit/6d54534c98762971171bf1faf0dfcfdb0d1cf8de))
* **ci:** declare shell bash on multi-line steps ([944c6a8](https://github.com/proofofwork-agency/reporecall/commit/944c6a8edfa9af96c3cdcb597f14bdd9109fea00))
* **ci:** give the all-languages integration test its own worker ([b9ff5a6](https://github.com/proofofwork-agency/reporecall/commit/b9ff5a67cea1d01db8ad14b3b7b8fb565862f2eb))
* **ci:** isolate both all-languages WASM suites, not just one ([0e196c0](https://github.com/proofofwork-agency/reporecall/commit/0e196c0043dfc683bc8d0856c14882f833e79ed4))
* **ci:** patch production advisories and unbreak the packed demo on Windows ([70a46bd](https://github.com/proofofwork-agency/reporecall/commit/70a46bd117278f820b2e69fe0e81b2ffab417838))
* **ci:** run each all-languages WASM suite in its own process ([6cd6487](https://github.com/proofofwork-agency/reporecall/commit/6cd6487f9b21c63d7427e035c1cc4bd67422e044))
* **ci:** serialize vitest in CI instead of raising the heap ([852af8d](https://github.com/proofofwork-agency/reporecall/commit/852af8d394ff1135c8c36b49349c3e9c6122aca7))
* **indexer:** never trust the mtime of a file hashed right after it was written ([f9500f7](https://github.com/proofofwork-agency/reporecall/commit/f9500f7b0151293cd6b93c52b111c723e1bfe277))
* **publish:** prefix the tarball path so npm treats it as a file ([f49a7c0](https://github.com/proofofwork-agency/reporecall/commit/f49a7c041b299548de393901d0c2992e73bb6c68))
* **quality:** make fixture hashes portable across line-ending checkouts ([9b5a41f](https://github.com/proofofwork-agency/reporecall/commit/9b5a41f4d48c34b522daa689c64a996eac0fdbf1))
* **quality:** the claims detector never actually detected anything ([f6b3b1f](https://github.com/proofofwork-agency/reporecall/commit/f6b3b1f160f2f1eed8230398d7cd72bed743df71))
* **release:** audit the tree consumers get, not the one we develop against ([bbd458a](https://github.com/proofofwork-agency/reporecall/commit/bbd458a50f1fa1f7e17fa155087ad6e7afa98448))
* **smoke:** tolerate Windows temp-dir cleanup failure ([b693bc3](https://github.com/proofofwork-agency/reporecall/commit/b693bc37dabd65cf59a6d2e8399a4dd626e5d7bb))
* Windows smoke signal semantics, Lens inline-JSON XSS, conventions schema, Python docstrings ([47dffec](https://github.com/proofofwork-agency/reporecall/commit/47dffecae8e712b4d253cfc5e5389d6a6af56601))
* **windows:** finish the portable-path boundary; harden merkle and test teardown ([27126a3](https://github.com/proofofwork-agency/reporecall/commit/27126a38c304c976d22aa5c580f5b3f289eed4b5))
* **windows:** normalize repo-relative paths at the boundary; redesign docs site ([71d10a7](https://github.com/proofofwork-agency/reporecall/commit/71d10a797c9f35cd0840e78886778b9d7da23781))
* **windows:** normalize the chunk filePath the call graph keys on ([5846c70](https://github.com/proofofwork-agency/reporecall/commit/5846c70c67dcdfaaba4fe98468c1357c47e07e74))

## [0.9.1] - 2026-08-04

Patch release closing a freshness-integrity hole in change detection, plus the
CI job that would have caught it and a documentation site with search.

### Fixed

- **A modified file could stay indexed as fresh, forever.** The change
  pre-filter skips hashing when mtime, ctime and size all match the recorded
  entry. Filesystem timestamps are coarse — the Windows clock advances in
  ~15.6ms steps, HFS+ stores whole seconds, FAT32 two-second steps — so two
  writes inside one step share an mtime exactly. If a file was hashed between
  those writes, the second one became invisible on every later scan. On Windows
  nothing else caught it either: ctime is the creation time and does not move on
  modification, so a length-preserving edit cleared all three signals. The
  result was a stale chunk reporting itself as fresh, which is precisely what the
  Trust Contract exists to prevent. A file whose mtime is younger than the
  coarsest granularity we might be sitting on now records a "do not trust this
  timestamp" marker and is re-hashed on the next scan. That costs a read, not
  parse or embed work: on a 2,000-file repository a no-change re-index still
  processes 0 files and creates 0 chunks (`npm run stress:large-repo:ci`, which
  fails outright if a no-change pass touches any file).

### Added

- The full test suite now runs on Windows and macOS in CI, not only Ubuntu.
  Publish was previously the first place it ever executed on Windows, which is
  how a class of path-identity defects reached a release gate instead of a pull
  request.
- Documentation site gains offline full-text search (no external requests),
  rendered Mermaid architecture diagrams including a request-flow diagram, a
  custom 404 with search, and a social preview card.

### Changed

- Re-measured both registered claims against a freshly cloned and re-indexed
  1,306-file repository using this release's build. Numbers are unchanged within
  measurement variance; see `quality/evidence/`.

## [0.9.0] - 2026-08-04

Engineering-hardening release focused on trustworthy context, reproducible
evidence, project-boundary safety, and release verification.

### Added

- Versioned compatibility snapshots for CLI help, MCP schemas, config defaults,
  package exports, and JSON output contracts.
- A machine-readable improvement graph, claims registry, evidence schema, and
  pilot validation contract under `quality/`.
- Backward-compatible JSON/file evidence export for `reporecall stats`.
- A unified canonical path-safety boundary covering symlinks, missing
  descendants, deletion events, prefix collisions, and platform separators.
- Type-aware ESLint, coverage gates, module-size and cycle checks, packed
  tarball demos, multi-OS CI, and nightly stress/benchmark workflows.
- Retrieval trust metrics for high-confidence-wrong results and
  fresh/stale/empty classification.

### Changed

- Prompt-context, daemon, indexing, MCP, search, Lens, wiki, and product-area
  internals are decomposed behind their existing public façades.
- Scheduler and runtime tests use explicit idle/readiness signals instead of
  sleep-based synchronization.
- Retrieval selection now suppresses repeated hook contamination and weak
  adjacent context while preserving response and persistence contracts.
- Token reports return insufficient evidence when measurements are unavailable;
  estimated fallback savings are no longer presented as measured results.

### Fixed

- Precise lookup queries ("where is X implemented") no longer inject wiki
  overview pages describing code that is not part of the answer. A hub page
  could win the lexical match on a single shared token — a
  `subscription-update` lookup pulling in an `UpdateNode` hub — which diluted
  lookup precision. Overview pages are still injected in full for breadth
  queries, where they are the point.

### Breaking

- **Node 22 is now the minimum supported runtime** (was Node 20). Node 20
  reached end-of-life, and `better-sqlite3` 12.9+ no longer ships Node 20
  prebuilds for Windows, so a Node 20 install could silently fall back to
  compiling from source and fail without a local toolchain. Upgrade to Node 22
  or newer before installing.

### Compatibility

- The existing CLI commands, six public MCP tools, config contracts, JSON
  contracts, and package exports remain compatible.
- All data remains local; evidence exports are explicit and redacted by
  default.

## [0.8.1] - 2026-07-09

### Positioning, Trust & Distribution Improvements (toward 9/10)

This patch focuses on making the strengths impossible to miss and addressing the competitive analysis feedback (engineering was already strong; positioning and communication were the gaps).

- **README repositioned** as the "local-first, auto-injecting, self-aware-about-staleness context + memory layer". Hooks are the hero, Trust Contract is prominent with ASCII diagram, "when we shine" + "concede median repo" sections added, benchmark claims, and competitor table.
- **package.json** updated with new description, expanded keywords (context-layer, auto-inject, trust-contract, etc.).
- **Stats & get_stats enhanced**: `reporecall stats` and MCP `get_stats` now lead with explicit freshness/trust data (banner, indexedCommit, dirty files, level).
- **New benchmark**: `npm run benchmark:tokens` (scripts/benchmarks/token-savings.ts) — reports real freshness + estimated token savings vs naive.
- **Docs overhaul & sync**:
  - New `docs/competitive-positioning-2026.md` (full rating, matrix, recs, action plan).
  - Updated competitor comparison, CLAUDE.md (root + template in init), website/docs (intro, mcp-tools, changelog).
  - Consistent "Trust Contract", hooks-first, concede language everywhere.
- **CHANGELOG, release files** updated for 0.8.1.
- **Other**: Improved benchmark docs, more examples, "Why Reporecall" table.

These changes directly implement the strategic recommendations from the OSS coding agents research: out-communicate the bundle + trust, make hooks hero, concede easy cases, publish receipts.

## [0.8.0] - 2026-07-09

Trust-contract remediation release. This is a breaking MCP surface change focused
on freshness honesty, leaner injected context, smaller storage, and less agent
tool-choice confusion.

### Post-0.8 Positioning & Documentation Push (toward 9/10)

- README, CLAUDE.md template, and docs overhauled to lead with the **local-first auto-injecting trust-contract bundle**.
- Hooks positioned as the hero UX.
- Explicit "when we shine / concede median repo" language.
- New `docs/competitive-positioning-2026.md` one-pager + updated competitor matrix.
- `reporecall stats` and `get_stats` now prominently surface freshness/trust data.
- Added `npm run benchmark:tokens` + `scripts/benchmarks/token-savings.ts` (real freshness + estimated savings).
- Website docs sources synced with new messaging.
- Benchmark claims and "Why Reporecall" comparison table added.

### Breaking

- Collapsed the public MCP surface to six tools: `search_context`,
  `search_code`, `explain_flow`, `memory`, `refresh_context`, and `get_stats`.
- Folded standalone navigation and memory tools into action-based tools:
  `search_code action=read_chunk`, `explain_flow action=callers|callees|stack_tree|imports|symbol|resolve_seed`,
  and `memory action=recall|explain|list|store|forget`.
- Removed destructive/wiki/business/topology standalone MCP tools from public
  registration. CLI Lens/explain JSON remains the structured export path for
  business and wiki data.

### Added

- Staleness metadata and warning banners across MCP responses and hook-injected
  context, including explicit empty-index repair guidance.
- `indexedCommit` stamping on completed index/refresh passes, including
  no-change verification passes.
- Auto-refresh on stale daemon indexes, with debouncing and a freshness-aware
  repair path.
- Storage visibility in stats: metadata DB bytes, free bytes, target count, and
  target-alias count.
- Design note for the MCP tool collapse at
  `docs/design/wp5-tool-collapse.md`.

### Changed

- Hook installation templates now surface curl failures instead of silently
  swallowing daemon outages.
- Prompt-context injection is leaner: broad fallbacks are reduced, vanished
  evidence is disclosed, advisory text counts against budgets, and compression
  expansion points use `search_code action=read_chunk`.
- Target aliases are deduped, capped per target, and pruned on startup for
  legacy databases.
- Common test/spec fixture directories are ignored by default as code evidence.
- Root benchmark entrypoints moved to `scripts/benchmarks/`; stale benchmark
  outputs and untracked source/report/tmp dumps were removed.

### Fixed

- Empty code indexes no longer block `refresh_context` or independent memory
  actions.
- Memory write/read actions are no longer falsely coupled to code-index
  freshness.
- Legacy indexes without commit stamps are treated honestly as stale in git
  repos instead of silently trusted.
- Architecture dashboard/lens (`reporecall lens`, `lens --json`, and the MCP
  dashboard export) no longer crashes with `Cannot read properties of undefined
  (reading 'communities')`; the bulk community-membership lookup is invoked as a
  bound method so `this` is preserved. (`src/visualize/data-extractor.ts`)

## [0.7.1] - 2026-05-12

Patch release driven by reporecall's self-evaluation on its own codebase.
Tightens seven specific defects in retrieval, capability evidence, indexing,
and business-context routing.

### Changed

- **`reporecall index`** now generates deterministic wiki and business pages at
  the end of an index pass (when the memory layer is enabled). Previously only
  `reporecall serve` and the MCP `refresh_context` tool wrote these pages, so
  CLI-only users got empty `list_product_areas` / `business_context_query`
  results. Pass `--no-wiki` to skip generation in CI scripts. (`src/cli/index-cmd.ts`)

### Fixed

- **Intent classifier** now routes "what files would I need to change …" and
  related "what files implement / handle / cover" queries to change/architecture
  mode instead of lookup. (`src/search/intent.ts`)
- **Bulk delete in indexer** wraps all per-file removals in a single
  transaction (`MetadataStore.removeFiles`) — fixes a SIGILL on large
  delete sets observed on the Bun runtime. (`src/indexer/pipeline.ts`,
  `src/storage/metadata-store.ts`)
- **Auth capability over-matching** — wiki/business `scoreFamilyEvidence`
  now demotes reporecall's own infra directories (`/indexer/`, `/search/`,
  `/business/`, `/wiki/`) and Claude Code hook lifecycle filenames
  (`session-start`, `pre-tool-use`, `prompt-context`, etc.) so passing
  mentions of session/auth tokens no longer publish false auth capability
  pages. Demotion is anchored on lifecycle filenames rather than the broad
  `/hooks/` path so downstream React `src/hooks/useAuth.tsx` files still
  classify as authentication. (`src/wiki/business.ts`)
- **Confident-wrong seeds in lookup mode** — `selectPrimarySeed` now requires
  the best seed's file path or name to share at least two non-generic anchors
  with the user's query. Short queries (<2 anchors) still bypass the gate so
  single-symbol lookups stay intact. (`src/search/lookup-strategy.ts`)
- **Test files in architecture/change answers** — RRF ranker now supports
  a `testFileMode: "exclude"` option (vs penalty) and broad change /
  architecture queries drop test files entirely unless the query itself
  mentions test/spec/e2e/fixture/mock. (`src/search/ranker.ts`,
  `src/search/pipeline-core.ts`)
- **Capability evidence gates too restrictive** — lookup mode now enters the
  resolver; queries without a hardcoded capability family (auth/billing/
  generation/upload) are accepted only when their non-generic anchors actually
  appear in the file path. (`src/search/capability-evidence.ts`)
- **Discovered product areas never beat fixed** — `buildProductAreas` now
  applies a tunable override margin (`DISCOVERED_OVERRIDE_MARGIN = 3`) so a
  strong domain phrase can displace a weak fixed match while still preventing
  single-token coincidences from flipping established areas.
  (`src/business/product-areas.ts`)

### Benchmark

Live IR benchmark MAP floor lowered 0.18 → 0.17 to absorb the trade-off in
the lookup anchor gate (rejects confident-wrong seeds with high scores) and
the architecture/change `testFileMode = "exclude"` path. NDCG@10, MRR, and
route accuracy all improved with the same changes.

## [0.7.0] - 2026-05-09

### Added

- Generic capability evidence resolution for `trace`, `architecture`, and `change` prompts.
- Wiki capability pages can now anchor retrieval by hydrating `relatedFiles` into concrete source context.
- Selection metadata on returned files/chunks: `selectionSource`, `selectionReason`, and `wikiPagesUsed`.
- `missingEvidence` reporting for hook guidance when expected capability layers are absent.
- Deterministic business capability wiki generation.
- `productAreas[]` and `businessPages[]` in `reporecall lens --json` for external utilities that need product-language context.
- Product-area aggregation over business pages for a business-facing layer above code-derived capabilities.
- Generic product-area discovery from business terms and data concepts, so repo-specific domain language can surface without hard-coded project vocabulary.
- `areaKind` metadata on product areas (`fixed`, `discovered`, `fallback`) so consumers can distinguish foundational groupings from supporting domain signals.
- Business-facing `displayName` and `displaySummary` fields for product areas and business pages.
- Business presentation metadata: `displayQuality`, `presentationSafe`, and `presentationIssues` on product areas and business pages.
- Explicit `technicalEvidence.files` and `technicalEvidence.symbols` fields so trusted tools can use source evidence without making technical labels the public business surface.
- Business wiki markdown now reports evidence quality without listing raw technical file/symbol names in the narrative body.
- Large-repo stress harness: `npm run stress:large-repo`.
- Large-repo CI stress gate: `npm run stress:large-repo:ci`.
- Query-specific `productAreasUsed[]` and `businessPagesUsed[]` in `reporecall explain --json`.
- MCP business-context tools: `list_product_areas` and `business_context_query`.
- MCP lifecycle tool `refresh_context` for external clients that need to re-index code and regenerate deterministic wiki/business pages before querying context.
- MCP Lens export tool `get_lens_data` for read-only access to current Lens JSON without shelling out to `reporecall lens --json`.
- Lens Product Areas and Business tabs for generated business capability pages.
- Product-oriented business capability naming that keeps technical constructs as supporting evidence instead of primary capability labels.
- Replacement suggestions for `wiki_read` when a generated wiki slug disappeared after regeneration.
- Business context schema documentation in `docs/business-context-schema.md`.
- Config flags: `capabilityEvidence` and `genericCapabilityHydration`.
- Documented Codex support through MCP and direct CLI usage.

### Changed

- Trace and architecture prompts now prefer file coverage across layers over simply adding more chunks.
- Business wiki pages are used as evidence only for suitable prompts instead of being blindly injected everywhere.
- Claude hook context may append a compact product-area evidence section for trace, architecture, and change prompts while leaving lookup prompts unchanged.
- Product-area assignment now prefers capability/business/data evidence over incidental supporting file, symbol, or storage terms.
- Business-context query ranking now downweights fallback areas and treats discovered areas as supporting signals unless directly matched.
- Product-area summaries are now derived from child business pages, user actions, outcomes, and data concepts rather than only from raw capability names.
- Business-context query output now filters unsafe fallback labels by default while keeping raw wiki/Lens evidence available for diagnostics and trusted technical clients.
- Generated wiki fingerprints now include a new business-presentation generator version so stale deterministic business pages are refreshed after this schema change.
- Target catalog rebuild now runs once after an indexing pass instead of after every indexing window.
- Topology and Lens graph construction now have chunk-count guardrails for large repositories.
- Topology and Lens exports now expose additive telemetry when graph-heavy analysis is computed or intentionally skipped.
- Large-repo stress reports now include active memory samples, explicit store cleanup, post-close samples, and optional failure budgets.
- Test/spec files are suppressed more aggressively unless the query asks for tests.
- Assistant/client instruction files such as `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.codex/**`, and `.mcp.json` are ignored as code evidence by default.
- README content was rewritten around the current retrieval, wiki, lens, MCP, Codex, and business export surfaces.
- Package metadata now describes Reporecall as local codebase memory with intent-routed retrieval, generated wiki, and MCP tools.

### Fixed

- Rarest-term FTS planning no longer lets zero-document terms dominate query construction.
- Generic capability hydration preserves exact lookup behavior while improving broad inventory and flow questions.
- Lens metadata now uses the target project root for `projectName` instead of the current shell directory.
- Source tests and comments were cleaned of customer/project-specific examples.

## [0.6.2] - Lens Architecture Dashboard

- Added `reporecall lens` as a portable architecture dashboard.
- Added `--serve`, `--open`, `--json`, and sizing options for lens output.
- Generated wiki pages during lens generation when an index exists.
- Fixed community membership lookup for generated wiki pages.

## [0.6.1] - Wiki Startup Generation

- Generated wiki pages on MCP server and daemon startup.
- Added a source-commit freshness guard for wiki writes.
- Synced package lock metadata.

## [0.6.0] - Wiki Layer and Memory Precision

- Added the generated wiki layer and wiki MCP tools.
- Tightened wiki/memory separation in search and prompt context.
- Fixed noisy memory retrieval behavior.

## [0.5.0] - Topology-Aware Search

- Added Louvain community detection, hub detection, and surprise scoring.
- Added topology MCP tools and investigation suggestions.
- Split the search pipeline into focused strategy modules.
- Added daemon and hook hardening.

## [0.4.0] - Intent-Based Retrieval

- Replaced the old `R0/R1/R2` route model with intent modes.
- Added delivery modes, hook guidance, semantic features, streaming indexing, and SQLite ABI self-repair.

## [0.3.0] - Memory V1

- Added persistent project memory for rules, facts, episodes, and working context.
- Added memory MCP tools and memory prompt assembly.
- Added target resolution and broad workflow search.
- Added memory benchmark coverage.

## [0.2.0] - Core Retrieval

- Added intent-based routing, seed resolution, flow tree construction, import graph analysis, and dynamic context budgets.
- Added broad parser and retrieval test coverage.
- Added MCP tools for search, indexing, stats, and call graph navigation.

## [0.1.0] - Initial Release

- Local codebase memory engine with Tree-sitter parsing, hybrid search, SQLite FTS, MCP integration, CLI access, and Claude Code hooks.
