FROM oven/bun:1 AS builder
WORKDIR /app

# Copy workspace config for layer caching
COPY package.json bun.lock* ./
COPY patches/ patches/
COPY packages/protocol/package.json packages/protocol/
COPY packages/tools/package.json packages/tools/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/
COPY packages/cli/package.json packages/cli/
COPY packages/docs/package.json packages/docs/

RUN bun install --frozen-lockfile || bun install

# Copy source
COPY . .

# Build only what the server needs (protocol → tools → server + ui)
RUN bun run build:protocol && bun run build:tools && bun run build:server && bun run build:ui

# --- Production image ---
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./

ENV PIZZAPI_UI_DIR=/app/packages/ui/dist
ENV AUTH_DB_PATH=/app/data/auth.db

EXPOSE 3000
CMD ["bun", "run", "packages/server/dist/index.js"]
