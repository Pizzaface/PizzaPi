---
name: Add @ trigger detection and atMention state management in SessionViewer
status: open
created: 2026-02-24T17:42:44Z
updated: 2026-02-24T17:57:27Z
beads_id: PizzaPi-rc3.4
depends_on: [PizzaPi-rc3.1]
parallel: false
conflicts_with: [PizzaPi-rc3.5]
---

# Task: Add @ trigger detection and atMention state management in SessionViewer

## Description

Extend `SessionViewer`'s `onChange` and `onKeyDown` handlers to detect when the user types `@` at a word boundary, open the `AtMentionPopover`, and manage the associated state (`atMentionOpen`, `atMentionPath`, `atMentionQuery`, `atMentionTriggerOffset`).

## Acceptance Criteria

- [ ] Four new state variables added to `SessionViewer`: `atMentionOpen` (boolean), `atMentionPath` (string, default `""`), `atMentionQuery` (string), `atMentionTriggerOffset` (number)
- [ ] `onChange` handler detects `@` typed at a word boundary (character before `@` is space, newline, or start-of-string) and sets `atMentionOpen = true`, records `atMentionTriggerOffset` (index of `@` in input value)
- [ ] `atMentionQuery` is kept in sync: it is the substring from `atMentionTriggerOffset + 1` to current cursor position (i.e., what the user has typed after `@`)
- [ ] `onKeyDown` handler: `Escape` when `atMentionOpen` is true closes the popover (prevents event from propagating to abort shortcut)
- [ ] When `atMentionOpen` closes for any reason, all `atMention*` state is reset to defaults
- [ ] No `@` popover fires when `runnerId` is `undefined`
- [ ] Existing slash-command popover behaviour is unaffected (mutually exclusive via `commandOpen` vs `atMentionOpen`)
- [ ] `AtMentionPopover` is rendered in the JSX (even if wired incompletely — file selection handled in Task 005)
- [ ] `bun run typecheck` passes

## Technical Details

- Study the existing `commandOpen` / `setCommandOpen` pattern and mirror it for `atMentionOpen`
- Word boundary check: `inputValue[triggerIndex - 1]` is `undefined` (start) or matches `/[\s]/`
- `atMentionTriggerOffset` should be the cursor position at the moment `@` was typed (`event.target.selectionStart - 1` after the onChange event fires — note: onChange fires after the character is inserted)
- When `atMentionOpen` is already true and the user keeps typing, update `atMentionQuery` on every `onChange`; if backspace deletes past the `@` trigger character, close the popover
- `atMentionPath` controls which directory the `AtMentionPopover` is browsing; drilling into a folder calls `setAtMentionPath(newPath)`

## Dependencies

- [ ] Task 001 (runnerId prop) — required so SessionViewer receives runnerId
- [ ] Task 003 (AtMentionPopover) — needed to render the popover in JSX (can stub with placeholder if 003 not complete)

## Effort Estimate

- Size: S
- Hours: 2
- Parallel: false

## Definition of Done

- [ ] Trigger detection works: typing `@` opens popover, typing after `@` updates query, backspacing past `@` closes popover
- [ ] Escape closes popover without side effects
- [ ] No regressions to slash-command popover
- [ ] TypeScript compiles cleanly
- [ ] Code reviewed
