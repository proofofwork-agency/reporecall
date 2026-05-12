# Business Context Schema

Reporecall exposes business-oriented context as an additive view over generated wiki pages. This view is intended for external utilities, planning agents, dashboards, and MCP servers that need product language without changing core code retrieval behavior.

Stable public surfaces:

- `reporecall lens --json` exposes whole-project `productAreas[]` and `businessPages[]`.
- `reporecall explain --json` exposes query-specific `productAreasUsed[]` and `businessPagesUsed[]`.
- MCP tools `list_product_areas` and `business_context_query` expose the same structures for live agent clients.
- `list_product_areas` and `business_context_query` default to presentation-safe records for business-facing clients. `list_product_areas` accepts `includeUnsafe: true` for diagnostics.
- MCP tool `refresh_context` lets an external client re-index code, regenerate deterministic wiki/business pages, and get updated stats before reading business context.
- MCP tool `get_lens_data` returns the current Lens JSON from the existing index, with options to omit raw wiki content, business pages, or graph-heavy arrays.
- MCP tool `wiki_read` returns replacement suggestions when a generated page slug no longer exists after wiki regeneration.

Consumers should read `productAreas[]` for business-facing grouping and `businessPages[]` for capability-level evidence when present. Keep a fallback for older Reporecall output.

`productAreas[]` is not a closed taxonomy. Reporecall includes common software-product groupings, and it may also derive areas from recurring business terms and data concepts found in the repository's generated business pages.

## Contract

Lens `meta.graphDetails` may include:

| Field | Type | Description |
| --- | --- | --- |
| `included` | `boolean` | Whether Lens loaded graph-heavy chunk/call-edge details. |
| `reason` | `"within_limit" | "too_many_chunks"` | Why graph details were loaded or skipped. |
| `totalChunks` | `number` | Indexed chunk count used for the graph guardrail. |
| `maxGraphChunks` | `number` | Configured extraction cap for graph-heavy Lens data. |
| `edgeCount` | `number` | Edge count in the Lens graph when included, otherwise `0`. |

Each `productAreas[]` item may include:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Stable product-area identifier. |
| `name` | `string` | Stable product-area name, usually prefixed with `Product Area:`. Kept for compatibility. |
| `displayName` | `string` | Business-facing product area label for UI, MCP, and planning tools. |
| `areaKind` | `"fixed" | "discovered" | "fallback"` | Whether the area came from Reporecall's common taxonomy, repo-derived domain terms, or last-resort fallback naming. |
| `summary` | `string` | Compatibility summary. Consumers should prefer `displaySummary` for business-facing UI. |
| `displaySummary` | `string` | Business-facing explanation derived from child business pages, user actions, outcomes, and data concepts. |
| `displayQuality` | `"high" | "medium" | "low" | "fallback"` | Presentation quality for business-facing display fields. |
| `presentationSafe` | `boolean` | Whether the area is safe to show as primary business-facing context without extra sanitization. |
| `presentationIssues` | `string[]` | Machine-readable reasons when a label or summary is thin, generic, fallback-derived, or dominated by technical evidence. |
| `businessTerms` | `string[]` | Product terms aggregated from child business pages. |
| `capabilities` | `string[]` | Business-facing capability labels grouped under this area. |
| `businessPages` | `string[]` | Linked business page slugs. |
| `supportingFiles` | `string[]` | Compatibility evidence files aggregated from child pages. |
| `supportingSymbols` | `string[]` | Compatibility evidence symbols aggregated from child pages. |
| `technicalEvidence` | `{ files: string[]; symbols: string[] }` | Explicit technical evidence separated from business-facing labels and summaries. |
| `confidence` | `number` | Confidence from `0` to `1`. |
| `confidenceLabel` | `"low" | "medium" | "high"` | Coarse confidence label for UI and MCP responses. |

