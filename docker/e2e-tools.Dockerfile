FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        docker.io \
        docker-compose-v2 \
        git \
        jq \
        nodejs \
        npm \
    && rm -rf /var/lib/apt/lists/*

# Normalize command availability across distros/images
RUN if ! docker compose version >/dev/null 2>&1; then \
      apt-get update && apt-get install -y docker-compose-plugin && rm -rf /var/lib/apt/lists/* || true; \
    fi

WORKDIR /work
