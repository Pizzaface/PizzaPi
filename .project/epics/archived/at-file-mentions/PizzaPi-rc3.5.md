---
name: Implement file selection, text insertion, and keyboard handling (Tab drill-in)
status: open
created: 2026-02-24T17:42:44Z
updated: 2026-02-24T17:57:27Z
beads_id: PizzaPi-rc3.5
depends_on: [PizzaPi-rc3.3, PizzaPi-rc3.4]
parallel: false
conflicts_with: [PizzaPi-rc3.4]
---

# Task: Implement file selection, text insertion, and keyboard handling (Tab drill-in)

## Description

Implement the `onSelectFile` and `onDrillInto` callbacks passed to `AtMentionPopover`. On file selection, replace the `@…query` substring in the textarea with `@relative/path/to/file ` and reposition the cursor. Also handle `Tab` key to drill into the highlighted folder.

## Acceptance Criteria

- [ ] `onSelectFile(relativePath)` callback: replaces the substring from `atMentionTriggerOffset` to current cursor with `@{relativePath} ` (note trailing space), sets the cursor position immediately after the inserted text using `textarea.setSelectionRange`
- [ ] After file insertion, all `atMention*` state is reset (popover closes)
- [ ] `onDrillInto(path)` callback: sets `atMentionPath = path` and clears `atMentionQuery` (stays open)
- [ ] `Tab` key when `atMentionOpen` is true and highlighted item is a folder: calls `onDrillInto` for that folder (prevents default tab focus change)
- [ ] "← Back" action in `AtMentionPopover` triggers a parent-controlled `onBack()` that pops the last path segment from `atMentionPath`
- [ ] Pressing Escape correctly resets state (covered by Task 004 but should be integration-verified here)
- [ ] Text insertion is correct when `@` is mid-sentence (not just at end of input)
- [ ] `bun run typecheck` passes

## Technical Details

- `textarea` ref: `SessionViewer` likely already uses a ref for the textarea element (e.g., for focus management on slash-command selection); reuse or add a `textareaRef`
- Text replacement: `value.slice(0, atMentionTriggerOffset) + '@' + relativePath + ' ' + value.slice(cursorPosition)`
- `cursorPosition` at the moment of selection is `textarea.selectionStart` (captured synchronously in the callback)
- `setSelectionRange`: call after state update; use `useEffect` or `requestAnimationFrame` to ensure the DOM reflects the new value before calling
- The `onBack()` prop on `AtMentionPopover`: compute parent path with `path.split('/').slice(0, -1).join('/')` (empty string → root)
- `Tab` key: listen in `onKeyDown`; query the `Command` component for the highlighted item (shadcn `Command` may expose an `aria-selected` item); alternative: maintain `highlightedItem` in state synced with arrow-key navigation

## Dependencies

- [ ] Task 003 (AtMentionPopover) — onSelectFile/onDrillInto callbacks wired via props
- [ ] Task 004 (atMention state) — provides atMentionTriggerOffset, atMentionPath, textareaRef

## Effort Estimate

- Size: M
- Hours: 3
- Parallel: false

## Definition of Done

- [ ] File selection inserts correct text with trailing space and cursor positioned after it
- [ ] Mid-sentence `@` insertion works correctly
- [ ] Tab key drills into folders without triggering focus change
- [ ] Back navigation pops path segments correctly
- [ ] TypeScript compiles cleanly
- [ ] Code reviewed
