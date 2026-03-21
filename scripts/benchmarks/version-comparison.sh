#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Reporecall Version Comparison: No Memory vs Previous npm vs dist
# Real Claude API calls via `claude -p --output-format json`
#
# Usage:
#   bash scripts/benchmarks/version-comparison.sh
#
# Requirements:
#   - claude CLI, python3, reporecall built + indexed
#   - Test project at /tmp/reporecall-test (7 TypeScript files)
#
# Cost: ~$0.50-1.50 per run (21 API calls)
# ─────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT="/tmp/reporecall-test"
RESULTS="/tmp/reporecall-version-comparison.md"
MAX_BUDGET="0.50"
MODEL="${REPORECALL_BENCH_MODEL:-sonnet}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PKG_NAME="@proofofwork-agency/reporecall"

QUERIES=(
  "how does authentication work in this project"
  "who calls the login function"
  "how does password hashing work"
  "what does the rate limiter do"
  "how does the register function work"
  "show me the database layer"
  "what is the JWT token format"
)

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

run_section() {
  local label="$1"
  local dat_label="$2"
  shift 2

  local total_input=0 total_output=0 total_cr=0 total_cw=0 total_cost=0

  echo "| # | Query | Input | Output | Cache Read | Cache Write | Cost |" >> "$RESULTS"
  echo "|---|-------|-------|--------|------------|-------------|------|" >> "$RESULTS"

  for i in "${!QUERIES[@]}"; do
    query="${QUERIES[$i]}"
    echo "$label [$((i+1))/$QUERY_COUNT]: $query" >&2

    if [ "$1" = "tools" ]; then
      raw=$(echo "$query" | claude -p --output-format json --max-budget-usd "$MAX_BUDGET" --model "$MODEL" 2>/dev/null)
    else
      context=$(eval "$1" '"$query"' 2>/dev/null || true)
      full_prompt="Relevant codebase context (from Reporecall):

$context

Answer this question about the codebase above: $query"
      raw=$(echo "$full_prompt" | claude -p --output-format json --max-budget-usd "$MAX_BUDGET" --model "$MODEL" 2>/dev/null)
    fi

    parsed=$(echo "$raw" | parse_json)
    IFS='|' read -r inp out cr cw cost model_used <<< "$parsed"

    echo "| $((i+1)) | ${query:0:45} | $inp | $out | $cr | $cw | \$$cost |" >> "$RESULTS"

    total_input=$((total_input + inp))
    total_output=$((total_output + out))
    total_cr=$((total_cr + cr))
    total_cw=$((total_cw + cw))
    total_cost=$(python3 -c "print(round($total_cost + $cost, 6))")
  done

  echo "" >> "$RESULTS"
  echo "**Totals:** Input=$total_input | Output=$total_output | Cache Read=$total_cr | Cache Write=$total_cw | **Cost=\$$total_cost**" >> "$RESULTS"
  echo "" >> "$RESULTS"

  echo "$total_input|$total_output|$total_cr|$total_cw|$total_cost" > "/tmp/bench_${dat_label}.dat"
}

# ── detect previous npm version ─────────────────────────────

