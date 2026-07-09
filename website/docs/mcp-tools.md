---
id: mcp-tools
title: MCP Tools
sidebar_position: 4
---

# MCP Tools

As of **v0.8.0**, Reporecall exposes a deliberately compact **6-tool** MCP surface. This is part of the Trust Contract: fewer choices, less confusion, and explicit staleness on every response.

**Primary experience:** Claude Code hooks auto-inject context. Use MCP tools only for gaps.

Start the server:

```bash
reporecall mcp --project .
```

## How a coding agent should use these

1. **Answer from injected hook context first.**
2. **Fill gaps** with `search_context` (best default), `search_code action=read_chunk`, or `explain_flow` actions.
3. **Always check freshness** with `get_stats`. Run `refresh_context` when stale/empty.

All read-only tools return a `staleness` object + banner when relevant.

All read tools attach a `staleness` object (and a `banner` string when relevant) to their responses. Read tools short-circuit on an empty index with repair guidance — except `get_stats` and `memory`, which remain usable because memory is independent of the code index.

---

## 1. `search_context`

**Purpose:** Return assembled, token-budgeted code context for a multi-file question. Uses Reporecall's intent routing and evidence compression; compressed entries can be expanded later with `search_code action=read_chunk`. This is the preferred tool for "how does X work?" / "which files implement Y?" questions.

**Input properties:**

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Natural-language codebase question. |
| `tokenBudget` | integer | no | Context token budget. Defaults to the configured auto budget. |
| `activeFiles` | string[] | no | Currently open file paths, used for boosting. |

**Example `tools/call`:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search_context",
    "arguments": {
      "query": "how does checkout session creation work?",
      "tokenBudget": 4000,
      "activeFiles": ["src/server/routes/checkout.ts"]
    }
  }
}
```

The response includes `text` (the assembled context), `tokenCount`, `chunksIncluded`, `routeStyle`, `deliveryMode`, `selectedFiles`, a `chunks[]` array (id/name/filePath/kind/lines/score/language), and a `compression` summary.

---

## 2. `search_code`

**Purpose:** Search raw code chunks, or read one exact indexed chunk. This is the tool for precise hit lists and for expanding compressed evidence back to full source.

**`action` values:**

- **`search`** (default) — raw ranked hits for `query`.
- **`read_chunk`** — return the full source of one chunk, addressed either by `chunkId` or by `filePath` + `startLine`/`endLine`.

**Input properties:**

| Property | Type | Description |
| --- | --- | --- |
| `action` | `"search" \| "read_chunk"` | Operation to run (default `search`). |
| `query` | string | Search query (for `action=search`). |
| `limit` | integer (1–500) | Max results (default 20). |
| `activeFiles` | string[] | Open file paths for boosting. |
| `chunkId` | string | Exact chunk id (for `action=read_chunk`). |
| `filePath` | string | Indexed project-relative path (for `action=read_chunk`). |
| `startLine` | integer | Start line for file-path lookup. |
| `endLine` | integer | End line for file-path lookup. |

**Example — raw search:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "search_code",
    "arguments": { "action": "search", "query": "resolveCustomer", "limit": 10 }
  }
}
```

**Example — read a chunk by id (expand compressed evidence):**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "search_code",
    "arguments": { "action": "read_chunk", "chunkId": "a1b2c3d4" }
  }
}
```

**Example — read a chunk by location:**

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "search_code",
    "arguments": {
      "action": "read_chunk",
      "filePath": "src/billing/checkout.ts",
      "startLine": 41,
      "endLine": 88
    }
  }
}
```

---

## 3. `explain_flow`

**Purpose:** Code navigation. One tool, seven actions covering assembled call-flow context and focused graph/symbol lookups.

**`action` values:**

- **`flow`** (default) — assembled, budgeted call-flow context around a seed resolved from `query`.
- **`callers`** — functions that call a target (`functionName` or `query`).
- **`callees`** — functions called by a target (`functionName` or `query`).
- **`stack_tree`** — bidirectional call tree from a `seed`.
- **`imports`** — import statements for a `filePath`.
- **`symbol`** — look up code symbols by `name`.
- **`resolve_seed`** — rank code symbols that best match a `query` (seed candidates).

**Input properties:**

| Property | Type | Description |
| --- | --- | --- |
| `action` | enum | `flow` \| `callers` \| `callees` \| `stack_tree` \| `imports` \| `symbol` \| `resolve_seed` (default `flow`). |
| `query` | string | Natural-language query or symbol name. |
| `functionName` | string | Function name for `callers`/`callees`. |
| `name` | string | Symbol name for `action=symbol`. |
| `seed` | string | Function/method name for `action=stack_tree`. |
| `filePath` | string | Relative file path for `action=imports`. |
| `limit` | integer (1–500) | Max results for callers/callees (default 20). |
| `direction` | `"up" \| "down" \| "both"` | Tree direction (default `both`). |
| `maxDepth` | integer (1–10) | Maximum tree depth (default 2). |

**Example — flow:**

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "explain_flow",
    "arguments": { "action": "flow", "query": "checkout session" }
  }
}
```

**Example — callers:**

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "explain_flow",
    "arguments": { "action": "callers", "functionName": "createCheckoutSession", "limit": 20 }
  }
}
```

