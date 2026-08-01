# Mobile OTA updates (self-hosted, manual mode)

Ship **UI-only** changes to the installed mobile app without a store release or
new APK. Native/plugin changes still need a new APK (rare). Updates are served
by the **relay server the app already trusts** — no separate tunnel, no store,
no "install unknown apps" prompt (the signing key is never touched).

## How it works

The OTA zip mirrors the Capacitor web root (`webDir: mobile`): the bootstrap
shell `index.html` at the archive root, plus `app/` (built UI) and `vendor/`.
Bundling only `app/` would drop the bootstrap/sign-out/re-pair flow after an
update. `buildTimestamp` still comes from `app/build-info.json`.

```
build:mobile ──► mobile/{index.html,app/,vendor/} ──► publish:mobile:ota ──► mobile-ota/{manifest.json, pizzapi-<ts>.zip}
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

## Native setup (run on a machine with the Android/iOS toolchain)

`@capgo/capacitor-updater` is already a committed dependency, but the client
never imports it — it reaches the plugin via `registerPlugin("CapacitorUpdater")`
and guards every call to the native shell, so the web build/unit tests don't
pull it in. To package the native side, run a mobile build (which runs
`cap sync`, picking the plugin up from `package.json`):

```bash
bun run build:mobile   # builds UI + copies to mobile/app + cap sync (installs the native plugin)
```

`capacitor.config.ts` already sets `CapacitorUpdater: { autoUpdate: false }`
(manual mode) and `statsUrl: ""` (no telemetry to Capgo — self-hosted installs
never phone home on `notifyAppReady()`/update events).

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

- **HTTPS-only.** OTA ships executable JS, so the client only applies a bundle
  when the relay server URL is `https://` (`isSecureOtaOrigin`). The app allows
  `http://` for LAN/loopback servers and `CapacitorHttp` bypasses mixed-content
  blocking, so plain-http OTA would be MITM-exploitable — those servers update
  via a new APK instead.
- The bundle is public (it's the same UI the server already serves) — no auth on
  the endpoints; integrity comes from the checksum + TLS, not access control.
- `publish:mobile:ota` uses the system `zip`. If a device ever rejects the
  archive, swap that step for `@capgo/cli bundle zip` (their exact format).
- Rollback/staged rollout/kill-switch are not implemented — add a
  `minBuildTimestamp` gate in the manifest if you need to force-expire a bad
  bundle.
