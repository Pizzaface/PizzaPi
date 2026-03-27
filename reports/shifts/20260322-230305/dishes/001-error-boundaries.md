# Dish 001: React Error Boundaries

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** Sf4VuI1G
- **Dependencies:** none
- **Priority:** P0
- **Status:** served

## Files
- `packages/ui/src/components/ui/error-boundary.tsx` (create)
- `packages/ui/src/App.tsx` (modify — wrap root, SessionViewer, SessionSidebar)
- `packages/ui/src/components/ai-elements/tool.tsx` (modify — wrap individual tool cards)

## Verification
```bash
bun run typecheck
bun run build
bun test packages/ui
```

## Task Description

The UI has zero React Error Boundaries — any render error produces a white screen with no recovery. This is critical for a remote agent control tool where losing the UI means losing the ability to monitor/control running agents.

**Changes:**

1. **Create `packages/ui/src/components/ui/error-boundary.tsx`** — A reusable class component:
   - `getDerivedStateFromError()` to capture the error
   - `componentDidCatch()` to log to console
   - Fallback UI: centered card with `AlertCircle` icon, "Something went wrong" heading, error message (in dev), and a "Reload" button (`window.location.reload()`)
   - Accept `fallback` prop for custom fallback UI, and `level` prop (`"root" | "section" | "widget"`) to control fallback sizing
   - Style using existing `cn()` + Tailwind classes matching the app's destructive color tokens
   - Add a `resetErrorBoundary()` method that clears error state (for retry-without-reload in section/widget level)

2. **Wrap root in `packages/ui/src/App.tsx`** — Wrap the top-level return of `App` in `<ErrorBoundary level="root">`.

3. **Wrap `<SessionViewer>` usage** — In `App.tsx`, wrap in `<ErrorBoundary level="section">`.

4. **Wrap `<SessionSidebar>` usage** — In `App.tsx`, wrap in `<ErrorBoundary level="section">`.

5. **Wrap individual tool cards** — In `packages/ui/src/components/ai-elements/tool.tsx`, wrap each rendered card in `<ErrorBoundary level="widget">` with a compact inline fallback.

---

## Kitchen Disconnect (Fixer Diagnosis)

- **Category:** `prompt-gap`
- **Root Cause:** The original task spec focused on "add error boundaries with manual retry" and did not mention automatic context-driven reset. The cook implemented exactly what was specified — `resetErrorBoundary()` for manual retry — without considering that a multi-session application needs the boundary to auto-clear when the active session changes.
- **Detail:** In a single-session app, sticky errors are acceptable — the user can always click Retry. But PizzaPi switches `activeSessionId` programmatically (user clicks a different session in the sidebar). Since the boundary instance stays mounted and `hasError` remains `true`, the new session renders the error fallback from the previous session's crash. This is a UX regression masked as correct implementation: the spec asked for "retry support" and got it, but "auto-reset on context change" was never written down.
- **Prevention:** Task specs for stateful components in multi-context apps should explicitly call out lifecycle/reset requirements — especially for class components wrapping frequently-swapped children. A better spec would have included: "When the wrapped content's identity changes (e.g. session switch), the boundary must auto-clear error state."

## Fix Summary

**Commit:** `08903e2` — `fix: add resetKeys support to ErrorBoundary for context-aware reset`

**Changes:**
1. **`error-boundary.tsx`** — Added `resetKeys?: unknown[]` to `ErrorBoundaryProps`. Added `componentDidUpdate` that compares `prevProps.resetKeys` vs `this.props.resetKeys` using `Object.is` per-element; when any key differs and `hasError` is true, calls `setState({ hasError: false, error: null })`.
2. **`App.tsx`** — Both `<ErrorBoundary level="section">` wrappers (SessionViewer and SessionSidebar) now receive `resetKeys={[activeSessionId]}`, so switching sessions automatically clears any stuck crash.
3. **`error-boundary.test.ts`** (new) — 12 unit tests covering the key-comparison logic: no-op when `resetKeys` is undefined, equality by value, inequality on session switch, null transitions, multi-key arrays, and `Object.is` edge cases (`NaN`, `±0`).

**Verification:** `bun run typecheck` ✅ | `bun run build` ✅ | `bun test packages/ui` ✅ (455 pass, 0 fail)
