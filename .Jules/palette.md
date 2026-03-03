
## 2025-02-13 - [Focus Visible Styles on Navigation Sidebar]
**Learning:** The application uses generic `focus-visible` ring utilities (`focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset`) from Shadcn UI on deeply customized or complex DOM elements (like sliding session cards with nested hover effects and swipeable actions). By default, these composite buttons lack native or custom focus indicators, completely breaking keyboard accessibility for navigating sessions.
**Action:** Always verify that newly added complex interactive components (especially custom `<button>` wrappers for list items or cards) explicitly declare `focus-visible` classes to maintain keyboard navigability. Avoid generic `<button>` wrappers without focus state definitions.
