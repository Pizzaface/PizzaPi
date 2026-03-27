# Reality Check — 23:07

| Godmother ID | Title | Verdict | Notes |
|--------------|-------|---------|-------|
| Sf4VuI1G | P0: No React Error Boundary | ❌ Still needed | Zero ErrorBoundary references in UI codebase |
| 4h5FffKv | STDIO MCPs sandbox exempt | ❌ Still needed | `getSandboxEnv()` still injected in transport-stdio.ts:30-33 |
| 83fv3I6j | Session push events (heartbeat→WS) | ❌ Still needed | Protocol types exist (`session_added`/`session_removed`) but hub.ts server doesn't emit them |
| vS9rgojz | Chunked delivery P1 bugs | ⚠️ Mostly fixed | 3/5 sub-issues fixed (viewer race, resync stale state, session_end cleanup). Live event drops during hydration still present but seq-gap detection may cover it. Multi-node chunked state still process-local (theoretical). |
| q6aqxRbA | Redis health endpoint | ❌ Still needed | No /api/health endpoint, no degraded-mode UI banner |
| fIUvBDLZ | "No API key" on spawned sessions | ❌ Still needed | Diagnostic work — needs structured logging. Not suitable for autonomous cooking. |
