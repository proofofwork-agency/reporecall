# Trust Contract + Token Savings Benchmark (Placeholder)

This directory will contain reproducible measurements for:

- Token reduction vs baseline (full files or naive grep context)
- Retrieval quality on trace / architecture / change questions
- Staleness detection accuracy (how often `get_stats` correctly flags drift)
- Hook injection effectiveness

## Current Claims (to be measured)

- 40-70% context token savings on complex questions while preserving or improving answer quality
- 100% of hook/MCP responses carry freshness metadata
- Auto-refresh catches the majority of drift cases within the debounce window

## How to Run

```bash
# Example (to be implemented)
node scripts/benchmarks/token-savings.js --repo /path/to/target --queries queries.json
```

Contributions of real measurements + methodology on public or anonymized repos are extremely welcome. This is one of the highest-leverage things for adoption.