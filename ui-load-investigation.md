# UI Load Investigation (Dish 011)

## Summary

The intermittent multi-minute UI load appears to be primarily server-side data retrieval latency during initial Socket.IO namespace connects, especially when many sessions have large `lastState` payloads in Redis.

I implemented targeted fixes to stop loading giant session snapshots for list endpoints and reduce initial payload/latency, plus improved the auth pending UX with a real skeleton.

---

## 1) Auth session check timing (`packages/ui/src/App.tsx`)

### Finding
- `App` blocks on `useSession()` via `isPending` before rendering authenticated UI.
- This is a hard gate by design, so if auth is slow, users see only the pending screen.

### Fix
- Replaced the plain center spinner with an app-shell loading skeleton + status text.
- This does not change auth semantics, but improves perceived startup and avoids a blank/idle feel during slow auth checks.

Files:
- `packages/ui/src/App.tsx`

---

## 2) WebSocket connection delays (all namespaces)

### Finding
- Initial namespace hydration (`/hub`, `/runners`) depended on list helpers that could read full session hashes, including very large `lastState` blobs.
- That slows namespace startup and can look like delayed socket connection/initial data.

### Fix
- Added lightweight Redis session summary reads (`HMGET` selected fields) and switched list paths to use summaries.
- Updated runner registry reads that only need counts/metadata.

Files:
- `packages/server/src/ws/sio-state.ts`
- `packages/server/src/ws/sio-registry/sessions.ts`
- `packages/server/src/ws/sio-registry/runners.ts`

---

## 3) Initial session list fetch size

### Finding
- Sidebar REST fallback called `GET /api/sessions`, which also returned `persistedSessions`.
- Sidebar only needs live `sessions`, so this could transfer and parse unnecessary data.

### Fix
- Added `includePersisted` query support on `/api/sessions`.
- Sidebar fallback now calls `GET /api/sessions?includePersisted=0`.
- Also added tests covering the `shouldIncludePersistedSessions` helper.

Files:
- `packages/server/src/routes/sessions.ts`
- `packages/server/src/routes/sessions.test.ts`
- `packages/ui/src/components/SessionSidebar.tsx`

---

## 4) Chunked session delivery blocking initial render

### Finding
- Existing chunked hydration path already avoids rendering stale deltas during snapshot assembly and progressively updates status.
- No clear regressions found in this pass that directly explain the 2-minute startup symptom.

### Action
- No code changes in chunking logic this round.
- Main latency win came from session list metadata path optimization above.

---

## 5) Bundle size (`cd packages/ui && bun run build`)

### Result
- Main bundle remains large:
  - `dist/assets/index-BITu-fem.js` ≈ **3,863.49 kB** (≈ **1,031.39 kB gzip**)
- Build succeeds but emits large-chunk warnings.

### Note
- This is a separate optimization track (code-splitting/lazy loading/manual chunking), not fully addressed in this fix.

---

## 6) Sequential API calls that could be parallel

### Finding
- `/api/sessions` previously did sequential:
  1) `getSessions`
  2) `listPersistedRelaySessionsForUser`

### Fix
- Parallelized with `Promise.all` when persisted sessions are requested.
- Fast path skips persisted fetch entirely when `includePersisted=0`.

Files:
- `packages/server/src/routes/sessions.ts`

---

## Validation run

Run after review fixes were applied (PR #360 follow-up commit):

1. `bun test packages/ui` — pass
2. `bun test packages/server` — pass (route-level tests added for fast path)
3. `bun run typecheck` — pass
4. `cd packages/ui && bun run build` — pass

Note: the original commit of this document incorrectly stated "All passed" before
route-level tests were written and before a rebase onto the CI-fix landed on main.
The validation above reflects the corrected state.
