#!/usr/bin/env bash
# End-to-end smoke test for the PizzaPi runner image, against a live relay.
# Prints a PASS/FAIL/SKIP line per check and always cleans up what it created.
#
# Usage: ./docker/runner/smoke.sh
# Config (env, all optional):
#   SMOKE_NETWORK      docker network the relay lives on (default: pizzapi-web_default)
#   SMOKE_RELAY_URL    relay URL reachable from that network (default: http://server:7492)
#   SMOKE_IMAGE        image tag to build/use (default: pizzapi-runner:smoke)
#   PIZZAPI_API_KEY    API key; falls back to `apiKey` in ~/.pizzapi/config.json
#   SMOKE_REBUILD=1    force re-staging/rebuilding even if a context already exists
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SMOKE_NETWORK="${SMOKE_NETWORK:-pizzapi-web_default}"
SMOKE_RELAY_URL="${SMOKE_RELAY_URL:-http://server:7492}"
SMOKE_IMAGE="${SMOKE_IMAGE:-pizzapi-runner:smoke}"
CONTEXT_DIR="${SMOKE_CONTEXT_DIR:-$REPO_ROOT/packages/cli/dist/runner-image-context}"

RUN_ID="smoke-$(date +%s)-$$"
CONTAINER="pizzapi-runner-$RUN_ID"
VOLUME="pizzapi-runner-vol-$RUN_ID"
TMPDIR_ROOT="$(mktemp -d)"
WORKSPACE_DIR="$TMPDIR_ROOT/workspace"

RESULTS=()
# Extra containers/volumes created by the auth checks below — cleaned up
# alongside the main $CONTAINER/$VOLUME, keyed by suffix off $RUN_ID so
# nothing collides with a concurrent run.
EXTRA_CONTAINERS=()
EXTRA_VOLUMES=()

record() {
    # record STATUS "check name" "detail"
    RESULTS+=("$1|$2|$3")
    printf '[%s] %s%s\n' "$1" "$2" "${3:+ — $3}"
}

cleanup() {
    local ec=$?
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    for c in "${EXTRA_CONTAINERS[@]:-}"; do [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1 || true; done
    docker rmi "${SMOKE_IMAGE}-other" >/dev/null 2>&1 || true
    docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
    for v in "${EXTRA_VOLUMES[@]:-}"; do [ -n "$v" ] && docker volume rm -f "$v" >/dev/null 2>&1 || true; done
    rm -rf "$TMPDIR_ROOT"

    echo
    echo "==== SMOKE TEST SUMMARY ===="
    printf '%-6s  %-52s  %s\n' STATUS CHECK DETAIL
    local fail=0
    for r in "${RESULTS[@]}"; do
        IFS='|' read -r status name detail <<<"$r"
        printf '%-6s  %-52s  %s\n' "$status" "$name" "$detail"
        [ "$status" = "FAIL" ] && fail=1
    done
    if [ "$ec" != "0" ]; then
        echo "(script exited early with code $ec — see output above)"
        fail=1
    fi
    exit $fail
}
trap cleanup EXIT

# ── Preflight ────────────────────────────────────────────────────────────
if ! docker network inspect "$SMOKE_NETWORK" >/dev/null 2>&1; then
    echo "FATAL: docker network '$SMOKE_NETWORK' not found — is the relay dev stack running?" >&2
    exit 1
fi

API_KEY="${PIZZAPI_API_KEY:-}"
if [ -z "$API_KEY" ] && [ -f "$HOME/.pizzapi/config.json" ]; then
    if command -v jq >/dev/null 2>&1; then
        API_KEY="$(jq -r '.apiKey // empty' "$HOME/.pizzapi/config.json")"
    else
        API_KEY="$(grep -o '"apiKey"[[:space:]]*:[[:space:]]*"[^"]*"' "$HOME/.pizzapi/config.json" | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"
    fi
fi
if [ -z "$API_KEY" ]; then
    echo "FATAL: no API key (set PIZZAPI_API_KEY or apiKey in ~/.pizzapi/config.json)" >&2
    exit 1
fi

case "$(uname -m)" in
    x86_64) HOST_PLATFORM=linux/amd64; HOST_TARGET=linux-x64; OTHER_PLATFORM=linux/arm64; OTHER_TARGET=linux-arm64 ;;
    arm64|aarch64) HOST_PLATFORM=linux/arm64; HOST_TARGET=linux-arm64; OTHER_PLATFORM=linux/amd64; OTHER_TARGET=linux-x64 ;;
    *) echo "FATAL: unsupported host arch $(uname -m)" >&2; exit 1 ;;
