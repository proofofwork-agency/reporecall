# Architecture Overview

Reporecall indexes a project locally and exposes source-grounded context through CLI commands, Claude Code hooks, and MCP tools.

The main layers are:

| Layer | Role |
| --- | --- |
| Indexer | Scans files, chunks source with Tree-sitter, records imports and call edges. |
| Storage | Persists chunks, full-text search, metadata, graph edges, wiki, memory, and lens data in local stores. |
| Search | Routes user prompts by intent, retrieves candidate chunks, expands graph evidence, and assembles prompt context. |
| Hooks | Injects selected context into agent prompts and records hook diagnostics. |
| MCP/CLI | Exposes search, flow explanation, wiki, memory, business context, lens export, and indexing operations. |
| Lens/Wiki | Generates deterministic project views over code topology and business-facing capability evidence. |

Reporecall should stay a repo-intelligence engine. It should not absorb provider proxying, model hosting, or editor UI responsibilities.
