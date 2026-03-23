# Reality Check — 00:15

| Godmother ID | Title | Verdict | Notes |
|--------------|-------|---------|-------|
| wMcURf8B | Socket.IO maxHttpBufferSize 100MB | ❌ Still needed | Line 169: `100 * 1024 * 1024` — should be ~10MB |
| W2idB6QW | Email regex overly permissive | ❌ Still needed | Line 59: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` — no length check, accepts `a@b.c` |
| DmgUMmLl | Keyboard ? doesn't check open modals | ❌ Still needed | Only checks `!inInput`, no dialog/modal guard |
| Hjsibp2R | sessionUiCacheRef unbounded | ❌ Still needed | 4 refs, no eviction, grows with every session viewed |
| SivhU2C0 | RunnerManager uses alert/confirm | ❌ Still needed | Lines 84, 100, 111 — blocks main thread |
| 0V39TSR0 | Bun.sleepSync blocks worker | ❌ Still needed | 5 occurrences in worker.ts |
| ZxGs1TeE | existsSync blocks event loop | ❌ Still needed | Lines 6, 16, 26, 91 in static.ts |
| BfJvTzK0 | /api/chat no rate limiting | ❌ Still needed | No rate limit anywhere in chat.ts |
| jekGK4zm | BETTER_AUTH_SECRET optional | ❌ Still needed | Line 242: falls through to env, could be undefined |
| 2UxvLGwh | No request body size limit | ❌ Still needed | handler.ts has no body size enforcement |
| p02fgrfW | tokensCache unbounded (code-block) | ❌ Still needed | Line 130: `new Map()` with no eviction |
| gMbVkW61 | navigator.platform deprecated | ✅ Already fixed | Line 237 already uses `userAgentData?.platform ?? navigator.platform` |
| FaiF9sxf | No favicon.ico | ✅ Already fixed | packages/ui/public/favicon.ico exists |
| ehPJZxAr | Silent .catch in App.tsx | ✅ Already fixed | Line 352 sets fallback state gracefully; others are .catch(() => null) for JSON |
| v9qdThcU | No CSP header | ⏸️ Deferred | Conflicts with open PR #246 (security headers in handler.ts) |
