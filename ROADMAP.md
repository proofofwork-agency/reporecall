# Roadmap

## Search-seeded R1 fallback

When a query contains no explicit identifier (e.g., "how does authentication work"), use the top search result as a synthetic seed for `buildStackTree`. Currently the R1 flow route is unreachable for natural-language queries because seed resolution scores below the 0.55 confidence threshold, degrading to R2 (no call tree). Using the top hybrid search hit as a fallback seed would enable call-tree context for descriptive queries.

## Score floor tuning for mixed-signal queries

Queries that match both implementation code and type definitions can surface interfaces or configs above the actual handler functions. Investigate whether score adjustments (kind-aware boosting, implementation-path priority) can consistently rank handler/implementation chunks above type-only matches without penalizing legitimate type lookups.

## Domain-aware disambiguation

Queries spanning multiple subsystems (e.g., "orchestrator workers") can match unrelated symbols in a different domain. When the codebase has distinct subsystems with overlapping terminology, retrieval may surface results from the wrong domain. Potential approaches: term co-occurrence weighting, import-graph clustering, or subsystem-aware re-ranking.

## Semantic mode benchmark parity

Current benchmark numbers are keyword-only. Add a semantic mode benchmark pass to measure the delta from vector embeddings on architecture and conceptual queries (the two weakest categories at NDCG@10 0.308 and 0.350 respectively). Establish whether semantic mode justifies the embedding cost for typical codebases.

## Memory compaction quality metrics

Add benchmark coverage for memory compaction: measure deduplication accuracy, fact promotion precision, and whether compacted memory sets maintain recall compared to uncompacted sets. Currently compaction behavior is tested deterministically but not benchmarked for retrieval quality impact.
