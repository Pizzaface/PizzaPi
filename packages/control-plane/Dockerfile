FROM oven/bun:1-alpine AS builder

WORKDIR /app
COPY package.json bun.lock* ./
COPY packages/control-plane/package.json packages/control-plane/
RUN bun install --frozen-lockfile

COPY packages/control-plane packages/control-plane
RUN cd packages/control-plane && bun run build

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=builder /app/packages/control-plane/dist ./dist
COPY --from=builder /app/packages/control-plane/package.json ./
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3100
CMD ["bun", "run", "dist/index.js"]
