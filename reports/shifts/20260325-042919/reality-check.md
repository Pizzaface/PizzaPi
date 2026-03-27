# Reality Check — 04:35 UTC

| Godmother ID | Title | Verdict | Notes |
|--------------|-------|---------|-------|
| Oj8CXyzM | `?` keyboard shortcut dead code | ❌ Still needed | Bug confirmed at App.tsx line 2826 — `!e.shiftKey` conflicts with `e.key === "?"` |
| fIUvBDLZ | Auth race condition in spawned sessions | ⚠️ Still needed (design) | No structured logging improvements found; `worker-auth.ts` exists but is empty. Idea in "design" status — root cause unconfirmed. Skipping from cook menu — requires investigation, not a simple code fix. |
| MCBL0VIN | Fragile `not.toContain("usage")` assertion | ❌ Still needed | Fragile assertion confirmed at packages/tools/src/search.test.ts:250 |
| IBj63TgN | `(session as any).user?.id` type cast | ❌ Still needed | Cast confirmed at App.tsx:136 and App.tsx:3171 — `useSession()` from better-auth lacks `user` type |
| 2UDzk4SB | daemon kill_session cannot SIGTERM bridge | ✅ Partially fixed | "Bridge sessions" concept has evolved — only `child: null` path is now for re-adopted sessions which have a `disconnect_session` fallback. No standalone bridge process path. Marking partially-fixed. |
| TFHUdgx2 | Stale test descriptions in remote-payload-cap.test.ts | ❌ Still needed | Confirmed: descriptions reference 10MB threshold (actual: 5MB), 8MB byte limit (actual: 6MB), 50MB truncation (actual: 5MB cap) |

## Disposition
- **On menu (4):** Oj8CXyzM, MCBL0VIN, IBj63TgN, TFHUdgx2
- **Skipped — design/investigation needed:** fIUvBDLZ
- **Marking partially-fixed:** 2UDzk4SB
