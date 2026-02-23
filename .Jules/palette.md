## 2026-02-21 - Improving Auth Tabs Accessibility
**Learning:** Custom tab implementations must support keyboard navigation (Arrow keys, Home/End) alongside ARIA roles. Simply adding `role="tab"` without focus management creates a broken experience for keyboard users.
**Action:** When adding ARIA roles to interactive components, always implement the corresponding keyboard interaction patterns defined in the WAI-ARIA APG.

## 2026-02-21 - Icon-Only Button Accessibility
**Learning:** Several icon-only buttons (e.g., in WebTerminal, SessionViewer) were implemented without `aria-label` or `title` attributes, making them inaccessible to screen readers and confusing for mouse users (no tooltip).
**Action:** Always verify icon-only buttons have an `aria-label` describing the action, and preferably a `title` for a native tooltip.
