# Dish 006: Replace Bun.sleepSync with Async Sleep

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** 0V39TSR0
- **Dependencies:** none
- **Files:** packages/cli/src/runner/worker.ts
- **Verification:** cd packages/cli && bun test, bun run typecheck
- **Status:** queued

## Task Description

`worker.ts` uses `Bun.sleepSync()` for exponential backoff in 5 places (lines 53, 66, 77, 96, 134). This blocks the worker thread entirely during retries, preventing it from handling any other events.

**Fix:**
1. Replace all `Bun.sleepSync(ms)` calls with `await Bun.sleep(ms)` (Bun's async sleep)
2. Ensure the containing functions are `async` — check each call site
3. Verify that callers of these functions properly `await` them
4. The retry logic and backoff timing should remain identical — only the blocking behavior changes

**Important:** worker.ts is a Bun worker. Make sure async sleep doesn't change the message handling semantics. The worker uses `self.onmessage` — check whether any of these sleeps are inside the message handler and whether making them async introduces race conditions with subsequent messages.
