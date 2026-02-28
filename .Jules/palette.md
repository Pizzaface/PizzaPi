## 2026-02-21 - Improving Auth Tabs Accessibility
**Learning:** Custom tab implementations must support keyboard navigation (Arrow keys, Home/End) alongside ARIA roles. Simply adding `role="tab"` without focus management creates a broken experience for keyboard users.
**Action:** When adding ARIA roles to interactive components, always implement the corresponding keyboard interaction patterns defined in the WAI-ARIA APG.

## 2026-02-21 - Icon-Only Button Accessibility
**Learning:** Several icon-only buttons (e.g., in WebTerminal, SessionViewer) were implemented without `aria-label` or `title` attributes, making them inaccessible to screen readers and confusing for mouse users (no tooltip).
**Action:** Always verify icon-only buttons have an `aria-label` describing the action, and preferably a `title` for a native tooltip.

## 2026-02-25 - Tree View Accessibility in File Explorer
**Learning:** The File Explorer tree view used generic `div` and `button` elements without `aria-expanded` state, making it impossible for screen reader users to know if a folder is open or closed.
**Action:** When implementing custom tree views, always ensure `aria-expanded` is present on the toggle control, and use `aria-label` to provide context (e.g., "Folder [name]").

## 2025-05-20 - Title Attribute Insufficiency
**Learning:** Icon-only buttons in `SessionViewer` relied solely on `title` for accessibility. While `title` provides a tooltip, it is not reliably announced by all screen readers and does not replace `aria-label` for providing an accessible name.
**Action:** Ensure all icon-only buttons have an explicit `aria-label`, even if they already have a `title`.

## 2026-02-28 - ARIA Labels on Non-Interactive Drag Handles
**Learning:** Adding `aria-label` to purely pointer-driven elements (like `onPointerDown` drag handles) that lack full keyboard support should NOT be accompanied by `role="button"` or `tabIndex={0}`. Doing so creates a keyboard trap/broken focus element that screen readers announce but users cannot activate with Space or Enter.
**Action:** When adding accessibility labels to visually interactive but non-keyboard-operable elements, use `aria-label` or `aria-roledescription` without making them focusable unless full keyboard interaction (e.g., Space/Enter handlers) is also implemented.
