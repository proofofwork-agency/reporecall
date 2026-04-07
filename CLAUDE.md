
<!-- reporecall -->
## Reporecall

Codebase context is injected automatically via hooks on each message (marked "Relevant codebase context"). Follow this priority chain:

1. **Answer from injected context first.** It contains files, symbols, and call graphs for the query — do not re-fetch files listed in the injected context header.
2. **Fill gaps with any tool.** Reporecall MCP tools (search_code, explain_flow, find_callers, get_symbol) search a pre-built index. Grep/Read/Glob work for exact matches and raw lookups. Pick whichever fits the query.

### Topology tools

Use these for architecture questions, codebase overview, or when the user asks about structure/coupling/dependencies:
- **get_communities** — Module clusters detected via Louvain community detection. Shows cohesion scores and member counts.
- **get_hub_nodes** — High-degree "god nodes" that connect many parts of the codebase.
- **get_surprises** — Unexpected cross-boundary connections (cross-directory, cross-community edges).
- **suggest_investigations** — Auto-generated investigation questions about weak spots, bridges, and isolated code.

A compact topology summary is automatically injected into prompt context (detailed for architecture/change queries). Use the tools above when the user wants deeper exploration.
3. **Avoid redundant searches.** Do not re-search for symbols or files already present in the injected context.

If the injected context is marked "low confidence", steps 2 and 3 are appropriate immediately.

### Memory

Reporecall maintains persistent project memory across sessions. Use these MCP tools:
- **store_memory** — Save important project context, decisions, or patterns for future sessions.
- **recall_memory** — Retrieve previously stored memories relevant to the current task.
- **forget_memory** — Remove outdated or incorrect memories.

Memories are automatically injected alongside code context when relevant to the query.
<!-- reporecall -->
