# Dish 001: Reduce Socket.IO maxHttpBufferSize

- **Cook Type:** jules
- **Complexity:** S
- **Godmother ID:** wMcURf8B
- **Dependencies:** none
- **Files:** packages/server/src/index.ts
- **Verification:** bun test packages/server, bun run typecheck
- **Status:** queued

## Task Description

The Socket.IO `maxHttpBufferSize` is set to 100MB (line 169 of `packages/server/src/index.ts`):
```
maxHttpBufferSize: 100 * 1024 * 1024, // 100 MB
```

This is a P1 DoS vector — a single malicious client can send 100MB payloads per message.

**Fix:** Reduce to 10MB (`10 * 1024 * 1024`). The comment explains this was set high for image attachments, but 10MB is more than sufficient for any attachment relay. Update the comment to explain the rationale.

Also add a test in `packages/server/src/index.test.ts` (or the appropriate test file) asserting the buffer size is ≤ 10MB if one exists.

## Kitchen Disconnect — 2026-03-23T02:30:00Z
- **Root cause:** Task scoped only to `packages/server/src/index.ts` — cook changed the server limit but not the coordinated CLI constants that were calibrated to it
- **Category:** missing-context
- **Detail:** `chunked-delivery.ts` is a dedicated module whose constants (`MAX_MESSAGE_SIZE`, `CHUNK_THRESHOLD`) are explicitly designed to stay below `maxHttpBufferSize`. The cook had no reason to look cross-package unless the task or a search revealed the dependency. A grep for "100 MB" or "maxHttpBufferSize" in the CLI package would have surfaced it immediately, but that's not obvious if you only know to edit one file.
- **Prevention:** Task descriptions for server transport-limit changes should explicitly call out that `chunked-delivery.ts` constants must be updated in tandem. Alternatively, add a co-location comment in `index.ts` pointing at `chunked-delivery.ts` so future changes are self-documenting.

## Fix Applied
- `CHUNK_THRESHOLD`: 10MB → 5MB (triggers chunking well below the 10MB server cap)
- `MAX_MESSAGE_SIZE`: 50MB → 5MB (individual message hard cap, safely below 10MB limit)
- `CHUNK_BYTE_LIMIT`: unchanged at 8MB per chunk (already within limit; comment updated to reference 10MB)
- All comments referencing "100 MB" updated to "10 MB"
- Verification: 18/18 tests pass (`packages/cli/src/extensions/remote-payload-cap.test.ts`), no new typecheck errors in `chunked-delivery.ts`
