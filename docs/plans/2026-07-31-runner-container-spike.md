# Spike: PizzaPi Runner Container Image

**Status:** scoped; ready for implementation planning  
**Target:** `ghcr.io/pizzaface/pizzapi-runner:<version>` for `linux/amd64` and `linux/arm64`

## Decision

Ship a small, non-root Linux image that runs the existing standalone PizzaPi binary as:

```text
tini -- pizza runner
```

The container is a remote coding machine, not just a daemon wrapper. It must contain the small set of OS tools PizzaPi itself relies on, while project-specific language toolchains remain user-supplied through derived images.

Do not combine the runner with the PizzaPi relay/server image. The runner only needs outbound HTTP/WebSocket access to the relay; it exposes no ports.

## User outcome

A user can move a runner off their host with one Compose service, persist its identity and credentials, mount one or more workspaces, connect it to optional sidecars, and replace the image to upgrade it.

```yaml
services:
  runner:
    image: ghcr.io/pizzaface/pizzapi-runner:0.5.61
    restart: unless-stopped
    stop_grace_period: 30s
    environment:
      PIZZAPI_RELAY_URL: https://pizza.example.com
      PIZZAPI_API_KEY: ${PIZZAPI_API_KEY}
      PIZZAPI_RUNNER_NAME: docker-runner
      PIZZAPI_WORKSPACE_ROOTS: /workspace
    volumes:
      - runner-data:/home/pizza/.pizzapi
      - ./projects:/workspace

volumes:
  runner-data:
```

The relay may be another Compose service:

```yaml
PIZZAPI_RELAY_URL: http://server:7492
```

`localhost` always means the runner container itself.

## Image contract

### Base and entrypoint

- Debian slim, matching the standalone binary's glibc target.
- Run as an unprivileged `pizza` user, default UID/GID 1000.
- `HOME=/home/pizza`, `WORKDIR=/workspace`.
- `tini` as PID 1 so signals and orphaned session processes are reaped.
- `ENTRYPOINT ["tini", "--", "pizza"]`, `CMD ["runner"]`.
- OCI labels include version, git SHA, source URL, and license.
- No `EXPOSE`: control and service-tunnel connections are outbound.

### Included runtime tools

Install only tools required for a useful baseline runner:

| Package | Why |
|---|---|
| `ca-certificates` | TLS relay/provider connections |
| `bash` | default web terminal and agent shell |
| `git` | built-in Git runner service and coding work |
| `openssh-client` | Git over SSH |
| `ripgrep`, `findutils` | search tool and sandbox path scanning |
| `procps` | `ps`/`pgrep` process display and cleanup |
| `bubblewrap`, `socat` | optional Linux session sandbox |
| `curl` | baseline network/debug tool |
| `tini` | PID 1 signal forwarding/reaping |

Do not include GitHub CLI, Docker CLI/socket, compilers, Node, Python, or project language SDKs. Users needing them should build `FROM ghcr.io/pizzaface/pizzapi-runner:<version>` and install exactly what their projects require.

### Build source

Reuse the existing standalone Linux artifacts from `packages/cli/build-binaries.ts`, including:

- `pizza-linux-{x64,arm64}`
- matching `librust_pty*.so`
- `package.json`, `theme/`, `export-html/`, `templates/`, and `skills/`

Do not create a second source-based CLI installation path for Docker.

## Storage and mounts

### Required persistent volume

Mount `/home/pizza/.pizzapi` as one persistent volume. It contains a coupled set of runner state:

- `runner.json` identity, secret, and process lock
- `config.json`, `settings.json`, `models.json`
- `auth.json` provider credentials
- session transcripts and attachments
- usage database/cache
- installed packages, plugins, agents, skills, providers, and global runner services

Persisting the whole directory is simpler and less error-prone than splitting files. Treat the volume as secret-bearing data. Never bake it into the image.

On an unclean container death, `runner.json` can contain a stale container PID. Existing runner-state validation checks whether that PID belongs to a runner before clearing it; this must be covered by the restart smoke test.

### Workspace mounts

- Mount projects below a stable container path such as `/workspace`.
- Set `PIZZAPI_WORKSPACE_ROOTS` to the mounted roots. The image should default it to `/workspace` unless the operator overrides it.
- Spawn requests must use container paths, not host paths.
- Multiple roots work as comma-separated mounts, for example `/work/client,/work/oss`.
- Read-only mounts are allowed but agents cannot edit them.

### Optional host integration mounts

| Integration | Recommended mount/config | Notes |
|---|---|---|
| Git identity | host `.gitconfig` to `/home/pizza/.gitconfig:ro` | Or configure it inside the persistent volume/user environment |
| SSH auth | mount an SSH agent socket and set `SSH_AUTH_SOCK` | Prefer this to mounting private keys |
| GitHub auth | pass `GH_TOKEN` to a derived image containing `gh` | `gh` is not in the base image |
| Cloud/provider auth | environment secrets or files under persisted `.pizzapi` | macOS Keychain credentials are unavailable in Linux |
| Extra CA | derived image or mounted CA plus standard CA env/config | Do not disable TLS verification |

Do not recommend mounting the host home directory, `/`, or `/var/run/docker.sock`. The Docker socket is host-root-equivalent and conflicts with the sandbox's Unix-socket restrictions.

## Runner services and sidecars

