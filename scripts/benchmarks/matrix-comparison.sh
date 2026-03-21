#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Reporecall Matrix Benchmark
#
# 2×2 matrix: Code Memory (Reporecall) × Memory System
# With R0/R1/R2 route coverage and version comparison
#
# Scenarios:
#   A. Raw Claude (no Reporecall, no memories)
#   B. Memories only (12 records, no Reporecall)
#   C. Reporecall <prev_version> code context only
#   D. Reporecall <prev_version> + 12 memories
#   E. Reporecall <current_version> code context only
#   F. Reporecall <current_version> + 2 memories
#   G. Reporecall <current_version> + 12 memories
#
# Usage:
#   bash scripts/benchmarks/matrix-comparison.sh
#
# Requirements:
#   - claude CLI, python3, npm
#   - Test project at /tmp/reporecall-test (7 TypeScript files)
#   - dist/ built (npx tsup)
#
# Cost: ~$2-5 per run (49 API calls)
# ─────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT="/tmp/reporecall-test"
RESULTS="/tmp/reporecall-matrix-benchmark.md"
MAX_BUDGET="0.50"
MODEL="${REPORECALL_BENCH_MODEL:-sonnet}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLAUDE_MEM_DIR="$HOME/.claude/projects/-tmp-reporecall-test/memory"
PKG_NAME="@proofofwork-agency/reporecall"

# ── Auto-detect versions ────────────────────────────────────

CURRENT_VERSION=$(node -p "require('$REPO_ROOT/package.json').version")
PREV_VERSION=$(npm view "$PKG_NAME" versions --json 2>/dev/null \
  | python3 -c "import sys,json; vs=json.load(sys.stdin); print(vs[-2] if len(vs)>=2 else vs[-1])")

echo "Detected versions: previous=$PREV_VERSION, current=$CURRENT_VERSION" >&2

# ── Queries by route ─────────────────────────────────────────
# R0: non-navigational (simple lookups)
# R1: navigational + strong seed (who calls X, how does X work)
# R2: navigational + no clear seed (architecture, trace flows)

R0_QUERIES=(
  "show me the rate limiter"
  "where is password hashing"
)

R1_QUERIES=(
  "who calls the login function"
  "how does password hashing work"
)

R2_QUERIES=(
  "trace the full authentication flow from HTTP request to JWT token generation"
  "explain how the database layer and auth service interact when a new user registers"
  "if I wanted to add OAuth2 support which files would I need to modify"
)

