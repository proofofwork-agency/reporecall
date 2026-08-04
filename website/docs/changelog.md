---
id: changelog
title: Changelog
sidebar_position: 9
---

# Changelog

## v0.9.1 — Freshness Integrity (2026-08-04)

- **Fixed:** a modified file could stay indexed as fresh indefinitely. Change
  detection skips hashing when mtime, ctime and size all match, but filesystem
  timestamps are coarse — the Windows clock advances in ~15.6ms steps, HFS+
  stores whole seconds, FAT32 two-second steps — so two writes inside one step
  share an mtime exactly. A file hashed between them lost the second write on
  every later scan. On Windows `ctime` is the creation time and does not move on
  modification, so a length-preserving edit cleared all three signals at once.
  Files written within that granularity are now marked timestamp-untrusted and
  re-hashed on the next scan.
- Added: the full test suite runs on Windows and macOS in CI, not only Ubuntu.
- Added: offline documentation search, rendered Mermaid architecture diagrams,
  a custom 404, and a social preview card.
- Both registered claims re-measured against a freshly cloned and re-indexed
  1,306-file repository with this release's build. Retrieval gate unchanged;
  context-assembly cost moved inside measurement variance.

## v0.9.0 — Engineering Hardening (2026-08-04)

- Added reproducible evidence, compatibility snapshots, claims validation, and
  machine-readable release gates.
- Unified filesystem containment across indexing, watcher, removal, MCP, and
  daemon entry points.
- Added type-aware linting, coverage, module/cycle checks, multi-OS CI, packed
  demos, and nightly stress/benchmark jobs.
- Hardened retrieval confidence, freshness signaling, and repeated hook-context
  contamination handling.
- Decomposed large internals behind compatible CLI, MCP, config, JSON, and
  package façades.
- Fixed precise lookups injecting unrelated wiki overview pages that matched on
  a single shared token; breadth queries still receive them in full.
- **Breaking:** Node 22 is now the minimum supported runtime. Node 20 is
  end-of-life and `better-sqlite3` 12.9+ dropped its Windows prebuilds, so a
  Node 20 install could fall back to a source build.

See the root CHANGELOG for details.

## v0.8.1 — Positioning, Trust & Distribution (2026-07-09)

Patch release focused on making the product story match the engineering quality (per competitive analysis).

- README and all docs now lead with **local-first, auto-injecting, self-aware context + memory layer** + Trust Contract.
- Hooks positioned as primary UX.
- `reporecall stats` / `get_stats` prominently show freshness.
- New `npm run benchmark:tokens`.
- New competitive positioning doc.
- Full sync across README, CLAUDE.md, website/docs, competitor matrix.

See root CHANGELOG for details.

## v0.8.0 — Trust-Contract Remediation (2026-07-09)

A **breaking MCP surface change** focused on freshness honesty, leaner injected context, smaller storage, and less agent tool-choice confusion.

### Breaking — six-tool MCP surface

The public MCP surface collapsed to **exactly six tools**:

- `search_context`, `search_code`, `explain_flow`, `memory`, `refresh_context`, `get_stats`.

Standalone navigation and memory tools were folded into action-based verbs — `search_code action=read_chunk`; `explain_flow action=callers|callees|stack_tree|imports|symbol|resolve_seed`; `memory action=recall|explain|list|store|forget`. Destructive, wiki, business, and topology standalone tools were removed from public MCP registration; **CLI Lens/explain JSON is now the structured export path** for business and wiki data. See [MCP Tools](./mcp-tools.md) for the full mapping.

### Added — freshness honesty

- Staleness metadata and warning banners across MCP responses and hook-injected context, with explicit empty-index repair guidance.
- `indexedCommit` stamping on completed index/refresh passes (including no-change verification passes).
- **Auto-refresh** on stale daemon indexes, with debouncing and a freshness-aware repair path.
- Storage visibility in stats: metadata DB bytes, free bytes, target count, and target-alias count.
- Design note for the tool collapse at `docs/design/wp5-tool-collapse.md`.

### Changed — leaner context & compact storage

- Prompt-context injection is leaner: broad fallbacks reduced, vanished evidence disclosed, advisory text counted against budgets, and compression expansion points use `search_code action=read_chunk`.
- Target aliases are deduped, capped per target, and pruned on startup for legacy databases (compact metadata storage).
- Hook installation templates now surface curl/daemon failures instead of silently swallowing them.
- Common test/spec fixture directories are ignored by default as code evidence.

### Fixed

- Empty code indexes no longer block `refresh_context` or independent `memory` actions.
- Memory write/read actions are no longer falsely coupled to code-index freshness.
- Legacy indexes without commit stamps are treated honestly as stale in git repos.
- The architecture lens no longer crashes with `Cannot read properties of undefined (reading 'communities')` (bound community-membership lookup in `src/visualize/data-extractor.ts`).

## Earlier releases

- **v0.7.1** — Self-evaluation patch: `reporecall index` generates deterministic wiki/business pages; intent-classifier routing fixes; single-transaction bulk delete; auth over-matching and confident-wrong seed fixes.
- **v0.7.0** — Capability evidence & business-context export: generic capability evidence for trace/architecture/change; `productAreas[]` / `businessPages[]` in `lens --json`; documented Codex support.
- **v0.6.x** — Lens architecture dashboard and the generated wiki layer.
- **v0.5.0** — Topology-aware search (Louvain communities, hubs, surprises).
- **v0.4.0** — Intent-based retrieval modes (replacing the old R0/R1/R2 model).
- **v0.3.0** — Memory V1 (rules, facts, episodes, working context).
- **v0.1.0 – v0.2.0** — Initial release and core retrieval: Tree-sitter parsing, hybrid search, SQLite FTS, MCP integration, CLI, and Claude Code hooks.

---

For the complete, authoritative history, see the [`CHANGELOG.md`](https://github.com/proofofwork-agency/reporecall/blob/main/CHANGELOG.md) shipped with the package.
