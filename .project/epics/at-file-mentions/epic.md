---
name: at-file-mentions
status: open
created: 2026-02-24T17:39:52Z
updated: 2026-02-24T17:58:00Z
progress: 0%
prd: .project/prds/at-file-mentions.md
beads_id: PizzaPi-rc3
---

# Epic: at-file-mentions

## Overview

Add an `@` file-mention system to the `SessionViewer` prompt input. When a user types `@` (at word boundary), a popover appears showing files and directories from the connected runner's CWD via the existing `/api/runners/{id}/files` API. Users can drill into folders and select a file to insert its relative path as `@path/to/file.tsx` into the message. The UI follows the existing slash-command Command popover pattern in `SessionViewer.tsx`.

No backend changes are required — the `/api/runners/{id}/files` API already supports arbitrary path listing.

## Architecture Decisions

- **Reuse Command popover pattern**: The `@` mention popover sits alongside the existing slash-command `Command` popover in `SessionViewer.tsx`. They are mutually exclusive (`commandOpen` vs `atMentionOpen`).
- **New `AtMentionPopover` component**: Extract the mention UI into a self-contained component in `packages/ui/src/components/AtMentionPopover.tsx` to keep `SessionViewer.tsx` readable.
- **`useAtMentionFiles` hook**: Encapsulate fetch logic and per-session path-keyed cache (a `Map<path, entries>`) in a custom hook. Cache lives only for the duration of the popover being open; invalidated on close.
- **Prop threading**: `runnerId` is already present in `activeSessionInfo` in `App.tsx` and needs to be added to `SessionViewerProps` so `SessionViewer` can call the files API. App.tsx already passes it to `FileExplorer`; parity is straightforward.
- **Text replacement**: Track the `@` trigger cursor offset in the input string. On selection, replace the substring from `@` to cursor with `@relative/path ` using standard string manipulation.
- **No rich-text editor**: Paths are inserted as plain text into the `<textarea>`. Syntax highlighting of `@tokens` is out of scope for this epic.

## Technical Approach

### Frontend Components

**`packages/ui/src/components/AtMentionPopover.tsx`** (new)
- Renders the `Command`/`CommandList` popover (shadcn) with file/folder entries
- Props: `open`, `runnerId`, `path`, `query`, `onSelectFile(path)`, `onDrillInto(path)`, `onClose`
- Shows breadcrumb header with current path and "← Back" action
- Reuses file/folder icons from `FileExplorer` (`FileIcon`, `FolderIcon`)
- Sorts: directories first (alphabetical), then files (alphabetical)
- Hides dot-files/folders (`name.startsWith('.')`)
- Loading and empty states handled internally via `useAtMentionFiles`

**`packages/ui/src/hooks/useAtMentionFiles.ts`** (new)
- Accepts `runnerId: string | undefined`, `path: string`, `enabled: boolean`
- Returns `{ entries, loading, error }`
- Caches fetched listings in a `useRef<Map<string, Entry[]>>` scoped to the hook instance
- Cache is reset when `enabled` flips from `true → false` (popover closed)
- Debounces fetch by ~100 ms (avoids rapid fetches during fast folder navigation)
- Calls `POST /api/runners/{runnerId}/files` with `{ path }`

**`packages/ui/src/components/SessionViewer.tsx`** (modified)
- Add `runnerId?: string` to `SessionViewerProps`
- Add state: `atMentionOpen`, `atMentionPath` (string, default `""`), `atMentionQuery` (string), `atMentionTriggerOffset` (number — char index of `@` in input)
- Extend `onChange` handler: detect `@` typed at word boundary → set `atMentionOpen=true`, record trigger offset
- Extend `onKeyDown` handler: pass `Escape` to close mention popover (takes priority over abort shortcut); `Tab` triggers drill-in on the highlighted folder
- On `atMentionOpen` close: clear all `atMention*` state

**`packages/ui/src/App.tsx`** (modified, one line)
- Pass `runnerId={activeSessionInfo?.runnerId ?? undefined}` to `<SessionViewer>` (it is already destructured in `activeSessionInfo`; just add the prop)

