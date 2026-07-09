# WP5 Tool Collapse Design Note

## Hard Constraints

- `refresh_context` remains public. WP1/WP3 banners and hook text tell agents to run `refresh_context`; keeping it avoids breaking the honesty contract. No banner rename needed.
- Memory templates from WP2 reference memory actions. To avoid silently re-breaking `CLAUDE.md`, the surviving `memory` tool must include both read and write verbs, and `src/cli/init.ts` plus tests must be updated in the same WP5 commit from `store_memory`/`recall_memories`/`forget_memory` to `memory action=store|recall|forget`.
- `memory` must not carry `readOnlyHint: true`, because it includes write verbs. It is also exempt from empty code-index short-circuiting because memory storage is independent of code chunks.

## Exact Surviving Public Tools

1. `search_context` — routed, budgeted, compressed multi-file context.
2. `search_code` — raw hit search plus exact chunk/source read via `action=read_chunk`.
3. `explain_flow` — code navigation verb tool via `action=flow|callers|callees|stack_tree|imports|symbol|resolve_seed`.
4. `memory` — memory verb tool via `action=recall|explain|list|store|forget`.
5. `refresh_context` — public repair/reindex verb, kept because staleness banners name it.
6. `get_stats` — health/stats/freshness surface.

## Full 32 to 6 Mapping

| Current tool | WP5 outcome |
| --- | --- |
| `search_context` | Survives unchanged. |
| `search_code` | Survives; absorbs `read_code_chunk` as `search_code action=read_chunk`. |
| `read_code_chunk` | Folded into `search_code action=read_chunk`. |
| `explain_flow` | Survives; absorbs graph/symbol/navigation actions. |
| `find_callers` | Folded into `explain_flow action=callers`. |
| `find_callees` | Folded into `explain_flow action=callees`. |
| `build_stack_tree` | Folded into `explain_flow action=stack_tree`. |
| `get_imports` | Folded into `explain_flow action=imports`. |
| `get_symbol` | Folded into `explain_flow action=symbol`. |
| `resolve_seed` | Folded into `explain_flow action=resolve_seed`. |
| `recall_memories` | Folded into `memory action=recall`. |
| `explain_memory` | Folded into `memory action=explain`. |
| `list_memories` | Folded into `memory action=list`. |
| `store_memory` | Folded into `memory action=store` to preserve the WP2 template contract. |
| `forget_memory` | Folded into `memory action=forget`, still explicit and named but no longer a separate chooser item. |
| `refresh_context` | Survives unchanged. |
| `get_stats` | Survives unchanged. |
| `index_codebase` | Dropped from MCP; use `refresh_context` for MCP repair or CLI `reporecall index` for lower-level indexing. |
| `clear_index` | Dropped/destructive; CLI-only to avoid accidental index wipes through agent tool choice. |
| `compact_memories` | Dropped/destructive; CLI/internal-only until a dedicated CLI command exists or compaction is folded into refresh policy. |
| `clear_working_memory` | Dropped/destructive; CLI/internal-only because it deletes generated memory state. |
| `get_lens_data` | Dropped from MCP public surface; CLI `reporecall lens --json` remains the structured export path. |
| `get_communities` | Internal-only/dropped; topology summary remains inside `get_stats`/Lens/CLI surfaces. |
| `get_hub_nodes` | Internal-only/dropped; same rationale. |
| `get_surprises` | Internal-only/dropped; same rationale. |
| `suggest_investigations` | Internal-only/dropped; same rationale. |
| `list_product_areas` | Dropped from MCP; product/business context remains available through Lens/CLI export, not as an agent chooser tool. |
| `business_context_query` | Dropped from MCP; same rationale. |
| `wiki_query` | Dropped from MCP; wiki is supporting evidence inside context/Lens, not a separate agent-facing retrieval surface. |
| `wiki_read` | Dropped from MCP; use Lens/CLI docs surfaces if needed. |
| `wiki_write` | Dropped/destructive; CLI/manual memory files only because MCP write creates persistent generated docs. |
| `wiki_check_staleness` | Dropped/internal-only; wiki staleness becomes Lens/CLI/internal diagnostic, not an agent chooser tool. |

## Destructive Tool Rationale

- `clear_index` — deletes the code index; CLI-only avoids accidental agent-triggered data loss.
- `compact_memories` — mutates archival/supersession state; internal/CLI-only until explicit UX exists. WP5 accepts that this removes the only external invocation path for now; WP6 compaction policy may absorb it.
- `clear_working_memory` — deletes generated working memories; internal/CLI-only. WP5 accepts that this removes the only external invocation path until a CLI verb or policy exists.
- `wiki_write` — writes persistent wiki memory pages; remove from MCP to prevent unreviewed agent-authored docs.
- `index_codebase` — not destructive exactly, but redundant/confusing with `refresh_context`; remove as standalone and keep `refresh_context` as the one public repair verb.
- `store_memory` and `forget_memory` — no longer standalone chooser items; folded into `memory action=store|forget` to preserve template functionality while reducing surface.

## Implementation Plan After Review Approval

1. Add a public-tool registration allowlist with the six names above.
2. Extend `search_code` schema/handler with `action`, `chunkId`, `filePath`, `startLine`, `endLine`.
3. Extend `explain_flow` schema/handler with action-specific parameters and return shapes for callers/callees/stack_tree/imports/symbol/resolve_seed.
4. Add new `memory` tool when `memorySearch` and `memoryIndexer` are available; it supports recall/explain/list/store/forget, has no `readOnlyHint`, bypasses empty code-index gating, and reuses existing logic under the lock.
5. Update descriptions, README/docs, `src/cli/init.ts` template, and tests so no public guidance points at removed MCP tool names.
6. Add/adjust tests: exact six registered tools; replacement action coverage; `refresh_context` still works on empty index; `memory action=store|recall` works on an empty code index while code tools stay gated; init template and this repo's own `CLAUDE.md` mention `memory` verbs; removed destructive names are absent.

## Current Status

WP5 implementation is in progress in the working tree after review approval.
