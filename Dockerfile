# syntax=docker/dockerfile:1

# ── Shared dependency layer ──────────────────────────────────────────────────
# Installs node_modules and copies configs shared by both build stages.
# The docker/compose.yml dev profile targets this stage (target: builder).
FROM oven/bun:1.3.10 AS builder
WORKDIR /app

# Copy patches and lockfile first for layer caching
COPY patches/ patches/
COPY bun.lock* ./
COPY package.json /tmp/full-package.json

# Only declare the workspaces needed for the web hub.
# Preserves patchedDependencies from the real package.json.
RUN cat /tmp/full-package.json | bun -e ' \
    const f = JSON.parse(await Bun.stdin.text()); \
    const slim = { \
        name: f.name, version: f.version, \
        workspaces: ["packages/protocol","packages/tunnel","packages/tools","packages/server","packages/ui"], \
        devDependencies: { typescript: f.devDependencies?.typescript ?? "^5.7.0" }, \
        patchedDependencies: f.patchedDependencies \
    }; \
    await Bun.write("/app/package.json", JSON.stringify(slim, null, 2));'

COPY packages/protocol/package.json packages/protocol/
COPY packages/tunnel/package.json packages/tunnel/
COPY packages/tools/package.json packages/tools/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/

# --ignore-scripts skips native builds (better-sqlite3 from @better-auth/cli)
# that aren't needed at runtime since the server uses bun:sqlite.
# Can't use --frozen-lockfile since we trimmed the workspace list.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --ignore-scripts

# Root tsconfigs needed by tsc --build project references
COPY tsconfig.base.json tsconfig.json ./

# Protocol source is shared by both server (tsc reference) and UI (bundled dep)
COPY packages/protocol/ packages/protocol/

# ── Build server (runs in parallel with build-ui) ───────────────────────────
# tsc --build follows project references: protocol → tools → server
FROM builder AS build-server
COPY packages/tunnel/ packages/tunnel/
COPY packages/tools/ packages/tools/
COPY packages/server/ packages/server/
RUN node_modules/typescript/bin/tsc --build packages/server/tsconfig.json

# ── Build UI ─────────────────────────────────────────────────────────────────
# When PREBUILT_UI=true (default), `pizza web` builds the UI on the host first
# (native speed, ~15s) and the Dockerfile just copies the dist from context.
# Set PREBUILT_UI=false to build inside Docker (slow on Docker Desktop VMs).
#
# UI_DIST_HASH is a cache-buster: `pizza web` sets it to a content hash of the
# pre-built dist/ so BuildKit invalidates the COPY layer when the dist changes.
# Without this, BuildKit can serve a stale build-ui stage from its layer cache
# even though the host dist/ has new content.
ARG PREBUILT_UI=false
ARG UI_DIST_HASH=none
ARG PIZZAPI_DEBUG_VIEW=0
FROM builder AS build-ui
ARG PREBUILT_UI
ARG UI_DIST_HASH
ARG PIZZAPI_DEBUG_VIEW
ENV PIZZAPI_DEBUG_VIEW=$PIZZAPI_DEBUG_VIEW
COPY packages/tools/ packages/tools/
COPY packages/ui/ packages/ui/
RUN echo "ui-dist-hash: $UI_DIST_HASH" \
    && echo "pizzapi-debug-view: $PIZZAPI_DEBUG_VIEW" \
    && if [ "$PREBUILT_UI" = "true" ] && [ -d packages/ui/dist ]; then \
        echo "Using pre-built UI dist from host"; \
    else \
        node_modules/typescript/bin/tsc --build packages/protocol/tsconfig.json \
        && node_modules/typescript/bin/tsc --build packages/tools/tsconfig.json \
        && cd packages/ui && bun run build; \
    fi

# ── Production image ─────────────────────────────────────────────────────────
FROM oven/bun:1.3.10-slim AS runtime-base
WORKDIR /app

COPY --from=build-server /app/node_modules ./node_modules
COPY --from=build-server /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build-server /app/packages/protocol/package.json ./packages/protocol/
COPY --from=build-server /app/packages/tunnel/dist ./packages/tunnel/dist
COPY --from=build-server /app/packages/tunnel/package.json ./packages/tunnel/
COPY --from=build-server /app/packages/tools/dist ./packages/tools/dist
COPY --from=build-server /app/packages/tools/package.json ./packages/tools/
COPY --from=build-server /app/packages/tools/node_modules ./packages/tools/node_modules
COPY --from=build-server /app/packages/server/dist ./packages/server/dist
COPY --from=build-server /app/packages/server/package.json ./packages/server/
COPY --from=build-server /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=build-server /app/package.json ./

ENV AUTH_DB_PATH=/app/data/auth.db

EXPOSE 7492
CMD ["bun", "run", "packages/server/dist/index.js"]

FROM runtime-base AS runtime
COPY --from=build-ui /app/packages/ui/dist ./packages/ui/dist
ENV PIZZAPI_UI_DIR=/app/packages/ui/dist

FROM runtime-base AS runtime-no-ui
RUN mkdir -p /app/packages/ui/dist
ENV PIZZAPI_UI_DIR=/app/packages/ui/dist
