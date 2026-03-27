# Dish 013: Investigate & Fix 2-Minute UI Load Time

- **Cook Type:** codex
- **Complexity:** M
- **Godmother ID:** —
- **Dependencies:** none
- **Pairing:** none
- **Paired:** false
- **Service:** 3 (Web UI Stability)
- **Files:** packages/ui/src/App.tsx, packages/server/src/**, packages/ui/vite.config.ts
- **Verification:** Measure load time before/after, bun run typecheck
- **Status:** cooking
- **Band:** A
- **dispatchPriority:** high

## Task Description
The web UI sometimes takes ~2 minutes to load. Investigate root causes:

1. **Profile the initial load**: Check what happens between page load and first render
   - Auth session check timing (isPending state)
   - WebSocket connection establishment delays
   - Initial session list fetch size/speed
   - Redis connection delays on server side
   - Chunked session delivery — are large sessions blocking initial render?
2. **Check for blocking operations**: 
   - Sequential API calls that could be parallelized
   - Large payloads on initial connect (session_active events)
   - Missing loading states that make it feel slower
3. **Measure and fix**: Profile with performance.now(), identify the bottleneck, implement fix
4. **Add a loading skeleton** if auth check is the bottleneck (Godmother idea RYjcnlGY)

Output: Identify root cause, implement fix, capture any deferred items as Godmother ideas.

## Health Inspection — 13:03 UTC
- **Inspector Model:** claude-sonnet-4-6
- **Verdict:** VIOLATION (corrected from inspector's CITATION)
- **Findings:** P2: no tests for getAllSessionSummaries; P3: dead guard, artifact at root, test coverage gap, fragile hmGet cast
- **Critic Missed:** P1 test-pollution (mock.module leak causing CI failures on pin.test.ts + runner-assoc-persist.test.ts). Independent inspector also missed it. Caught by Health Inspector via CI log analysis.
- **Fixer:** Session 8c45d710 dispatched
