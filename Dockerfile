FROM oven/bun:1 AS builder
WORKDIR /app

# Copy workspace config for layer caching
COPY package.json bun.lock* ./
COPY packages/tools/package.json packages/tools/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/

RUN bun install --frozen-lockfile || bun install

# Copy source
COPY . .

# Build all packages
RUN bun run build

# --- Production image ---
FROM oven/bun:1-slim
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./

EXPOSE 3000
CMD ["bun", "run", "packages/server/dist/index.js"]
