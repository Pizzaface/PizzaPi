# Dish 007: Usage Limit Errors → Parent Trigger

- **Cook Type:** sonnet
- **Complexity:** S
- **Godmother ID:** — (on-the-fly request)
- **Dependencies:** none
- **Priority:** P1
- **Status:** served

## Files
- `packages/cli/src/extensions/remote/index.ts` (modify)

## Verification
```bash
bun run typecheck
bun test packages/cli
```

## Task Description
When a child session hits a usage limit error from the provider, the parent session receives a `session_complete` trigger with exitReason "completed" and no error info. The parent has no way to know the child died from a usage limit.

**Root cause:** In `agent_end`, `lastRetryableError` is cleared before `fireSessionComplete` runs, and `exitReason` is always "completed" unless `wasAborted` is true.

**Fix:**
1. In `message_end` handler: when `stopReason === "error"` and this is a child session with a parent, fire a `session_error` trigger immediately so the parent gets real-time notification
2. In `agent_end`: capture `lastRetryableError` before clearing it, and if an error was present, pass exitReason "error" and include the error message in the session_complete payload
