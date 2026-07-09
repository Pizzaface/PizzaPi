# Audit: reference/mobile-builds.mdx
Verdict: MINOR ISSUES
Claims checked: 41 | Failed: 2

## Findings

### [P2] API key is NOT stored in localStorage
- Claim (line 137): "The mobile bootstrap page stores the relay URL and an API key in `localStorage` before loading the bundled UI."
- Reality: Only the server URL is stored in localStorage (`pizzapi.serverUrl`). The API key is passed via a URL fragment (`#pizzapi.apiKey=…`) and the bundled UI stores it in native secure storage (iOS Keychain / Android Keystore), explicitly never in clear-text localStorage. `mobile/index.html` `launchBundledUi()`: `var hash = apiKey ? '#pizzapi.apiKey=' + encodeURIComponent(apiKey) : ''; window.location.replace('./app/index.html' + hash);` (mobile/index.html). `mobile-runtime.ts` comment: "hands a freshly redeemed API key to the bundled UI through a URL fragment … never in clear-text localStorage" and `initMobileRuntime()` persists it via `setMobileApiKey()` → `SecureStorage.set()` (packages/ui/src/lib/mobile-runtime.ts).
- Fix: Say the bootstrap page stores the server URL in localStorage and hands the API key to the bundled UI via a URL fragment, which the UI persists to native secure storage.

### [P2] Socket.IO does not use the x-api-key header
- Claim (line 141): "Adds the `x-api-key` header to REST calls and Socket.IO handshakes."
- Reality: REST calls do get an `x-api-key` header via the fetch patch (packages/ui/src/lib/mobile-fetch.ts:35-36). Socket.IO instead sends the key in the `auth` payload as `apiKey`, not as a header: `getSocketIOAuth()` returns `{ ...extra, ...(apiKey ? { apiKey } : {}) }` (packages/ui/src/lib/relay.ts:48), consumed server-side as `socket.handshake.auth?.apiKey` (packages/server/src/ws/namespaces/auth.ts:44,80).
- Fix: "Adds the `x-api-key` header to REST calls and passes the API key in the Socket.IO `auth` payload."

### [P2] verify-apk-signed.ts also fails without apksigner/build-tools
- Claim (line 92): "`scripts/verify-apk-signed.ts`, which **fails the build if the APK came out unsigned**"
- Reality: The script fails closed on TWO conditions, not one. Beyond the unsigned-APK check, it exits 1 if apksigner is not found under `$ANDROID_HOME/build-tools`: `if (!apksigner) { console.error("✗ apksigner not found …"); process.exit(1); }` (scripts/verify-apk-signed.ts). So a locally-built, correctly-signed release still fails the script unless Android SDK build-tools are installed and `ANDROID_HOME`/`ANDROID_SDK_ROOT` is set. The doc's release-signing Steps never state this prerequisite for `build:mobile:android:release`.
- Fix: Add to the release-signing steps that `build:mobile:android:release` also requires `ANDROID_HOME` + build-tools (for apksigner); without them verify-apk-signed.ts fails even when the APK is signed.

### [P3] "sets the four PIZZAPI_KEYSTORE_* vars" is imprecise
- Claim (line 119): "The workflow decodes the keystore into `$RUNNER_TEMP`, sets the four `PIZZAPI_KEYSTORE_*` vars, and runs `bun run build:mobile:android:release`"
- Reality: The workflow sets `PIZZAPI_KEYSTORE_FILE` to `${{ runner.temp }}/release.jks` (decoded) and exposes `PIZZAPI_KEYSTORE_PASSWORD`, `PIZZAPI_KEY_ALIAS`, `PIZZAPI_KEY_PASSWORD` from secrets; `PIZZAPI_KEYSTORE_BASE64` is a secret used only to decode, not a gradle-consumed var (android-release.yml "Decode keystore" + "Build signed release" steps). Gradle reads only `PIZZAPI_KEYSTORE_FILE/PASSWORD/ALIAS/KEY_PASSWORD` (android/app/build.gradle).
- Fix: "decodes the keystore into `$RUNNER_TEMP`, points `PIZZAPI_KEYSTORE_FILE` at it (the other three creds come from secrets), and runs …"