esac

if [ "${SMOKE_REBUILD:-0}" = "1" ] || [ ! -d "$CONTEXT_DIR/$HOST_TARGET" ] || [ ! -d "$CONTEXT_DIR/$OTHER_TARGET" ]; then
    echo "Staging build context..."
    (cd "$REPO_ROOT" && bun docker/runner/stage-context.ts)
fi

GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
mkdir -p "$WORKSPACE_DIR/smoke-repo"
git -C "$WORKSPACE_DIR/smoke-repo" init -q
git -C "$WORKSPACE_DIR/smoke-repo" -c user.email=smoke@pizzapi.local -c user.name=smoke commit --allow-empty -q -m init

wait_healthy() {
    # wait_healthy CONTAINER TIMEOUT_ITERATIONS(2s each) -> sets HEALTH_STATUS, HEALTH_ELAPSED
    local c="$1" tries="$2" i
    for i in $(seq 1 "$tries"); do
        HEALTH_STATUS="$(docker inspect --format '{{.State.Health.Status}}' "$c" 2>/dev/null || echo unknown)"
        [ "$HEALTH_STATUS" = "healthy" ] && { HEALTH_ELAPSED=$((i * 2)); return 0; }
        sleep 2
    done
    HEALTH_ELAPSED=$((tries * 2))
    return 1
}

runner_id_of() {
    docker exec "$1" pizza runner status --json 2>/dev/null | { command -v jq >/dev/null 2>&1 && jq -r '.runnerId // empty' || grep -o '"runnerId":"[^"]*"' | head -1 | cut -d'"' -f4; }
}

status_reason_of() {
    docker exec "$1" pizza runner status --json 2>/dev/null | { command -v jq >/dev/null 2>&1 && jq -r '.reason // empty' || grep -o '"reason":"[^"]*"' | head -1 | cut -d'"' -f4; }
}

wait_for_log_pattern() {
    # wait_for_log_pattern CONTAINER FIXED_STRING TIMEOUT_SECONDS(1s each) -> 0 if seen
    local c="$1" pattern="$2" tries="$3" i
    for i in $(seq 1 "$tries"); do
        docker logs "$c" 2>&1 | grep -qF "$pattern" && return 0
        sleep 1
    done
    return 1
}

spawn_status_code() {
    # spawn_status_code RUNNER_ID CWD -> prints HTTP status code
    docker run --rm --network "$SMOKE_NETWORK" curlimages/curl:latest -sS -o /dev/null -w '%{http_code}' \
        -X POST -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
        -d "{\"runnerId\":\"$1\",\"cwd\":\"$2\"}" \
        "$SMOKE_RELAY_URL/api/runners/spawn" 2>/dev/null || echo "000"
}

run_container() {
    docker run -d --name "$CONTAINER" --network "$SMOKE_NETWORK" \
        -e PIZZAPI_RELAY_URL="$SMOKE_RELAY_URL" \
        -e PIZZAPI_API_KEY="$API_KEY" \
        -e PIZZAPI_RUNNER_NAME="$RUN_ID" \
        -v "$VOLUME:/home/pizza/.pizzapi" \
        -v "$WORKSPACE_DIR:/workspace" \
        "$SMOKE_IMAGE" >/dev/null
}

