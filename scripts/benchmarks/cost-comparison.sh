#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Reporecall Cost Comparison: No Memory vs Reporecall v0.2.0
# Real Claude API calls via `claude -p --output-format json`
#
# Usage:
#   bash scripts/benchmarks/cost-comparison.sh <project-path> [query1] [query2] ...
#
# Requirements: claude CLI, python3, reporecall built + indexed
# Cost: ~$0.30-2.00 per run depending on project size
# ─────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT="${1:?Usage: $0 <project-path> [query1] [query2] ...}"
PROJECT=$(cd "$PROJECT" && pwd)  # resolve to absolute path
shift

RESULTS="/tmp/reporecall-cost-comparison.md"
MAX_BUDGET="0.50"
MODEL="${REPORECALL_BENCH_MODEL:-sonnet}"

# Default queries if none provided
if [ $# -eq 0 ]; then
  QUERIES=(
    "how does authentication work in this project"
    "what is the main entry point"
    "show me the database layer"
    "how does error handling work"
    "what are the main exports"
    "how does the config system work"
    "who calls the main function"
  )
else
  QUERIES=("$@")
fi

QUERY_COUNT=${#QUERIES[@]}

# ── helpers ──────────────────────────────────────────────────

parse_json() {
  python3 -c "
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    print('0|0|0|0|0|unknown')
    sys.exit(0)
try:
    d = json.loads(raw)
    mu = d.get('modelUsage', {})
    model = list(mu.keys())[0] if mu else 'unknown'
    m = mu.get(model, {})
    inp = m.get('inputTokens', 0)
    out = m.get('outputTokens', 0)
    cr = m.get('cacheReadInputTokens', 0)
    cw = m.get('cacheCreationInputTokens', 0)
    cost = d.get('total_cost_usd', 0)
    print(f'{inp}|{out}|{cr}|{cw}|{cost}|{model}')
except:
    print('0|0|0|0|0|error')
"
}

# ── preflight ────────────────────────────────────────────────

command -v claude >/dev/null 2>&1 || { echo "ERROR: claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 required"; exit 1; }
[ -d "$PROJECT/.memory" ] || { echo "ERROR: $PROJECT is not indexed. Run: cd $PROJECT && npx reporecall index"; exit 1; }

echo "Project: $PROJECT"
echo "Queries: $QUERY_COUNT"
echo "Model:   $MODEL"
echo "Cost:    ~\$0.30-2.00 (real API calls)"
echo ""

# ── header ───────────────────────────────────────────────────

cat > "$RESULTS" << EOF
# Cost Comparison: No Memory vs Reporecall

**Method:** Real Claude API calls via \`claude -p --output-format json\`
**Model:** $MODEL
**Project:** $PROJECT
**Queries:** $QUERY_COUNT

---

EOF

# ── 1. NO MEMORY ─────────────────────────────────────────────

echo "## 1. No Memory (Claude navigates with tools)" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "| # | Query | Input | Output | Cache Read | Cache Write | Cost |" >> "$RESULTS"
echo "|---|-------|-------|--------|------------|-------------|------|" >> "$RESULTS"

cd "$PROJECT"
mv .claude .claude.bak 2>/dev/null || true
mv .mcp.json .mcp.json.bak 2>/dev/null || true
mv .memory .memory.bak 2>/dev/null || true
mv CLAUDE.md CLAUDE.md.bak 2>/dev/null || true

total_input_no=0; total_output_no=0; total_cr_no=0; total_cw_no=0; total_cost_no=0

for i in "${!QUERIES[@]}"; do
  query="${QUERIES[$i]}"
  echo "NO MEMORY [$((i+1))/$QUERY_COUNT]: $query" >&2

  raw=$(echo "$query" | claude -p --output-format json --max-budget-usd "$MAX_BUDGET" --model "$MODEL" 2>/dev/null)
  parsed=$(echo "$raw" | parse_json)
  IFS='|' read -r inp out cr cw cost model_used <<< "$parsed"

  echo "| $((i+1)) | ${query:0:50} | $inp | $out | $cr | $cw | \$$cost |" >> "$RESULTS"

  total_input_no=$((total_input_no + inp))
  total_output_no=$((total_output_no + out))
  total_cr_no=$((total_cr_no + cr))
  total_cw_no=$((total_cw_no + cw))
  total_cost_no=$(python3 -c "print(round($total_cost_no + $cost, 6))")
done

echo "" >> "$RESULTS"
echo "**Totals:** Input=$total_input_no | Output=$total_output_no | Cache Read=$total_cr_no | Cache Write=$total_cw_no | **Cost=\$$total_cost_no**" >> "$RESULTS"
echo "" >> "$RESULTS"

# Restore reporecall
mv .claude.bak .claude 2>/dev/null || true
mv .mcp.json.bak .mcp.json 2>/dev/null || true
mv .memory.bak .memory 2>/dev/null || true
mv CLAUDE.md.bak CLAUDE.md 2>/dev/null || true

# ── 2. WITH REPORECALL ──────────────────────────────────────

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## 2. Reporecall (pre-injected context, auto budget)" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "| # | Query | Input | Output | Cache Read | Cache Write | Cost |" >> "$RESULTS"
echo "|---|-------|-------|--------|------------|-------------|------|" >> "$RESULTS"

total_input_with=0; total_output_with=0; total_cr_with=0; total_cw_with=0; total_cost_with=0

for i in "${!QUERIES[@]}"; do
  query="${QUERIES[$i]}"
  echo "REPORECALL [$((i+1))/$QUERY_COUNT]: $query" >&2

  context=$(cd "$PROJECT" && npx reporecall search "$query" --budget 2>/dev/null)

  full_prompt="Relevant codebase context (from Reporecall):

$context

Answer this question about the codebase above: $query"

  raw=$(echo "$full_prompt" | claude -p --output-format json --max-budget-usd "$MAX_BUDGET" --model "$MODEL" 2>/dev/null)
  parsed=$(echo "$raw" | parse_json)
  IFS='|' read -r inp out cr cw cost model_used <<< "$parsed"

  echo "| $((i+1)) | ${query:0:50} | $inp | $out | $cr | $cw | \$$cost |" >> "$RESULTS"

  total_input_with=$((total_input_with + inp))
  total_output_with=$((total_output_with + out))
  total_cr_with=$((total_cr_with + cr))
  total_cw_with=$((total_cw_with + cw))
  total_cost_with=$(python3 -c "print(round($total_cost_with + $cost, 6))")
done

echo "" >> "$RESULTS"
echo "**Totals:** Input=$total_input_with | Output=$total_output_with | Cache Read=$total_cr_with | Cache Write=$total_cw_with | **Cost=\$$total_cost_with**" >> "$RESULTS"
echo "" >> "$RESULTS"

# ── 3. COMPARISON ────────────────────────────────────────────

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## 3. Comparison" >> "$RESULTS"
echo "" >> "$RESULTS"

python3 -c "
no_cost = $total_cost_no
with_cost = $total_cost_with
no_input = $total_input_no; with_input = $total_input_with
no_output = $total_output_no; with_output = $total_output_with
no_cr = $total_cr_no; with_cr = $total_cr_with
no_cw = $total_cw_no; with_cw = $total_cw_with
q = $QUERY_COUNT

no_total = no_input + no_cr + no_cw
with_total = with_input + with_cr + with_cw

print('| Metric | No Memory | Reporecall | Delta |')
print('|--------|-----------|------------|-------|')
print(f'| Input tokens | {no_input:,} | {with_input:,} | {no_input - with_input:+,} |')
print(f'| Output tokens | {no_output:,} | {with_output:,} | {no_output - with_output:+,} |')
print(f'| Cache read | {no_cr:,} | {with_cr:,} | {no_cr - with_cr:+,} |')
print(f'| Cache write | {no_cw:,} | {with_cw:,} | {no_cw - with_cw:+,} |')
print(f'| Total tokens | {no_total:,} | {with_total:,} | {no_total - with_total:+,} |')
print(f'| **Total cost** | **\${no_cost:.4f}** | **\${with_cost:.4f}** | **\${no_cost - with_cost:+.4f}** |')
print(f'| Per-query cost | \${no_cost/q:.4f} | \${with_cost/q:.4f} | — |')
if no_cost > 0:
    pct = (1 - with_cost/no_cost) * 100
    print(f'| **Cost savings** | — | — | **{pct:.1f}%** |')
print()
print(f'**Per 1,000 sessions ({q*1000:,} queries):**')
print(f'- No Memory: \${no_cost*1000:.2f}')
print(f'- Reporecall: \${with_cost*1000:.2f}')
print(f'- Savings: \${(no_cost-with_cost)*1000:.2f}')
" >> "$RESULTS"

echo "" >> "$RESULTS"

echo ""
echo "=== DONE ==="
echo "Results: $RESULTS"
echo ""
cat "$RESULTS"
