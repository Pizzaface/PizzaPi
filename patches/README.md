# Patches

Patches in this directory are applied automatically by Bun via the
`patchedDependencies` field in the root `package.json`. They are reapplied on
every `bun install` — no postinstall script is needed.

## @mariozechner/pi-coding-agent@0.55.1

**Purpose:** Two changes:

1. **Session control on extension API:** Expose `newSession()` and
   `switchSession()` on the extension runtime so the PizzaPi remote extension
   can trigger `/new` and `/resume` flows from the web UI.

2. **Remove version check:** Disable the npm registry version check and
   "Update Available" notification on startup (not relevant for PizzaPi's
   headless runner mode).

**Why this is needed:** Upstream `ExtensionAPI` only exposes session control
methods on `ExtensionCommandContext`, which is only available inside registered
command handlers. Regular event handlers and remote exec handlers only receive
`ExtensionContext`, which lacks session-control methods. This patch adds a thin
forwarding layer so `(pi as any).newSession()` and `(pi as any).switchSession()`
work from anywhere in the extension.

**What it changes:**

| File | Change |
|------|--------|
| `dist/core/extensions/loader.js` — `createExtensionRuntime()` | Adds `newSession` and `switchSession` stubs (reject before init) |
| `dist/core/extensions/loader.js` — `createExtensionAPI()` | Adds `newSession(options)` and `switchSession(sessionPath)` wrappers delegating to the runtime |
| `dist/core/extensions/runner.js` — `bindCommandContext()` | Copies real `newSessionHandler` / `switchSessionHandler` onto the runtime object |
| `dist/modes/interactive/interactive-mode.js` — `run()` | Removes `checkForNewVersion()` call |
| `dist/modes/interactive/interactive-mode.js` | Removes `checkForNewVersion()` and `showNewVersionNotification()` methods |

**Tests:** `packages/cli/src/patches.test.ts` verifies both patch application
(source inspection) and functional behavior (runtime method stubs, assignment,
rejection before init). Run with `bun test packages/cli/src/patches.test.ts`.

**Removing this patch:** If `newSession` and `switchSession` are added to
`ExtensionContextActions` (or `ExtensionAPI`) upstream, this patch can be
deleted and the `patchedDependencies` entry removed from `package.json`. The
call sites in `packages/cli/src/extensions/remote.ts` should then be updated to
use the typed API.

## Previously patched (no longer needed)

### @mariozechner/pi-ai (removed in 0.55.1 upgrade)

The pi-ai patch normalized image content blocks in `transform-messages.js` to
handle various formats (OpenAI-style `source.type: "base64"`, `image_url` data
URIs, etc.). This normalization now happens inside each provider's message
converter upstream, so the patch is no longer needed.
