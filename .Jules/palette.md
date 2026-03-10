
## 2025-02-13 - [Focus Visible Styles on Navigation Sidebar]
**Learning:** The application uses generic `focus-visible` ring utilities (`focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset`) from Shadcn UI on deeply customized or complex DOM elements (like sliding session cards with nested hover effects and swipeable actions). By default, these composite buttons lack native or custom focus indicators, completely breaking keyboard accessibility for navigating sessions.
**Action:** Always verify that newly added complex interactive components (especially custom `<button>` wrappers for list items or cards) explicitly declare `focus-visible` classes to maintain keyboard navigability. Avoid generic `<button>` wrappers without focus state definitions.
## 2024-03-04 - [Add focus visible states]
**Learning:** Common accessible interactive elements without native `<button>` or `<input>` tags, or custom styled buttons (like the `FileTypeCard`, `EditFileCard`, and `CompactionSummaryCard` which look like generic UI cards but use the `<button>` element) often lack default focus indicators because `hover:bg-muted` masks the visual cues of focus for keyboard-only users.
**Action:** Always ensure that custom styled `button` cards contain `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background` to provide a clear focus ring that maintains keyboard accessibility.

## 2025-03-05 - [aria-label on buttons with text]
**Learning:** Adding an `aria-label` to a button that already has visible text (like the user menu button which shows the user's name) completely overrides the visible text in the accessibility tree. This causes a WCAG 2.5.3 (Label in Name) violation, making it harder for assistive technology users (like Voice Control) to interact with the button using its visible label.
**Action:** Never add `aria-label` attributes to buttons that already contain visible text. Only apply `aria-label` to icon-only buttons or those lacking any visible descriptive text.

## $(date +%Y-%m-%d) - Component Composition with Radix UI Tooltips and DropdownMenus
**Learning:** When adding `Tooltip` components (from shadcn/ui / Radix UI) to buttons that act as triggers for other Radix UI components (like `DropdownMenuTrigger`), placing the `<Tooltip>` wrapper directly inside the `<DropdownMenuTrigger asChild>` breaks event delegation. Because `<Tooltip>` is a context provider and doesn't forward refs or DOM events, the child trigger loses its click/touch listeners. This causes critical functional regressions, especially noticeable on mobile interfaces where the dropdown becomes unopenable.
**Action:** When composing multiple Radix UI triggers (e.g., a Tooltip on a DropdownMenu trigger), always wrap the inner trigger with the outer one using nested `asChild` props. The correct compositional pattern is:
```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <DropdownMenuTrigger asChild>
      <Button>...</Button>
    </DropdownMenuTrigger>
  </TooltipTrigger>
  <TooltipContent>...</TooltipContent>
</Tooltip>
```

## 2026-03-06 - Tooltip Consistency for Icon Buttons
**Learning:** Mixing native `title` attributes with custom `Tooltip` components in the same icon button group creates a jarring, inconsistent hover experience for users. Native tooltips have unpredictable delays and styling.
**Action:** Always use the design system's `Tooltip` component for top-level icon-only actions to ensure a snappy, visually cohesive interface.

## 2026-03-10 - Consistent Icon Button Accessibility and Tooltips
**Learning:** Relying on native `title` attributes for icon-only buttons creates inconsistent hover delays across different components and lacks screen-reader robustness when not paired with explicit `aria-label` attributes. Within specific utility components like banner actions, this discrepancy becomes especially noticeable when other parts of the application utilize unified design system tooltips.
**Action:** Consistently replace native `title` attributes on icon-only buttons with the design system's `Tooltip` components (`TooltipProvider`, `Tooltip`, `TooltipTrigger`, `TooltipContent`). Furthermore, always explicitly declare `aria-label` on these buttons so that screen readers correctly identify their action, rather than relying solely on tooltip text or raw DOM content.
