# Reporecall v0.7.0 vs v0.6.2 Comparison

This document compares the current Reporecall working tree, prepared as `0.7.0`, against the previous `0.6.2` release baseline.

The short version: `0.6.2` made Reporecall visible and navigable through the Lens dashboard. `0.7.0` makes Reporecall more useful to agents by improving retrieval coverage, adding capability evidence, and exposing business-oriented context as a public, generic output.

## Executive Summary

| Area | v0.6.2 | v0.7.0 |
| --- | --- | --- |
| Core strength | Architecture Lens and generated wiki visibility | Better trace/architecture recall through capability evidence |
| Agent integration | Claude Code hooks, MCP, CLI | Claude Code hooks, Codex via MCP/CLI, generic tool surfaces |
| Wiki role | Generated topology docs, injected when relevant | Topology docs plus business capability evidence anchors |
| Business context | Not a first-class output | `productAreas[]`, `businessPages[]`, query-specific explain fields, MCP business/Lens tools, schema doc, Lens Product Areas and Business tabs |
| Retrieval strategy | Intent-routed search with graph/topology support | Intent-routed search plus capability/file coverage resolver |
| Public outputs | HTML Lens, MCP, CLI | HTML Lens, MCP business tools, MCP `get_lens_data`, CLI, `explain --json`, `lens --json` business export |
| Main risk | Broad/trace recall could miss backbone files | More scoring complexity and more moving parts |

## What Changed

### New capability evidence layer

`v0.7.0` adds `src/search/capability-evidence.ts`.

It selects files for `trace`, `architecture`, and `change` questions using multiple signals:

- direct code matches;
- wiki capability pages;
- wiki `relatedFiles`;
- import neighbors;
- call neighbors;
- mandatory flow-step hints;
- generic query-anchored fallback scoring.

The practical difference is that a query like "which files implement X?" should return a more complete implementation slice instead of only the highest-ranking chunks.

### Business wiki generation

`v0.7.0` adds `src/wiki/business.ts`.

It generates deterministic business capability pages from code communities, hubs, and surprises. These pages are product-language views over code evidence. They are not handwritten product requirements and are not treated as source-of-truth business rules.

Important guardrails:

- capability families are generic;
- confidence is capped when evidence is weak;
- metadata-only files are filtered;
- low-signal symbol noise is filtered;
- business pages are evidence anchors, not prompt text by default.

### Prompt context behavior

`src/hooks/prompt-context.ts` is significantly expanded.

New behavior:

- business wiki pages are filtered out of prompt injection;
- a compact product-area evidence section can be appended for trace, architecture, and change prompts when budget allows;
- business wiki `relatedFiles` can hydrate actual code context;
- selected files include provenance metadata;
- trace and architecture routes try to cover multiple implementation layers;
- broad inventory questions can hydrate files instead of just adding larger chunks;
- missing evidence is surfaced to the agent.

### Lens and export changes

The Lens data model now includes:

- `businessPages[]`;
- `productAreas[]`;
- `displayName` and `displaySummary` fields for business-facing display;
- `technicalEvidence` for source files and symbols behind the business layer;
- `wikiGraphNodes[]`;
- `wikiGraphEdges[]`;
- `businessPageCount`.

The HTML dashboard now includes **Product Areas** and **Business** tabs, so the business-facing aggregation and capability pages are visible in `reporecall lens`, not just in `reporecall lens --json`.

MCP clients can now use `get_lens_data` for the same current Lens JSON without shelling out to the CLI. The tool is read-only and should be paired with `refresh_context` when a client needs to re-index before reading Lens data.

Product areas include `areaKind` metadata: `fixed`, `discovered`, or `fallback`. This lets downstream consumers keep common product groupings primary while using repo-derived domain areas as supporting context.

Business pages and product areas also separate display fields from source evidence. Consumers should show `displayName` and `displaySummary` by default, and reserve `technicalEvidence` for trusted technical views.

### Configuration changes

New config flags:

| Key | Default | Purpose |
| --- | --- | --- |
| `capabilityEvidence` | `true` | Enables capability evidence selection for trace, architecture, and change routes. |
| `genericCapabilityHydration` | `true` | Hydrates generic broad-inventory evidence into prompt context. |

Default ignore rules now exclude assistant/client instruction artifacts from code evidence:

- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
- `REPORECALL.md`
- `.mcp.json`
- `.claude/**`
- `.codex/**`
- `.agents/**`
- `.cursor/**`
- `.continue/**`

This prevents agent instructions and local client config from polluting code retrieval.

## The Good

### Better recall shape

The strongest improvement is not "more context". It is better context shape.

`v0.6.2` could retrieve correct top chunks but still miss supporting files needed to understand a real flow. `v0.7.0` tries to build a file set that covers the actual implementation path:

- entry/UI;
- state, hook, or provider;
- service/client/controller;
- endpoint/function/handler;
- shared helpers.

