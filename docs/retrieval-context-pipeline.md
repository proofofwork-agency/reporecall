# Retrieval And Context Pipeline

Reporecall builds context in this order:

1. Sanitize and classify the prompt as `lookup`, `trace`, `bug`, `architecture`, `change`, or `skip`.
2. Resolve explicit seeds when the prompt names a file, route, symbol, or subsystem.
3. Retrieve candidates through keyword/vector indexes and graph expansion.
4. Apply route-specific selection for bug localization, trace flow, or broad architecture inventory.
5. Assemble context under the configured token budget.
6. Add wiki, memory, and product-area evidence when relevant and within budget.
7. Return text plus diagnostics through hooks, CLI, or MCP.

Context quality is more important than raw chunk volume. For trace and architecture prompts, Reporecall should cover the implementation path across entry points, services, storage, handlers, and shared helpers when those layers exist.

## Evidence Compression

When context compression is enabled, Reporecall keeps primary evidence intact and compacts secondary evidence into language-aware bullets with retrievable original chunk references. Compressed entries preserve imports, signatures, decorators, route/config/error literals, query matches, line numbers, and a `chunkId`.

The behavior is controlled in `.memory/config.json`:

- `contextCompressionEnabled`: set `false` to disable evidence compression.
- `contextCompressionMode`: `auto`, `always`, or `off`.
- `contextCompressionPreserveTopChunks`: number of top chunks kept as full source.
- `contextCompressionMinChunkTokens`: minimum chunk size before compression is attempted.
- `contextCompressionTargetRatio`: maximum compressed/full token ratio accepted.

Compressed context is reversible through MCP `search_code action=read_chunk`. Use the `chunkId` from compressed evidence, or provide `filePath` with `startLine`/`endLine`, to retrieve the full original chunk.

MCP clients should prefer `search_context` for multi-file questions because it returns the same assembled, compression-aware context used by hooks and CLI explain. Use `search_code` when you explicitly need raw matching chunks instead of a token-budgeted context bundle.