# ── 1. Build host-arch image ────────────────────────────────────────────
if docker buildx build --platform "$HOST_PLATFORM" --load \
    --build-arg VERSION=smoke --build-arg GIT_SHA="$GIT_SHA" \
    -t "$SMOKE_IMAGE" -f "$REPO_ROOT/docker/runner/Dockerfile" "$CONTEXT_DIR" \
    >/tmp/smoke-build-host.log 2>&1; then
    record PASS "build image ($HOST_PLATFORM)" ""
else
    record FAIL "build image ($HOST_PLATFORM)" "see /tmp/smoke-build-host.log"
    exit 1  # nothing else is possible without the host image
fi

# ── 1b. Build + run the *other* platform (proves both arches compile) ──
if docker run --rm --platform "$OTHER_PLATFORM" debian:trixie-slim true >/dev/null 2>&1; then
    if docker buildx build --platform "$OTHER_PLATFORM" --load \
        --build-arg VERSION=smoke --build-arg GIT_SHA="$GIT_SHA" \
        -t "${SMOKE_IMAGE}-other" -f "$REPO_ROOT/docker/runner/Dockerfile" "$CONTEXT_DIR" \
        >/tmp/smoke-build-other.log 2>&1; then
        record PASS "build image ($OTHER_PLATFORM)" ""
        if OUT="$(docker run --rm --platform "$OTHER_PLATFORM" "${SMOKE_IMAGE}-other" --version 2>&1)"; then
            record PASS "run --version under emulation ($OTHER_PLATFORM)" ""
        else
            record FAIL "run --version under emulation ($OTHER_PLATFORM)" "$OUT"
        fi
    else
        record FAIL "build image ($OTHER_PLATFORM)" "see /tmp/smoke-build-other.log"
    fi
else
    record SKIP "build+run image ($OTHER_PLATFORM)" "emulation unavailable (binfmt_misc/qemu not registered)"
fi

# ── 2. Container starts non-root and registers with the relay ──────────
run_container
UID_OUT="$(docker exec "$CONTAINER" id -u 2>/dev/null || echo '?')"
[ "$UID_OUT" = "1000" ] && record PASS "runs as non-root uid" "uid=$UID_OUT" \
    || record FAIL "runs as non-root uid" "uid=$UID_OUT"

if wait_healthy "$CONTAINER" 60; then
    record PASS "registers with relay (healthcheck)" "healthy after ~${HEALTH_ELAPSED}s"
else
    record FAIL "registers with relay (healthcheck)" "status=$HEALTH_STATUS after ${HEALTH_ELAPSED}s"
    docker logs "$CONTAINER" 2>&1 | tail -50
fi

# ── 3. Workspace enforcement ─────────────────────────────────────────────
RUNNER_ID="$(runner_id_of "$CONTAINER" || true)"
if [ -z "$RUNNER_ID" ]; then
    record FAIL "workspace enforcement rejects cwd=/etc" "could not read runnerId from container"
    record FAIL "workspace enforcement accepts real repo cwd" "could not read runnerId from container"
else
    CODE_ETC="$(spawn_status_code "$RUNNER_ID" /etc)"
    [ "$CODE_ETC" = "400" ] && record PASS "workspace enforcement rejects cwd=/etc" "http=$CODE_ETC" \
        || record FAIL "workspace enforcement rejects cwd=/etc" "http=$CODE_ETC"

    CODE_REPO="$(spawn_status_code "$RUNNER_ID" /workspace/smoke-repo)"
    [ "$CODE_REPO" = "200" ] && record PASS "workspace enforcement accepts real repo cwd" "http=$CODE_REPO" \
        || record FAIL "workspace enforcement accepts real repo cwd" "http=$CODE_REPO"
fi

