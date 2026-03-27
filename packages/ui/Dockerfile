# syntax=docker/dockerfile:1

FROM oven/bun:1.3.10 AS build
WORKDIR /app

# Keep layer caching efficient by installing dependencies before copying sources.
COPY patches/ patches/
COPY bun.lock* ./
COPY package.json /tmp/full-package.json

# Slim down the workspace list to only packages required to build the UI image.
RUN cat /tmp/full-package.json | bun -e ' \
  const full = JSON.parse(await Bun.stdin.text()); \
  const slim = { \
    name: full.name ?? "pizzapi-ui-build", \
    private: true, \
    version: full.version ?? "0.0.0", \
    workspaces: ["packages/protocol", "packages/tools", "packages/ui"], \
    devDependencies: { typescript: full.devDependencies?.typescript ?? "^5.7.0" }, \
    patchedDependencies: full.patchedDependencies \
  }; \
  await Bun.write("/app/package.json", JSON.stringify(slim, null, 2));'

COPY tsconfig.base.json tsconfig.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/tools/package.json packages/tools/
COPY packages/ui/package.json packages/ui/

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --ignore-scripts

COPY packages/protocol/ packages/protocol/
COPY packages/tools/ packages/tools/
COPY packages/ui/ packages/ui/

RUN node_modules/typescript/bin/tsc --build packages/protocol/tsconfig.json \
    && node_modules/typescript/bin/tsc --build packages/tools/tsconfig.json \
    && bun run --cwd packages/ui build

FROM nginx:alpine AS runtime

ARG VERSION=0.0.0
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="pizzapi-ui" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}"

COPY packages/ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/ui/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
