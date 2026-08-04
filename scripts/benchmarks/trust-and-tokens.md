# Trust Contract + Token Evidence

This directory will contain reproducible measurements for:

- Token reduction vs baseline (full files or naive grep context)
- Retrieval quality on trace / architecture / change questions
- Staleness detection accuracy (how often `get_stats` correctly flags drift)
- Hook injection effectiveness

## Current claim status

**Published:** context-assembly cost. `npm run benchmark:context-cost` measures the
tokens needed to put the answering evidence in front of the model, against a
baseline of reading the known-relevant files whole. It makes no model calls, so it
is deterministic and reproducible. The published figure is registered in
`quality/claims.json` as `context_cost_median_reduction` with its artifact,
fixture hash and cohort size; see the README for the number and its scope.

A query is counted only when Reporecall delivered every `mustInclude` file, so
omitting evidence cannot register as a saving. The baseline counts only
known-relevant files — never the wrong files a real search would also open — which
makes the result a floor rather than a best case.

**Not yet published:** end-to-end agent token usage. That requires paired
native-tools and Reporecall runs on the same model and settings in fresh sessions
with blind grading, per `quality/pilot/README.md`. Context-assembly cost excludes
reasoning tokens, tool-call overhead and multi-turn exploration, and is never
presented as an end-to-end result. Fresh/stale/empty classification and
auto-refresh behavior are release-gate targets, not published results. Missing
measurements remain `insufficient_evidence`.

## How to Run

```bash
npm run benchmark:tokens -- --project /path/to/target --output /tmp/reporecall-evidence.json
```

Contributions of real measurements + methodology on public or anonymized repos are extremely welcome. This is one of the highest-leverage things for adoption.
