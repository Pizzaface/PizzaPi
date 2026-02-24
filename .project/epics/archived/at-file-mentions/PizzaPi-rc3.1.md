---
name: Add runnerId prop to SessionViewer and thread from App.tsx
status: open
created: 2026-02-24T17:42:44Z
updated: 2026-02-24T17:57:27Z
beads_id: PizzaPi-rc3.1
depends_on: []
parallel: true
conflicts_with: []
---

# Task: Add runnerId prop to SessionViewer and thread from App.tsx

## Description

Add a `runnerId?: string` prop to `SessionViewerProps` so that `SessionViewer` can call the runner files API. Thread the value from `App.tsx` where `activeSessionInfo.runnerId` is already available.

## Acceptance Criteria

- [ ] `runnerId?: string` is added to `SessionViewerProps` in `SessionViewer.tsx`
- [ ] `App.tsx` passes `runnerId={activeSessionInfo?.runnerId ?? undefined}` to `<SessionViewer>`
- [ ] `bun run typecheck` passes with no new errors
- [ ] No regressions to existing `SessionViewer` behaviour (slash commands, abort shortcut, etc.)

## Technical Details

- File: `packages/ui/src/components/SessionViewer.tsx` — add `runnerId?: string` to the props interface
- File: `packages/ui/src/App.tsx` — add the `runnerId` prop to the `<SessionViewer>` JSX call
- `activeSessionInfo` is already destructured in `App.tsx`; `runnerId` is already present on the session info object (it is passed to `<FileExplorer>` elsewhere)
- The prop does not need to be used by any existing logic yet — it's purely additive and creates the hook for Tasks 4 & 5

## Dependencies

- [ ] None — this is the foundation task

## Effort Estimate

- Size: XS
- Hours: 0.5
- Parallel: true

## Definition of Done

- [ ] Code implemented
- [ ] TypeScript compiles cleanly
- [ ] Visually verified no UI regression (dev build)
- [ ] Code reviewed
