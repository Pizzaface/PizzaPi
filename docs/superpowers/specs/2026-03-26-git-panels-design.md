# Git Panels — Design Spec

**Date:** 2026-03-26
**Status:** Draft
**Scope:** Expand the existing git panel into three independent panels — Git Changes, Git Graph, and Branches — each registering as its own CombinedPanel tab with independent positioning.

---

## Overview

The current git integration is a single `GitChangesView` component embedded in `FileExplorer.tsx`. It shows branch name, ahead/behind counts, staged/unstaged files, and per-file diffs. This spec expands git support into three independent, fully interactive panels with staging, commits, push/pull, a DAG commit graph, and branch management.

## Goals

- Full staging + commit workflow from the UI (stage/unstage individual files, write commit message, commit)
- Push/pull from the UI
- DAG commit graph with colored branch lanes (VS Code / GitLens style)
- Branch management: list, checkout, create, delete, simple merge
- Each feature is its own independently-positionable panel
- Extract git code out of `FileExplorer.tsx` into a dedicated `git/` directory

## Non-Goals

- Merge conflict resolution UI (follow-up — logged in Godmother)
- Interactive rebase
- Remote management (add/remove remotes)
- Stash management
- Submodule support

---

## Architecture

### File Structure

**UI — new `git/` directory:**
```
packages/ui/src/components/git/
  GitChangesPanel.tsx    — staging, commit, push/pull (migrated from GitChangesView)
  GitGraphPanel.tsx      — DAG commit history renderer
  BranchesPanel.tsx      — branch list with checkout/create/delete
  DiffViewer.tsx         — shared diff display component (extracted from GitChangesView)
  shared.ts              — status label helper, color constants, branch name validation
  types.ts               — shared interfaces (GitCommit, GitBranch, GitStatus, etc.)
```

**Backend — expand existing service:**
```
packages/cli/src/runner/services/git-service.ts
```

**Server — extracted routes:**
```
packages/server/src/routes/runners-git.ts
```

**Protocol — new event types:**
```
packages/protocol/src/runner.ts
```

### Migration

`GitChangesView` moves from `FileExplorer.tsx` into `git/GitChangesPanel.tsx`. Shared helpers (`gitStatusLabel`, `GitChange` type, status icon/color mapping) move to `git/shared.ts`. `FileExplorer.tsx` drops ~250 lines and loses all git-related code. Import paths in `App.tsx` update accordingly.

### Panel Registration

Each panel registers in `App.tsx` as its own `CombinedPanelTab` with:
- Own position state (persisted in localStorage)
- Own toggle button in the SessionViewer header
- Own close handler
- Own drag-to-reposition support

**localStorage keys:**
- Git Changes: migrate from existing `pp-git-position` key (no change needed — same panel, same key)
- Git Graph: `pp-git-graph-position`
- Branches: `pp-branches-position`

This follows the exact pattern used by `terminalPanelTab`, `filesPanelTab`, and the current `gitPanelTab`.

### Cross-Panel Coordination

`App.tsx` holds a `gitRefreshSignal` as a `useState<number>` counter, passed as a prop to each git panel. The following write operations increment the signal: `git_stage`, `git_unstage`, `git_commit`, `git_push`, `git_pull`, `git_checkout`, `git_branch_create`, `git_branch_delete`, `git_merge`. Read operations (`git_log`, `git_branches`, `git_show`, `git_show_file_diff`, `git_status`, `git_diff`) do not. All three git panels subscribe to this signal and re-fetch their data when it changes.

### Empty & Error States

All three panels handle these common states:
- **No git repo:** If `git rev-parse` fails (no `.git` directory), show: "Not a git repository" with a muted icon. No further commands attempted.
- **Detached HEAD:** Branch name shows "HEAD detached at `<short-hash>`" instead of a branch name. Push/pull buttons disabled. Branches panel highlights no current branch.
- **No upstream / no remote:** If the current branch has no upstream tracking branch (or no remotes exist), push/pull buttons show as disabled with a tooltip: "No upstream configured." The `git_status` command already detects this (the `rev-list --left-right HEAD...@{u}` call fails) — the frontend treats missing ahead/behind data the same as 0 but with the "no upstream" tooltip instead.
- **Network errors (push/pull):** Inline error message with retry option. Don't block the rest of the panel.
- **Loading states:** Spinner on initial load, inline skeleton on refresh.

---

## Panel 1: Git Changes Panel

Evolved from the existing `GitChangesView`. Keeps the current name and toggle.

### Current Features (preserved)
- Branch name display with ahead/behind badges
- Staged vs unstaged file lists with status icons (M, A, D, R, ??)
- Click a file → view its diff (existing diff viewer)
- Refresh button

