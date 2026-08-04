# PizzaPi runner image

Build and smoke-test scripts for the `pizzapi-runner` container image. See
[`docs/plans/2026-07-31-runner-container-spike.md`](../../docs/plans/2026-07-31-runner-container-spike.md)
for the design and operator-facing docs (Compose, mounts, sandbox posture).

```sh
bun docker/runner/stage-context.ts                 # build binaries + assemble context
docker buildx build --platform linux/amd64,linux/arm64 \
  -f docker/runner/Dockerfile packages/cli/dist/runner-image-context
./docker/runner/smoke.sh                           # end-to-end smoke against a live relay
```

## Model credentials

Pairing authenticates the runner to the *relay*, not to model providers. Log
those in from inside the container:

```sh
docker compose exec runner pizza auth            # list providers + what's configured
docker compose exec runner pizza auth anthropic  # OAuth or API key
```

The OAuth flows print an authorization URL and accept the final redirect URL
pasted back, so the browser can be on a different machine than the container
and no callback port needs publishing. Credentials are written to
`/home/pizza/.pizzapi/auth.json` in the runner-data volume; new sessions pick
them up with no restart. `PIZZAPI_AUTH_FILE` remains the non-interactive path
for automated provisioning.

