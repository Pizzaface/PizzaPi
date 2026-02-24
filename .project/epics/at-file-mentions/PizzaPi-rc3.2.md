---
name: Implement useAtMentionFiles hook (fetch + cache)
status: open
created: 2026-02-24T17:42:44Z
updated: 2026-02-24T17:57:27Z
beads_id: PizzaPi-rc3.2
depends_on: []
parallel: true
conflicts_with: []
---

# Task: Implement useAtMentionFiles hook (fetch + cache)

## Description

Create the `useAtMentionFiles` custom React hook that fetches directory listings from `/api/runners/{runnerId}/files` with per-session path-keyed caching and ~100 ms debounce. This hook is the data layer for `AtMentionPopover`.

## Acceptance Criteria

- [ ] Hook created at `packages/ui/src/hooks/useAtMentionFiles.ts`
- [ ] Signature: `useAtMentionFiles(runnerId: string | undefined, path: string, enabled: boolean): { entries: Entry[], loading: boolean, error: string | null }`
- [ ] Uses `useRef<Map<string, Entry[]>>` for path-keyed cache scoped to the hook instance
- [ ] Cache is reset (Map cleared) when `enabled` flips `true → false`
- [ ] Fetches are debounced by ~100 ms to avoid rapid requests during folder navigation
- [ ] Calls `POST /api/runners/{runnerId}/files` with `{ path }` body
- [ ] Returns `loading: true` while fetch in-flight, `error` on failure
- [ ] When `runnerId` is `undefined` or `enabled` is `false`, returns empty entries immediately without fetching
- [ ] `bun run typecheck` passes

## Technical Details

- Location: `packages/ui/src/hooks/useAtMentionFiles.ts`
- The existing `POST /api/runners/{id}/files` endpoint accepts `{ path: string }` and returns `{ entries: Array<{ name: string, type: 'file' | 'directory' }> }` (verify exact shape from `packages/server/`)
- Use `useEffect` + `useRef` for debounce timer rather than a library dependency
- The `Entry` type can be exported from this file or from a shared types location
- Cache key: the `path` string (absolute or relative — match whatever the API uses)

## Dependencies

- [ ] Verify response shape from `POST /api/runners/{id}/files` in server code before finalising `Entry` type

## Effort Estimate

- Size: S
- Hours: 2
- Parallel: true

## Definition of Done

- [ ] Hook implemented with fetch, cache, and debounce
- [ ] TypeScript compiles cleanly
- [ ] Manually tested by calling the hook in a test harness or via Task 3
- [ ] Code reviewed
