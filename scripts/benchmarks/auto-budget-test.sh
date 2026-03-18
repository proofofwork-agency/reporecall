#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Reporecall Auto Budget Test
# Tests dynamic budget scaling across projects of different sizes
#
# Usage:
#   bash scripts/benchmarks/auto-budget-test.sh <project1> [project2]
#
# Requirements: claude CLI, python3, reporecall built + indexed
# Cost: ~$0.20-1.00 per project
# ─────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT1="${1:?Usage: $0 <project1> [project2]}"
PROJECT1=$(cd "$PROJECT1" && pwd)
PROJECT2="${2:-}"
[ -n "$PROJECT2" ] && PROJECT2=$(cd "$PROJECT2" && pwd)

RESULTS="/tmp/reporecall-auto-budget-test.md"
MAX_BUDGET="0.50"
MODEL="${REPORECALL_BENCH_MODEL:-sonnet}"

# Default queries (generic enough for any project)
DEFAULT_QUERIES=(
  "how does authentication work in this project"
  "what is the main entry point"
  "show me the database layer"
  "how does error handling work"
  "what are the main exports"
  "how does the config system work"
  "who calls the main function"
)

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

run_queries() {
  local project="$1"
  local label="$2"
  shift 2
  local queries=("$@")
  local count=${#queries[@]}

  local total_input=0 total_output=0 total_cr=0 total_cw=0 total_cost=0

  echo "" >> "$RESULTS"
  echo "### $label ($project)" >> "$RESULTS"
  echo "" >> "$RESULTS"
  echo "| # | Query | Input | Output | Cache Read | Cache Write | Cost |" >> "$RESULTS"
  echo "|---|-------|-------|--------|------------|-------------|------|" >> "$RESULTS"

  for i in "${!queries[@]}"; do
    query="${queries[$i]}"
    echo "$label [$((i+1))/$count]: $query" >&2

    # --budget without value → auto budget
    context=$(cd "$project" && npx reporecall search "$query" --budget 2>/dev/null)

    full_prompt="Relevant codebase context (from Reporecall):

$context

Answer this question about the codebase above: $query"

    raw=$(echo "$full_prompt" | claude -p --output-format json --max-budget-usd "$MAX_BUDGET" --model "$MODEL" 2>/dev/null)
    parsed=$(echo "$raw" | parse_json)
    IFS='|' read -r inp out cr cw cost model_used <<< "$parsed"

    echo "| $((i+1)) | ${query:0:50} | $inp | $out | $cr | $cw | \$$cost |" >> "$RESULTS"

    total_input=$((total_input + inp))
    total_output=$((total_output + out))
    total_cr=$((total_cr + cr))
    total_cw=$((total_cw + cw))
    total_cost=$(python3 -c "print(round($total_cost + $cost, 6))")
  done

  echo "" >> "$RESULTS"
  echo "**Totals:** Input=$total_input | Output=$total_output | Cache Read=$total_cr | Cache Write=$total_cw | **Cost=\$$total_cost**" >> "$RESULTS"
  echo "" >> "$RESULTS"

  # Save for comparison
  echo "$total_cost|$count" > "/tmp/auto_${label}.dat"
}

# ── preflight ────────────────────────────────────────────────

command -v claude >/dev/null 2>&1 || { echo "ERROR: claude CLI not found"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 required"; exit 1; }
[ -d "$PROJECT1/.memory" ] || { echo "ERROR: $PROJECT1 not indexed. Run: cd $PROJECT1 && npx reporecall index"; exit 1; }
if [ -n "$PROJECT2" ]; then
  [ -d "$PROJECT2/.memory" ] || { echo "ERROR: $PROJECT2 not indexed. Run: cd $PROJECT2 && npx reporecall index"; exit 1; }
fi

# ── header ───────────────────────────────────────────────────

cat > "$RESULTS" << EOF
# Auto Budget Test

**Method:** Real Claude API calls with auto-budget (\`--budget\` without value)
**Model:** $MODEL
**Formula:** \`clamp(1500 + chunks × 2.5, 2000, 6000)\`

---

## Project Stats
EOF

echo "" >> "$RESULTS"

# Show stats for each project
echo "=== Auto Budget Check ===" >&2
echo "Project 1 stats:" >&2
cd "$PROJECT1" && npx reporecall stats 2>&1 | tee -a "$RESULTS" >&2
echo "" >> "$RESULTS"

if [ -n "$PROJECT2" ]; then
  echo "Project 2 stats:" >&2
  cd "$PROJECT2" && npx reporecall stats 2>&1 | tee -a "$RESULTS" >&2
  echo "" >> "$RESULTS"
fi

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## Results" >> "$RESULTS"

# ── run queries ──────────────────────────────────────────────

p1_name=$(basename "$PROJECT1")
run_queries "$PROJECT1" "${p1_name}_auto" "${DEFAULT_QUERIES[@]}"

if [ -n "$PROJECT2" ]; then
  p2_name=$(basename "$PROJECT2")
  run_queries "$PROJECT2" "${p2_name}_auto" "${DEFAULT_QUERIES[@]}"
fi

# ── comparison ───────────────────────────────────────────────

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## Comparison" >> "$RESULTS"
echo "" >> "$RESULTS"

IFS='|' read -r p1_cost p1_count < "/tmp/auto_${p1_name}_auto.dat"

if [ -n "$PROJECT2" ]; then
  IFS='|' read -r p2_cost p2_count < "/tmp/auto_${p2_name}_auto.dat"

  python3 -c "
p1_cost = $p1_cost; p1_count = $p1_count
p2_cost = $p2_cost; p2_count = $p2_count

print('| Metric | $p1_name | $p2_name |')
print('|--------|---------|---------|')
print(f'| Total cost | \${p1_cost:.4f} | \${p2_cost:.4f} |')
print(f'| Per-query cost | \${p1_cost/p1_count:.4f} | \${p2_cost/p2_count:.4f} |')
print(f'| Queries | {p1_count} | {p2_count} |')
print()
print('**Auto budget formula: clamp(1500 + chunks × 2.5, 2000, 6000)**')
" >> "$RESULTS"
else
  python3 -c "
p1_cost = $p1_cost; p1_count = $p1_count
print('| Metric | $p1_name |')
print('|--------|---------|')
print(f'| Total cost | \${p1_cost:.4f} |')
print(f'| Per-query cost | \${p1_cost/p1_count:.4f} |')
print(f'| Queries | {p1_count} |')
print()
print('**Auto budget formula: clamp(1500 + chunks × 2.5, 2000, 6000)**')
" >> "$RESULTS"
fi

echo "" >> "$RESULTS"

# ── cleanup ──────────────────────────────────────────────────

rm -f /tmp/auto_*.dat

echo ""
echo "=== DONE ==="
echo "Results: $RESULTS"
echo ""
cat "$RESULTS"