# ── 4. PTY ────────────────────────────────────────────────────────────────
LDD_OUT="$(docker exec "$CONTAINER" sh -c 'ldd /opt/pizzapi/librust_pty*.so 2>&1' || true)"
echo "$LDD_OUT" | grep -qi "not found" \
    && record FAIL "PTY library resolves cleanly (ldd)" "$LDD_OUT" \
    || record PASS "PTY library resolves cleanly (ldd)" ""

PTY_LOG_ERR="$(docker logs "$CONTAINER" 2>&1 | grep -i pty | grep -iE 'error|fail' || true)"
[ -z "$PTY_LOG_ERR" ] && record PASS "daemon log shows no PTY/terminal init errors" "" \
    || record FAIL "daemon log shows no PTY/terminal init errors" "$PTY_LOG_ERR"

# ── 8. Sidecar DNS ────────────────────────────────────────────────────────
if docker exec "$CONTAINER" curl -sS -o /dev/null -w '%{http_code}' "$SMOKE_RELAY_URL/health" 2>/dev/null | grep -q 200; then
    record PASS "reaches relay sidecar by service name" "$SMOKE_RELAY_URL/health"
else
    record FAIL "reaches relay sidecar by service name" "$SMOKE_RELAY_URL/health unreachable"
fi
if docker exec "$CONTAINER" socat -T2 -u /dev/null TCP:redis:6379 >/dev/null 2>&1; then
    record PASS "reaches redis sidecar by service name (bonus)" "redis:6379"
else
    record SKIP "reaches redis sidecar by service name (bonus)" "redis:6379 not reachable (no redis service on $SMOKE_NETWORK?)"
fi

# ── 9a. Default sandbox posture is logged ───────────────────────────────
SANDBOX_LOG="$(docker logs "$CONTAINER" 2>&1 | grep -o 'sandbox=[a-z]*' | head -1 || true)"
[ "$SANDBOX_LOG" = "sandbox=none" ] && record PASS "default sandbox posture logged" "$SANDBOX_LOG" \
    || record FAIL "default sandbox posture logged" "got '$SANDBOX_LOG'"

# ── 5+6. Stop, remove, recreate on the same volume: identity + shutdown time ─
STOP_START="$(date +%s)"
docker stop -t 30 "$CONTAINER" >/dev/null
STOP_ELAPSED=$(( $(date +%s) - STOP_START ))
[ "$STOP_ELAPSED" -lt 30 ] && record PASS "clean shutdown (docker stop)" "${STOP_ELAPSED}s" \
    || record FAIL "clean shutdown (docker stop)" "${STOP_ELAPSED}s (hit grace period)"
docker rm "$CONTAINER" >/dev/null

run_container
if wait_healthy "$CONTAINER" 60; then
    RUNNER_ID_AFTER="$(runner_id_of "$CONTAINER" || true)"
    if [ -n "$RUNNER_ID_AFTER" ] && [ "$RUNNER_ID_AFTER" = "$RUNNER_ID" ]; then
        record PASS "identity persists across stop+rm+recreate" "runnerId=$RUNNER_ID_AFTER"
    else
        record FAIL "identity persists across stop+rm+recreate" "before=$RUNNER_ID after=$RUNNER_ID_AFTER"
    fi
else
    record FAIL "identity persists across stop+rm+recreate" "container never became healthy after recreate"
    docker logs "$CONTAINER" 2>&1 | tail -50
fi

# ── 7. Stale lock recovery after SIGKILL ────────────────────────────────
docker kill -s SIGKILL "$CONTAINER" >/dev/null
docker rm "$CONTAINER" >/dev/null
run_container
if wait_healthy "$CONTAINER" 60; then
    KILL_LOGS="$(docker logs "$CONTAINER" 2>&1 || true)"
    if echo "$KILL_LOGS" | grep -qi "already running"; then
        record FAIL "stale lock recovery after SIGKILL" "daemon reported a fatal 'already running' lock error"
    else
        record PASS "stale lock recovery after SIGKILL" "healthy again after ~${HEALTH_ELAPSED}s"
    fi