### New: Commit Workflow

Located at the top of the panel, above the file lists.

- **Subject line input** — always visible when there are staged changes. Placeholder: "Commit message..."
- **Body textarea** — collapsed by default. Expands on click or when the user presses Enter in the subject line. Optional.
- **Commit button** — disabled when subject is empty OR no staged files exist. Shows spinner while committing.
- **Keyboard shortcut:** `Cmd+Enter` (Mac) / `Ctrl+Enter` (other) triggers commit from either input.
- After successful commit: clear inputs, refresh file lists, flash a brief success indicator.

### New: Staging Controls

Per-file buttons on each row:
- **Unstaged files:** `+` button on hover → runs `git add -- <path>`
- **Staged files:** `−` button on hover → runs `git restore --staged -- <path>`
- **Bulk actions** in section headers: "Stage All" / "Unstage All" buttons

### New: Push/Pull Actions

In the branch header row, next to the branch name:
- **Push button** — shows ahead count as badge. Runs `git push`. Spinner while in-flight. Error shown inline (e.g., "rejected — pull first").
- **Pull button** — shows behind count as badge. Runs `git pull`. Spinner while in-flight. Success shows pulled commit count briefly.
- Both buttons show as disabled (greyed out, no click handler) when ahead/behind is 0. They remain visible so the layout is stable and keyboard navigation is predictable.

---

## Panel 2: Git Graph Panel

New panel. Working label: **"Git Graph"** (used in toggle button, panel header, localStorage key). Rename is a follow-up if a better name surfaces.

Shows a scrollable DAG of commits with colored branch lanes.

### Data Model

Each commit from the backend:
```typescript
interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;       // first line only for the list
  author: string;
  authorEmail: string;
  date: string;          // ISO 8601
  parents: string[];     // parent hashes (0 = root, 1 = normal, 2+ = merge)
  refs: string[];        // branch/tag names pointing at this commit
}
```

Each branch from the backend:
```typescript
interface GitBranch {
  name: string;           // e.g. "main", "feat/git-panel"
  current: boolean;       // true if this is the checked-out branch
  remote: boolean;        // true for remote-tracking branches (e.g. "origin/main")
  remoteName?: string;    // e.g. "origin" — only set for remote branches
  lastCommitHash: string; // short hash of tip commit
  lastCommitMessage: string; // first line of tip commit message
  lastCommitDate: string; // ISO 8601
}
```

### Rendering

- **HTML/CSS rows** — no canvas or SVG. Each row is a flex container. Lane cells are fixed-width spans with colored dots, vertical lines (border-left), and connector characters for forks/merges.
- **Lane colors** — stable per branch. Hash the ref name to pick from a 10-color palette. Consistent across refreshes.
- **Row contents:** graph lanes | commit dot | short hash | ref badges | message | author | relative time
- **Max lanes:** Cap at 8 visible lanes. When a 9th lane would be needed, the rightmost (oldest) active lane is visually merged into a single "overflow" column with a distinct muted color. The overflow column shows a simple vertical line — individual commits in it are still rendered as dots, but no fork/merge connectors are drawn within the overflow zone.

### Lane Assignment Algorithm

Frontend computes lane positions from the commit list (received in topological order):

1. Maintain an ordered list of active lanes, each tracking a commit hash it's "waiting for" (the next commit in that lane).
2. For each commit, find which lane(s) expect it (from parent pointers of previous commits).
3. Place the commit in one of those lanes (prefer reusing the leftmost).
4. If the commit has multiple parents (merge), draw connector lines from the other parent lanes into this lane.
5. If the commit has multiple children (fork point), the additional children spawn new lanes to the right.
6. When a lane's commit is reached with no further continuation, close the lane.

This is the standard `git log --graph` algorithm. Plenty of reference implementations exist.

### Interactions

- **Click a commit** → expand inline to show: full commit message, author + email, full date, list of changed files with status icons. The expansion replaces the graph rows below the clicked commit (push them down), similar to an accordion.
- **Click a changed file** in the expanded commit → replaces the graph panel content with a full-panel diff view (same pattern as the existing diff viewer in GitChangesView: back arrow in a header bar to return to the graph). Reuses a shared `DiffViewer` component extracted from the current diff rendering code in `GitChangesView` into `git/DiffViewer.tsx`.
- **Click a local branch ref badge** → checkout that branch (with confirmation dialog). Remote branch refs (e.g., `origin/main`) and tag refs are displayed but not clickable — they are informational only, consistent with the Branches panel where remote branches are read-only.
- **Scroll to bottom** → fetch next page (50 commits per page). Uses offset-based pagination (`--skip`). Known limitation: if new commits arrive between page loads, the window may shift slightly. Acceptable for this use case — cursor-based pagination is a possible future optimization.
- **Refresh button** → reload from HEAD.

