# Mobile OTA updates (self-hosted, manual mode)

Ship **UI-only** changes to the installed mobile app without a store release or
new APK. Native/plugin changes still need a new APK (rare). Updates are served
by the **relay server the app already trusts** — no separate tunnel, no store,
no "install unknown apps" prompt (the signing key is never touched).

## How it works

```
build:mobile ──► mobile/app/ ──► publish:mobile:ota ──► mobile-ota/{manifest.json, pizzapi-<ts>.zip}
                                                              │
relay server (PIZZAPI_MOBILE_OTA_DIR) serves /api/mobile/ota/*
                                                              │
app launch ──► fetch manifest ──► buildTimestamp newer? ──► Capgo download+verify(sha256)+set+reload
```

- **Freshness key:** the bundle's `buildTimestamp` (same signal as the web
  update banner). ISO-8601 sorts lexically, so "strictly newer" is a plain `>`.
- **Manual mode:** the app's server URL is chosen at runtime, so Capgo's
  build-time `autoUpdate.updateUrl` can't be used. `packages/ui/src/lib/mobile-ota.ts`
  fetches the manifest and drives `download → set → reload` itself.
- **Integrity:** the native updater verifies the SHA-256 from the manifest
  before applying, and auto-rolls-back if the new bundle never calls
  `notifyAppReady()` (we call it on boot in `main.ts`).
- **Plugin access:** the client reaches the updater through Capacitor's
  `registerPlugin("CapacitorUpdater")` bridge (by name, like `PizzapiNtfy`) — it
  does **not** import the `@capgo` JS wrapper, so the web build never resolves
  the package and there's no bare-specifier `import()` for the WebView to fail
  on. On native the proxy routes to the plugin `cap sync` installs.

## One-time native setup (run on a machine with the Android/iOS toolchain)

The web build and unit tests do **not** need this — the client accesses the
plugin via `registerPlugin` (by name) and guards every call to the native shell,
so nothing imports the `@capgo` package until you add it here.

```bash
bun add @capgo/capacitor-updater@^8    # matches @capacitor/core ^8
bun run build:mobile                   # builds UI + copies to mobile/app + cap sync
```

`capacitor.config.ts` already sets `CapacitorUpdater: { autoUpdate: false }`.

## Publishing an update

```bash
bun run build:mobile                          # produce mobile/app/
PIZZAPI_MOBILE_OTA_DIR=/srv/pizzapi-ota bun run publish:mobile:ota
```

Then run the relay server with the **same** dir:

```bash
PIZZAPI_MOBILE_OTA_DIR=/srv/pizzapi-ota <start server>
```

`GET /api/mobile/ota/manifest.json` should now return the manifest. On next
launch, installed apps older than that `buildTimestamp` pull and apply it.

When `PIZZAPI_MOBILE_OTA_DIR` is unset the feature is off (every OTA path 404s).

## Notes / limits

- The bundle is public (it's the same UI the server already serves) — no auth on
  the endpoints; integrity comes from the checksum, not access control.
- `publish:mobile:ota` uses the system `zip`. If a device ever rejects the
  archive, swap that step for `@capgo/cli bundle zip` (their exact format).
- Rollback/staged rollout/kill-switch are not implemented — add a
  `minBuildTimestamp` gate in the manifest if you need to force-expire a bad
  bundle.
