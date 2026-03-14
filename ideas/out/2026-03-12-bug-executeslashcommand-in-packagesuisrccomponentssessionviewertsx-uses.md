---
id: 4IbYjMUD
project: PizzaPi
topics:
    - bug
    - ui
    - agent-sessions
    - react-hooks
status: out
created: "2026-03-12T23:04:53-04:00"
updated: "2026-03-13T09:28:15-04:00"
---

Bug: `executeSlashCommand` in `packages/ui/src/components/SessionViewer.tsx` uses `onSpawnAgentSession` but omits it from the `useCallback` dependency array. The callback can hold a stale `onSpawnAgentSession` closure (which itself captures `activeSessionId/liveSessions` in App), so typed `/agents <name>` can resolve against outdated runner/session context and fail or target the wrong cwd after state updates. Expected: include `onSpawnAgentSession` in dependencies (and optionally stabilize callback in App with refs).
