# Dish 003: Add Modal Check to Keyboard ? Shortcut

- **Cook Type:** jules
- **Complexity:** S
- **Godmother ID:** DmgUMmLl
- **Dependencies:** none
- **Files:** packages/ui/src/App.tsx
- **Verification:** bun run typecheck
- **Status:** queued

## Task Description

The keyboard shortcut `?` to show the shortcuts help dialog (around line 2601 of App.tsx) only checks `!inInput` but does NOT check whether a dialog/modal is already open. If a user types `?` while a dialog is open (e.g., NewSessionWizard, ChangePassword, etc.), it triggers the shortcuts help.

**Fix:** Add a check for open dialogs. Look for existing boolean state variables that track dialog visibility (e.g., `showShortcutsHelp`, `showNewSessionDialog`, etc.) and add them to the guard:

```typescript
if (
  e.key === "?" &&
  !inInput &&
  !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey &&
  !showShortcutsHelp &&
  // Add checks for other open dialogs/modals
) {
```

Alternatively, check for any open `[role="dialog"]` element in the DOM, which is more robust and doesn't require tracking each dialog individually:
```typescript
const hasOpenDialog = document.querySelector('[role="dialog"]') !== null;
if (e.key === "?" && !inInput && !hasOpenDialog && ...) {
```
