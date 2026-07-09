---
id: cli-reference
title: CLI Reference
sidebar_position: 3
---

# CLI Reference

Every command accepts `--project <path>` to target a project root other than the current working directory (the default is auto-detected from the CWD). Options below are shown with their defaults where they have one.

Canonical command name: **`reporecall`** (the `memory` bin is an alias).

---

## Setup & lifecycle

### `init`

Initialize Reporecall for the current project. Creates `.memory/`, `.memoryignore`, Claude Code hooks, `.mcp.json`, and a `CLAUDE.md` section. Does **not** index code.

| Option | Default | Description |
| --- | --- | --- |
| `--embedding-provider <provider>` | `local` | One of `local`, `ollama`, `openai`, `keyword`. |
| `--port <n>` | — | Daemon port (1–65535); merged into `config.json`. |
| `--autostart` | — | Register auto-start on login (macOS launchd / Windows Task Scheduler). |
| `--project <path>` | CWD | Project root. |

```bash
reporecall init --embedding-provider local
```

```text
Initializing Reporecall for: /path/to/project
  Created /path/to/project/.memory/config.json
  Created /path/to/project/.memoryignore
  Created Claude Code hooks in /path/to/project/.claude/settings.json
  Created MCP configuration in /path/to/project/.mcp.json
  Added Reporecall instructions to CLAUDE.md

Done! Next steps:
  1. Start daemon: reporecall serve
  2. Optional one-off foreground index: reporecall index
```

### `index`

Index the current project's codebase. Generates deterministic wiki/business pages at the end of the pass (when the memory layer is enabled).

| Option | Default | Description |
| --- | --- | --- |
| `--no-wiki` | — | Skip deterministic wiki/business page generation. |
| `--project <path>` | CWD | Project root. |

```bash
reporecall index
```

```text
Indexing project: /path/to/project
Chunking: [████████████████████] 100% (312/312 files)
Done: 312 files, 4821 chunks
Wiki: generated 22 pages (14 communities, 6 hubs, 2 business)
```

### `serve`

Start the Reporecall daemon (incremental indexer + file watcher + HTTP server). Runs an initial index, generates wiki pages, and keeps the index fresh. Exposes `/health` and `/ready` on `127.0.0.1`.