That is the right direction for agent work because agents usually fail when they miss one important file, not when they lack another paragraph from a file they already have.

### Business context is additive

The business layer is not wired back into core retrieval as hard-coded truth.

It is exposed as:

- generated wiki pages;
- `productAreas[]` and `businessPages[]` in `lens --json`;
- `productAreasUsed[]` and `businessPagesUsed[]` in `explain --json`;
- MCP `list_product_areas`, `business_context_query`, and `get_lens_data`;
- a documented schema;
- Lens Product Areas and Business tabs.

This makes it useful for external tools without letting generated product narrative take over source-code retrieval.

### Cleaner public API story

`v0.7.0` has clearer public surfaces:

- Claude Code hooks for automatic context injection;
- MCP tools for live agent access;
- CLI for deterministic command output;
- `reporecall explain --json` for per-question diagnostics;
- `reporecall lens --json` for whole-project topology and business context;
- MCP `get_lens_data` for read-only Lens JSON;
- `docs/business-context-schema.md` for downstream consumers.

That is much better than telling tools to import internal modules.

### More auditable selection

Selected files can now carry:

- `selectionSource`;
- `selectionReason`;
- `wikiPagesUsed`;
- `missingEvidence`.

This is important because retrieval quality is hard to debug without provenance. A file being selected because it directly matched the query is different from a file being selected because a business wiki page pointed to it.

### Lookup behavior is protected

The capability resolver is limited to `trace`, `architecture`, and `change`. Exact lookup should stay small and direct.

This matters because improving broad recall often damages exact lookup precision. The new behavior is scoped to the query modes that need it.

### Dashboard is more complete

`v0.6.2` Lens showed topology and wiki. `v0.7.0` also shows business capability pages.

The dashboard now better matches the JSON export and the README claims.

## The Bad

### More complexity in retrieval

The retrieval pipeline is now more powerful but harder to reason about.

There are more layers:

- intent classification;
- seed retrieval;
- wiki search;
- capability evidence resolution;
- file hydration;
- adjacency expansion;
- prompt pruning;
- business-page filtering.

This improves capability, but debugging a bad retrieval result now requires checking more places.

### Scoring remains heuristic

The capability resolver uses deterministic scoring. That is good for cost, speed, and repeatability, but it is still heuristic.

Even with named constants, the scoring model will need calibration over time:

- which files count as UI vs service vs shared;
- how much import neighbors should matter;
- when business wiki evidence should dominate;
- when generic query anchors should beat family-specific signals.

The current version is practical, not mathematically clean.

### Business page generation is bounded, not perfect

Business pages are generated from code structure and symbol/path names. That means they can be useful, but they are still inferred.

Possible failure modes:

- a capability exists but naming is too generic to detect;
- a capability is detected but described too broadly;
- a code community mixes multiple product concerns;
- external systems are inferred from names rather than runtime config;
- confidence can be high for code evidence while business interpretation is still incomplete.

The docs correctly position these pages as product-language maps with supporting evidence, not as canonical specs.

### HTML Lens is now heavier

Adding Business pages makes Lens more useful, but the dashboard has more UI and more embedded data.

For normal projects this is fine. For very large generated wiki sets, the self-contained HTML could become heavier and slower to search/render.

### Some behavior is still CLI-local and synchronous

The Lens data extractor still reads wiki page frontmatter from disk while building dashboard data. That is acceptable for local CLI use, but it is not the ideal architecture if the wiki grows to thousands of pages.

Longer term, the memory store should carry page metadata directly so the Lens does not need per-page file reads.

## The Ugly

### The hook path is getting large

`src/hooks/prompt-context.ts` has grown substantially.

It now owns too much orchestration:

- wiki inclusion rules;
- capability hydration;
- trace file selection;
- selected-file pruning;
- telemetry fields;
- prompt context assembly.

This is not broken, but it is becoming a future refactor target. The right direction is to keep moving route-specific selection logic into smaller modules.

### Generic capability families are useful but incomplete

The current capability families cover common app domains like authentication, billing, generation, upload, messaging, flows, and jobs.

That is useful, but generic software has many domains:

- permissions and roles;
- notifications;
- analytics;
- onboarding;
- search;
- admin operations;
- imports/exports;
- collaboration;
- scheduling;
- audit trails.

The generic fallback helps, but family-aware scoring will never cover every project domain out of the box.

### More tests, but full-suite local UX still has known rough edges

The focused test groups pass, and the build is clean. The review also noted a local full-suite issue around parallel native-module loading in the tree-builder/topology area.

That is not a regression from the `0.7.0` changes, but it affects confidence for new contributors because a full `npm test` can look broken in some environments.

A future improvement should make this easier to diagnose, likely through `reporecall doctor`, test isolation, or a documented rebuild step.

## The Greatness

### Reporecall is becoming an agent context layer, not just search

The biggest upgrade is conceptual.

