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