| Option | Default | Description |
| --- | --- | --- |
| `--port <n>` | `37222` | HTTP port. |
| `--mcp` | — | Also start the MCP server on stdio (shares the daemon's stores). |
| `--max-chunks <n>` | `0` (dynamic) | Max context chunks per query. |
| `--debug` | — | Enable debug logging for hook/retrieval diagnostics. |
| `--no-memory` | — | Disable the memory layer. |
| `--project <path>` | CWD | Project root. |

```bash
reporecall serve
```

```text
Reporecall daemon starting for: /path/to/project
Loaded existing index: 312 files, 4821 chunks
Running incremental index update...
Index up to date: no changes detected
File watcher active
HTTP server listening on http://127.0.0.1:37222

Ready. Reporecall hooks will auto-inject context.
```

---

## Retrieval

### `search`

Search the codebase index. Use `--budget` for token-limited context assembly instead of a raw result list.

| Option | Default | Description |
| --- | --- | --- |
| `--limit <n>` | `10` | Max results (raw mode). |
| `--budget [tokens]` | — | Token budget for assembled context. Omit the value for auto. |
| `--max-chunks <n>` | — | Max context chunks per query (with `--budget`). |
| `--no-memory` | — | Disable the memory layer. |
| `--project <path>` | CWD | Project root. |

```bash
reporecall search "checkout session"
```

```text
[0.842] function createCheckoutSession
       src/billing/checkout.ts:41-88
       export async function createCheckoutSession(input: CheckoutInput) {
         const customer = await resolveCustomer(input.userId)
         ...
```

Token-budgeted context assembly (auto budget):

```bash
reporecall search "checkout session" --budget
```

### `explain`

Dry-run the retrieval pipeline for a query, showing the chosen query mode, resolved seed, and the context that would be injected. Add `--json` for full diagnostics.

| Option | Default | Description |
| --- | --- | --- |
| `--json` | — | Output as JSON (includes `productAreasUsed[]`, `businessPagesUsed[]`, `selectedFiles`, `missingEvidence`, etc.). |
| `--project <path>` | CWD | Project root. |

```bash
reporecall explain "which files implement authentication?"
```

```text
Query mode:     architecture
Intent:         code=true, navigation=false
Sanitized:      which files implement authentication
Seed:           (none)
Memory route:   M0
Tokens:         3,204
Chunks:         9
Context:        sufficient

Chunks:
  1. useAuth (function, src/hooks/useAuth.tsx:12-64) score=0.71
  2. authMiddleware (function, src/server/auth.ts:20-55) score=0.66
  ...
```

```bash
reporecall explain --json "which files implement billing?"
```

---

## Inspection

### `stats`

Show index statistics, session metrics, memory usage, search latency, query-mode breakdown, and daemon status.

| Option | Default | Description |
| --- | --- | --- |
| `--project <path>` | CWD | Project root. |

```bash
reporecall stats
```

```text
Reporecall

Index:
  Chunks:       4821 across 312 files
  Languages:    typescript (78%), json (11%), markdown (8%), sql (3%)
  Storage:      42.7 MB
  Metadata DB:  8.1 MB (1.2 MB free)
  Targets:      3,904 targets, 5,210 aliases
  Last indexed: 4 minutes ago

Session Stats:
  Hooks fired:         128
  Chunks served:       1,024
  Tokens injected:     402,880

Daemon: running (PID 48213)
```

### `graph`

Show the call graph for a function or method. With no direction flag, both directions are shown.

| Option | Default | Description |
| --- | --- | --- |
| `--callers` | — | Show who calls this function. |
| `--callees` | — | Show what this function calls. |
| `--both` | default | Show both callers and callees. |
| `--limit <n>` | `20` | Max results per direction. |
| `--project <path>` | CWD | Project root. |

```bash
reporecall graph createCheckoutSession --both
```

```text
Callers of "createCheckoutSession" (2):
  handleCheckout @ src/server/routes/checkout.ts:33
  retryCheckout @ src/billing/retry.ts:19

Callees of "createCheckoutSession" (4):
  resolveCustomer [call] @ src/billing/checkout.ts:42
  createStripeSession [call] @ src/billing/checkout.ts:58
  ...
```

### `conventions`

Show detected coding conventions (naming styles, metrics, language distribution, most-called functions).

| Option | Default | Description |
| --- | --- | --- |
| `--json` | — | Output as JSON. |
| `--refresh` | — | Re-analyze conventions from the current index. |
| `--project <path>` | CWD | Project root. |

```bash
reporecall conventions
```

```text
Coding Conventions

Naming Style:
  Functions: camelCase
  Classes:   PascalCase

Code Metrics:
  Total functions:    1204
  Total classes:      142
  Docstring coverage: 37%
  Avg function length:    18 lines
  Median function length: 11 lines
```

### `doctor`

Diagnose common issues: SQLite runtime health, data directory, metadata/FTS/vector stores, memory store, embedding-provider health, stale WAL files, daemon status, and search-weight balance.

| Option | Default | Description |
| --- | --- | --- |
| `--project <path>` | CWD | Project root. |

```bash
reporecall doctor
```

```text
Reporecall Doctor

✓ better-sqlite3 runtime is healthy
✓ Data directory exists
✓ Metadata database exists (8288.0 KB)
✓ FTS database exists
✓ Vector store exists
✓ Using local embedding model (no external service needed)
✓ Search weights are balanced

All checks passed! Everything looks healthy.
```

---

## Visualization

### `lens`

Generate the interactive architecture dashboard (single HTML file), serve it over HTTP, or emit structured JSON. See [Lens](./lens.md) for the JSON shape.

| Option | Default | Description |
| --- | --- | --- |
| `--output <path>` | — | Output HTML file path. |
| `--open` | — | Open in the default browser after generation. |
| `--serve` | — | Serve the dashboard over HTTP on localhost. |
| `--port <n>` | `7878` | Port to serve on (with `--serve`). |
| `--json` | — | Output raw JSON data instead of HTML. |
| `--max-hubs <n>` | `15` | Maximum hub nodes to include. |
| `--max-surprises <n>` | `20` | Maximum surprises to include. |
| `--max-communities <n>` | `20` | Maximum communities to include. |
| `--project <path>` | CWD | Project root. |

```bash
reporecall lens --serve --open
```

```text
Dashboard generated: /path/to/project/.memory/lens.html
  412 symbols, 14 communities, 15 hubs, 20 surprises, 22 wiki pages
Serving dashboard at http://localhost:7878/
Press Ctrl+C to stop.
```

Structured export:

```bash
reporecall lens --json > lens.json
```

---

## Integration

### `mcp`

Start the MCP server over stdio transport. Console output is redirected to stderr so it never corrupts the JSON-RPC stream on stdout. See [MCP Tools](./mcp-tools.md).

| Option | Default | Description |
| --- | --- | --- |
| `--no-memory` | — | Disable the memory layer. |
| `--project <path>` | CWD | Project root. |

```bash
reporecall mcp --project .
```

If a daemon is already running for the project, `mcp` warns about SQLite lock contention and suggests `serve --mcp` instead.