---

## Panel 3: Branches Panel

New panel. Lists all branches with management actions.

### Layout

- **Search/filter input** at top — filters by branch name as you type.
- **Local Branches section** — each row shows: branch name, last commit subject (truncated), relative time.
- **Current branch** highlighted with a distinct indicator (e.g., checkmark icon or accent color).
- **Remote Branches section** (collapsible, collapsed by default) — shows `origin/main`, `origin/feat/...`, etc. Read-only, for context.

### Interactions

- **Click a local branch** → checkout. If uncommitted changes exist, show confirmation: "You have uncommitted changes. Switch anyway?" (git checkout handles this — it'll fail if changes would be overwritten, which we surface as an error).
- **"New Branch" button** → reveals an inline text input. Creates branch from HEAD via `git checkout -b <name>`. Input validates branch name against `^[a-zA-Z0-9_./-]+$`.
- **Delete button** (trash icon on hover, non-current branches only) → confirmation dialog → `git branch -d <name>`. If branch is unmerged, show warning with option to force delete (`-D`).
- **Merge button** (on non-current local branches) → confirmation: "Merge <branch> into <current>?" → runs `git merge <branch>`. On clean merge: success, all panels refresh. On conflict: auto-abort (`git merge --abort`), show error: "Merge conflicts detected — resolve in terminal."
- **Remote branches** are display-only.

---

## Backend: Runner Service

All new commands are added to `git-service.ts`, following the existing pattern:
- `execFile` with argv arrays (no shell, no injection risk)
- `isCwdAllowed()` guard on every command
- Results emitted via `emitFileResult` helper (both direct and service envelope channels)
- `requestId` threaded through for response correlation

### New Commands

| Command | Git invocation | Timeout | Notes |
|---------|---------------|---------|-------|
| `git_stage` | `git add -- <paths>` | 5s | `paths: string[]` |
| `git_unstage` | `git restore --staged -- <paths>` | 5s | `paths: string[]` |
| `git_commit` | `git commit -m <subject> [-m <body>]` | 30s | Returns `{ hash, message }` |
| `git_push` | `git push` | 30s | Returns `{ ok, message }` |
| `git_pull` | `git pull` | 30s | Returns `{ ok, message, newCommits }` |
| `git_log` | `git log --format=<fmt> --all --topo-order -n <limit> --skip <offset>` | 10s | Returns `{ commits: GitCommit[] }` |
| `git_show` | `git show --stat --name-status --format=<fmt> <hash>` | 10s | Returns `{ commit: GitCommit, body: string, files: Array<{ status: string; path: string }> }` |
| `git_show_file_diff` | `git diff <hash>^..<hash> -- <path>` | 10s | One file at one commit. Backend first runs `git rev-parse <hash>^` to check for a parent. If it fails (root commit), falls back to `git diff-tree --root -p <hash> -- <path>`. |
| `git_branches` | `git branch -a --format='%(refname:short)%09%(objectname:short)%09%(contents:subject)%09%(committerdate:iso)'` | 10s | Returns `{ local: GitBranch[], remote: GitBranch[] }`. Single call, no N+1. |
| `git_checkout` | `git checkout <branch>` | 10s | Returns new branch name |
| `git_branch_create` | `git checkout -b <name>` | 10s | Returns new branch name |
| `git_branch_delete` | `git branch -d/-D <name>` | 10s | `force: boolean` for `-D` |
| `git_merge` | `git merge --no-edit <branch>` | 30s | On conflict: `git merge --abort`, return error |

### Input Validation

- **Branch names:** validated against `^[a-zA-Z0-9_./-]+$` before any branch operation. Reject names starting with `-`.
- **Commit hashes:** validated against `^[0-9a-f]{4,40}$`.
- **File paths:** passed through `isCwdAllowed()` — no path traversal.
- **Commit messages:** passed as separate `-m` arguments to `execFile`, never shell-interpolated.

---

## Server Routes

Extract existing `git-status` and `git-diff` routes from `runners.ts` into a new `runners-git.ts`. Add routes for each new command.

All routes follow the same pattern:
1. Authenticate request (session cookie or bearer token)
2. Look up runner, verify it's connected
3. Parse and validate body (`cwd`, command-specific params)
4. Check `cwdMatchesRoots()` — reject if cwd is outside the runner's allowed workspace roots
5. `sendRunnerCommand()` to forward to the runner
6. Return structured JSON response

### Route Table

| Method | Path | Runner Command |
|--------|------|----------------|
| POST | `/api/runners/:id/git-status` | `git_status` (existing) |
| POST | `/api/runners/:id/git-diff` | `git_diff` (existing) |
| POST | `/api/runners/:id/git-stage` | `git_stage` |
| POST | `/api/runners/:id/git-unstage` | `git_unstage` |
| POST | `/api/runners/:id/git-commit` | `git_commit` |
| POST | `/api/runners/:id/git-push` | `git_push` |
| POST | `/api/runners/:id/git-pull` | `git_pull` |
| POST | `/api/runners/:id/git-log` | `git_log` |
| POST | `/api/runners/:id/git-show` | `git_show` |
| POST | `/api/runners/:id/git-show-file-diff` | `git_show_file_diff` |
| POST | `/api/runners/:id/git-branches` | `git_branches` |
| POST | `/api/runners/:id/git-checkout` | `git_checkout` |
| POST | `/api/runners/:id/git-branch-create` | `git_branch_create` |
| POST | `/api/runners/:id/git-branch-delete` | `git_branch_delete` |
| POST | `/api/runners/:id/git-merge` | `git_merge` |

---

## Protocol Changes

Add to `RunnerServerToClientEvents` in `packages/protocol/src/runner.ts` (server → runner direction, matching the existing `git_status` and `git_diff` events). All responses flow back through the generic `file_result` event on `RunnerClientToServerEvents`, correlated by `requestId`.

```typescript
git_stage: (data: { requestId?: string; cwd: string; paths: string[] }) => void;
git_unstage: (data: { requestId?: string; cwd: string; paths: string[] }) => void;
git_commit: (data: { requestId?: string; cwd: string; subject: string; body?: string }) => void;
git_push: (data: { requestId?: string; cwd: string }) => void;
git_pull: (data: { requestId?: string; cwd: string }) => void;
git_log: (data: { requestId?: string; cwd: string; limit?: number; offset?: number }) => void;
git_show: (data: { requestId?: string; cwd: string; hash: string }) => void;
git_show_file_diff: (data: { requestId?: string; cwd: string; hash: string; path: string }) => void;
git_branches: (data: { requestId?: string; cwd: string }) => void;
git_checkout: (data: { requestId?: string; cwd: string; branch: string }) => void;
git_branch_create: (data: { requestId?: string; cwd: string; name: string }) => void;
git_branch_delete: (data: { requestId?: string; cwd: string; name: string; force?: boolean }) => void;
git_merge: (data: { requestId?: string; cwd: string; branch: string }) => void;
```

---

## Security

- **No shell execution.** All git commands use `execFile` with argv arrays. Commit messages, branch names, and paths are never interpolated into shell strings.
- **Workspace root enforcement.** Every command checks `isCwdAllowed()` on the runner. Every server route checks `cwdMatchesRoots()` before forwarding.
- **Input validation.** Branch names: `^[a-zA-Z0-9_./-]+$`, no leading `-`. Commit hashes: `^[0-9a-f]{4,40}$`. Paths validated by the workspace root check.
- **Auth on every route.** All server routes require authentication (session cookie or bearer token). No anonymous access.
- **Safe defaults.** Branch delete uses `-d` (safe) by default. Force delete requires explicit `force: true`. Merge auto-aborts on conflict.

---

## Testing

### UI Tests

- **`GitChangesPanel.test.ts`** — commit button enable/disable logic (no staged files, empty subject, etc.), staging/unstaging state transitions, push/pull button state.
- **`GitGraphPanel.test.ts`** — lane assignment algorithm: linear history, single fork, single merge, multiple branches, octopus merge, max-lane collapse. Pure function tests, no DOM.
- **`BranchesPanel.test.ts`** — filter/search logic, local vs remote grouping, branch name validation.
- **`shared.test.ts`** — status label helper, branch name validation regex, color assignment.

### Backend Tests

- **`git-service.test.ts`** — mock `execFile` for each new command handler. Test: correct argv construction, error handling, `isCwdAllowed` rejection, timeout values, response parsing, branch name validation rejection.

### Server Tests

- **`runners-git.test.ts`** — route auth enforcement, roots validation, body parameter validation, proper forwarding to runner, error response shapes.

---

## Follow-ups (out of scope)

- **Merge conflict resolution UI** — when a merge hits conflicts, provide a UI to view conflict markers, pick ours/theirs per file, and continue/abort the merge. Logged in Godmother.
- **Git Graph panel naming** — the panel needs a user-facing name better than "Git Graph". TBD.
- **Stash management** — stash/pop/list from the UI.
- **Interactive rebase** — reorder/squash/edit commits.
- **Blame view** — per-line blame annotations in the file viewer.
