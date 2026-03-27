# Dish 005: Accessible Button Names (Chef's Special)

- **Cook Type:** jules
- **Complexity:** S
- **Godmother ID:** — (codebase exploration find)
- **Dependencies:** none
- **Priority:** P2
- **Status:** served

## Files
- `packages/ui/src/App.tsx` (modify — add aria-labels to ~10 buttons)
- `packages/ui/src/components/PluginsManager.tsx` (modify — add aria-label to 1 button)

## Verification
```bash
bun run typecheck
bun run build
```

## Task Description

Several buttons in the UI lack accessible names — they contain only icons with no `aria-label`, `title`, or visible text. Screen readers cannot identify what these buttons do.

**In `packages/ui/src/App.tsx`**, the following buttons near lines 3014-3141 and 3326-3833 need `aria-label` attributes:
- Header action buttons (settings, new session, etc.)
- Icon-only toggle buttons
- The inline session action buttons

**In `packages/ui/src/components/PluginsManager.tsx`** line 87, add an aria-label.

For each button, read the surrounding JSX context to determine its purpose, then add an appropriate `aria-label="..."` attribute. Use concise, action-oriented labels like "Open settings", "New session", "Toggle sidebar", etc.
