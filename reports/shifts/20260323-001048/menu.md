# Tonight's Menu — Night Shift 20260323-001048

**Goal:** Fix as many backlog items as possible
**Strategy:** All dishes independent — maximum parallelism, no blocking deps

| # | Dish | Cook Type | Complexity | Dependencies | Godmother ID | Status |
|---|------|-----------|------------|--------------|--------------|--------|
| 001 | Reduce Socket.IO maxHttpBufferSize | jules | S | none | wMcURf8B | queued |
| 002 | Improve email validation regex | jules | S | none | W2idB6QW | queued |
| 003 | Add modal check to keyboard ? shortcut | jules | S | none | DmgUMmLl | queued |
| 004 | sessionUiCacheRef LRU eviction | sonnet | M | none | Hjsibp2R | queued |
| 005 | Replace alert/confirm in RunnerManager | sonnet | M | none | SivhU2C0 | queued |
| 006 | Replace Bun.sleepSync with async sleep | sonnet | M | none | 0V39TSR0 | queued |
| 007 | Replace existsSync with async in static.ts | sonnet | S | none | ZxGs1TeE | queued |
| 008 | Add rate limiting to /api/chat | sonnet | M | none | BfJvTzK0 | queued |
| 009 | BETTER_AUTH_SECRET startup validation | sonnet | S | none | jekGK4zm | queued |
| 010 | Add request body size limits | sonnet | M | none | 2UxvLGwh | queued |
| 011 | Add eviction to code-block tokensCache | sonnet | S | none | p02fgrfW | queued |

**Fire order:** All at once — no dependencies. Jules dishes fire immediately. Sonnet dishes fire in waves of 4 to manage concurrency.
