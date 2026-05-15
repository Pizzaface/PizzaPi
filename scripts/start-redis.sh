#!/usr/bin/env bash
# Start a Redis container for local PizzaPi development.
#
# Usage:
#   ./scripts/start-redis.sh
#
# Starts redis:7-alpine on port 6379. If the container already exists but
# is stopped, it restarts it.  If Redis is already running on 6379, this
# is a no-op.
#
# The server (bun run dev) defaults to redis://localhost:6379, so no env
# var configuration is needed.
#
# Stop with: ./scripts/stop-redis.sh

set -euo pipefail

CONTAINER_NAME="pizzapi-redis-dev"
REDIS_PORT="6379"

# ── Docker available? ─────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
    echo "❌ Docker is not installed or not in PATH."
    echo "   Install Docker from https://docs.docker.com/get-docker/"
    exit 1
fi

if ! docker info &>/dev/null; then
    echo "❌ Docker is not running. Start Docker Desktop (or dockerd) and retry."
    exit 1
fi

# ── Already running? ──────────────────────────────────────────────────────────
if docker inspect "$CONTAINER_NAME" --format '{{.State.Status}}' 2>/dev/null | grep -q 'running'; then
    echo "✅ Redis ($CONTAINER_NAME) is already running on port $REDIS_PORT."
    echo "   URL: redis://localhost:$REDIS_PORT"
    exit 0
fi

# ── Port already in use (reuse existing local Redis) ──────────────────────────
if lsof -i ":$REDIS_PORT" -sTCP:LISTEN &>/dev/null; then
    echo "✅ Port $REDIS_PORT is already in use by an existing local service."
    lsof -i ":$REDIS_PORT" -sTCP:LISTEN
    echo ""
    echo "   Reusing redis://localhost:$REDIS_PORT"
    exit 0
fi

# ── Container exists but stopped → restart ────────────────────────────────────
if docker inspect "$CONTAINER_NAME" &>/dev/null; then
    echo "🔄 Restarting existing Redis container ($CONTAINER_NAME)..."
    docker start "$CONTAINER_NAME"
else
    echo "🚀 Starting Redis container ($CONTAINER_NAME) on port $REDIS_PORT..."
    docker run -d \
        --name "$CONTAINER_NAME" \
        -p "$REDIS_PORT:6379" \
        --restart unless-stopped \
        redis:7-alpine \
        redis-server --save "" --appendonly no
fi

# ── Wait for Redis to accept connections ──────────────────────────────────────
echo -n "⏳ Waiting for Redis..."
for i in $(seq 1 30); do
    if docker exec "$CONTAINER_NAME" redis-cli ping 2>/dev/null | grep -q PONG; then
        echo " ready!"
        break
    fi
    sleep 0.5
    echo -n "."
done

# Verify it actually responds
if ! docker exec "$CONTAINER_NAME" redis-cli ping 2>/dev/null | grep -q PONG; then
    echo ""
    echo "❌ Redis failed to start within 15s. Check docker logs:"
    echo "   docker logs $CONTAINER_NAME"
    exit 1
fi

echo ""
echo "✅ Redis is ready!"
echo "   Container: $CONTAINER_NAME"
echo "   URL:       redis://localhost:$REDIS_PORT"
echo ""
echo "   Stop with: ./scripts/stop-redis.sh"
echo "   You can now run: bun run dev"