`v0.6.2` was already more than search because it had wiki and Lens. `v0.7.0` pushes further: it tries to assemble the files an agent actually needs to work on a flow.

That is the difference between:

> "Here are the top search hits."

and:

> "Here is the implementation surface you probably need to inspect first, with reasons."

That is a real agent-product improvement.

### It stays local and deterministic

The new business pages and capability evidence do not require an LLM call.

That keeps Reporecall:

- fast;
- cheap;
- reproducible;
- private;
- testable.

For developer tooling, that is a strong foundation.

### The public surface is broader but still generic

The release adds value for multiple consumers without hard-wiring any one downstream tool.

Supported consumers now include:

- Claude Code through hooks;
- Codex through MCP/CLI;
- MCP-compatible clients;
- scripts through CLI JSON;
- dashboards through Lens JSON;
- planning utilities through `productAreas[]` and `businessPages[]`.

That is the right abstraction boundary.

### Business context is useful without being dangerous

The business layer could have been risky if it were injected into prompts as truth. Instead, it is treated as evidence and exposed as a separate output.

That is the correct compromise:

- code retrieval remains grounded in files and graphs;
- external tools get product language;
- agents can trace back to supporting files.

## The Badness

### There is more to tune

The new system creates more knobs:

- capability family weights;
- layer coverage limits;
- prompt pruning limits;
- wiki matching thresholds;
- business confidence rules;
- generic hydration rules.

This means the release improves capability but also increases maintenance responsibility.

### Some improvements are hidden unless users know where to look

Users who only run `reporecall search` may not notice the biggest improvements.

The best `0.7.0` surfaces are:

- hook-injected prompt context;
- `reporecall explain --json`;
- MCP tools;
- `reporecall lens`;
- `reporecall lens --json`.
- MCP `get_lens_data`.

The README now explains this, but the CLI UX could still do more to guide users toward the right entry point.

### The benchmark story is mixed

The current keyword benchmark after the review fixes reports:

| Metric | Current |
| --- | ---: |
| NDCG@10 | `0.396` |
| MRR | `0.568` |
| Route accuracy | `88.9%` |

Those numbers are stable after the documentation and review fixes. They do not fully capture the new capability evidence behavior, because the benchmark is not solely a project-context recall audit.

The more important acceptance check for this release is whether trace and architecture questions get better file coverage without damaging lookup behavior.

## What Is Better Than v0.6.2

1. Trace and architecture questions can now recover related implementation files, not just top chunks.
2. Wiki pages can act as retrieval evidence through `relatedFiles`.
3. Business capability context exists as a stable public export.
4. Lens HTML now renders business capability pages.
5. Codex and other MCP-compatible clients are documented as supported consumers.
6. Assistant/client instruction files are excluded from code evidence by default.
7. Selected files have clearer provenance.
8. Exact lookup remains scoped away from capability hydration.
9. MCP clients can refresh context and read Lens JSON without shelling out.
10. The package docs and changelog now match the actual release surface.

## What Is Worse Or Riskier Than v0.6.2

1. Retrieval logic is more complex.
2. Prompt-context orchestration is larger and should eventually be split.
3. Heuristic scoring needs continued calibration.
4. Business pages can be incomplete or over-broad when names are weak.
5. Lens has more embedded data and UI surface.
6. Very large wiki sets may expose the synchronous dashboard extraction path.
7. Full-suite test UX can still be noisy in some local environments because of a pre-existing native-module parallel-load issue.

## Release Readiness View

### Good enough for `0.7.0`

- Generic capability evidence is implemented and tested.
- Business wiki generation is implemented and tested.
- Business pages are visible in both JSON and HTML Lens.
- Lens JSON is available over MCP through `get_lens_data`.
- Public schema is documented.
- README and changelog are aligned.
- Focused tests pass.
- Build passes.
- Keyword benchmark did not regress after the review fixes.
- No customer/project-specific hard references are present in source/docs/tests.

### Should follow after `0.7.0`

- Move more prompt-context route logic into smaller modules.
- Replace frontmatter reads in Lens extraction with stored page metadata.
- Add more capability families or a configurable family registry.
- Improve benchmark coverage for capability evidence specifically.
- Improve full-suite test ergonomics around native SQLite module loading.
- Add CLI affordances that explain which surface to use: search vs explain vs lens vs MCP.

## Final Verdict

`v0.7.0` is a meaningful upgrade over `v0.6.2`.

The good is real: better file coverage, better agent context, business capability exports, Codex/MCP clarity, and a more complete Lens dashboard.

The bad is also real: more heuristics, more orchestration, and more maintenance surface.

The ugly is manageable: the largest file is getting too large, dashboard extraction has a scale wart, and capability families will need tuning.

Overall, this is the right kind of complexity. Reporecall is moving from "code search plus wiki" toward "generic local context infrastructure for coding agents and adjacent tools." That is the better product direction, as long as the next releases keep paying down the orchestration and scoring complexity introduced here.
