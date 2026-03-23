# Sidebar Session Status Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the overloaded chase animations and inline pin/dot elements with a cleaner three-state status system where only active sessions spin, awaiting sessions pulse amber, completed-unread sessions pulse green, and the provider icon itself is the sole status indicator.

**Architecture:** Extract a pure `getSessionVisualState()` helper that maps sidebar inputs to one of four visual states. Update the session row class logic, the provider icon container, and the CSS animations. Remove the inline pin icon and the activity dot overlay.

**Tech Stack:** React, TailwindCSS v4, CSS custom properties + keyframes (oklch color space)

---

## Task 1: Extract `getSessionVisualState` helper

**Files:**
- Create: `packages/ui/src/lib/session-visual-state.ts`
- Create: `packages/ui/src/lib/session-visual-state.test.ts`

This is a pure function — no React, no DOM. It encodes the priority logic that currently lives inline in the session row's `cn()` chain.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/ui/src/lib/session-visual-state.test.ts
import { describe, test, expect } from "bun:test";
import { getSessionVisualState } from "./session-visual-state";

describe("getSessionVisualState", () => {
  test("returns 'active' when session is active and not awaiting", () => {
    expect(getSessionVisualState({
      isActive: true,
      isAwaiting: false,
      isCompletedUnread: false,
      isSelected: false,
    })).toBe("active");
  });

  test("returns 'awaiting' when session has pending question", () => {
    expect(getSessionVisualState({
      isActive: true,
      isAwaiting: true,
      isCompletedUnread: false,
      isSelected: false,
    })).toBe("awaiting");
  });

  test("awaiting wins over active (priority)", () => {
    expect(getSessionVisualState({
      isActive: true,
      isAwaiting: true,
      isCompletedUnread: false,
      isSelected: false,
    })).toBe("awaiting");
  });

  test("returns 'completedUnread' for completed unread session", () => {
    expect(getSessionVisualState({
      isActive: false,
      isAwaiting: false,
      isCompletedUnread: true,
      isSelected: false,
    })).toBe("completedUnread");
  });

  test("returns 'idle' when none of the above", () => {
    expect(getSessionVisualState({
      isActive: false,
      isAwaiting: false,
      isCompletedUnread: false,
      isSelected: false,
    })).toBe("idle");
  });

  test("returns 'selected' when isSelected is true (overrides all)", () => {
    expect(getSessionVisualState({
      isActive: true,
      isAwaiting: true,
      isCompletedUnread: true,
      isSelected: true,
    })).toBe("selected");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/ui/src/lib/session-visual-state.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// packages/ui/src/lib/session-visual-state.ts
export type SessionVisualState = "selected" | "awaiting" | "active" | "completedUnread" | "idle";

export interface SessionVisualStateInput {
  isSelected: boolean;
  isAwaiting: boolean;
  isActive: boolean;
  isCompletedUnread: boolean;
}

/**
 * Determine the visual state of a sidebar session row.
 * Priority: selected > awaiting > active > completedUnread > idle.
 */
export function getSessionVisualState(input: SessionVisualStateInput): SessionVisualState {
  if (input.isSelected) return "selected";
  if (input.isAwaiting) return "awaiting";
  if (input.isActive) return "active";
  if (input.isCompletedUnread) return "completedUnread";
  return "idle";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/ui/src/lib/session-visual-state.test.ts`
Expected: PASS — all 6 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/session-visual-state.ts packages/ui/src/lib/session-visual-state.test.ts
git commit -m "feat: extract getSessionVisualState pure helper with tests"
```

---

## Task 2: Replace CSS chase animations with new status treatments

**Files:**
- Modify: `packages/ui/src/style.css` (lines ~58–145, the chase animation section)

Replace the three identical chase animations with:
- `animate-working-chase` — keep the blue conic spinning chase (active work)
- `animate-awaiting-pulse` — new soft amber pulse (no spin)
- `animate-completed-pulse` — new soft green pulse (no spin)

- [ ] **Step 1: Replace awaiting chase with amber pulse**

In `packages/ui/src/style.css`, replace the `.animate-awaiting-chase::before` block (lines ~104–124) with a soft amber pulse keyframe and class. Remove `.animate-awaiting-chase` from the shared chase blocks (lines ~64–82).

New CSS for awaiting:
```css
@keyframes awaiting-pulse {
  0%, 100% {
    box-shadow: inset 0 0 0 1.5px oklch(0.78 0.16 70 / 0.25);
  }
  50% {
    box-shadow: inset 0 0 0 1.5px oklch(0.78 0.16 70 / 0.6);
  }
}

.animate-awaiting-pulse {
  animation: awaiting-pulse 2.5s ease-in-out infinite;
  border-radius: 6px;
}
```

- [ ] **Step 2: Replace completed chase with green pulse**

Replace the `.animate-completed-chase::before` block (lines ~125–145) with a soft green pulse.

New CSS for completed:
```css
@keyframes completed-pulse {
  0%, 100% {
    box-shadow: inset 0 0 0 1.5px oklch(0.72 0.19 152 / 0.25);
  }
  50% {
    box-shadow: inset 0 0 0 1.5px oklch(0.72 0.19 152 / 0.6);
  }
}

.animate-completed-pulse {
  animation: completed-pulse 2.5s ease-in-out infinite;
  border-radius: 6px;
}
```

- [ ] **Step 3: Clean up shared chase blocks**

Update the shared selectors (lines ~64–82) so only `.animate-working-chase` uses the `isolation`, `::after` inner mask, and `::before` conic gradient. Remove `.animate-awaiting-chase` and `.animate-completed-chase` from those shared selectors entirely.

- [ ] **Step 4: Verify no other files reference the old class names**

Run: `rg "animate-awaiting-chase|animate-completed-chase" packages/ui/src -g '*.tsx' -g '*.ts'`

Any references to the old names need to be updated in Task 3 (the session row). Note them for that task.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/style.css
git commit -m "feat: replace awaiting/completed chase with pulse animations"
```

---

## Task 3: Update session row to use new visual state + animations

**Files:**
- Modify: `packages/ui/src/components/SessionSidebar.tsx`

Use `getSessionVisualState` and the new animation class names in the session row's `cn()` chain.

- [ ] **Step 1: Import the new helper**

At the top of `SessionSidebar.tsx`, add:
```typescript
import { getSessionVisualState } from "@/lib/session-visual-state";
```

- [ ] **Step 2: Replace the inline state logic in the session button's className**

Find the `cn()` block on the session `<button>` that currently reads (approximately):
```
selectMode && isChecked
  ? "bg-sidebar-accent ..."
  : isActiveSession
    ? "bg-sidebar-accent ..."
    : sessionsWithPendingQuestion?.has(s.sessionId)
      ? "... animate-awaiting-chase"
      : s.isActive
        ? "... animate-working-chase"
        : completedUnreadSessions.has(s.sessionId)
          ? "... animate-completed-chase"
          : "bg-sidebar ..."
```

Replace with a call to `getSessionVisualState`:
```typescript
const visualState = getSessionVisualState({
  isSelected: isActiveSession || (selectMode && isChecked),
  isAwaiting: !!sessionsWithPendingQuestion?.has(s.sessionId),
  isActive: !!s.isActive,
  isCompletedUnread: completedUnreadSessions.has(s.sessionId),
});
```

Then use the result in `cn()`:
```typescript
cn(
  "relative flex items-center gap-2.5 w-full min-w-0 px-2.5 py-3 md:py-2.5 text-left rounded-md",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  !hasOffset && "transition-transform duration-200 ease-out",
  visualState === "selected" && "bg-sidebar-accent text-sidebar-accent-foreground",
  visualState === "awaiting" && "text-sidebar-foreground animate-awaiting-pulse",
  visualState === "active" && "text-sidebar-foreground animate-working-chase",
  visualState === "completedUnread" && "text-sidebar-foreground animate-completed-pulse",
  visualState === "idle" && "bg-sidebar text-sidebar-foreground hover:bg-sidebar-accent/50",
)
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: clean exit

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/SessionSidebar.tsx
git commit -m "feat: use getSessionVisualState for session row styling"
```

---

## Task 4: Update provider icon to be the sole status indicator

**Files:**
- Modify: `packages/ui/src/components/SessionSidebar.tsx`

Remove the small activity dot (`<span>` overlaying the provider icon) and instead apply status-aware styling to the icon container itself.

- [ ] **Step 1: Remove the activity dot**

Find and delete the `<span>` element that renders the activity dot overlay. It looks like:
```tsx
<span
  className={cn(
    "absolute -top-0.5 -right-0.5 inline-block h-2 w-2 rounded-full border border-sidebar ring-1 ring-sidebar transition-colors",
    s.isActive
      ? "bg-blue-400 shadow-[0_0_4px_#60a5fa80] animate-pulse ring-blue-400/20"
      : "bg-green-600 ring-green-600/20",
  )}
  title={s.isActive ? "Actively generating" : "Session idle"}
/>
```

Delete this entire `<span>`.

- [ ] **Step 2: Apply status-aware styling to the provider icon container**

The provider icon container is currently:
```tsx
<div className="relative flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-md bg-sidebar-accent/50">
```

Use the `visualState` variable (already computed in Task 3) to style it:
```tsx
<div className={cn(
  "relative flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-md transition-all duration-300",
  visualState === "active" && "bg-blue-500/20 shadow-[0_0_8px_#3b82f680] animate-pulse",
  visualState === "awaiting" && "bg-amber-500/20 shadow-[0_0_8px_#f59e0b60]",
  visualState === "completedUnread" && "bg-green-500/20 shadow-[0_0_8px_#22c55e60]",
  (visualState === "idle" || visualState === "selected") && "bg-sidebar-accent/50",
)}>
```

For the awaiting and completedUnread states, add a subtle CSS pulse on the container using the existing Tailwind `animate-pulse` or use a custom gentler animation — try `animate-pulse` first and adjust if it's too strong.

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: clean exit

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/SessionSidebar.tsx
git commit -m "feat: provider icon as sole status indicator, remove activity dot"
```

---

## Task 5: Remove inline pin icon

**Files:**
- Modify: `packages/ui/src/components/SessionSidebar.tsx`

- [ ] **Step 1: Remove the inline pin toggle element**

Find and delete the `<span role="button">` block that renders the always-visible pin icon inside the session button. It looks like:
```tsx
{!selectMode && (
  <span
    role="button"
    tabIndex={-1}
    className={cn(
      "flex-shrink-0 flex items-center justify-center w-5 h-5 rounded transition-colors",
      isPinned
        ? "text-blue-400 hover:text-blue-300"
        : "text-sidebar-foreground/20 hover:text-sidebar-foreground/40",
      isPinPending && "opacity-50 pointer-events-none",
    )}
    onClick={...}
    onPointerDown={...}
    aria-label={isPinned ? "Unpin session" : "Pin session"}
    title={isPinned ? "Unpin" : "Pin"}
  >
    <Pin className={cn("h-3.5 w-3.5", isPinned && "fill-blue-400/30")} />
  </span>
)}
```

Delete this entire block. **Keep** the keyboard handler (`onKeyDown` with `e.key.toLowerCase() === "p"`) on the parent button so keyboard pinning still works. **Keep** the Pin button in the swipe-reveal action area.

- [ ] **Step 2: Remove the Pin import if unused**

Check if `Pin` and `PinOff` from lucide-react are still used elsewhere in the file (swipe-reveal buttons, ended-pinned section). Only remove from the import if completely unused.

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: clean exit

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/SessionSidebar.tsx
git commit -m "feat: remove inline pin icon from session row"
```

---

## Task 6: Run full verification

- [ ] **Step 1: Run full UI test suite**

Run: `bun test packages/ui`
Expected: all tests pass

- [ ] **Step 2: Run full typecheck**

Run: `bun run typecheck`
Expected: clean exit

- [ ] **Step 3: Verify no stale references**

Run: `rg "animate-awaiting-chase|animate-completed-chase" packages/ui/src`
Expected: no results (all references replaced)

- [ ] **Step 4: Final commit if any cleanup was needed**

```bash
git add -A && git commit -m "chore: cleanup stale animation references" || true
```