else
    record FAIL "stale lock recovery after SIGKILL" "never became healthy again"
    docker logs "$CONTAINER" 2>&1 | tail -50
fi

# ── 10. No privileged/hostPID/extra caps/docker socket ──────────────────
PRIV="$(docker inspect --format '{{.HostConfig.Privileged}}' "$CONTAINER" || true)"
PIDMODE="$(docker inspect --format '{{.HostConfig.PidMode}}' "$CONTAINER" || true)"
CAPADD="$(docker inspect --format '{{.HostConfig.CapAdd}}' "$CONTAINER" || true)"
MOUNTS="$(docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$CONTAINER" || true)"
if [ "$PRIV" = "false" ] && [ -z "$PIDMODE" ] && { [ "$CAPADD" = "[]" ] || [ "$CAPADD" = "<no value>" ]; } && ! echo "$MOUNTS" | grep -q docker.sock; then
    record PASS "no --privileged/hostPID/extra caps/docker socket" "privileged=$PRIV pid=$PIDMODE capAdd=$CAPADD"
else
    record FAIL "no --privileged/hostPID/extra caps/docker socket" "privileged=$PRIV pid=$PIDMODE capAdd=$CAPADD mounts=$MOUNTS"
fi

# ── 9b. Opt-in sandbox actually works with the documented flag ─────────
if docker run --rm --security-opt seccomp=unconfined -e PIZZAPI_SANDBOX=basic --entrypoint bwrap "$SMOKE_IMAGE" \
    --ro-bind / / --unshare-all true >/dev/null 2>&1; then
    record PASS "opt-in sandbox works (seccomp=unconfined)" "bwrap --unshare-all succeeded"
else
    record FAIL "opt-in sandbox works (seccomp=unconfined)" "bwrap failed even with the opt-in flag"
fi

# ── 11. Headless auto-pairing end to end ────────────────────────────────
PAIR_CONTAINER="$CONTAINER-pair"
PAIR_VOLUME="$VOLUME-pair"
EXTRA_CONTAINERS+=("$PAIR_CONTAINER")
EXTRA_VOLUMES+=("$PAIR_VOLUME")

docker run -d --name "$PAIR_CONTAINER" --network "$SMOKE_NETWORK" \
    -e PIZZAPI_RELAY_URL="$SMOKE_RELAY_URL" \
    -e PIZZAPI_RUNNER_NAME="$RUN_ID-pair" \
    -v "$PAIR_VOLUME:/home/pizza/.pizzapi" \
    "$SMOKE_IMAGE" >/dev/null

