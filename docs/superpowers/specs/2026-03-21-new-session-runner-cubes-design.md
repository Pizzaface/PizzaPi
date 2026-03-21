# New Session Wizard - Runner Cubes + Virtualized Recent Projects (Design Spec)

## Problem

The current **New session** UI is functional but doesn't scale well:

- Runner selection is a dropdown, which is harder to scan when there are multiple runners.
- "Recent folders" are shown as wrapped chips (or a non-virtualized list), which breaks down with longer histories and long paths.
- The New Session UX exists in **two places** (`App.tsx` and `RunnerManager.tsx`) with similar-but-not-identical behavior, making it easy for them to drift.

## Goals

1. Replace runner dropdown with a **grid of selectable runner "cubes"**.
2. Use a **Wizard/Stepper** flow:
   - Step 1: Runner
   - Step 2: Working directory (optional) + Recent projects
3. Make **Recent projects**:
   - **Scrollable** (fixed height so the dialog footer stays visible)
   - **Virtualized**
   - **50 items per runner**
   - **Filters live** as the user types in the working directory field
   - Clicking an item **fills the input** (does *not* auto-start)
4. Keep recents "relevant" by **excluding linked/child spawns** (sessions spawned with `parentSessionId`) from being recorded.
5. **Unify both entrypoints** by implementing the UI as a shared component.

## Non-Goals

- Implementing a filesystem browser / scanning runner roots.
- Auto-starting a session on recent-item click.
- Cross-runner / global recent-project history (per-runner only for now).
- Validating that a typed or selected cwd actually exists on the runner - the server already enforces roots-based access; no pre-flight path existence check is needed.
- Cleaning up historical child-session paths from recents (prevention-only, no migration).

---

## UX Design

### Entry points

1. **Main viewer dialog** (current `App.tsx` modal)
   - Opens the wizard at Step 1.
   - If there is exactly **one connected runner**, auto-select it and start at Step 2.

2. **Runner Manager dialog** (current `RunnerManager.tsx` modal)
   - Uses the same wizard component with the runner **preselected** (always - RunnerManager only opens the dialog after the user clicks "New session" on a specific runner).
   - Step 1 is skipped/hidden; the component starts directly at Step 2.

### Step 1: Runner

- Display runners as a **responsive grid** of "cube" cards.
  - Mobile: 2 columns
  - Desktop: 3-4 columns (wrap as needed)
  - If many runners, the grid scrolls within a bounded area.
