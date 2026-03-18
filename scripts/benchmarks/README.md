# Benchmark Scripts

Real Claude API cost comparison benchmarks. These scripts measure actual token usage and costs by making live API calls.

## Requirements

- `claude` CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- Active Claude API credits (each run costs $0.30-$2+ depending on project size)
- `python3` (for JSON parsing and cost calculations)
- `reporecall` built and available (`npm run build` in project root)

## Scripts

### `cost-comparison.sh`
Compare No Memory vs Reporecall on any indexed project.

```bash
# Run on a project (must already be indexed with `reporecall index`)
bash scripts/benchmarks/cost-comparison.sh /path/to/project "query 1" "query 2" ...

# Run with default queries on a project
bash scripts/benchmarks/cost-comparison.sh /path/to/project
```

### `version-comparison.sh`
Compare No Memory vs v0.1.0 vs v0.2.0 on the small test project at `/tmp/reporecall-test`.

```bash
# Requires the test project to exist (7 TypeScript files)
bash scripts/benchmarks/version-comparison.sh
```

### `auto-budget-test.sh`
Test the dynamic auto-budget on one or two projects.

```bash
# Single project
bash scripts/benchmarks/auto-budget-test.sh /path/to/project

# Two projects (compare budget scaling)
bash scripts/benchmarks/auto-budget-test.sh /path/to/small /path/to/large
```

## Cost Warning

These scripts make real Claude API calls. Typical costs:
- 7 queries, small project: ~$0.06-0.40
- 10 queries, large project: ~$0.40-2.20
- Full version comparison (21 queries): ~$0.50-1.50

Results are written to `/tmp/` as markdown files.
