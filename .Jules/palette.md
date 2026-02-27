## 2026-02-21 - Improving Auth Tabs Accessibility
**Learning:** Custom tab implementations must support keyboard navigation (Arrow keys, Home/End) alongside ARIA roles. Simply adding `role="tab"` without focus management creates a broken experience for keyboard users.
**Action:** When adding ARIA roles to interactive components, always implement the corresponding keyboard interaction patterns defined in the WAI-ARIA APG.

## 2026-02-21 - Icon-Only Button Accessibility
**Learning:** Several icon-only buttons (e.g., in WebTerminal, SessionViewer) were implemented without `aria-label` or `title` attributes, making them inaccessible to screen readers and confusing for mouse users (no tooltip).
**Action:** Always verify icon-only buttons have an `aria-label` describing the action, and preferably a `title` for a native tooltip.

## 2026-02-25 - Tree View Accessibility in File Explorer
**Learning:** The File Explorer tree view used generic `div` and `button` elements without `aria-expanded` state, making it impossible for screen reader users to know if a folder is open or closed.
**Action:** When implementing custom tree views, always ensure `aria-expanded` is present on the toggle control, and use `aria-label` to provide context (e.g., "Folder [name]").