- Each cube shows:
  - **Name** (primary)
  - Meta line: e.g. `8 sessions · 2 roots` - where **roots** are the filesystem paths the runner is configured to allow as working directories (from the runner's `roots` config)
  - A small **green connection dot** in the corner for connected runners
- Clicking a cube selects it and advances to Step 2.
- Only connected runners are shown in the picker (matching the current `/api/runners` behavior), so the wizard does not need a disconnected/offline visual state.

### Step 2: Folder (optional)

- Working directory input (free-form), labeled clearly as:
  - "This is the path on the runner machine."
- Below the input: **Recent projects** list for the selected runner.

Recent projects list behavior:

- Fixed-height scroll region with virtualization.
- Shows up to **50** entries.
- **Filters live** as the user types:
  - Case-insensitive.
  - **OR logic**: an entry matches if the query is found as a substring anywhere in the full path **or** the basename (either match is sufficient).
  - Example: `src` matches `/home/user/src/project` (full path) and also matches `/code/src-lib` (basename). `pizza` matches `/code/PizzaPi` (case-insensitive basename match).
  - Filter updates immediately on each keystroke (no debounce required for client-side filtering).
- Clicking a recent entry **replaces the entire input value** with that path, and **clears the filter** (input becomes the selected path, showing all recents again on next focus).
- Optional "remove" action (×) per row.
  - This is **not** UI-only.
  - It calls the existing per-runner delete endpoint to remove that path from recents for the current user/runner.

Row display:

- Primary: basename (project/folder name)
- Secondary: truncated path tail showing the last **2 segments** (for example `…/parent/project`) to disambiguate duplicates; use the existing `formatPathTail` utility already in `packages/ui/src/lib/path.ts`

### Footer

- Step 2 shows: **Back**, Cancel, **Start Session**.
- Start is disabled until a runner is selected.
- Folder is optional — leaving the input blank is valid. An empty/blank cwd is sent as absent (omitted from the spawn payload), matching current behavior.

### Errors / empty states

- No runners connected → show guidance ("Start one with `pizzapi runner`") and disable Start.
- Recent list loading → inline spinner.
- Recent list fetch failure → inline non-fatal message (e.g. "Couldn't load recent projects") while keeping manual cwd entry usable; the user can still start a session with a typed cwd. Use the standard fetch timeout (no special per-request timeout beyond what the browser enforces).
- Recent list empty → "No recent projects yet."
- Spawn in-progress → "Start Session" button shows a spinner and is disabled; dialog stays open.
- Spawn success → dialog closes, session opens (matching existing behavior).
- Spawn errors → dialog stays open; inline error alert replaces any previous error; spinner clears.
- If the selected runner disappears while the wizard is open:
  - if other runners remain, return to Step 1, clear the runner selection, and show a lightweight "Runner disconnected" message - **preserve any cwd the user had typed** so they don't lose it if they pick another runner;
  - if no runners remain, close the dialog and show the same message outside the modal.
- The wizard uses the existing runner fetch/polling model while open; the green dot reflects the latest fetched connected-runner snapshot, not a separate websocket-specific status channel.

---

## Data & API Changes

### Recent projects meaning

"Recent projects" = **recent working directories you started sessions in**.

- Scope: **per user + per runner**.
- Order: most-recent first.

### Backend cap increase

- Increase `MAX_RECENT_FOLDERS` from **10 → 50**.
- Prune oldest entries beyond 50 per `(userId, runnerId)`.

### Existing recent-project endpoints

- Keep using `GET /api/runners/:runnerId/recent-folders` to fetch recents.
- Keep using the existing `DELETE /api/runners/:runnerId/recent-folders` endpoint for per-row remove actions.
  - Request body: `{ path: string }`.
  - UI behavior: optimistic removal is acceptable, but if the delete request fails, restore the row and show a lightweight inline error.

### Exclude linked/child session spawns

- When spawning via `POST /api/runners/spawn`, only record a recent folder when:
  - `cwd` is present and **non-empty after trimming**, and
  - there is **no validated `parentSessionId`**.
- Here, **validated** means the server resolved the supplied `parentSessionId` to a session owned by the same user and set `validatedParentSessionId` internally before forwarding the spawn to the runner.

This prevents subagent/linked sessions from polluting the user's recent-project list.

---

## Implementation Plan (Structure)

### Shared component

Create a shared UI component, e.g.:

- `packages/ui/src/components/NewSessionWizardDialog.tsx`

It will be used by both:

- `packages/ui/src/App.tsx`
- `packages/ui/src/components/RunnerManager.tsx`

Support two modes:

- **Global** (choose runner)
- **Preselected runner** (skip Step 1)

### Virtualization

Use existing dependency:

- `@tanstack/react-virtual`

Implementation details:

- Fixed row height: **36px**
- `overscan`: **8**
- Dialog list container uses `max-height: 360px` + `overflow-y-auto` so the footer stays visible. On mobile (small viewport), the dialog itself is full-height per shadcn/ui defaults; no separate mobile override is needed.
- Rapid runner switching (user clicks Step-back and picks a different runner before the previous fetch completes) is handled with the standard `cancelled` flag pattern already used in this codebase - stale responses are discarded.
- Virtualizer count is based on the **filtered** list.

---

## Testing

- **Server**: unit tests for recent-folder recording rules:
  - cap/prune behavior at 50 - cap is **per `(userId, runnerId)` pair**
  - does **not** record when spawn includes a validated `parentSessionId`
- **UI**: unit tests for filtering logic (query → filtered list), plus smoke-level rendering tests if appropriate.

---

## Notes

Implementation will be done in an isolated git worktree/feature branch.
