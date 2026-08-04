# PizzaPi runner image

Build and smoke-test scripts for the `pizzapi-runner` container image. See
[`docs/plans/2026-07-31-runner-container-spike.md`](../../docs/plans/2026-07-31-runner-container-spike.md)
for the design and operator-facing docs (Compose, mounts, sandbox posture).

## First boot: pair the runner

Start the runner with `PIZZAPI_RELAY_URL` set and no `PIZZAPI_API_KEY`. Follow
its logs to get the approval QR code and URL:

```sh
docker compose up -d runner
docker compose logs -f runner
```

Open the URL or scan the QR code with a browser already signed in to that
PizzaPi relay, then approve the runner. The QR is rendered full-size so it
stays scannable in Docker log viewers; the URL is reprinted about once a minute
while approval is pending.

The relay API key is saved in `/home/pizza/.pizzapi` (normally the
`runner-data` volume), so the runner reconnects after container recreation
without pairing again. Pairing authenticates the runner to the **relay**; it
does not authenticate model providers.

## Model provider authentication

The preferred path is **Runner Settings → Providers** in the web or Android
app. Select **Sign in** for OAuth/subscription access or **API key** for a
provider key. Credentials are stored in the runner's
`/home/pizza/.pizzapi/auth.json`; new sessions pick them up without restarting
the runner.

For SSH/headless setup, run the same login flow inside the container:

```sh
docker compose exec runner pizza auth            # list providers and status
docker compose exec runner pizza auth anthropic  # OAuth or API-key login
```

OAuth clients such as Anthropic and OpenAI Codex use registered localhost
callbacks, not the PizzaPi relay URL. If the browser runs on the Docker host,
publish the provider's callback port on loopback and the Providers screen will
auto-complete after sign-in:

```yaml
ports:
  - "127.0.0.1:53692:53692" # Anthropic (Claude Pro/Max)
  - "127.0.0.1:1455:1455"   # OpenAI Codex
```

If the browser is on another device, complete sign-in and paste the final
localhost redirect URL into the Providers screen or CLI prompt. The
`PIZZAPI_AUTH_FILE` secret remains the non-interactive option for automated
provisioning.

## Build locally

```sh
bun docker/runner/stage-context.ts                 # build binaries + assemble context
docker buildx build --platform linux/amd64,linux/arm64 \
  -f docker/runner/Dockerfile packages/cli/dist/runner-image-context
./docker/runner/smoke.sh                           # end-to-end smoke against a live relay
```