- Built-in runner services work inside the image: terminal, file explorer, Git, process, memory, time, and tunnel.
- Global custom services persist under `/home/pizza/.pizzapi/services` and are loaded normally.
- Project-local `.pizzapi/services` are not part of the image MVP. Although `service-loader.ts` supports `discoverServices({ cwd })`, the current daemon only invokes global discovery; restore that integration separately before promising per-session project services (Godmother follow-up `ZCEJktvF`).
- Service HTTP ports stay inside the container. PizzaPi's existing `/_tunnel` WebSocket proxies them to the browser, so Compose `ports:` entries are unnecessary.
- Sidecars (databases, Ollama, MCP HTTP servers, browsers) should share a Compose network and be addressed by service DNS name, such as `postgres:5432` or `ollama:11434`.
- Stdio MCP servers and custom services must bring their executable dependencies in a derived runner image.

## Credentials

Support both existing paths without adding a container-specific secret system:

1. `PIZZAPI_API_KEY`/provider environment variables, preferably supplied by the orchestrator's secret mechanism.
2. Existing files in the persistent `/home/pizza/.pizzapi` volume.

Worker sessions inherit daemon environment variables except the existing denylist. This means Compose secrets exposed as environment variables also reach workers unless already denied. Document this; do not promise daemon-only secrecy for arbitrary environment variables.

OAuth login can write to persisted `auth.json`. Host keychain fallback does not cross into the Linux container.

## Sandbox and security posture

A Docker container is the runner's machine boundary; it is not automatically a per-session boundary.

The current Linux sandbox uses nested Bubblewrap. Ordinary Docker configurations may reject its namespace operations, and PizzaPi currently degrades to unsandboxed execution when sandbox initialization fails. Therefore the first image must be explicit rather than silently claiming sandbox support:

- Default the image to `PIZZAPI_SANDBOX=none`.
- Run the container non-root and mount only intended workspaces/config.
- Document opt-in testing of `sandbox.enableWeakerNestedSandbox: true` for operators who want nested Bubblewrap. This mode is weaker and must be verified on the target Docker/Podman host.
- Do not require `--privileged`, host PID namespace, or broad capabilities.
- Do not expose the web terminal to users who should not have full command execution inside the container; it has the runner user's permissions and no separate sandbox.

A future stronger design may run each worker in its own container. That is a different orchestration feature and not part of this image.

## Operational behavior

- Upgrade by pulling a new immutable version tag and recreating the container; keep the data volume.
- Publish version tags matching the CLI release, plus `main` for edge builds. Avoid using `latest` in documentation.
- Use `restart: unless-stopped` and `stop_grace_period: 30s`.
- Do not add a fake healthcheck based only on the presence of `runner.json`; it cannot prove relay registration. Add a healthcheck only after the CLI exposes a real local runner status/probe command.
- Container logs are runner stdout/stderr; leave rotation to Docker or the orchestrator.
- Resource limits are operator-set. Multiple workers and their child processes share the container limits.

## MVP acceptance criteria

1. Both image architectures start as non-root and register with a remote relay.
2. A session spawned with `cwd=/workspace/<repo>` can read, edit, search, and run Git commands.
3. The built-in web terminal opens with Bash and the bundled PTY library.
4. Runner identity, provider auth, transcripts, installed global services, and attachments survive container recreation.
5. `docker stop` performs a clean shutdown within 30 seconds; restart after forced kill clears a stale state lock.
6. A runner service panel is reachable through the existing relay tunnel without publishing a container port.
7. A worker can reach a Compose sidecar by service name.
8. Requests outside `PIZZAPI_WORKSPACE_ROOTS` are rejected.
9. The image works without privileged mode or a Docker socket.
10. Startup/logging states clearly that the session sandbox is disabled by the image default; an opt-in nested-sandbox smoke test documents supported host settings.

## Implementation slices

### 1. Build and smoke the image

Add one runner Dockerfile and a local smoke script/Compose fixture. Build from the existing standalone artifact and verify binary, PTY, signal handling, non-root ownership, and both architectures in CI.

### 2. Publish with releases

Add a GHCR buildx job alongside the existing UI image jobs. Publish version and SHA tags, then add `main` publication after release behavior is proven.

### 3. Document operator contracts

Add a runner-container guide covering Compose, data/workspace mounts, sidecars, derived images, UID/GID ownership, credentials, SSH agent forwarding, sandbox limitations, and upgrades.

Keep these slices separate; no CLI command or Compose generator is needed for MVP.

## Explicit non-goals

- Running the relay/server in the same container.
- One-container-per-session orchestration.
- Kubernetes manifests, Helm charts, or a Docker Compose generator.
- Docker-outside-of-Docker or mounting the host Docker socket.
- A universal development image containing every language toolchain.
- Transparent access to host paths, host keychains, host localhost services, or host-installed executables.
- Changing runner/worker process architecture.

## Open decisions before implementation

1. **Registry name:** confirm `ghcr.io/pizzaface/pizzapi-runner`.
2. **Base UID/GID:** accept fixed 1000 for MVP, or require runtime UID remapping in the first release.
3. **Sandbox default:** approve the explicit `PIZZAPI_SANDBOX=none` default versus making weaker nested Bubblewrap a tested default.
4. **Edge tags:** publish only immutable release tags initially, or also `main` from day one.