### [P3] "for the relay server" overstates CapacitorHttp scope
- Claim (line 30): "`CapacitorHttp` is enabled so `fetch`/`XHR` run through native networking for the relay server."
- Reality: `CapacitorHttp.enabled: true` patches `fetch`/`XHR` globally for all URLs, not just the relay (capacitor.config.ts). The mobile-fetch patch then scopes the `x-api-key` injection to relay-origin requests (mobile-fetch.ts:32-37).
- Fix: "…run through native networking (the API key is only injected for relay-origin requests)."

## Verified accurate (no change needed)
- `capacitor.config.ts` `webDir: "mobile"`; `mobile/index.html` bootstrap + `mobile/app/` bundled PWA (capacitor.config.ts; mobile/).
- `scripts/copy-mobile-ui.ts` copies `packages/ui/dist` → `mobile/app/` and is invoked by every `build:mobile*` script (scripts/copy-mobile-ui.ts; package.json scripts).
- `android/` and `ios/` are committed projects; synced web assets are gitignored (`android/app/src/main/assets/public` in android/.gitignore; `App/App/public` in ios/.gitignore).
- All four `build:mobile*` npm scripts exist and behave as described, including `build:mobile:ios` only syncing (no xcodebuild) and `build:mobile:android:release` running `assembleRelease bundleRelease` then `verify-apk-signed.ts` (package.json).
- ci.yml `mobile-android` job runs on push+PR, installs Java/Android SDK/Bun, runs `build:mobile:android` (debug APK) (.github/workflows/ci.yml).
- `android/app/build.gradle` release signing reads `PIZZAPI_KEYSTORE_FILE/PASSWORD/ALIAS/KEY_PASSWORD` from env or gradle properties; absent keystore → no signingConfig → unsigned (android/app/build.gradle). `-PversionCode`/`-PversionName` map to `project.findProperty` (android/app/build.gradle).
- android-debug-apk.yml: `workflow_dispatch` + `v*` tags, uploads `app-debug.apk`, no secrets. android-release.yml: same triggers, never on PRs, fails fast on missing secrets, decodes keystore to `$RUNNER_TEMP`, on a tag `versionName` defaults to tag minus leading `v` (.github/workflows/android-debug-apk.yml; .github/workflows/android-release.yml).
- iOS not built in CI (no iOS workflow exists).
- UI connects to `/hub`, `/viewer`, `/runners`, and `/terminal` namespaces with absolute server URL + API key (App.tsx:2971,3277; useRunnersFeed.ts:80; WebTerminal.tsx:154; relay.ts).
- Server trusts `capacitor://localhost` + `https://localhost` by default; `PIZZAPI_TRUST_MOBILE_ORIGINS=false` disables (packages/server/src/auth.ts:373-375).
- QR flow recommended; manual entry calls `redirectToServer()` → `window.location.replace(url)` to the server web sign-in (mobile/index.html).
- Mobile-link approval mints a short-lived ephemeral key (`mintEphemeralApiKey(userId, …, ttl)` with `MOBILE_API_KEY_TTL_SECONDS`) (packages/server/src/mobile-links.ts approveMobileLink).

## Redesign notes
- The "Server URL and Auth" section is the only place that mis-states the key storage; the page intro (lines 7-9) actually describes the flow correctly. Consolidate so the security architecture (fragment → secure storage) is stated once and correctly.
- The release-signing Steps could surface the apksigner/build-tools prerequisite up front (it's currently only implied by the Android SDK Aside and step 3) — a user following the steps on a fresh machine will hit a confusing "apksigner not found" failure after a successful signed build.
- The Commands block comments summarize `build:mobile` as "Build the PWA and sync both native projects" but the scripts also build `protocol` + `tools` first; minor, but a reader reproducing sub-steps manually may miss the dependency chain.

## Code UX opportunities
- `verify-apk-signed.ts` fails closed when apksigner is missing, which is the right security call but produces a poor local-Dev experience: a signed APK is rejected for an environment reason. Consider detecting build-tools absence earlier and printing a single actionable hint that names the exact `sdkmanager "build-tools;36.0.0"` command (CI already pins 36.0.0).
- The bootstrap page passes the API key via URL fragment and relies on the bundled UI to clear it; a brief code comment cross-link from `mobile-runtime.ts` to this docs page (or vice versa) would keep the "never localStorage" invariant discoverable for future edits.