## 2026-02-21 - Improving Auth Tabs Accessibility
**Learning:** Custom tab implementations must support keyboard navigation (Arrow keys, Home/End) alongside ARIA roles. Simply adding `role="tab"` without focus management creates a broken experience for keyboard users.
**Action:** When adding ARIA roles to interactive components, always implement the corresponding keyboard interaction patterns defined in the WAI-ARIA APG.
