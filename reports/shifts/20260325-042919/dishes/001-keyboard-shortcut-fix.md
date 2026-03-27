# Dish 001: Fix `?` Keyboard Shortcut Dead Code

- **Cook Type:** sonnet
- **Complexity:** S
- **Priority:** P1
- **Godmother ID:** Oj8CXyzM
- **Dependencies:** none
- **Files:** packages/ui/src/App.tsx
- **Verification:** bun run typecheck; bun test packages/ui
- **Status:** queued
- **Confidence Band:** A
- **dispatchPriority:** high

## Task Description

In `packages/ui/src/App.tsx` around line 2826, the keyboard handler checks:
```
e.key === "?" &&
!inInput &&
!e.metaKey &&
!e.ctrlKey &&
!e.altKey &&
!e.shiftKey &&
!document.querySelector('[role="dialog"]')
```

On standard US/international keyboard layouts, typing `?` requires pressing `Shift+/`. So `e.key === "?"` is only true when `e.shiftKey` is `true`. But the handler also requires `!e.shiftKey`. These two conditions are **mutually exclusive** — the `?` shortcut can never fire on standard layouts. It's dead code.

**Fix:** Remove the `!e.shiftKey` condition from this specific block. The `?` key is not a Shift-conflicting shortcut (unlike letter shortcuts where Shift+K means something different). When `e.key === "?"`, the shiftKey flag is expected and should not exclude the event.

Look at the exact code block at lines ~2823-2835:
```tsx
// ? — Show shortcuts help (only when not in an input)
if (
  e.key === "?" &&
  !inInput &&
  !e.metaKey &&
  !e.ctrlKey &&
  !e.altKey &&
  !e.shiftKey &&           // ← REMOVE THIS LINE
  !document.querySelector('[role="dialog"]')
) {
  setShowShortcutsHelp(true);
  return;
}
```

**Steps:**
1. Branch: `git checkout -b fix/keyboard-question-mark-shortcut`
2. Remove `!e.shiftKey &&` from the `?` shortcut handler (and only that handler — don't touch any other keyboard handlers)
3. Verify the change doesn't break any other shortcut logic
4. Run: `bun run typecheck` — must pass
5. Run: `bun test packages/ui` — must pass
6. Commit with message: `fix(ui): remove !e.shiftKey from ? shortcut — was dead code on standard layouts`
7. Push and open a PR

## Acceptance Criteria
- `e.key === "?"` shortcut no longer has `!e.shiftKey` in its condition
- No other keyboard handlers are modified
- Typecheck passes
- Tests pass
- PR description explains the fix and the root cause

## Health Inspection — 2026-03-25T11:46Z
- **Inspector Model:** claude-sonnet-4-6 (Anthropic)
- **Verdict:** CLEAN_BILL
- **Findings:** P3 — no dedicated unit test for keyboard shortcut handler (low-risk; UI event listeners are inherently difficult to unit-test without a DOM environment)
- **Critic Missed:** Nothing material. P3 gap noted by inspector was implicitly accepted by critic as well.