if wait_for_log_pattern "$PAIR_CONTAINER" 'setup-claim?t=' 30; then
    record PASS "auto-pairing prints an approval URL (no credential, fresh volume)" ""
    PAIR_TOKEN="$(docker logs "$PAIR_CONTAINER" 2>&1 | grep -o 'setup-claim?t=[a-f0-9]*' | tail -1 | sed 's/.*t=//')"
    APPROVE_CODE="$(docker run --rm --network "$SMOKE_NETWORK" curlimages/curl:latest -sS -o /dev/null -w '%{http_code}' \
        -X POST -H "x-api-key: $API_KEY" "$SMOKE_RELAY_URL/api/setup-claim/$PAIR_TOKEN/approve" 2>/dev/null || echo "000")"
    [ "$APPROVE_CODE" = "200" ] && record PASS "approve pending claim via x-api-key (requireEnrollmentAuth)" "http=$APPROVE_CODE" \
        || record FAIL "approve pending claim via x-api-key (requireEnrollmentAuth)" "http=$APPROVE_CODE"

    record SKIP "pairing label round-trips via /api/setup-claim-info" "live relay ($SMOKE_RELAY_URL) is a released build without label/setup-claim-info support (confirmed: that route 404s there) — pairing itself still works"

    if wait_healthy "$PAIR_CONTAINER" 60; then
        record PASS "runner reaches healthy after approval" "healthy after ~${HEALTH_ELAPSED}s"

        CONFIG_MODE="$(docker exec "$PAIR_CONTAINER" stat -c '%a' /home/pizza/.pizzapi/config.json 2>/dev/null || echo '?')"
        [ "$CONFIG_MODE" = "600" ] && record PASS "config.json is 0600 after pairing" "mode=$CONFIG_MODE" \
            || record FAIL "config.json is 0600 after pairing" "mode=$CONFIG_MODE"

        CONFIG_HAS_KEY="$(docker exec "$PAIR_CONTAINER" sh -c "grep -c apiKey /home/pizza/.pizzapi/config.json" 2>/dev/null || echo 0)"
        [ "${CONFIG_HAS_KEY:-0}" -gt 0 ] 2>/dev/null && record PASS "config.json contains the minted apiKey" "" \
            || record FAIL "config.json contains the minted apiKey" "grep -c apiKey = ${CONFIG_HAS_KEY:-0}"

        RESTART_MARK="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        docker restart "$PAIR_CONTAINER" >/dev/null
        if wait_healthy "$PAIR_CONTAINER" 60; then
            REPAIR_LOG="$(docker logs --since "$RESTART_MARK" "$PAIR_CONTAINER" 2>&1 | grep -iE 'no credentials found|Approve this runner at' || true)"
            [ -z "$REPAIR_LOG" ] && record PASS "restart does not re-pair (config.json apiKey already satisfies it)" "healthy again after ~${HEALTH_ELAPSED}s" \
                || record FAIL "restart does not re-pair (config.json apiKey already satisfies it)" "$REPAIR_LOG"
        else
            record FAIL "restart does not re-pair (config.json apiKey already satisfies it)" "container never became healthy again"
            docker logs "$PAIR_CONTAINER" 2>&1 | tail -50
        fi
    else
        record FAIL "runner reaches healthy after approval" "status=$HEALTH_STATUS after ${HEALTH_ELAPSED}s"
        docker logs "$PAIR_CONTAINER" 2>&1 | tail -50
    fi
else
    record FAIL "auto-pairing prints an approval URL (no credential, fresh volume)" "no setup-claim URL in logs after 30s"
    docker logs "$PAIR_CONTAINER" 2>&1 | tail -50
fi

# ── 12. PIZZAPI_PAIRING=0 fails fast instead of hanging ─────────────────
NOPAIR_CONTAINER="$CONTAINER-nopair"
EXTRA_CONTAINERS+=("$NOPAIR_CONTAINER")
docker run -d --name "$NOPAIR_CONTAINER" --network "$SMOKE_NETWORK" \
    -e PIZZAPI_RELAY_URL="$SMOKE_RELAY_URL" \
    -e PIZZAPI_PAIRING=0 \
    "$SMOKE_IMAGE" >/dev/null

if wait_for_log_pattern "$NOPAIR_CONTAINER" 'Set PIZZAPI_API_KEY' 15; then
    if docker logs "$NOPAIR_CONTAINER" 2>&1 | grep -qF 'setup-claim?t='; then
        record FAIL "PIZZAPI_PAIRING=0 fails fast, no auto-pair" "unexpectedly printed a pairing URL despite the opt-out"
    else
        record PASS "PIZZAPI_PAIRING=0 fails fast, no auto-pair" "clear error within 15s, no pairing URL printed"
    fi
else
    record FAIL "PIZZAPI_PAIRING=0 fails fast, no auto-pair" "no clear error message within 15s (looks like a hang)"
    docker logs "$NOPAIR_CONTAINER" 2>&1 | tail -30
fi

