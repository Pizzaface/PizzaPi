---
name: Integration, polish, and accessibility (dot-files, mobile, ARIA)
status: open
created: 2026-02-24T17:42:44Z
updated: 2026-02-24T17:57:27Z
beads_id: PizzaPi-rc3.6
depends_on: [PizzaPi-rc3.5]
parallel: false
conflicts_with: []
---

# Task: Integration, polish, and accessibility (dot-files, mobile, ARIA)

## Description

End-to-end integration validation, UX polish, and accessibility hardening for the `@` file-mention feature. Covers dot-file filtering, mobile layout (iOS Safari keyboard), ARIA attributes, and verifying all edge cases from the success criteria.

## Acceptance Criteria

- [ ] Popover appears within 300 ms of typing `@` with runner connected (measure visually)
- [ ] File listing from `useAtMentionFiles` appears within 500 ms (normal runner latency)
- [ ] Dot-files and dot-folders (`.git`, `.env`, etc.) are filtered from the listing
- [ ] No `@` popover fires when no runner is connected (`runnerId` is `undefined`)
- [ ] Selecting a file inserts `@relative/path/to/file.tsx ` with cursor after it
- [ ] Pressing `Escape` closes the popover without modifying input (other than the `@` remaining)
- [ ] Slash-command popover behaviour is unaffected — full regression pass
- [ ] On iOS Safari: popover is not clipped by the virtual keyboard (use `max-height` + `overflow-y: auto` with viewport-aware positioning or `env(keyboard-inset-height)`)
- [ ] ARIA: popover has `role="listbox"`, items have `role="option"`, `aria-selected` reflects keyboard highlight, popover is `aria-label`-ed appropriately
- [ ] Empty directory shows a friendly "No files found" message
- [ ] Deep path navigation (5+ levels) works without errors
- [ ] `bun run typecheck` passes with zero errors
- [ ] `bun run build` succeeds

## Technical Details

- **Mobile**: test on iOS Safari simulator or real device; the shadcn `Command` popover may need `max-h-[50vh]` and `overflow-y-auto` with bottom-anchoring relative to the textarea
- **ARIA**: shadcn `Command` provides baseline ARIA; verify that `AtMentionPopover` adds `aria-label="File mentions"` to the wrapping element, and that `CommandItem` elements receive meaningful labels (e.g., `aria-label="Select file: index.ts"`)
- **Dot-file filtering**: already implemented in Task 003, but validate with real directories that contain dot-entries
- **Performance**: if listing is slow, confirm the 100 ms debounce in `useAtMentionFiles` prevents excessive requests during rapid folder navigation
- **Edge cases to test**:
  - Empty directory (no files, no folders)
  - `@` typed at position 0 (start of input)
  - `@` typed mid-word (should NOT trigger — word boundary check)
  - Switching sessions while popover is open (popover should close / runnerId changes)
  - Very long file paths (check truncation in popover items)

## Dependencies

- [ ] Task 005 (full feature wired) — must be complete before integration testing

## Effort Estimate

- Size: S
- Hours: 2
- Parallel: false

## Definition of Done

- [ ] All acceptance criteria verified manually
- [ ] Mobile layout tested (iOS Safari)
- [ ] ARIA attributes present and correct (verified with browser accessibility inspector)
- [ ] `bun run typecheck` passes
- [ ] `bun run build` succeeds
- [ ] Code reviewed
