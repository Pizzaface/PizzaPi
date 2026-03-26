# Runner Page: Services Display + Tab Persistence

**Date:** 2026-03-26
**Status:** Approved

## Summary

Three changes to the Runner page in the PizzaPi web UI:

1. **Services tab** — New tab on the Runner detail page showing active runner services as a responsive card grid with Lucide icons.
2. **Header service badges** — Compact status indicators in the runner header, always visible regardless of active tab.
3. **Tab persistence + cross-runner sync** — Remember the active Runner page tab across navigation and runner switches, enabling side-by-side comparison.

## Feature 1: Services Tab + Header Badges

### Data Source

All data comes from existing fields on the `RunnerInfo` protocol type (already broadcast via the `/runners` WebSocket namespace):

- `serviceIds?: string[]` — IDs of active services (e.g. `["terminal", "file-explorer", "git", "tunnel"]`)
- `panels?: ServicePanelInfo[]` — metadata for services that expose a UI panel (`{ serviceId, port, label, icon }`)

No server-side or protocol changes required.

**Data normalization:** All UI surfaces (header badges, service cards, tab count) derive from a single `normalizedServiceIds: string[]` computed once from `runner.serviceIds`:
- Deduplicate entries
- Ignore `panels` entries whose `serviceId` doesn't appear in the deduplicated set
- For plugin services with no matching panel entry, use fallback icon `"square"` and the raw service ID as label

**Ordering:** Built-in services first (in `BUILTIN_SERVICE_LABELS` map insertion order), then plugin services alphabetically by ID.

### Header Badges

A new row in the `RunnerDetailPanel` header (below the runner ID, above the tab bar) showing compact pill badges for each active service:

- Each badge: status dot + service ID in monospace text
- **Green** dot/border for built-in services (IDs: `terminal`, `file-explorer`, `git`, `tunnel`)
- **Blue** dot/border for plugin services (any ID not in the built-in set)
- Flex-wrap layout so badges wrap on narrow screens
- Only rendered when `runner.serviceIds` has entries

### Services Tab

New tab added to the `TABS` array in `RunnerDetailPanel` with key `"services"`. Tab content:

- **Responsive card grid** using explicit Tailwind breakpoints:
  - Default: `grid-cols-2`
  - `sm` (≥640px): `grid-cols-3`
  - `md` (≥768px): `grid-cols-4`
  - Gap: `gap-2`
- **Card layout**: Square aspect ratio (`aspect-ratio: 1`), centered Lucide icon, label below, green status dot top-right
- **Sections**: "Built-in Services" and "Plugin Services" (if any plugin services exist), separated by a small uppercase label
- **Plugin service cards**: Blue-tinted border/background, "panel" chip (top-left) when the service has a `ServicePanelInfo` entry
- **Icon resolution**: For built-in services, use a hardcoded map of service ID → Lucide icon name. For plugin services, use the `icon` field from `ServicePanelInfo` (rendered via the existing `DynamicLucideIcon` component, which already falls back to `"square"` for invalid/unknown icon names). Services with no panel info also get the `"square"` fallback.
- **Empty state**: Standard empty state with message "No active services" (consistent with HooksList pattern)
- **Tab badge count**: Show `normalizedServiceIds.length` in the tab bar

### Built-in Service Icon Map

```ts
const BUILTIN_SERVICE_ICONS: Record<string, string> = {
  terminal: "terminal",
  "file-explorer": "folder-open",
  git: "git-branch",
  tunnel: "server",
};
```

### Built-in Service Label Map

```ts
const BUILTIN_SERVICE_LABELS: Record<string, string> = {
  terminal: "Terminal",
  "file-explorer": "Files",
  git: "Git",
  tunnel: "Tunnel",
};
```

## Feature 2: Tab Persistence

### Current Behavior

- `RunnerDetailPanel` owns `activeTab` via `useState<RunnerTab>("sessions")`
- A `useEffect` resets to `"sessions"` whenever `runner.runnerId` changes
- Navigating to a session and back always resets the tab

### New Behavior

- **Lift `activeTab` state** out of `RunnerDetailPanel` into `RunnerManager`
- Persist to `localStorage` under key `pp.runner-tab`
- Read/write via helper functions in `packages/ui/src/lib/runner-tab-storage.ts` (unit-tested in isolation):
  - `readRunnerTab(): RunnerTab` — reads from localStorage, validates against the `RunnerTab` union. Returns `"sessions"` on any failure (missing key, invalid value, storage access denied, privacy mode).
  - `writeRunnerTab(tab: RunnerTab): void` — writes to localStorage, silently ignores errors.
- Read initial value from `readRunnerTab()` on mount
- Write via `writeRunnerTab()` on every tab change
- `RunnerDetailPanel` receives `activeTab` and `onTabChange` as props instead of owning the state

### RunnerTab Type Update

Add `"services"` to the `RunnerTab` union:

```ts
export type RunnerTab = "sessions" | "skills" | "agents" | "plugins" | "sandbox" | "hooks" | "usage" | "services";
```

## Feature 3: Cross-Runner Tab Sync

### Current Behavior

The `useEffect` on `runner.runnerId` resets the tab to `"sessions"` every time a different runner is selected.

### New Behavior

**Remove the reset `useEffect`.** With tab state lifted to `RunnerManager` and persisted, switching runners naturally preserves the active tab. If you're viewing "Skills" on Runner A and click Runner B, you see Runner B's "Skills" tab.

**Edge case handling:** If a tab has no content for the selected runner (e.g. no services, no hooks), the tab content renders its standard empty state. This is already how Skills, Agents, Plugins, and Hooks work — no special handling needed.

## Files Changed

| File | Change |
|------|--------|
| `packages/ui/src/components/RunnerDetailPanel.tsx` | Add Services tab + header badges, accept `activeTab`/`onTabChange` as props, remove internal state + reset useEffect, add `"services"` to `RunnerTab` and `TABS` |
| `packages/ui/src/components/RunnerManager.tsx` | Own `activeTab` state, persist to localStorage, pass to `RunnerDetailPanel` |
| `packages/ui/src/lib/runner-tab-storage.ts` | `readRunnerTab()` / `writeRunnerTab()` helpers with validation and safe fallback |
| `packages/ui/src/lib/runner-tab-storage.test.ts` | Unit tests for read/write helpers |

## Files NOT Changed

- No protocol changes (data already exists on `RunnerInfo`)
- No server changes
- No CLI/daemon changes

## Testing

- Verify services tab renders with mock `RunnerInfo` containing `serviceIds` and `panels`
- Verify header badges render for each service ID
- Verify built-in vs plugin visual distinction
- Verify tab persists across: runner switches, session navigation, page refresh
- Verify empty states when no services / no panels
- Verify responsive grid at different viewport widths
- Verify `readRunnerTab()` returns `"sessions"` for invalid/missing/corrupt localStorage values
- Verify duplicate `serviceIds` are deduplicated
- Verify `panels` entries with no matching `serviceId` are ignored
- Verify persisted `"services"` tab shows empty state when switching to a runner with zero `serviceIds`