Each `businessPages[]` item may include:

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Stable wiki page slug, usually prefixed with `business-`. |
| `capability` | `string` | Compatibility capability name extracted from the wiki page. |
| `displayName` | `string` | Business-facing capability label. Technical class/function labels are humanized here when possible. |
| `description` | `string` | Short page description. |
| `summary` | `string` | Compatibility summary. Consumers should prefer `displaySummary` for business-facing UI. |
| `displaySummary` | `string` | Business-facing summary that avoids using source file, class, or function names as the primary explanation. |
| `displayQuality` | `"high" | "medium" | "low" | "fallback"` | Presentation quality for the display fields. |
| `presentationSafe` | `boolean` | Whether the page is safe to show as primary business-facing context without extra sanitization. |
| `presentationIssues` | `string[]` | Machine-readable reasons when a label or summary is thin, generic, fallback-derived, or dominated by technical evidence. |
| `actor` | `string` | Primary user, client, worker, or integration involved. |
| `trigger` | `string` | Event or request that starts the capability. |
| `businessTerms` | `string[]` | Human-readable terms useful for product search, story drafting, and backlog grouping. |
| `userActions` | `string[]` | User-visible or operator-visible actions supported by the capability. |
| `decisionPoints` | `string[]` | Business-relevant checks, routing decisions, or eligibility gates. |
| `sideEffects` | `string[]` | State changes, callbacks, generated output, or downstream effects. |
| `businessOutcome` | `string` | Expected product result or state transition. |
| `dataConcepts` | `string[]` | Product/data concepts surfaced from code evidence. |
| `externalSystems` | `string[]` | External services or integration surfaces inferred from evidence. |
| `confidence` | `number` | Confidence from `0` to `1`. |
| `confidenceLabel` | `"low" | "medium" | "high"` | Coarse confidence label for UI and MCP responses. |
| `supportingFiles` | `string[]` | Compatibility evidence files. Business tools may hide these unless technical context is requested. |
| `supportingSymbols` | `string[]` | Compatibility evidence symbols. Business tools may hide these unless technical context is requested. |
| `technicalEvidence` | `{ files: string[]; symbols: string[] }` | Explicit source evidence for trusted technical tools. |
| `links` | `string[]` | Related wiki page slugs. |
| `content` | `string` | Markdown business narrative. The body should stay business-facing and describe evidence quality; concrete file/symbol names are exposed through structured evidence fields. |

## Consumer Guidance

- Treat this as a read-only product map, not a source-of-truth product specification.
- Keep the business view additive. Do not feed business summaries back into core search ranking as hard rules.
- Call MCP `refresh_context` after substantial repository changes or before a planning workflow that needs current wiki/product-area context.
- Call MCP `get_lens_data` when an agent or utility needs the full current Lens export without shelling out to `reporecall lens --json`.
- Use MCP `business_context_query` when an agent has a user question and needs only relevant product areas/pages instead of the full Lens export.
- If `wiki_read` returns `status: "not_found"`, show or follow the returned `suggestions[]` instead of treating a stale generated slug as a hard failure.
- Use `productAreas[]` as the preferred business-facing entry point. Use `businessPages[]` when the user needs capability-level detail and evidence.
- Prefer `areaKind: "fixed"` for primary navigation, treat `areaKind: "discovered"` as domain-supporting evidence unless it directly matches the user query, and treat `areaKind: "fallback"` as low-confidence context.
- Prefer `displayName` and `displaySummary` for business-facing UI. Keep `name`, `capability`, and `summary` for compatibility and diagnostics.
- For business-facing output, prefer records where `presentationSafe` is `true`. Treat `displayQuality: "fallback"` as diagnostic/supporting evidence, not primary user-facing content.
- Use `presentationIssues` to explain or filter weak generated labels without discarding raw wiki pages or source evidence.
- Hide `technicalEvidence`, `supportingFiles`, `supportingSymbols`, and raw markdown from hosted business users unless technical context is explicitly allowed.
- Prefer product-facing fields for public MCP surfaces: `displayName`, `displaySummary`, `businessTerms`, `userActions`, `businessOutcome`, `dataConcepts`, `externalSystems`, and `confidenceLabel`.
- Use `technicalEvidence` only as private evidence for trusted tools that can read source.
