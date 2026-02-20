# Patches

Patches in this directory are applied automatically by Bun via the
`patchedDependencies` field in the root `package.json`. They are reapplied on
every `bun install` — no postinstall script is needed.

## @mariozechner/pi-coding-agent@0.53.0

**Purpose:** Expose `newSession()` and `switchSession()` on the extension runtime
so the PizzaPi remote extension can trigger `/new` and `/resume` flows from the
web UI.

**Why this is needed:** Upstream `ExtensionAPI` only exposes these methods on
`ExtensionCommandContext`, which is only available inside registered command
handlers. Regular event handlers and remote exec handlers only receive
`ExtensionContext`, which lacks session-control methods. This patch adds a thin
forwarding layer so `(pi as any).newSession()` and `(pi as any).switchSession()`
work from anywhere in the extension.

**What it changes (3 hunks across 2 files):**

| File | Change |
|------|--------|
| `dist/core/extensions/loader.js` — `createExtensionRuntime()` | Adds `newSession` and `switchSession` stubs (throw before init) |
| `dist/core/extensions/loader.js` — `createExtensionAPI()` | Adds `newSession(options)` and `switchSession(sessionPath)` wrappers delegating to the runtime |
| `dist/core/extensions/runner.js` — `bindCommandContext()` | Copies real `newSessionHandler` / `switchSessionHandler` onto the runtime object |

**Removing this patch:** If `newSession` and `switchSession` are added to
`ExtensionContextActions` (or `ExtensionAPI`) upstream, this patch can be
deleted and the `patchedDependencies` entry removed from `package.json`. The
call sites in `packages/cli/src/extensions/remote.ts` should then be updated to
use the typed API.
