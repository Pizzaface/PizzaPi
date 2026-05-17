# Git Panel Branch & Status Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden git panel branch dropdown rendering/data freshness, show correct behind/pull state without local changes, and add a single sync dropdown (pull FF, pull --rebase, merge into current).

**Architecture:** UI changes in git panel components (portalized dropdown, sync menu), hook changes in `useGitService` for full-status fallback + generation guards, and git service changes to support pull rebase flag and merge action. Tests cover fallback, upstream visibility, merge safeguards, and refresh behavior.

**Tech Stack:** React (UI), TypeScript, Bun tests, git service over service_message channel.

---

## File map
- Modify: `packages/ui/src/components/git/GitBranchSelector.tsx`
- Modify: `packages/ui/src/components/git/GitPanel.tsx`
- Modify: `packages/ui/src/hooks/useGitService.ts`
- Modify: `packages/cli/src/runner/services/git-service.ts`
- Tests (likely new/updated):
  - `packages/ui/src/hooks/git-status-refresh-scheduler.test.ts` (if needed)
  - `packages/ui/src/hooks/useGitService` adjacent test (may add new test file)
  - `packages/cli/src/runner/services/git-service.test.ts`

## Tasks

### Task 1: UI – Branch dropdown robustness
**Files:**
- Modify: `packages/ui/src/components/git/GitBranchSelector.tsx`

- [ ] Add portal rendering for dropdown (mount to `document.body`), high z-index token, anchored to trigger width (`min-width` = trigger width, `max-height` with scroll, `max-width: 90vw`). Focus/escape already present; keep focus return on close.
- [ ] Add explicit loading / empty / error states. Show inline spinner while fetching; show "No branches found" when empty; show error text when full-status + fallback fail.
- [ ] On open, trigger branch refresh via full-status request (delegated to hook), debounce duplicate opens, and guard stale responses; close on outside/escape remains. Measure trigger width via ref.
- [ ] Ensure long branch names truncate with tooltip; list scrolls within viewport at narrow widths.

### Task 2: UI – Sync dropdown control
**Files:**
- Modify: `packages/ui/src/components/git/GitPanel.tsx`

- [ ] Add a "Sync" button with dropdown options: Pull (FF), Pull --rebase, Merge branch into current.
- [ ] Disable menu items while an operation is in progress; reuse `operationInProgress` state.
- [ ] For merge option, reuse branch selector as a modal/picker (local + remotes), block self-merge, and pass selected branch to merge action; toast success/error; refresh after.
- [ ] Keep existing Push/Publish buttons; ensure layout responsive and doesn’t clip the new menu.

### Task 3: Hook – Status/branches freshness & guards
**Files:**
- Modify: `packages/ui/src/hooks/useGitService.ts`

- [ ] Ensure initial and post-op refresh use `git_full_status` with fallback to legacy snapshot (status + branches/worktrees). On full-status failure, attempt `git_branches`; annotate UI via state for error/partial (behind/ahead suppressed in partial).
- [ ] On dropdown open, fetch branches via full-status; if failed, fallback to branches; guard with requestId+generation and discard stale responses. Debounce to avoid git spam; optional short TTL before refetch.
- [ ] Keep behind/pull visibility using full-status even when no local changes; show "no upstream" when rev-list fails.
- [ ] On stage/unstage failure, immediately refetch full-status to clear optimistic drift; ensure generation guard so parallel requests don’t overwrite.

### Task 4: Service – pull rebase flag and merge action
**Files:**
- Modify: `packages/cli/src/runner/services/git-service.ts`
- Modify tests: `packages/cli/src/runner/services/git-service.test.ts`

- [ ] Extend `git_pull` handler to accept `rebase` boolean; run `git pull --rebase` when true; keep existing behavior otherwise; update message schema/types so callers stay in sync.
- [ ] Add `git_merge` handler to merge a branch into current: validate branch name (reuse isValidBranchName; reject traversal/specials), run `git merge <branch>`, surface errors (conflicts), and invalidate status cache family.
- [ ] Guard against self-merge and path traversal. Return ok/error payload; no-upstream not required.

### Task 5: Tests
**Files:**
- Modify/add: `packages/cli/src/runner/services/git-service.test.ts`
- Modify/add: UI/hook tests as feasible (e.g., new test file near hook)

- [ ] Test pull with rebase flag invokes `git pull --rebase`.
- [ ] Test merge handler rejects invalid/self branch and emits error on git failure/conflict.
- [ ] Test full-status fallback: full-status fails, branches succeed → UI state marks partial; behind/ahead hidden.
- [ ] Test generation guard drops stale responses when two requests overlap; throttled dropdown open respects debounce/TTL.
- [ ] Test stage/unstage failure triggers immediate full-status refetch (count/assert) if feasible in hook tests.

### Task 6: Verification & handoff
- [ ] Run targeted tests: `bun test packages/cli/src/runner/services/git-service.test.ts` and any added UI/hook tests.
- [ ] Manual smoke: open git panel, branch dropdown renders above content, loads branches; behind/pull shows after fetch with no local changes; sync menu actions disabled while busy; merge error surfaces if conflict.
- [ ] Update Godmother idea status when coding complete.
