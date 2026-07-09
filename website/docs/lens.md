---
id: lens
title: Architecture Lens
sidebar_position: 8
---

# Architecture Lens

The **Lens** is Reporecall's architecture dashboard: one command produces a single self-contained HTML file showing your whole codebase at a glance, and the same data is available as a structured JSON export for external tools.

The Lens requires an existing index — run `reporecall index` (or `reporecall serve`) first. If no index is found, `lens` prints a prompt to index first.

## HTML dashboard

```bash
reporecall lens --serve --open
```

- `--serve` starts a small HTTP server on `localhost` (default port `7878`).
- `--open` opens it in your default browser.
- Without `--serve`, the command writes an HTML file (default under `.memory/`, or `--output <path>`) and exits.

The dashboard shows:

- overview stats;
- Louvain communities;
- high-degree hub nodes;
- surprising cross-module edges;
- generated wiki pages;
- product areas that group related business capability pages;
- business capability pages with product-facing summaries and supporting files.

### Sizing options

| Option | Default |
| --- | --- |
| `--max-communities <n>` | `20` |
| `--max-hubs <n>` | `15` |
| `--max-surprises <n>` | `20` |
| `--port <n>` (with `--serve`) | `7878` |

## JSON export

```bash
reporecall lens --json > lens.json
```

`--json` prints the raw dashboard data (logs go to stderr) so it pipes cleanly. This is the recommended, dependency-free way for external tools to consume Reporecall's topology, wiki graph, and business context. (The former `get_lens_data` MCP tool was removed in v0.8.0; use this CLI export instead.)

### Top-level shape

```json
{
  "meta": { "...": "..." },
  "communities": [],
  "hubs": [],
  "surprises": [],
  "questions": [],
  "wikiPages": [],
  "wikiGraphNodes": [],
  "wikiGraphEdges": [],
  "businessPages": [],
  "productAreas": [],
  "chordMatrix": [],
  "chordLabels": [],
  "chordColors": []
}
```

| Field | Description |
| --- | --- |
| `meta` | Project name, timestamps, and counts (see below). |
| `communities` | Louvain communities: id, label, node count, cohesion, color, members, cross-edges, wiki slug. |
| `hubs` | High-degree nodes with callers, callees, community, and wiki mentions. |
| `surprises` | Cross-module edges with score, reasons, and source/target communities. |
| `questions` | Suggested investigation prompts (`type`, `question`, `why`). |
| `wikiPages` | Full generated wiki pages (name, type, description, summary, content, links, backlinks, related symbols/files, confidence, source commit). |
| `wikiGraphNodes` / `wikiGraphEdges` | Machine-readable wiki graph for visualization. |
| `businessPages` | Product-language capability pages (see [Business context](#business-context)). |
| `productAreas` | Business-facing groupings over capability pages. |
| `chordMatrix` | Community×community cross-edge counts for the chord diagram. |
| `chordLabels` / `chordColors` | Labels and colors aligned to the chord matrix rows/columns. |

### `meta`

```json
{
  "projectName": "your-project",
  "generatedAt": "2026-07-09T12:00:00.000Z",
  "totalSymbols": 412,
  "totalFiles": 312,
  "totalEdges": 1840,
  "graphDetails": {
    "included": true,
    "reason": "within_limit",
    "totalChunks": 4821,
    "maxGraphChunks": 50000,
    "edgeCount": 1840
  },
  "communityCount": 14,
  "wikiPageCount": 22,
  "businessPageCount": 2,
  "productAreaCount": 3,
  "hubCount": 15,
  "surpriseCount": 20
}
```

`graphDetails.reason` is `within_limit` or `too_many_chunks` — the latter signals that graph-heavy details were skipped for a large repo (the guardrail governed by `topologyMaxChunks`).

## Business context

The Lens carries an additive, product-language layer that external planning tools and dashboards can use without touching code internals.

- **`productAreas[]`** — business-facing groupings. Each has `displayName`, `displaySummary`, and `areaKind` (`fixed` | `discovered` | `fallback`), plus presentation metadata (`displayQuality`, `presentationSafe`, `presentationIssues`) and separated `technicalEvidence`.
- **`businessPages[]`** — capability-level pages with `displayName`, `displaySummary`, `actor`, `trigger`, `businessTerms`, `userActions`, `decisionPoints`, `sideEffects`, `businessOutcome`, `dataConcepts`, `externalSystems`, `confidenceLabel`, and `technicalEvidence`.

Consumer guidance:

- Prefer `displayName` / `displaySummary` for business-facing UI; keep `name` / `capability` / `summary` for compatibility.
- Prefer records where `presentationSafe` is `true`; treat `displayQuality: "fallback"` as diagnostic, not primary content.
- Use `areaKind: "fixed"` for primary navigation, `discovered` as domain-supporting evidence, and `fallback` as low-confidence.
- Hide `technicalEvidence` / `supportingFiles` / `supportingSymbols` from hosted business users unless technical context is explicitly allowed.

For query-specific business context (only the areas/pages relevant to one question), use `reporecall explain --json`, which exposes `productAreasUsed[]` and `businessPagesUsed[]`. The full schema is documented in the in-repo `docs/business-context-schema.md`.

## Refreshing before export

The Lens reads the **current** index. If you need fresh topology/wiki data first, re-index (`reporecall index`) or, from an MCP client, call `refresh_context` — then read `reporecall lens --json`.
