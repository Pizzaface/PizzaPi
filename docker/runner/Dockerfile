# syntax=docker/dockerfile:1
# PizzaPi runner image — a remote coding machine, not just a daemon wrapper.
#
# Build context is the staged directory from stage-context.ts, NOT the repo
# root (the root .dockerignore excludes packages/cli and docker/). One
# Dockerfile builds both platforms via buildx; TARGETARCH picks which staged
# arch directory to install from a `RUN --mount=type=bind` so the *other*
# arch's ~115MB never lands in an image layer:
#
#   bun docker/runner/stage-context.ts
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f docker/runner/Dockerfile packages/cli/dist/runner-image-context
#
# See docs/plans/2026-07-31-runner-container-spike.md for the design.
FROM debian:trixie-slim

ARG TARGETARCH
ARG VERSION=0.0.0-dev
ARG GIT_SHA=unknown

LABEL org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.source="https://github.com/Pizzaface/PizzaPi" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="PizzaPi Runner" \
      org.opencontainers.image.description="Non-root remote coding runner for PizzaPi: connects to a relay, spawns coding agent sessions against mounted workspaces."

# Only what PizzaPi itself relies on: TLS, git, ssh, the built-in web
# terminal shell, search/process tools for runner services, bubblewrap+socat
# for the optional sandbox, curl for debugging, tini as PID 1. setpriv comes
# from util-linux, already in the base image. No gh, node, python, or
# compilers — derived images add project toolchains.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        bash \
        git \
        openssh-client \
        ripgrep \
        findutils \
        procps \
        bubblewrap \
        socat \
        curl \
        tini \
    && rm -rf /var/lib/apt/lists/*

# Install the binary + assets for TARGETARCH, and the matching seccomp vendor
# files (see fact #4 in the container spike) — bind-mounted from the build
# context so only the selected arch's files end up in an image layer.
RUN --mount=type=bind,source=.,target=/mnt/ctx \
    set -eu; \
    case "$TARGETARCH" in \
        amd64) arch_dir=linux-x64; seccomp_arch=x64 ;; \
        arm64) arch_dir=linux-arm64; seccomp_arch=arm64 ;; \
        *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    seccomp_dir="/usr/lib/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/$seccomp_arch"; \
    mkdir -p /opt/pizzapi "$seccomp_dir"; \
    cp -a "/mnt/ctx/$arch_dir/." /opt/pizzapi/; \
    cp -a "/mnt/ctx/seccomp/$seccomp_arch/." "$seccomp_dir/"; \
    cp "/mnt/ctx/entrypoint.sh" /usr/local/bin/pizzapi-entrypoint; \
    ln -s /opt/pizzapi/pizza /usr/local/bin/pizza; \
    chmod +x /usr/local/bin/pizzapi-entrypoint "$seccomp_dir/apply-seccomp"

RUN groupadd -g 1000 pizza \
    && useradd -u 1000 -g 1000 -m -d /home/pizza -s /bin/bash pizza \
    && mkdir -p /home/pizza/.pizzapi /workspace \
    && chown -R pizza:pizza /home/pizza /workspace

ENV HOME=/home/pizza \
    PIZZAPI_WORKSPACE_ROOTS=/workspace \
    PIZZAPI_SANDBOX=none \
    LANG=C.UTF-8

WORKDIR /workspace
USER pizza

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD pizza runner status || exit 1

ENTRYPOINT ["/usr/local/bin/pizzapi-entrypoint"]
CMD ["runner"]