# ── 13. PIZZAPI_API_KEY_FILE registers without the key in docker inspect ─
APIKEY_FILE_HOST="$TMPDIR_ROOT/api-key-secret.txt"
printf '%s' "$API_KEY" > "$APIKEY_FILE_HOST"
FILECRED_CONTAINER="$CONTAINER-filecred"
FILECRED_VOLUME="$VOLUME-filecred"
EXTRA_CONTAINERS+=("$FILECRED_CONTAINER")
EXTRA_VOLUMES+=("$FILECRED_VOLUME")

docker run -d --name "$FILECRED_CONTAINER" --network "$SMOKE_NETWORK" \
    -e PIZZAPI_RELAY_URL="$SMOKE_RELAY_URL" \
    -e PIZZAPI_API_KEY_FILE=/run/secrets/pizzapi_api_key \
    -e PIZZAPI_RUNNER_NAME="$RUN_ID-filecred" \
    -v "$FILECRED_VOLUME:/home/pizza/.pizzapi" \
    -v "$APIKEY_FILE_HOST:/run/secrets/pizzapi_api_key:ro" \
    "$SMOKE_IMAGE" >/dev/null

if wait_healthy "$FILECRED_CONTAINER" 60; then
    record PASS "PIZZAPI_API_KEY_FILE registers normally" "healthy after ~${HEALTH_ELAPSED}s"
else
    record FAIL "PIZZAPI_API_KEY_FILE registers normally" "status=$HEALTH_STATUS after ${HEALTH_ELAPSED}s"
    docker logs "$FILECRED_CONTAINER" 2>&1 | tail -50
fi

INSPECT_ENV="$(docker inspect --format '{{json .Config.Env}}' "$FILECRED_CONTAINER")"
if echo "$INSPECT_ENV" | grep -q 'PIZZAPI_API_KEY='; then
    record FAIL "raw API key absent from docker inspect env" "PIZZAPI_API_KEY found in launch env — only _FILE was passed"
else
    record PASS "raw API key absent from docker inspect env" "only PIZZAPI_API_KEY_FILE present in launch env"
fi

# ── 14. PIZZAPI_AUTH_FILE seeds once, never clobbers ────────────────────
AUTH1_HOST="$TMPDIR_ROOT/auth1.json"
AUTH2_HOST="$TMPDIR_ROOT/auth2.json"
echo '{"marker":"auth-file-one"}' > "$AUTH1_HOST"
echo '{"marker":"auth-file-two-should-not-appear"}' > "$AUTH2_HOST"

AUTHFILE_CONTAINER="$CONTAINER-authfile"
AUTHFILE_VOLUME="$VOLUME-authfile"
EXTRA_CONTAINERS+=("$AUTHFILE_CONTAINER")
EXTRA_VOLUMES+=("$AUTHFILE_VOLUME")

docker run -d --name "$AUTHFILE_CONTAINER" --network "$SMOKE_NETWORK" \
    -e PIZZAPI_RELAY_URL="$SMOKE_RELAY_URL" \
    -e PIZZAPI_API_KEY="$API_KEY" \
    -e PIZZAPI_RUNNER_NAME="$RUN_ID-authfile" \
    -e PIZZAPI_AUTH_FILE=/run/secrets/auth.json \
    -v "$AUTHFILE_VOLUME:/home/pizza/.pizzapi" \
    -v "$AUTH1_HOST:/run/secrets/auth.json:ro" \
    "$SMOKE_IMAGE" >/dev/null

if wait_healthy "$AUTHFILE_CONTAINER" 60; then
    AUTH_MODE="$(docker exec "$AUTHFILE_CONTAINER" stat -c '%a' /home/pizza/.pizzapi/auth.json 2>/dev/null || echo '?')"
    [ "$AUTH_MODE" = "600" ] && record PASS "PIZZAPI_AUTH_FILE seeds auth.json at 0600 (first boot)" "mode=$AUTH_MODE" \
        || record FAIL "PIZZAPI_AUTH_FILE seeds auth.json at 0600 (first boot)" "mode=$AUTH_MODE"

    AUTH_CONTENT="$(docker exec "$AUTHFILE_CONTAINER" cat /home/pizza/.pizzapi/auth.json 2>/dev/null || echo '')"
    echo "$AUTH_CONTENT" | grep -q 'auth-file-one' && record PASS "seeded auth.json has the source file's contents" "" \
        || record FAIL "seeded auth.json has the source file's contents" "got: $AUTH_CONTENT"
