## 2026-02-21 - Improving Auth Tabs Accessibility
**Learning:** Custom tab implementations often miss ARIA roles, making them confusing for screen reader users. Simple additions like `role="tablist"`, `role="tab"`, and `aria-selected` significantly improve the experience.
**Action:** Always check custom navigation components for proper ARIA roles.
