#!/usr/bin/env bash
# run-spike.sh — Start servers, run Bun client tests, print summary
# Usage: bash spike/socketio/run-spike.sh [--keep-servers]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/packages/server"

KEEP_SERVERS=${1:-""}
LOG_DIR="/tmp/socketio-spike"
mkdir -p "$LOG_DIR"

cleanup() {
  echo ""
  echo "🧹 Cleaning up servers..."
  [[ -n "${S1_PID:-}" ]] && kill "$S1_PID" 2>/dev/null || true
  [[ -n "${S2_PID:-}" ]] && kill "$S2_PID" 2>/dev/null || true
  echo "Done."
}
[[ "$KEEP_SERVERS" != "--keep-servers" ]] && trap cleanup EXIT

echo "══════════════════════════════════════════════════"
echo " PizzaPi Socket.IO Spike Runner"
echo "══════════════════════════════════════════════════"
echo ""

# ── Prereqs ──────────────────────────────────────────────────────────────────
if ! command -v bun &>/dev/null; then
  echo "❌ bun not found"; exit 1
fi

if ! redis-cli ping &>/dev/null; then
  echo "⚠️  Redis not responding on localhost:6379."
  echo "   Cross-server fan-out tests will fail."
  echo "   Start Redis with: redis-server"
  echo "   Continuing anyway (single-server tests will still run)..."
  echo ""
fi

# ── Start servers ─────────────────────────────────────────────────────────────
echo "▶ Starting server1 (port 3100)..."
PORT=3100 bun spike/server.ts > "$LOG_DIR/server1.log" 2>&1 &
S1_PID=$!

echo "▶ Starting server2 (port 3101)..."
PORT=3101 bun spike/server2.ts > "$LOG_DIR/server2.log" 2>&1 &
S2_PID=$!

echo "  Waiting for servers to boot..."
sleep 2

# Verify servers are up
if ! curl -sf http://localhost:3100/socket.io/socket.io.js -o /dev/null; then
  echo "❌ server1 not responding. Logs:"
  cat "$LOG_DIR/server1.log"
  exit 1
fi
if ! curl -sf http://localhost:3101/socket.io/socket.io.js -o /dev/null; then
  echo "❌ server2 not responding. Logs:"
  cat "$LOG_DIR/server2.log"
  exit 1
fi
echo "  ✅ Both servers up"
echo ""

# ── Run Bun client tests ──────────────────────────────────────────────────────
echo "▶ Running Bun client tests..."
echo ""
set +e
bun spike/client-bun.ts 2>&1 | tee "$LOG_DIR/client.log"
CLIENT_EXIT=${PIPESTATUS[0]}
set -e
echo ""

# ── Server logs ───────────────────────────────────────────────────────────────
echo "══ Server1 logs ══════════════════════════════════"
cat "$LOG_DIR/server1.log"
echo ""
echo "══ Server2 logs ══════════════════════════════════"
cat "$LOG_DIR/server2.log"
echo ""

# ── Browser test reminder ─────────────────────────────────────────────────────
echo "══ Browser test ══════════════════════════════════"
echo "  Open packages/server/spike/client-browser.html in a browser"
echo "  (servers must still be running; use --keep-servers)"
echo ""

# ── Result ────────────────────────────────────────────────────────────────────
echo "══════════════════════════════════════════════════"
if [[ "$CLIENT_EXIT" -eq 0 ]]; then
  echo "  🎉 All automated tests PASSED"
else
  echo "  ⚠️  Some tests FAILED (exit code $CLIENT_EXIT)"
fi
echo "  Logs: $LOG_DIR/"
echo "══════════════════════════════════════════════════"

exit $CLIENT_EXIT
