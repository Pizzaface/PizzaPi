## 2024-05-19 - Standardize Tooltips for Icon-only Buttons
**Learning:** Native HTML `title` attributes on interactive icon-only buttons create inconsistent and often inaccessible experiences. Replacing them with the shadcn `Tooltip` component ensures predictable hover states, proper ARIA labeling, and visual alignment with the design system.
**Action:** Always use `<Tooltip><TooltipTrigger asChild><button aria-label="..."><Icon/></button></TooltipTrigger><TooltipContent>...</TooltipContent></Tooltip>` for icon-only actions instead of native `title` attributes.
