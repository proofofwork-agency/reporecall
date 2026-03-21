#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Reporecall Version Comparison: No Memory vs v0.1.0 vs v0.2.* vs dist
# Real Claude API calls via `claude -p --output-format json`
#
# Usage:
#   bash scripts/benchmarks/version-comparison.sh
#
# Requirements:
#   - claude CLI, python3, reporecall built + indexed
#   - Test project at /tmp/reporecall-test (7 TypeScript files)
#   - v0.1.0 tag must exist in git history
#
# Cost: ~$0.70-2.00 per run (28 API calls)
# ─────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT="/tmp/reporecall-test"
RESULTS="/tmp/reporecall-version-comparison.md"
MAX_BUDGET="0.50"
MODEL="${REPORECALL_BENCH_MODEL:-sonnet}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

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

# ── preflight ────────────────────────────────────────────────

command -v claude >/dev/null 2>&1 || { echo "ERROR: claude CLI not found"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 required"; exit 1; }
[ -d "$PROJECT" ] || { echo "ERROR: Test project not found at $PROJECT. Create it first."; exit 1; }
[ -d "$PROJECT/.memory" ] || { echo "ERROR: $PROJECT not indexed. Run: cd $PROJECT && npx reporecall index"; exit 1; }

echo "Project: $PROJECT"
echo "Queries: $QUERY_COUNT"
echo "Model:   $MODEL"
echo "Sections: No Memory, v0.1.0, v0.2.5, dist (28 total API calls)"
echo "Cost:    ~\$0.70-2.00"
echo ""

# ── header ───────────────────────────────────────────────────

cat > "$RESULTS" << EOF
# Version Comparison: No Memory vs v0.1.0 vs v0.2.5 vs dist

**Method:** Real Claude API calls via \`claude -p --output-format json\`
**Model:** $MODEL
**Project:** $PROJECT ($QUERY_COUNT queries × 4 scenarios = $((QUERY_COUNT * 4)) API calls)

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

# ── 2. v0.1.0 ───────────────────────────────────────────────

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## 2. Reporecall v0.1.0" >> "$RESULTS"
echo "" >> "$RESULTS"

# Build v0.1.0 from git tag
V1_DIR="/tmp/reporecall-test-v1-bench"
V1_WORKTREE="/tmp/reporecall-v1-bench-build"

rm -rf "$V1_DIR"
mkdir -p "$V1_DIR/src"
cd "$V1_DIR" && npm init -y 2>/dev/null 1>/dev/null

cd "$REPO_ROOT"
V1_TAG=$(git log --all --oneline | grep -i "v0.1.0\|0.1.0" | head -1 | awk '{print $1}')
if [ -z "$V1_TAG" ]; then
  echo "WARNING: v0.1.0 tag not found, skipping v0.1.0 section" >&2
  echo "*v0.1.0 not available — tag not found in git history*" >> "$RESULTS"
  echo "" >> "$RESULTS"
  echo "0|0|0|0|0" > "/tmp/bench_v010.dat"
else
  git worktree add "$V1_WORKTREE" "$V1_TAG" 2>/dev/null || true
  cd "$V1_WORKTREE" && npm install --legacy-peer-deps 2>/dev/null 1>/dev/null && npx tsup 2>/dev/null 1>/dev/null && npm pack 2>/dev/null 1>/dev/null

  cd "$V1_DIR"
  TARBALL=$(ls "${V1_WORKTREE}"/proofofwork-agency-reporecall-*.tgz 2>/dev/null | head -1)
  if [ -n "$TARBALL" ]; then
    npm install "$TARBALL" --legacy-peer-deps 2>/dev/null 1>/dev/null
    cp "$PROJECT/src/"*.ts src/ 2>/dev/null || true
    npx reporecall init --embedding-provider keyword 2>/dev/null 1>/dev/null
    npx reporecall index 2>/dev/null 1>/dev/null
    echo "v0.1.0 indexed" >&2

    cd "$PROJECT"
    run_section "v0.1.0" "v010" "cd $V1_DIR && npx reporecall search --budget 3000"
  else
    echo "*v0.1.0 build failed*" >> "$RESULTS"
    echo "" >> "$RESULTS"
    echo "0|0|0|0|0" > "/tmp/bench_v010.dat"
  fi

  cd "$REPO_ROOT"
  git worktree remove "$V1_WORKTREE" 2>/dev/null || true
fi

# ── 3. v0.2.5 (latest published tag) ────────────────────────

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## 3. Reporecall v0.2.5" >> "$RESULTS"
echo "" >> "$RESULTS"

V2_DIR="/tmp/reporecall-test-v2-bench"
V2_WORKTREE="/tmp/reporecall-v2-bench-build"

rm -rf "$V2_DIR"
mkdir -p "$V2_DIR/src"
cd "$V2_DIR" && npm init -y 2>/dev/null 1>/dev/null

cd "$REPO_ROOT"
V2_TAG=$(git tag --list 'v0.2*' | sort -V | tail -1)
if [ -z "$V2_TAG" ]; then
  echo "WARNING: v0.2.x tag not found, skipping v0.2.x section" >&2
  echo "*v0.2.x not available — tag not found in git history*" >> "$RESULTS"
  echo "" >> "$RESULTS"
  echo "0|0|0|0|0" > "/tmp/bench_v025.dat"
else
  git worktree add "$V2_WORKTREE" "$V2_TAG" 2>/dev/null || true
  cd "$V2_WORKTREE" && npm install --legacy-peer-deps 2>/dev/null 1>/dev/null && npx tsup 2>/dev/null 1>/dev/null && npm pack 2>/dev/null 1>/dev/null

  cd "$V2_DIR"
  TARBALL=$(ls "${V2_WORKTREE}"/proofofwork-agency-reporecall-*.tgz 2>/dev/null | head -1)
  if [ -n "$TARBALL" ]; then
    npm install "$TARBALL" --legacy-peer-deps 2>/dev/null 1>/dev/null
    cp "$PROJECT/src/"*.ts src/ 2>/dev/null || true
    npx reporecall init --embedding-provider keyword 2>/dev/null 1>/dev/null
    npx reporecall index 2>/dev/null 1>/dev/null
    echo "$V2_TAG indexed" >&2

    cd "$PROJECT"
    run_section "$V2_TAG" "v025" "cd $V2_DIR && npx reporecall search --budget"
  else
    echo "*$V2_TAG build failed*" >> "$RESULTS"
    echo "" >> "$RESULTS"
    echo "0|0|0|0|0" > "/tmp/bench_v025.dat"
  fi

  cd "$REPO_ROOT"
  git worktree remove "$V2_WORKTREE" 2>/dev/null || true
fi

# ── 4. dist (local build) ──────────────────────────────────

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## 4. Reporecall dist (local build)" >> "$RESULTS"
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

# ── 5. COMPARISON ────────────────────────────────────────────

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## 5. Head-to-Head Comparison" >> "$RESULTS"
echo "" >> "$RESULTS"

IFS='|' read -r nm_inp nm_out nm_cr nm_cw nm_cost < /tmp/bench_nomem.dat
IFS='|' read -r v1_inp v1_out v1_cr v1_cw v1_cost < /tmp/bench_v010.dat
IFS='|' read -r v2_inp v2_out v2_cr v2_cw v2_cost < /tmp/bench_v025.dat
IFS='|' read -r d_inp d_out d_cr d_cw d_cost < /tmp/bench_dist.dat

python3 -c "
nm_cost = $nm_cost; v1_cost = $v1_cost; v2_cost = $v2_cost; d_cost = $d_cost
nm_inp = $nm_inp; v1_inp = $v1_inp; v2_inp = $v2_inp; d_inp = $d_inp
nm_out = $nm_out; v1_out = $v1_out; v2_out = $v2_out; d_out = $d_out
nm_cr = $nm_cr; v1_cr = $v1_cr; v2_cr = $v2_cr; d_cr = $d_cr
nm_cw = $nm_cw; v1_cw = $v1_cw; v2_cw = $v2_cw; d_cw = $d_cw
q = $QUERY_COUNT

nm_total = nm_inp + nm_cr + nm_cw
v1_total = v1_inp + v1_cr + v1_cw
v2_total = v2_inp + v2_cr + v2_cw
d_total = d_inp + d_cr + d_cw

print('| Metric | No Memory | v0.1.0 | v0.2.5 | dist |')
print('|--------|-----------|--------|--------|------|')
print(f'| Input tokens | {nm_inp:,} | {v1_inp:,} | {v2_inp:,} | {d_inp:,} |')
print(f'| Output tokens | {nm_out:,} | {v1_out:,} | {v2_out:,} | {d_out:,} |')
print(f'| Cache read | {nm_cr:,} | {v1_cr:,} | {v2_cr:,} | {d_cr:,} |')
print(f'| Cache write | {nm_cw:,} | {v1_cw:,} | {v2_cw:,} | {d_cw:,} |')
print(f'| Total tokens | {nm_total:,} | {v1_total:,} | {v2_total:,} | {d_total:,} |')
print(f'| **Total cost** | **\${nm_cost:.4f}** | **\${v1_cost:.4f}** | **\${v2_cost:.4f}** | **\${d_cost:.4f}** |')
print(f'| Per-query cost | \${nm_cost/q:.4f} | \${v1_cost/q:.4f} | \${v2_cost/q:.4f} | \${d_cost/q:.4f} |')
if nm_cost > 0:
    print(f'| Savings vs No Memory | — | {(1-v1_cost/nm_cost)*100:.1f}% | {(1-v2_cost/nm_cost)*100:.1f}% | {(1-d_cost/nm_cost)*100:.1f}% |')
if v1_cost > 0:
    print(f'| vs v0.1.0 | — | — | {(1-v2_cost/v1_cost)*100:.1f}% | {(1-d_cost/v1_cost)*100:.1f}% |')
if v2_cost > 0:
    print(f'| dist vs v0.2.5 | — | — | — | {(1-d_cost/v2_cost)*100:.1f}% |')
print()
print(f'**Per 1,000 sessions ({q*1000:,} queries):**')
print(f'- No Memory: \${nm_cost*1000:.2f}')
print(f'- v0.1.0: \${v1_cost*1000:.2f}')
print(f'- v0.2.5: \${v2_cost*1000:.2f}')
print(f'- dist: \${d_cost*1000:.2f}')
if nm_cost > 0 and d_cost > 0:
    print(f'- Savings (dist vs No Memory): \${(nm_cost-d_cost)*1000:.2f}')
" >> "$RESULTS"

echo "" >> "$RESULTS"

# ── cleanup ──────────────────────────────────────────────────

rm -rf "$V1_DIR" "$V2_DIR" "$DIST_DIR" /tmp/bench_nomem.dat /tmp/bench_v010.dat /tmp/bench_v025.dat /tmp/bench_dist.dat

echo ""
echo "=== DONE ==="
echo "Results: $RESULTS"
echo ""
cat "$RESULTS"