ALL_QUERIES=("${R0_QUERIES[@]}" "${R1_QUERIES[@]}" "${R2_QUERIES[@]}")
QUERY_COUNT=${#ALL_QUERIES[@]}

# ── Memory record creation ──────────────────────────────────

create_few_memories() {
  mkdir -p "$CLAUDE_MEM_DIR"
  cat > "$CLAUDE_MEM_DIR/feedback_testing.md" << 'EOF'
---
name: testing-preferences
description: Use integration tests over mocks for database code
type: feedback
---
Always use integration tests with real database connections for auth code.
**Why:** Mocked tests passed but production migrations failed last quarter.
**How to apply:** When writing tests for auth or database modules, spin up a real SQLite instance.
EOF
  cat > "$CLAUDE_MEM_DIR/user_role.md" << 'EOF'
---
name: user-role
description: Senior backend engineer focused on security
type: user
---
User is a senior backend engineer specializing in authentication and security.
Deep experience with JWT, OAuth2, bcrypt. Prefers TypeScript.
EOF
  cat > "$CLAUDE_MEM_DIR/MEMORY.md" << 'EOF'
# Memory Index
- [feedback_testing.md](feedback_testing.md) — Use integration tests over mocks
- [user_role.md](user_role.md) — Senior backend engineer focused on security
EOF
}

create_many_memories() {
  create_few_memories
  for item in \
    "project_deadline:Auth v2 launch deadline is March 28:project" \
    "feedback_pr_style:Keep PRs under 400 lines split large refactors:feedback" \
    "reference_linear:Auth bugs tracked in Linear project AUTH:reference" \
    "feedback_error_handling:Use typed error classes not string throws:feedback" \
    "project_rate_limit:Rate limiter moving from in-memory to Redis in Q2:project" \
    "user_preferences:Prefers functional style immutable data no classes:user" \
    "reference_grafana:Auth latency dashboard at grafana internal:reference" \
    "feedback_logging:Use structured logging with pino never console.log:feedback" \
    "project_compliance:SOC2 audit in April session tokens must be encrypted:project" \
    "feedback_naming:Use camelCase for functions PascalCase for types:feedback"; do
    IFS=':' read -r name desc type <<< "$item"
    cat > "$CLAUDE_MEM_DIR/${name}.md" << EOF
---
name: ${name//_/-}
description: $desc
type: $type
---
Detailed memory about ${name//_/ } that provides important context for the project.
**Why:** Team preference established based on past incidents.
**How to apply:** Apply when working on related auth code.
EOF
  done
  cat > "$CLAUDE_MEM_DIR/MEMORY.md" << 'EOF'
# Memory Index
- [feedback_testing.md](feedback_testing.md) — Use integration tests
- [user_role.md](user_role.md) — Senior backend engineer
- [project_deadline.md](project_deadline.md) — Auth v2 deadline
- [feedback_pr_style.md](feedback_pr_style.md) — PR style
- [reference_linear.md](reference_linear.md) — Linear tracking
- [feedback_error_handling.md](feedback_error_handling.md) — Error handling
- [project_rate_limit.md](project_rate_limit.md) — Rate limit migration
- [user_preferences.md](user_preferences.md) — Coding preferences
- [reference_grafana.md](reference_grafana.md) — Grafana dashboard
- [feedback_logging.md](feedback_logging.md) — Logging style
- [project_compliance.md](project_compliance.md) — SOC2 compliance
- [feedback_naming.md](feedback_naming.md) — Naming conventions
EOF
}

clear_memories() {
  rm -rf "$CLAUDE_MEM_DIR" 2>/dev/null || true
}

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

# run_one_query <label> <search_cmd> <route_label> <query> — appends to RESULTS, updates totals
# Uses/modifies: idx, total_input, total_output, total_cr, total_cw, total_cost
run_one_query() {
  local label="$1" search_cmd="$2" route_label="$3" query="$4"
  idx=$((idx + 1))
  echo "  $label [$idx/$QUERY_COUNT]: $query" >&2

  local raw
  if [ "$search_cmd" = "tools" ]; then
    raw=$(cd "$PROJECT" && echo "$query" | claude -p --output-format json --max-budget-usd "$MAX_BUDGET" --model "$MODEL" 2>/dev/null || echo '{}')
  else
    local context
    context=$(eval "$search_cmd" '"$query"' 2>/dev/null || true)
    local full_prompt="Relevant codebase context (from Reporecall):

$context

Answer this question about the codebase above: $query"
    raw=$(cd "$PROJECT" && echo "$full_prompt" | claude -p --output-format json --max-budget-usd "$MAX_BUDGET" --model "$MODEL" 2>/dev/null || echo '{}')
  fi

  local parsed inp out cr cw cost model_used
  parsed=$(echo "$raw" | parse_json)
  IFS='|' read -r inp out cr cw cost model_used <<< "$parsed"

  echo "| $idx | $route_label | ${query:0:52} | $inp | $out | $cr | $cw | \$$cost |" >> "$RESULTS"

  total_input=$((total_input + inp))
  total_output=$((total_output + out))
  total_cr=$((total_cr + cr))
  total_cw=$((total_cw + cw))
  total_cost=$(python3 -c "print(round($total_cost + $cost, 6))")
}

# run_scenario <label> <dat_label> <search_cmd|"tools">
run_scenario() {
  local label="$1"
  local dat_label="$2"
  local search_cmd="$3"

  total_input=0; total_output=0; total_cr=0; total_cw=0; total_cost=0
  idx=0

  echo "| # | Route | Query | Input | Output | Cache R | Cache W | Cost |" >> "$RESULTS"
  echo "|---|-------|-------|-------|--------|---------|---------|------|" >> "$RESULTS"

  for q in "${R0_QUERIES[@]}"; do run_one_query "$label" "$search_cmd" "R0" "$q"; done
  for q in "${R1_QUERIES[@]}"; do run_one_query "$label" "$search_cmd" "R1" "$q"; done
  for q in "${R2_QUERIES[@]}"; do run_one_query "$label" "$search_cmd" "R2" "$q"; done

  echo "" >> "$RESULTS"
  echo "**Totals:** Input=$total_input | Output=$total_output | Cache Read=$total_cr | Cache Write=$total_cw | **Cost=\$$total_cost**" >> "$RESULTS"
  echo "" >> "$RESULTS"

  # Save totals for summary
  echo "$total_input|$total_output|$total_cr|$total_cw|$total_cost" > "/tmp/bench_${dat_label}.dat"
}

# ── preflight ────────────────────────────────────────────────

command -v claude >/dev/null 2>&1 || { echo "ERROR: claude CLI not found"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 required"; exit 1; }
[ -d "$PROJECT" ] || { echo "ERROR: Test project not found at $PROJECT"; exit 1; }
[ -d "$PROJECT/.memory" ] || { echo "ERROR: $PROJECT not indexed"; exit 1; }

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Reporecall Matrix Benchmark                            ║"
echo "║  Code Memory × Memory System × Route Type               ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Project:    $PROJECT"
echo "Model:      $MODEL"
echo "Previous:   v$PREV_VERSION (from npm)"
echo "Current:    v$CURRENT_VERSION (from package.json)"
echo "Queries:    $QUERY_COUNT (${#R0_QUERIES[@]} R0 + ${#R1_QUERIES[@]} R1 + ${#R2_QUERIES[@]} R2)"
echo "Scenarios:  7 × $QUERY_COUNT = $((7 * QUERY_COUNT)) API calls"
echo ""

# ── Setup versions ───────────────────────────────────────────

echo "▸ Setting up v$PREV_VERSION (from npm)..." >&2
PREV_DIR="/tmp/reporecall-bench-prev"
rm -rf "$PREV_DIR"
mkdir -p "$PREV_DIR/src"
cd "$PREV_DIR" && npm init -y 2>/dev/null 1>/dev/null
cd "$PREV_DIR" && npm install "${PKG_NAME}@${PREV_VERSION}" --legacy-peer-deps 2>/dev/null 1>/dev/null
cp "$PROJECT"/src/*.ts src/ 2>/dev/null || true
npx reporecall init --embedding-provider keyword 2>/dev/null 1>/dev/null
npx reporecall index 2>/dev/null 1>/dev/null
echo "  v$PREV_VERSION ready" >&2

echo "▸ Setting up v$CURRENT_VERSION (local build)..." >&2
DIST_DIR="/tmp/reporecall-bench-dist"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/src"
cd "$DIST_DIR" && npm init -y 2>/dev/null 1>/dev/null
cd "$REPO_ROOT" && npm pack 2>/dev/null 1>/dev/null
DIST_TAR=$(ls "$REPO_ROOT"/proofofwork-agency-reporecall-*.tgz 2>/dev/null | head -1)
cd "$DIST_DIR"
npm install "$DIST_TAR" --legacy-peer-deps 2>/dev/null 1>/dev/null
cp "$PROJECT"/src/*.ts src/ 2>/dev/null || true
npx reporecall init --embedding-provider keyword 2>/dev/null 1>/dev/null
npx reporecall index 2>/dev/null 1>/dev/null
echo "  v$CURRENT_VERSION ready" >&2
rm -f "$REPO_ROOT"/*.tgz 2>/dev/null || true

# ── Report header ────────────────────────────────────────────

cat > "$RESULTS" << EOF
# Reporecall Matrix Benchmark

**Date:** $(date +%Y-%m-%d) | **Model:** $MODEL | **Project:** auth-demo (7 TypeScript files)
**Queries:** $QUERY_COUNT (${#R0_QUERIES[@]} R0 standard + ${#R1_QUERIES[@]} R1 flow + ${#R2_QUERIES[@]} R2 deep)
**Versions:** v$PREV_VERSION (previous) vs v$CURRENT_VERSION (current)

**Route types:**
- **R0** (standard): Non-navigational queries — direct lookups
- **R1** (flow): Navigational + strong seed — caller/callee traces
- **R2** (deep): Navigational + no clear seed — architecture/multi-hop

---

EOF

# ══════════════════════════════════════════════════════════════
# A: No Code Memory, No Memory System (raw Claude)
# ══════════════════════════════════════════════════════════════

echo "" >&2
echo "━━━ A: Raw Claude (no Reporecall, no memories) ━━━" >&2

clear_memories
cd "$PROJECT"
mv .claude .claude.bak 2>/dev/null || true
mv .mcp.json .mcp.json.bak 2>/dev/null || true
mv .memory .memory.bak 2>/dev/null || true
mv CLAUDE.md CLAUDE.md.bak 2>/dev/null || true

echo "## A. Raw Claude (no Reporecall, no memories)" >> "$RESULTS"
echo "" >> "$RESULTS"

run_scenario "A" "a" "tools"

mv .claude.bak .claude 2>/dev/null || true
mv .mcp.json.bak .mcp.json 2>/dev/null || true
mv .memory.bak .memory 2>/dev/null || true
mv CLAUDE.md.bak CLAUDE.md 2>/dev/null || true

# ══════════════════════════════════════════════════════════════
# B: No Code Memory, WITH Memory System (12 mems)
# ══════════════════════════════════════════════════════════════

echo "" >&2
echo "━━━ B: Memory only (12 records, no Reporecall) ━━━" >&2

create_many_memories
cd "$PROJECT"
mv .claude .claude.bak 2>/dev/null || true
mv .mcp.json .mcp.json.bak 2>/dev/null || true
mv .memory .memory.bak 2>/dev/null || true

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## B. Memory System only (12 memories, no Reporecall)" >> "$RESULTS"
echo "" >> "$RESULTS"

run_scenario "B" "b" "tools"

mv .claude.bak .claude 2>/dev/null || true
mv .mcp.json.bak .mcp.json 2>/dev/null || true
mv .memory.bak .memory 2>/dev/null || true

# ══════════════════════════════════════════════════════════════
# C: Reporecall previous version code only
# ══════════════════════════════════════════════════════════════

echo "" >&2
echo "━━━ C: Reporecall v$PREV_VERSION, no memories ━━━" >&2

clear_memories

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## C. Reporecall v$PREV_VERSION code context (no memories)" >> "$RESULTS"
echo "" >> "$RESULTS"

run_scenario "C" "c" "cd $PREV_DIR && npx reporecall search --budget 8000"

# ══════════════════════════════════════════════════════════════
# D: Reporecall previous version + 12 memories
# ══════════════════════════════════════════════════════════════

echo "" >&2
echo "━━━ D: Reporecall v$PREV_VERSION + 12 memories ━━━" >&2

create_many_memories

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## D. Reporecall v$PREV_VERSION + 12 memories" >> "$RESULTS"
echo "" >> "$RESULTS"

run_scenario "D" "d" "cd $PREV_DIR && npx reporecall search --budget 8000"

# ══════════════════════════════════════════════════════════════
# E: Reporecall current version code only
# ══════════════════════════════════════════════════════════════

echo "" >&2
echo "━━━ E: Reporecall v$CURRENT_VERSION, no memories ━━━" >&2

clear_memories
cd "$DIST_DIR" && rm -rf .memory/memory-index 2>/dev/null || true
cd "$DIST_DIR" && npx reporecall index 2>/dev/null 1>/dev/null

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## E. Reporecall v$CURRENT_VERSION code context (no memories)" >> "$RESULTS"
echo "" >> "$RESULTS"

run_scenario "E" "e" "cd $DIST_DIR && npx reporecall search --budget 8000"

# ══════════════════════════════════════════════════════════════
# F: Reporecall current version + 2 memories
# ══════════════════════════════════════════════════════════════

echo "" >&2
echo "━━━ F: Reporecall v$CURRENT_VERSION + 2 memories ━━━" >&2

create_few_memories
cd "$DIST_DIR" && rm -rf .memory/memory-index 2>/dev/null || true
cd "$DIST_DIR" && npx reporecall init --embedding-provider keyword 2>/dev/null 1>/dev/null
cd "$DIST_DIR" && npx reporecall index 2>/dev/null 1>/dev/null

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## F. Reporecall v$CURRENT_VERSION + 2 memories" >> "$RESULTS"
echo "" >> "$RESULTS"

run_scenario "F" "f" "cd $DIST_DIR && npx reporecall search --budget 8000"

# ══════════════════════════════════════════════════════════════
# G: Reporecall current version + 12 memories
# ══════════════════════════════════════════════════════════════

echo "" >&2
echo "━━━ G: Reporecall v$CURRENT_VERSION + 12 memories ━━━" >&2

create_many_memories
cd "$DIST_DIR" && rm -rf .memory/memory-index 2>/dev/null || true
cd "$DIST_DIR" && npx reporecall init --embedding-provider keyword 2>/dev/null 1>/dev/null
cd "$DIST_DIR" && npx reporecall index 2>/dev/null 1>/dev/null

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## G. Reporecall v$CURRENT_VERSION + 12 memories" >> "$RESULTS"
echo "" >> "$RESULTS"

run_scenario "G" "g" "cd $DIST_DIR && npx reporecall search --budget 8000"

# ══════════════════════════════════════════════════════════════
# SUMMARY MATRIX
# ══════════════════════════════════════════════════════════════

echo "---" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "## Summary" >> "$RESULTS"
echo "" >> "$RESULTS"

IFS='|' read -r a_inp a_out a_cr a_cw a_cost < /tmp/bench_a.dat
IFS='|' read -r b_inp b_out b_cr b_cw b_cost < /tmp/bench_b.dat
IFS='|' read -r c_inp c_out c_cr c_cw c_cost < /tmp/bench_c.dat
IFS='|' read -r d_inp d_out d_cr d_cw d_cost < /tmp/bench_d.dat
IFS='|' read -r e_inp e_out e_cr e_cw e_cost < /tmp/bench_e.dat
IFS='|' read -r f_inp f_out f_cr f_cw f_cost < /tmp/bench_f.dat
IFS='|' read -r g_inp g_out g_cr g_cw g_cost < /tmp/bench_g.dat

PREV_VER="$PREV_VERSION" CURR_VER="$CURRENT_VERSION" \
A_COST="$a_cost" B_COST="$b_cost" C_COST="$c_cost" D_COST="$d_cost" \
E_COST="$e_cost" F_COST="$f_cost" G_COST="$g_cost" \
A_INP="$a_inp" B_INP="$b_inp" C_INP="$c_inp" D_INP="$d_inp" \
E_INP="$e_inp" F_INP="$f_inp" G_INP="$g_inp" \
A_OUT="$a_out" B_OUT="$b_out" C_OUT="$c_out" D_OUT="$d_out" \
E_OUT="$e_out" F_OUT="$f_out" G_OUT="$g_out" \
A_CR="$a_cr" B_CR="$b_cr" C_CR="$c_cr" D_CR="$d_cr" \
E_CR="$e_cr" F_CR="$f_cr" G_CR="$g_cr" \
A_CW="$a_cw" B_CW="$b_cw" C_CW="$c_cw" D_CW="$d_cw" \
E_CW="$e_cw" F_CW="$f_cw" G_CW="$g_cw" \
QCOUNT="$QUERY_COUNT" \
python3 << 'PYEOF' >> "$RESULTS"
import os
e = os.environ
prev_ver = e["PREV_VER"]; curr_ver = e["CURR_VER"]
a_cost = float(e["A_COST"]); b_cost = float(e["B_COST"]); c_cost = float(e["C_COST"]); d_cost = float(e["D_COST"])
e_cost = float(e["E_COST"]); f_cost = float(e["F_COST"]); g_cost = float(e["G_COST"])
a_inp = int(e["A_INP"]); b_inp = int(e["B_INP"]); c_inp = int(e["C_INP"]); d_inp = int(e["D_INP"])
e_inp = int(e["E_INP"]); f_inp = int(e["F_INP"]); g_inp = int(e["G_INP"])
a_out = int(e["A_OUT"]); b_out = int(e["B_OUT"]); c_out = int(e["C_OUT"]); d_out = int(e["D_OUT"])
e_out = int(e["E_OUT"]); f_out = int(e["F_OUT"]); g_out = int(e["G_OUT"])
a_cr = int(e["A_CR"]); b_cr = int(e["B_CR"]); c_cr = int(e["C_CR"]); d_cr = int(e["D_CR"])
e_cr = int(e["E_CR"]); f_cr = int(e["F_CR"]); g_cr = int(e["G_CR"])
a_cw = int(e["A_CW"]); b_cw = int(e["B_CW"]); c_cw = int(e["C_CW"]); d_cw = int(e["D_CW"])
e_cw = int(e["E_CW"]); f_cw = int(e["F_CW"]); g_cw = int(e["G_CW"])
q = int(e["QCOUNT"])

a_ti = a_inp + a_cr + a_cw
b_ti = b_inp + b_cr + b_cw
c_ti = c_inp + c_cr + c_cw
d_ti = d_inp + d_cr + d_cw
e_ti = e_inp + e_cr + e_cw
f_ti = f_inp + f_cr + f_cw
g_ti = g_inp + g_cr + g_cw

print("### Cost Matrix (2x2)")
print()
print("| | No Memory System | Memory (2 rec) | Memory (12 rec) |")
print("|---|---|---|---|")
print(f"| **No Reporecall** | A: ${a_cost:.4f} | — | B: ${b_cost:.4f} |")
print(f"| **Reporecall v{prev_ver}** | C: ${c_cost:.4f} | — | D: ${d_cost:.4f} |")
print(f"| **Reporecall v{curr_ver}** | E: ${e_cost:.4f} | F: ${f_cost:.4f} | G: ${g_cost:.4f} |")
print()

print("### Token Matrix (total input tokens)")
print()
print("| | No Memory System | Memory (2 rec) | Memory (12 rec) |")
print("|---|---|---|---|")
print(f"| **No Reporecall** | A: {a_ti:,} | — | B: {b_ti:,} |")
print(f"| **Reporecall v{prev_ver}** | C: {c_ti:,} | — | D: {d_ti:,} |")
print(f"| **Reporecall v{curr_ver}** | E: {e_ti:,} | F: {f_ti:,} | G: {g_ti:,} |")
print()

print("### Output Token Matrix")
print()
print("| | No Memory System | Memory (2 rec) | Memory (12 rec) |")
print("|---|---|---|---|")
print(f"| **No Reporecall** | A: {a_out:,} | — | B: {b_out:,} |")
print(f"| **Reporecall v{prev_ver}** | C: {c_out:,} | — | D: {d_out:,} |")
print(f"| **Reporecall v{curr_ver}** | E: {e_out:,} | F: {f_out:,} | G: {g_out:,} |")
print()

print("### Savings Analysis")
print()
def pct(base, val):
    if base == 0: return "N/A"
    return f"{(1 - val/base)*100:+.1f}%"
def diff(base, val):
    if base == 0: return "N/A"
    return f"{(val/base - 1)*100:+.1f}%"

print("**vs Raw Claude (A):**")
print(f"- B (memories only):              cost {diff(a_cost, b_cost)}")
print(f"- C (v{prev_ver} code only):      cost {diff(a_cost, c_cost)}")
print(f"- D (v{prev_ver} + 12 mem):       cost {diff(a_cost, d_cost)}")
print(f"- E (v{curr_ver} code only):      cost {diff(a_cost, e_cost)}")
print(f"- F (v{curr_ver} + 2 mem):        cost {diff(a_cost, f_cost)}")
print(f"- G (v{curr_ver} + 12 mem):       cost {diff(a_cost, g_cost)}")
print()

print(f"**Compression savings (v{prev_ver} -> v{curr_ver}):**")
if c_cost > 0 and e_cost > 0:
    print(f"- Code only: {pct(c_cost, e_cost)} cost (C -> E)")
if d_cost > 0 and g_cost > 0:
    print(f"- Code + 12 mem: {pct(d_cost, g_cost)} cost (D -> G)")
print()

print(f"**Memory overhead (v{curr_ver}):**")
if e_cost > 0:
    print(f"- +2 memories: {diff(e_cost, f_cost)} cost (E -> F)")
    print(f"- +12 memories: {diff(e_cost, g_cost)} cost (E -> G)")
print()

print(f"### Per 1,000 Sessions ({q*1000:,} queries)")
print()
print("| Scenario | Cost/1k sessions | vs Raw Claude |")
print("|----------|------------------|---------------|")
print(f"| A. Raw Claude | ${a_cost*1000:.2f} | — |")
print(f"| B. Memories only | ${b_cost*1000:.2f} | {diff(a_cost, b_cost)} |")
print(f"| C. v{prev_ver} code | ${c_cost*1000:.2f} | {diff(a_cost, c_cost)} |")
print(f"| D. v{prev_ver} + 12 mem | ${d_cost*1000:.2f} | {diff(a_cost, d_cost)} |")
print(f"| **E. v{curr_ver} code** | **${e_cost*1000:.2f}** | **{diff(a_cost, e_cost)}** |")
print(f"| F. v{curr_ver} + 2 mem | ${f_cost*1000:.2f} | {diff(a_cost, f_cost)} |")
print(f"| **G. v{curr_ver} + 12 mem** | **${g_cost*1000:.2f}** | **{diff(a_cost, g_cost)}** |")
PYEOF

echo "" >> "$RESULTS"

# ── Cleanup ──────────────────────────────────────────────────

clear_memories
rm -rf "$PREV_DIR" "$DIST_DIR"
rm -f /tmp/bench_{a,b,c,d,e,f,g}.dat

echo "" >&2
echo "╔══════════════════════════════════════════════════════════╗" >&2
echo "║  BENCHMARK COMPLETE                                     ║" >&2
echo "║  Results: $RESULTS                                      ║" >&2
echo "╚══════════════════════════════════════════════════════════╝" >&2
echo "" >&2
cat "$RESULTS"
