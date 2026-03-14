---
id: 3zBgHqAQ
project: PizzaPi
topics:
    - bug
    - agent-sessions
    - ui
    - react-hooks
status: out
created: "2026-03-12T23:14:59-04:00"
updated: "2026-03-13T09:28:15-04:00"
---

Bug: `/agents` picker can display stale agent lists from the wrong session/runner due an unguarded async race in `SessionViewer`. In `packages/ui/src/components/SessionViewer.tsx` (agent-mode `useEffect` around line ~1084), fetch(`/api/runners/${runnerId}/agents`) updates `setAgentsList(...)` without checking that `sessionId`/`runnerId` are still current when the promise resolves.

Expected: stale responses should be discarded (same `dispatchSessionId` guard pattern already used in `/skills` and `/plugins` handlers), or use AbortController on dependency change/unmount.
Actual: switching sessions/runners while fetch is in-flight can overwrite `agentsList` with old data.
Impact: user can select an agent that does not exist on the current runner, leading to confusing spawn failures and incorrect picker contents.
Quick repro: open `/agents` on session A (runner1), quickly switch to session B (runner2) before response returns; old response can populate B's picker.
