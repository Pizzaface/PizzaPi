## 2024-03-23 - Replaced Native Titles with Tooltips in ImageViewer
**Learning:** The native `title` HTML attribute creates an inconsistent and often delayed visual feedback experience compared to the rest of the application.
**Action:** Always favor using the standard Radix/Shadcn UI `Tooltip` components instead of `title` attributes for icon-only buttons to ensure immediate, styled, and predictable tooltips. Ensure `aria-label` remains on the button for screen readers.