**Example — imports:**

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "explain_flow",
    "arguments": { "action": "imports", "filePath": "src/billing/checkout.ts" }
  }
}
```

---

## 4. `memory`

**Purpose:** Persistent project memory. Reads (`recall`, `explain`, `list`) and explicit writes (`store`, `forget`). Memory is independent of the code index, so this tool works even when no code is indexed. See [Memory](./memory.md) for the model.

**`action` values:** `recall` | `explain` | `list` | `store` | `forget`.

**Key input properties:**

| Property | Type | Used by | Description |
| --- | --- | --- | --- |
| `action` | enum | all | Required. |
| `query` | string | recall, explain | Search query. |
| `limit` | integer (1–50) | recall, explain | Max results. |
| `tokenBudget` | number | explain | Memory token budget (default 500). |
| `types` / `classes` / `scopes` / `statuses` | string[] | recall, explain | Filters (see below). |
| `activeFiles` / `topCodeFiles` / `topCodeSymbols` | string[] | recall, explain | Contextual boosting. |
| `minConfidence` | number (0–1) | recall, explain | Minimum confidence. |
| `memoryType` / `memoryClass` / `memoryScope` / `memoryStatus` | enum | list, store | Single-value filters/fields. |
| `name` | string (≤200) | store, forget | Memory name. |
| `description` | string (≤500) | store | One-line description. |
| `content` | string | store | Markdown body. |
| `summary` | string (≤500) | store | Optional compressed summary. |
| `pinned` | boolean | store | Survive compaction. |
| `confidence` | number (0–1) | store | Confidence score. |
| `relatedFiles` / `relatedSymbols` | string[] | store | Associations. |
| `supersedesId` | string | store | Memory this record supersedes. |
| `sourceKind` | enum | store | `claude_auto` \| `reporecall_local` \| `generated`. |
| `reason` | string (≤500) | store | Lifecycle/compaction reason. |

Filter enums: **types** `user`/`feedback`/`project`/`reference`; **classes** `rule`/`fact`/`episode`/`working`; **scopes** `global`/`project`/`branch`; **statuses** `active`/`archived`/`superseded`.

`action=store` **requires** `name`, `description`, `memoryType`, and `content`.

**Example — recall:**

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": {
    "name": "memory",
    "arguments": { "action": "recall", "query": "commit message conventions", "limit": 5 }
  }
}
```

**Example — store:**

```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "tools/call",
  "params": {
    "name": "memory",
    "arguments": {
      "action": "store",
      "memoryType": "project",
      "memoryClass": "rule",
      "name": "no-coauthor-tag",
      "description": "Do not add Co-Authored-By tags to commits",
      "content": "# Commit policy\n\nDo not append Co-Authored-By trailers to commits in this repo.",
      "pinned": true
    }
  }
}
```

**Example — forget:**

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "tools/call",
  "params": {
    "name": "memory",
    "arguments": { "action": "forget", "name": "no-coauthor-tag" }
  }
}
```

---

## 5. `refresh_context`

**Purpose:** The single public repair/reindex verb. Re-indexes code, regenerates deterministic wiki/business pages when the wiki layer is enabled, and (optionally) returns updated stats. Staleness banners and hook text point agents here, so it stays public and works even on an empty index.

**Input properties:**

| Property | Type | Description |
| --- | --- | --- |
| `paths` | string[] | Specific file paths to refresh (omit for a full project refresh). |
| `includeStats` | boolean | Include updated index statistics in the response (default true). |

**Example:**

```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "method": "tools/call",
  "params": {
    "name": "refresh_context",
    "arguments": { "includeStats": true }
  }
}
```

To refresh only specific files after a targeted change:

```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "method": "tools/call",
  "params": {
    "name": "refresh_context",
    "arguments": { "paths": ["src/billing/checkout.ts"], "includeStats": false }
  }
}
```

---

## 6. `get_stats`

**Purpose:** Health, stats, and freshness. Returns index statistics, detected conventions, latency percentiles, `lastIndexedAt`, and storage details (metadata DB bytes, free bytes, target count, target-alias count). Takes no arguments and is exempt from empty-index short-circuiting.

**Input properties:** none.

**Example:**

```json
{
  "jsonrpc": "2.0",
  "id": 13,
  "method": "tools/call",
  "params": {
    "name": "get_stats",
    "arguments": {}
  }
}
```

Use `get_stats` to inspect index freshness (indexed commit vs. HEAD), storage footprint, and chunk/file counts when retrieval looks stale or incomplete.

---

## What replaced the old tools

The six tools above absorbed the previous standalone tools. **Do not expect the removed names on the MCP surface** — use CLI Lens/explain JSON exports for business and wiki data.

| Removed standalone tool | Now use |
| --- | --- |
| `read_code_chunk` | `search_code action=read_chunk` |
| `find_callers` | `explain_flow action=callers` |
| `find_callees` | `explain_flow action=callees` |
| `build_stack_tree` | `explain_flow action=stack_tree` |
| `get_imports` | `explain_flow action=imports` |
| `get_symbol` | `explain_flow action=symbol` |
| `resolve_seed` | `explain_flow action=resolve_seed` |
| `recall_memories` | `memory action=recall` |
| `explain_memory` | `memory action=explain` |
| `list_memories` | `memory action=list` |
| `store_memory` | `memory action=store` |
| `forget_memory` | `memory action=forget` |
| `index_codebase` | `refresh_context` (MCP) or `reporecall index` (CLI) |
| `get_lens_data` | `reporecall lens --json` (CLI) |
| `list_product_areas`, `business_context_query` | `reporecall lens --json` / `reporecall explain --json` |
| `get_communities`, `get_hub_nodes`, `get_surprises`, `suggest_investigations` | `get_stats` / Lens / CLI |
| `wiki_query`, `wiki_read`, `wiki_write`, `wiki_check_staleness` | Lens/CLI docs surfaces |
| `clear_index`, `compact_memories`, `clear_working_memory` | CLI/internal-only (destructive; removed from MCP) |