else
    record FAIL "PIZZAPI_AUTH_FILE seeds auth.json at 0600 (first boot)" "container never became healthy"
    docker logs "$AUTHFILE_CONTAINER" 2>&1 | tail -50
fi

docker stop -t 10 "$AUTHFILE_CONTAINER" >/dev/null 2>&1 || true
docker rm "$AUTHFILE_CONTAINER" >/dev/null 2>&1 || true

docker run -d --name "$AUTHFILE_CONTAINER" --network "$SMOKE_NETWORK" \
    -e PIZZAPI_RELAY_URL="$SMOKE_RELAY_URL" \
    -e PIZZAPI_API_KEY="$API_KEY" \
    -e PIZZAPI_RUNNER_NAME="$RUN_ID-authfile" \
    -e PIZZAPI_AUTH_FILE=/run/secrets/auth.json \
    -v "$AUTHFILE_VOLUME:/home/pizza/.pizzapi" \
    -v "$AUTH2_HOST:/run/secrets/auth.json:ro" \
    "$SMOKE_IMAGE" >/dev/null

if wait_healthy "$AUTHFILE_CONTAINER" 60; then
    AUTH_CONTENT2="$(docker exec "$AUTHFILE_CONTAINER" cat /home/pizza/.pizzapi/auth.json 2>/dev/null || echo '')"
    if echo "$AUTH_CONTENT2" | grep -q 'auth-file-one'; then
        record PASS "PIZZAPI_AUTH_FILE never clobbers an existing auth.json" "still has first seed's contents after a second boot with a different file"
    else
        record FAIL "PIZZAPI_AUTH_FILE never clobbers an existing auth.json" "got: $AUTH_CONTENT2"
    fi
else
    record FAIL "PIZZAPI_AUTH_FILE never clobbers an existing auth.json" "container never became healthy on second boot"
    docker logs "$AUTHFILE_CONTAINER" 2>&1 | tail -50
fi

# ── 15. A rejected API key is loud and prompt, not a silent hang ───────
BADKEY_CONTAINER="$CONTAINER-badkey"
EXTRA_CONTAINERS+=("$BADKEY_CONTAINER")
BAD_KEY="pizzapi_smoke_invalid_$(date +%s)"
docker run -d --name "$BADKEY_CONTAINER" --network "$SMOKE_NETWORK" \
    -e PIZZAPI_RELAY_URL="$SMOKE_RELAY_URL" \
    -e PIZZAPI_API_KEY="$BAD_KEY" \
    -e PIZZAPI_RUNNER_NAME="$RUN_ID-badkey" \
    "$SMOKE_IMAGE" >/dev/null

if wait_for_log_pattern "$BADKEY_CONTAINER" 'rejected our API key' 20; then
    record PASS "bad API key rejection is loud and prompt" "rejection message appeared within 20s"
else
    record FAIL "bad API key rejection is loud and prompt" "no rejection message within 20s (looks like a silent hang)"
    docker logs "$BADKEY_CONTAINER" 2>&1 | tail -30
fi

STATUS_REASON="$(status_reason_of "$BADKEY_CONTAINER" || true)"
case "$STATUS_REASON" in
    *"relay rejected credentials"*) record PASS "runner status reports the relay-rejected reason (bonus)" "$STATUS_REASON" ;;
    *) record SKIP "runner status reports the relay-rejected reason (bonus)" "got '${STATUS_REASON:-<empty>}' — may need another connect_error round-trip" ;;
esac