PREV_VERSION=$(npm view "$PKG_NAME" versions --json 2>/dev/null | python3 -c "
import sys, json
versions = json.loads(sys.stdin.read())
if isinstance(versions, list) and len(versions) >= 2:
    print(versions[-2])
else:
    print('')
")

if [ -z "$PREV_VERSION" ]; then
  echo "ERROR: Could not determine previous npm version for $PKG_NAME"
  exit 1
fi

echo "Detected previous npm version: $PREV_VERSION"

# ── preflight ────────────────────────────────────────────────

command -v claude >/dev/null 2>&1 || { echo "ERROR: claude CLI not found"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 required"; exit 1; }
[ -d "$PROJECT" ] || { echo "ERROR: Test project not found at $PROJECT. Create it first."; exit 1; }
[ -d "$PROJECT/.memory" ] || { echo "ERROR: $PROJECT not indexed. Run: cd $PROJECT && npx reporecall index"; exit 1; }

echo "Project: $PROJECT"
echo "Queries: $QUERY_COUNT"
echo "Model:   $MODEL"
echo "Sections: No Memory, v$PREV_VERSION (npm), dist ($((QUERY_COUNT * 3)) total API calls)"
echo "Cost:    ~\$0.50-1.50"
echo ""

# ── header ───────────────────────────────────────────────────

cat > "$RESULTS" << EOF
# Version Comparison: No Memory vs v$PREV_VERSION vs dist

**Method:** Real Claude API calls via \`claude -p --output-format json\`
**Model:** $MODEL
**Project:** $PROJECT ($QUERY_COUNT queries x 3 scenarios = $((QUERY_COUNT * 3)) API calls)

---

EOF

# ── 1. NO MEMORY ─────────────────────────────────────────────

echo "## 1. No Memory (Claude navigates with tools)" >> "$RESULTS"
echo "" >> "$RESULTS"

cd "$PROJECT"
mv .claude .claude.bak 2>/dev/null || true
mv .mcp.json .mcp.json.bak 2>/dev/null || true
mv .memory .memory.bak 2>/dev/null || true
mv CLAUDE.md CLAUDE.md.bak 2>/dev/null || true

run_section "NO MEMORY" "nomem" "tools"

mv .claude.bak .claude 2>/dev/null || true
mv .mcp.json.bak .mcp.json 2>/dev/null || true
mv .memory.bak .memory 2>/dev/null || true
mv CLAUDE.md.bak CLAUDE.md 2>/dev/null || true

# ── 2. Previous npm version ─────────────────────────────────

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## 2. Reporecall v$PREV_VERSION (previous npm release)" >> "$RESULTS"
echo "" >> "$RESULTS"

PREV_DIR="/tmp/reporecall-test-prev-bench"

rm -rf "$PREV_DIR"
mkdir -p "$PREV_DIR/src"
cd "$PREV_DIR" && npm init -y 2>/dev/null 1>/dev/null

npm install "${PKG_NAME}@${PREV_VERSION}" --legacy-peer-deps 2>/dev/null 1>/dev/null
cp "$PROJECT/src/"*.ts src/ 2>/dev/null || true
npx reporecall init --embedding-provider keyword 2>/dev/null 1>/dev/null
npx reporecall index 2>/dev/null 1>/dev/null
echo "v$PREV_VERSION (npm) indexed" >&2

cd "$PROJECT"
run_section "v$PREV_VERSION" "prev" "cd $PREV_DIR && npx reporecall search --budget"

# ── 3. dist (local build) ──────────────────────────────────

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## 3. Reporecall dist (local build)" >> "$RESULTS"
echo "" >> "$RESULTS"

DIST_DIR="/tmp/reporecall-test-dist-bench"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/src"
cd "$DIST_DIR" && npm init -y 2>/dev/null 1>/dev/null

cd "$REPO_ROOT"
npm pack 2>/dev/null 1>/dev/null
DIST_TARBALL=$(ls proofofwork-agency-reporecall-*.tgz 2>/dev/null | head -1)
if [ -n "$DIST_TARBALL" ]; then
  cd "$DIST_DIR"
  npm install "$REPO_ROOT/$DIST_TARBALL" --legacy-peer-deps 2>/dev/null 1>/dev/null
  cp "$PROJECT/src/"*.ts src/ 2>/dev/null || true
  npx reporecall init --embedding-provider keyword 2>/dev/null 1>/dev/null
  npx reporecall index 2>/dev/null 1>/dev/null
  echo "dist indexed" >&2

  cd "$PROJECT"
  run_section "dist" "dist" "cd $DIST_DIR && npx reporecall search --budget"
else
  echo "*dist pack failed*" >> "$RESULTS"
  echo "" >> "$RESULTS"
  echo "0|0|0|0|0" > "/tmp/bench_dist.dat"
fi

rm -f "$REPO_ROOT/$DIST_TARBALL" 2>/dev/null || true

# ── 4. COMPARISON ────────────────────────────────────────────

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## 4. Head-to-Head Comparison" >> "$RESULTS"
echo "" >> "$RESULTS"

IFS='|' read -r nm_inp nm_out nm_cr nm_cw nm_cost < /tmp/bench_nomem.dat
IFS='|' read -r pv_inp pv_out pv_cr pv_cw pv_cost < /tmp/bench_prev.dat
IFS='|' read -r d_inp d_out d_cr d_cw d_cost < /tmp/bench_dist.dat

python3 -c "
nm_cost = $nm_cost; pv_cost = $pv_cost; d_cost = $d_cost
nm_inp = $nm_inp; pv_inp = $pv_inp; d_inp = $d_inp
nm_out = $nm_out; pv_out = $pv_out; d_out = $d_out
nm_cr = $nm_cr; pv_cr = $pv_cr; d_cr = $d_cr
nm_cw = $nm_cw; pv_cw = $pv_cw; d_cw = $d_cw
q = $QUERY_COUNT
prev = '$PREV_VERSION'

nm_total = nm_inp + nm_cr + nm_cw
pv_total = pv_inp + pv_cr + pv_cw
d_total = d_inp + d_cr + d_cw

print(f'| Metric | No Memory | v{prev} | dist |')
sep = '-' * (len(prev) + 4)
print(f'|--------|-----------|{sep}|------|')
print(f'| Input tokens | {nm_inp:,} | {pv_inp:,} | {d_inp:,} |')
print(f'| Output tokens | {nm_out:,} | {pv_out:,} | {d_out:,} |')
print(f'| Cache read | {nm_cr:,} | {pv_cr:,} | {d_cr:,} |')
print(f'| Cache write | {nm_cw:,} | {pv_cw:,} | {d_cw:,} |')
print(f'| Total tokens | {nm_total:,} | {pv_total:,} | {d_total:,} |')
print(f'| **Total cost** | **\${nm_cost:.4f}** | **\${pv_cost:.4f}** | **\${d_cost:.4f}** |')
print(f'| Per-query cost | \${nm_cost/q:.4f} | \${pv_cost/q:.4f} | \${d_cost/q:.4f} |')
if nm_cost > 0:
    print(f'| Savings vs No Memory | --- | {(1-pv_cost/nm_cost)*100:.1f}% | {(1-d_cost/nm_cost)*100:.1f}% |')
if pv_cost > 0:
    print(f'| dist vs v{prev} | --- | --- | {(1-d_cost/pv_cost)*100:.1f}% |')
print()
print(f'**Per 1,000 sessions ({q*1000:,} queries):**')
print(f'- No Memory: \${nm_cost*1000:.2f}')
print(f'- v{prev}: \${pv_cost*1000:.2f}')
print(f'- dist: \${d_cost*1000:.2f}')
if nm_cost > 0 and d_cost > 0:
    print(f'- Savings (dist vs No Memory): \${(nm_cost-d_cost)*1000:.2f}')
" >> "$RESULTS"

echo "" >> "$RESULTS"

# ── cleanup ──────────────────────────────────────────────────

rm -rf "$PREV_DIR" "$DIST_DIR" /tmp/bench_nomem.dat /tmp/bench_prev.dat /tmp/bench_dist.dat

echo ""
echo "=== DONE ==="
echo "Results: $RESULTS"
echo ""
cat "$RESULTS"
