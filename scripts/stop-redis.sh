#!/usr/bin/env bash
# Stop the dev Redis container started by start-redis.sh.
#
# Usage:
#   ./scripts/stop-redis.sh

set -euo pipefail

CONTAINER_NAME="pizzapi-redis-dev"

if ! docker inspect "$CONTAINER_NAME" &>/dev/null; then
    echo "📭 No Redis container ($CONTAINER_NAME) found. Nothing to stop."
    exit 0
fi

STATUS=$(docker inspect "$CONTAINER_NAME" --format '{{.State.Status}}' 2>/dev/null)

if [ "$STATUS" != "running" ]; then
    echo "📭 Redis container ($CONTAINER_NAME) is not running (status: $STATUS)."
    echo "   Remove with: docker rm $CONTAINER_NAME"
    exit 0
fi

echo "🛑 Stopping Redis container ($CONTAINER_NAME)..."
docker stop "$CONTAINER_NAME"
echo "✅ Redis stopped."
echo "   Remove completely with: docker rm $CONTAINER_NAME"
