# Dish 007: Replace existsSync with Async in static.ts

- **Cook Type:** sonnet
- **Complexity:** S
- **Godmother ID:** ZxGs1TeE
- **Dependencies:** none
- **Files:** packages/server/src/static.ts
- **Verification:** bun test packages/server, bun run typecheck
- **Status:** queued

## Task Description

`static.ts` uses `existsSync()` on every HTTP request (lines 6, 16, 26, 91), blocking the event loop for each static file serve.

**Fix:**
1. Replace `import { existsSync } from "fs"` with async alternatives
2. For Bun, use `Bun.file(path).exists()` which returns a Promise
3. Make the static file handler async
4. Lines 16 and 26 are in the UI directory resolution (called once at startup) — these can stay sync since they run during init, not per-request
5. Line 91 is the per-request check — this MUST become async

**Key distinction:** Startup-time calls (find the UI dist directory) are fine as sync. Per-request calls (does this file exist?) must be async.
