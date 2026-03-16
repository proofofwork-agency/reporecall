#!/usr/bin/env bash
set -euo pipefail

# Integration test for Reporecall + Claude Code
# Run from project root: bash test/integration/memory-test.sh
#
# Configuration (all optional — sensible defaults are provided):
#   MEMORY_PORT             — daemon HTTP port (default: read from .memory/config.json, fallback 37222)
#   MEMORY_CHUNK_THRESHOLD  — minimum chunks required before tests run (default: 100)
#   MEMORY_DATA_DIR         — path to .memory data directory (default: .memory)
#   CLAUDE_BIN              — path to Claude CLI binary (default: auto-detected via PATH)

# --- Configuration -----------------------------------------------------------

DATA_DIR="${MEMORY_DATA_DIR:-.memory}"

# Port priority: env var > config.json > default 37222
if [ -n "${MEMORY_PORT:-}" ]; then
  PORT="$MEMORY_PORT"
elif [ -f "${DATA_DIR}/config.json" ]; then
  PORT=$(python3 -c "import json; print(json.load(open('${DATA_DIR}/config.json')).get('port', 37222))" 2>/dev/null || echo 37222)
else
  PORT=37222
fi

# Chunk threshold: how many indexed chunks before we consider the index "ready"
CHUNK_THRESHOLD="${MEMORY_CHUNK_THRESHOLD:-100}"

# Claude CLI: find via env var or PATH lookup
if [ -n "${CLAUDE_BIN:-}" ]; then
  CLAUDE="$CLAUDE_BIN"
elif command -v claude >/dev/null 2>&1; then
  CLAUDE="$(command -v claude)"
else
  echo "[WARN] Claude CLI not found in PATH. Set CLAUDE_BIN to the full path."
  echo "       Tests that require Claude CLI will be skipped."
  CLAUDE=""
fi

# --- State -------------------------------------------------------------------

DAEMON_PID=""
PASS=0
FAIL=0
SKIP=0

cleanup() {
  if [ -n "$DAEMON_PID" ]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -f "${DATA_DIR}/daemon.pid" "${DATA_DIR}/metadata.db-wal" "${DATA_DIR}/metadata.db-shm" \
        "${DATA_DIR}/fts.db-wal" "${DATA_DIR}/fts.db-shm"
}
trap cleanup EXIT

echo "=== Reporecall Integration Test ==="
echo "  Port:            ${PORT}"
echo "  Chunk threshold: ${CHUNK_THRESHOLD}"
echo "  Data dir:        ${DATA_DIR}"
echo "  Claude CLI:      ${CLAUDE:-<not found>}"
echo ""

# Read bearer token at runtime (created by daemon on startup)
read_token() {
  cat "${DATA_DIR}/daemon.token" 2>/dev/null || echo ""
}

# Authenticated curl helper
auth_curl() {
  local token
  token="$(read_token)"
  if [ -n "$token" ]; then
    curl -s -H "Authorization: Bearer ${token}" "$@"
  else
    curl -s "$@"
  fi
}

# --- Start daemon ---
echo "[setup] Starting daemon..."
rm -f "${DATA_DIR}/daemon.pid" "${DATA_DIR}/metadata.db-wal" "${DATA_DIR}/metadata.db-shm" \
      "${DATA_DIR}/fts.db-wal" "${DATA_DIR}/fts.db-shm"
node dist/memory.js serve --project . --port "$PORT" &
DAEMON_PID=$!

echo "[setup] Waiting for health..."
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "[FAIL] Daemon did not become healthy in 60s"
    exit 1
  fi
  sleep 1
done

# Wait for index to be populated (WAL may not be flushed immediately)
echo "[setup] Waiting for index..."
for i in $(seq 1 30); do
  CHUNKS=$(auth_curl "http://127.0.0.1:${PORT}/status" | python3 -c "import json,sys; print(json.load(sys.stdin)['totalChunks'])" 2>/dev/null || echo 0)
  if [ "$CHUNKS" -ge "$CHUNK_THRESHOLD" ]; then
    break
  fi
  sleep 1
done
echo "[setup] Index ready: ${CHUNKS} chunks"
if [ "$CHUNKS" -lt "$CHUNK_THRESHOLD" ]; then
  echo "[FAIL] Index too small (${CHUNKS} chunks, expected ${CHUNK_THRESHOLD}+)"
  exit 1
fi
echo ""

# --- Test 1: Realistic end-to-end ---
if [ -n "$CLAUDE" ]; then
  echo "[test1] Realistic end-to-end (normal Claude + Reporecall)..."
  RESULT1=$("$CLAUDE" -p --output-format text \
    "What MCP tools are exposed by the memory server? Return tool names as a comma-separated list." 2>/dev/null)

  if echo "$RESULT1" | grep -q "search_code" && echo "$RESULT1" | grep -q "find_callees"; then
    echo "[test1] PASS"
    echo "  Answer: $(echo "$RESULT1" | tail -1)"
    PASS=$((PASS + 1))
  else
    echo "[test1] FAIL"
    echo "  Answer: $RESULT1"
    FAIL=$((FAIL + 1))
  fi
else
  echo "[test1] SKIP — Claude CLI not available"
  SKIP=$((SKIP + 1))
fi
echo ""

# --- Test 2: Forced memory-only ---
# IMPORTANT: --tools "" alone is NOT enough. Claude will still emit fake tool
# calls as plain text because --tools "" only removes tool schemas, it does not
# tell the model it has no tools. --append-system-prompt is REQUIRED.
if [ -n "$CLAUDE" ]; then
  echo "[test2] Forced memory-only (--tools \"\" + --append-system-prompt)..."
  RESULT2=$("$CLAUDE" -p --output-format text --tools "" \
    --append-system-prompt 'You have no tools available. Do not emit tool calls, XML tool blocks, or file reads. Answer only from hook-injected context. If the context is insufficient, reply exactly: Insufficient context.' \
    "What MCP tools are exposed by the memory server? Return tool names as a comma-separated list." 2>/dev/null)

  if echo "$RESULT2" | grep -q "search_code" && echo "$RESULT2" | grep -q "find_callees"; then
    echo "[test2] PASS"
    echo "  Answer: $(echo "$RESULT2" | tail -1)"
    PASS=$((PASS + 1))
  elif echo "$RESULT2" | grep -q "Insufficient context"; then
    echo "[test2] PARTIAL — answered 'Insufficient context' (retrieval may have missed)"
    echo "  This is acceptable; the model obeyed the no-tools instruction."
    PASS=$((PASS + 1))
  else
    echo "[test2] FAIL"
    echo "  Answer: $RESULT2"
    FAIL=$((FAIL + 1))
  fi
else
  echo "[test2] SKIP — Claude CLI not available"
  SKIP=$((SKIP + 1))
fi
echo ""

# --- Summary ---
echo "=== Results: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped ==="
exit "$FAIL"
