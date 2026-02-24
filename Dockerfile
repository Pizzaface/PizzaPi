FROM oven/bun:1 AS builder
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
        workspaces: ["packages/protocol","packages/tools","packages/server","packages/ui"], \
        patchedDependencies: f.patchedDependencies \
    }; \
    await Bun.write("/app/package.json", JSON.stringify(slim, null, 2));'

COPY packages/protocol/package.json packages/protocol/
COPY packages/tools/package.json packages/tools/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/

# --ignore-scripts skips native builds (better-sqlite3 from @better-auth/cli)
# that aren't needed at runtime since the server uses bun:sqlite.
# Can't use --frozen-lockfile since we trimmed the workspace list.
RUN bun install --ignore-scripts

# Copy source for needed packages only
COPY tsconfig.base.json ./
COPY packages/protocol/ packages/protocol/
COPY packages/tools/ packages/tools/
COPY packages/server/ packages/server/
COPY packages/ui/ packages/ui/

# Copy root tsconfig for project references
COPY tsconfig.json ./

# Build with tsc --build to resolve project references, then build UI
RUN bunx tsc --build packages/server/tsconfig.json \
    && cd /app/packages/ui && bun run build

# --- Production image ---
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder /app/packages/protocol/package.json ./packages/protocol/
COPY --from=builder /app/packages/tools/dist ./packages/tools/dist
COPY --from=builder /app/packages/tools/package.json ./packages/tools/
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/
COPY --from=builder /app/packages/ui/dist ./packages/ui/dist
COPY --from=builder /app/package.json ./

ENV PIZZAPI_UI_DIR=/app/packages/ui/dist
ENV AUTH_DB_PATH=/app/data/auth.db

EXPOSE 3000
CMD ["bun", "run", "packages/server/dist/index.js"]
