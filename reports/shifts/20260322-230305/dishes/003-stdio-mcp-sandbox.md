# Dish 003: STDIO MCP Sandbox Exemption

- **Cook Type:** jules
- **Complexity:** S
- **Godmother ID:** 4h5FffKv
- **Dependencies:** none
- **Priority:** P2
- **Status:** served

## Files
- `packages/cli/src/extensions/mcp/transport-stdio.ts` (modify)

## Verification
```bash
bun run typecheck
bun test packages/cli
```

## Task Description

STDIO MCP servers are trusted local processes spawned from user config — they should be completely exempt from sandbox processing. Currently:

- ✅ Already exempt from filesystem sandbox (`wrapCommand` not called)
- ❌ Still gets network proxy env vars injected via `getSandboxEnv()`

In `packages/cli/src/extensions/mcp/transport-stdio.ts`:
- Line 10: `import { getSandboxEnv, isSandboxActive } from "@pizzapi/tools";`
- Line 30: `const sandboxEnv = isSandboxActive() ? getSandboxEnv() : {};`
- Line 33: `const mergedEnv = { ...process.env, ...(opts.env ?? {}), ...sandboxEnv };`

The sandbox env vars are spread LAST, meaning they override even user-provided env — MCPs can't even opt out via their own env config.

**Fix:** Remove the sandbox env injection entirely from this file. STDIO MCPs should get a clean environment: `process.env` merged with user-provided `env` from config only.

Change line 33 to:
```ts
const mergedEnv = { ...process.env, ...(opts.env ?? {}) };
```

And remove the unused imports and the `sandboxEnv` variable.