### Backend Services

None required. The existing `POST /api/runners/{id}/files` endpoint accepts `{ path: string }` and returns a directory listing.

### Infrastructure

No infrastructure changes needed.

## Implementation Strategy

1. Add the `runnerId` prop to `SessionViewer` and pass it from App.tsx — zero risk, purely additive
2. Build `useAtMentionFiles` hook with fetch + cache logic; unit-testable in isolation
3. Build `AtMentionPopover` component against the hook; can be developed with mock data
4. Wire trigger detection into `SessionViewer`'s `onChange`/`onKeyDown`
5. Implement text insertion/replacement logic and selection callbacks
6. Polish: dot-file filtering, sort order, mobile tap targets, ARIA attributes

### Testing approach

- Manual smoke test: type `@`, verify popover with CWD listing; navigate into `packages/`, select a file, verify insertion
- Mobile: test on iOS Safari (popover must not be clipped by keyboard)
- Keyboard: Arrow keys, Enter, Escape, Tab
- Edge cases: no runner connected (popover must not trigger), empty directories, deep paths

## Task Breakdown Preview

- [ ] Task 1: Add `runnerId` prop to `SessionViewerProps` and thread from App.tsx
- [ ] Task 2: Implement `useAtMentionFiles` hook (fetch + cache)
- [ ] Task 3: Build `AtMentionPopover` component (UI, icons, breadcrumb, sort/filter)
- [ ] Task 4: Add `@` trigger detection and state management in `SessionViewer`
- [ ] Task 5: Implement file selection, text insertion, and keyboard handling (Escape, Tab drill-in)
- [ ] Task 6: Integration, polish, and accessibility (dot-file filtering, mobile, ARIA)

## Dependencies

- **`/api/runners/{id}/files` API** — already exists, no changes required
- **shadcn `Command` component** — already used by slash-command popover, reuse as-is
- **`FileExplorer` file/folder icons** — reuse `FileIcon`/`FolderIcon` from existing `FileExplorer.tsx`
- **`SessionViewer` slash-command state pattern** — architectural reference for `atMentionOpen` state shape

## Success Criteria (Technical)

- Popover appears within 300ms of typing `@` when runner is connected
- File listing from `useAtMentionFiles` appears within 500ms (runner responding normally)
- Selecting a file inserts `@relative/path/to/file.tsx ` with cursor positioned after it
- Pressing Escape closes the popover without modifying the input (other than leaving `@`)
- No `@` popover fires when no runner is connected (`runnerId` is undefined)
- TypeScript compiles cleanly (`bun run typecheck` passes)
- No regressions to slash-command popover behaviour

## Estimated Effort

- **Overall**: 2–3 focused engineering sessions (~1–2 days)
- **Critical path**: `useAtMentionFiles` → `AtMentionPopover` → `SessionViewer` integration
- **Highest risk**: Cursor position tracking across textarea edits (browser inconsistencies); mitigate with `selectionStart`/`selectionEnd` after programmatic value set

## Tasks Created

- [ ] PizzaPi-rc3.1 - Add runnerId prop to SessionViewer and thread from App.tsx (parallel: true)
- [ ] PizzaPi-rc3.2 - Implement useAtMentionFiles hook (fetch + cache) (parallel: true)
- [ ] PizzaPi-rc3.3 - Build AtMentionPopover component (UI, icons, breadcrumb, sort/filter) (parallel: true)
- [ ] PizzaPi-rc3.4 - Add @ trigger detection and atMention state management in SessionViewer (parallel: false)
- [ ] PizzaPi-rc3.5 - Implement file selection, text insertion, and keyboard handling (Tab drill-in) (parallel: false)
- [ ] PizzaPi-rc3.6 - Integration, polish, and accessibility (dot-files, mobile, ARIA) (parallel: false)

Total tasks: 6
Parallel tasks: 3
Sequential tasks: 3
Estimated total effort: ~13.5 hours
