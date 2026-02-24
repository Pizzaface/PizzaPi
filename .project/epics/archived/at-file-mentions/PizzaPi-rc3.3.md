---
name: Build AtMentionPopover component (UI, icons, breadcrumb, sort/filter)
status: open
created: 2026-02-24T17:42:44Z
updated: 2026-02-24T17:57:27Z
beads_id: PizzaPi-rc3.3
depends_on: [PizzaPi-rc3.2]
parallel: true
conflicts_with: []
---

# Task: Build AtMentionPopover component (UI, icons, breadcrumb, sort/filter)

## Description

Create the `AtMentionPopover` React component that renders the file/folder picker popover. It reuses the shadcn `Command`/`CommandList` pattern from the existing slash-command popover, with breadcrumb navigation, sort/filter rules, and loading/empty states.

## Acceptance Criteria

- [ ] Component created at `packages/ui/src/components/AtMentionPopover.tsx`
- [ ] Props: `open: boolean`, `runnerId: string | undefined`, `path: string`, `query: string`, `onSelectFile(relativePath: string): void`, `onDrillInto(path: string): void`, `onClose(): void`
- [ ] Uses `useAtMentionFiles` hook internally for data
- [ ] Shows breadcrumb header with current path; includes "← Back" action when path is not root
- [ ] Reuses `FileIcon` and `FolderIcon` from `FileExplorer.tsx`
- [ ] Sort order: directories first (alphabetical), then files (alphabetical)
- [ ] Filters out dot-files and dot-folders (`name.startsWith('.')`)
- [ ] Filters entries by `query` (case-insensitive substring match on `name`)
- [ ] Renders loading state while `useAtMentionFiles` is fetching
- [ ] Renders empty state when no matching entries
- [ ] Clicking a file calls `onSelectFile(relativePath)` where `relativePath` is relative to the runner CWD
- [ ] Clicking a folder calls `onDrillInto(newPath)`
- [ ] `bun run typecheck` passes

## Technical Details

- Follow the exact same `Command` + `CommandList` + `CommandItem` structure used by the slash-command popover in `SessionViewer.tsx` — study it first
- The popover must be positioned near the textarea cursor; use a simple absolute/fixed positioning strategy anchored to the textarea bottom-left for MVP (no fancy virtual cursor coordinates)
- `FileIcon` and `FolderIcon` are defined in `packages/ui/src/components/FileExplorer.tsx` — import them directly or extract to a shared icons file if they are not already exported
- Relative path computation: when the API returns paths relative to CWD, they can be used as-is; if absolute, strip the runner CWD prefix

## Dependencies

- [ ] Task 002 (useAtMentionFiles hook) — can develop against mock data if 002 is not done

## Effort Estimate

- Size: M
- Hours: 4
- Parallel: true

## Definition of Done

- [ ] Component implemented with all acceptance criteria met
- [ ] Tested manually with real runner connection
- [ ] Dot-file filtering and sort order verified visually
- [ ] TypeScript compiles cleanly
- [ ] Code reviewed
