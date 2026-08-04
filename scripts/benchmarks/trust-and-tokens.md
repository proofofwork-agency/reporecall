# Trust Contract + Token Evidence

This directory will contain reproducible measurements for:

- Token reduction vs baseline (full files or naive grep context)
- Retrieval quality on trace / architecture / change questions
- Staleness detection accuracy (how often `get_stats` correctly flags drift)
- Hook injection effectiveness

## Current claim status

There is not yet enough paired external evidence for a token-savings claim.
Fresh/stale/empty classification and auto-refresh behavior are release-gate
targets, not published results. Missing measurements remain
`insufficient_evidence`.

## How to Run

```bash
npm run benchmark:tokens -- --project /path/to/target --output /tmp/reporecall-evidence.json
```

Contributions of real measurements + methodology on public or anonymized repos are extremely welcome. This is one of the highest-leverage things for adoption.
