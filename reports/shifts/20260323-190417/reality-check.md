# Reality Check — 19:04

Focus: Runner ↔ Server ↔ UI architectural refactoring

| Godmother ID | Title | Verdict | Notes |
|--------------|-------|---------|-------|
| 8uphsUaD | Refactor session_active to delta-based | ❌ Still needed | Core problem remains — full snapshots on every turn |
| vS9rgojz | Chunked delivery P1 bugs | ❌ Still needed | Verified: all 4 P1s still present in relay.ts/viewer.ts |
| Syd30Yv5 | Chunked hydration drops/rewinds | ❌ Still needed | Subsumes into vS9rgojz |
| mMtDh19k | Resync during chunked assembly | ❌ Still needed | viewer.ts still has the stale-lastState resync path |
| r53Zhem9 | First-connect chunkedPending race | ❌ Still needed | viewer.ts addViewer timing still races |
| 9mOLVdjU | Runner Service Abstraction | ❌ Still needed | No unified envelope — each panel is bespoke |
| YomWEX9l | Remove wait_for_message | ❌ Still needed | Both messaging paths still exist |
| cm3dh7J9 | App.tsx decomposition | ❌ Still needed | 4018 lines, 50+ hooks |
| nZhcwlHW | SessionSidebar decomposition | ❌ Still needed | 1617 lines |
| O1tacMPf | SessionViewer decomposition | ❌ Still needed | 2720 lines |
| c11jl79V | pendingChunkedStates memory leak | ✅ Partially fixed | session_end handler now defers cleanup via enqueueSessionEvent, but still process-local |
| BeBzY5Mz | Message bus Redis persistence | ❌ Still needed | Bus is in-memory only |

## Observation
Recent work landed error boundaries, degraded banners, health endpoints, security headers, and usage limit errors. But the **core architectural debt** — the snapshot tax, the relay monolith, the three-layer persistence — is untouched. This is the right focus for tonight.
