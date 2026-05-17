# Git Panel Branch & Status Hardening Design

## Goal
Improve the git panel so the branch dropdown always renders correctly, branches load reliably, behind/ahead state is accurate without needing local changes, and provide a single dropdown control for pull/rebase/merge.

## Scope
- UI: Branch selector visibility/positioning across breakpoints; portalized dropdown with proper z-index and sizing.
- Data freshness: Reliable branch list loading; status shows behind/pull even with no local mutations.
- Controls: Add a single dropdown for pull (FF), pull --rebase, and merge-into-current.
- Non-goals: Conflict resolution UI, cherry-pick UX, stash UI.

## Current pain
- Branch dropdown can render behind/under other elements; sometimes appears empty.
- Behind/pull state often missing until a local change/push occurs.
- Missing merge/rebase control; user wants single dropdown.

## Design

### Branch dropdown robustness
- Render dropdown in a portal with high z-index.
- Anchor width to trigger; `min-width` = trigger width; `max-height` with scroll to avoid clipping.
- Position relative to trigger (top-full/left-0); allow vertical scroll in narrow panes.
- Always fetch branches on open; debounce duplicate opens.
- Distinguish loading vs empty state in the list header; show inline spinner while fetching.
- Respect generation/discard stale responses.

### Branch data freshness
- On dropdown open: request `git_full_status` (status + branches + worktrees). If it fails, fallback to `git_branches` (branches only) and show an inline notice that behind/ahead may be stale until a full-status succeeds; keep current branch from status.
- Invalidate branch list on cwd generation change, after checkout completion, and after branch create/delete (when detected via generation bump or manual refresh).
- Keep branch list in sync with status generation (requestId → generation guard; discard late responses based on generation + requestId tracking).
- Loading/empty/error states: show spinner while fetching; “No branches found” when empty; error banner when both full-status and fallback fail.

### Behind/ahead correctness
- On mount and after pull/push/checkout, request `git_full_status` (not just status); manual refresh also triggers full-status.
- Show behind count and Pull whenever upstream exists, even with zero local changes.
- If `rev-list ... @{u}` fails (no upstream, detached/tag, shallow clone, or fetch missing), show “No upstream” state and hide pull/behind. Do not auto-fetch; rely on user pull/refresh.

### Changed files stability
- Continue optimistic staging; on mutation failure, immediately refetch status (full-status) to avoid drift.
- Post-mutation refresh scheduler triggers full-status so branches/worktrees stay fresh; debounce as today to limit cost.

### Merge/rebase control
- Add single "Sync" button with dropdown options:
  1) Pull (fast-forward)
  2) Pull --rebase
  3) Merge branch into current (opens branch picker, then merge; block self-merge)
- Disable menu items while an operation is in progress; reuse operationInProgress state; toast success/error; after failure, refetch full-status. If merge conflict occurs, surface the error and refresh status (no conflict UI in scope).
- Dirty/staged working tree: allow operations but surface git’s error if it refuses (no pre-guard); toast the error and refresh status. (Future: preflight guard can be added, but not in scope.)

### Responsiveness
- Dropdown `max-width: 90vw` and scroll; trigger text truncates with tooltip for long branch names.
- Works across desktop and narrow panes; portal avoids parent overflow clipping; ensure shared z-index token so other popovers/tooltips stay above content panes when needed.

### Performance/risks
- Full-status is slightly heavier; rely on existing debounce/backoff and non-blocking UI with spinner. Portal/z-index change should not regress other popovers; test layering against existing tooltips/menus.

## Testing plan
- Unit:
  - Generation guard rejects stale responses when multiple opens overlap; requestId+generation enforced.
  - Fallback path: `git_full_status` fails, `git_branches` succeeds → branches render, behind/ahead suppressed with notice.
  - Upstream cases: upstream present, missing, shallow-clone rev-list failure; ensure pull visibility toggles correctly.
  - Stage/unstage failure triggers immediate full-status refetch (assert call count and state reset).
  - Merge option: prevents self-merge; uses selected branch name; on error/conflict, emits error and refetches status.
- UI behavior (manual/Playwright if available):
  - Branch dropdown renders above neighbors, scrolls within viewport at 1024px and 1440px; long names truncated with tooltip.
  - Branch list reloads on open; shows loading then items; empty state when none; shows error state when both calls fail.
  - Behind/pull shows after `git fetch` without local changes; disappears when no upstream.
  - Pull FF, Pull --rebase, Merge into current trigger correct service calls; toasts shown; items disabled during in-progress op.
  - Failure in stage/unstage triggers immediate status refetch.

## Rollout / risks
- Portal/z-index changes could affect layering: verify other popovers unaffected.
- Full-status on interactions increases git calls slightly; mitigated by existing debounce.
- Merge action needs explicit branch selection to avoid accidental merges.
