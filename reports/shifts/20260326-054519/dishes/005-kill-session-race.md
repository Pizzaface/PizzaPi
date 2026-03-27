# Dish 005: Kill Session + exit(43) Race — killedSessions Set Guard

- **Cook Type:** sonnet
- **Complexity:** S
- **Godmother ID:** CVM8j9cS
- **Dependencies:** none
- **Pairing:** none
- **Paired:** false
- **Files:** packages/cli/src/runner/daemon.ts, packages/cli/src/runner/session-spawner.ts
- **Verification:** cd packages/cli && bun run typecheck; bun test packages/cli
- **Status:** cooking
- **Session:** 97fe3fb2-c866-4494-a69e-89c1ebd0e836
- **dispatchPriority:** high

## Task Description

### Problem

**The race condition:**
1. User calls `kill_session` for a session → daemon calls `child.kill("SIGTERM")` + `runningSessions.delete(sessionId)`
2. BUT the worker already called `process.exit(43)` (restart-in-place) BEFORE SIGTERM was delivered
3. The child's `exit` event fires with code=43 → `onRestartRequested()` (i.e., `doSpawn()`) is called
4. A NEW child is spawned for a session that was just explicitly killed
5. Relay gets contradictory events: `session_killed` + new session registration

Current code in `session-spawner.ts` (line 155):
```ts
child.on("exit", (code, signal) => {
    runningSessions.delete(sessionId);
    untrackSessionCwd(sessionId, effectiveCwd);
    if (code === 43 && onRestartRequested) {
        restartingSessions.add(sessionId);
        onRestartRequested();  // ← fires doSpawn() even for killed sessions!
    } else {
        void cleanupSessionAttachments(sessionId).catch(() => {});
    }
});
```

### Fix

1. **In `daemon.ts`**, add a `killedSessions` Set near `runningSessions` and `restartingSessions`:
   ```ts
   const killedSessions = new Set<string>();
   ```

2. **In the `kill_session` handler** (daemon.ts ~line 505), add the session to `killedSessions` BEFORE killing:
   ```ts
   killedSessions.add(sessionId);
   entry.child.kill("SIGTERM");
   ```

3. **Pass `killedSessions` to `spawnSession()`** — update the function signature in `session-spawner.ts` to accept it as a parameter (same pattern as `runningSessions` and `restartingSessions`).

4. **In the exit handler** in `session-spawner.ts`, check `killedSessions` before calling `onRestartRequested()`:
   ```ts
   if (code === 43 && onRestartRequested && !killedSessions.has(sessionId)) {
       restartingSessions.add(sessionId);
       onRestartRequested();
   } else {
       killedSessions.delete(sessionId);  // clean up
       void cleanupSessionAttachments(sessionId).catch(() => {});
   }
   ```

5. **Clean up** the `killedSessions` entry in the `session_ended` handler or `kill_session` handler to prevent leaks if a session never actually exits.

### Scope
- Changes to daemon.ts: add killedSessions Set, populate in kill_session, pass to spawnSession, clean up in session_ended
- Changes to session-spawner.ts: accept killedSessions parameter, check it in exit handler
- Verify no other callers of `spawnSession()` are missed

### Verification
```bash
cd packages/cli && bun run typecheck
bun test packages/cli
```
TypeScript must be clean. Tests must pass (check session-spawner.test.ts for existing coverage; add a test for the kill+exit43 race if one doesn't exist).

## Status History
| Time | Status | Notes |
|------|--------|-------|
| 05:52 | queued | Created in Prep — Band A, high priority |
