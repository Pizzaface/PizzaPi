# Git UX Contract — shared spec for parallel agents

All agents implement against this contract exactly. Field names, types, and
message types must match. The integration step (GitPanel.tsx) depends on this.

## Architecture recap

- Backend: `packages/cli/src/runner/services/git-service.ts` handles
  `service_message` envelopes with `serviceId="git"`. Each op is a
  `git_<op>` message → `git_<op>_result` response (via `this.emit(...)`).
- UI hook: `packages/ui/src/hooks/useGitService.ts` wraps
  `useServiceChannel("git")`, exposes typed actions + reactive state.
- UI components: `packages/ui/src/components/git/`.

## New GitService message types (backend)

Add `case` branches + `handleX` methods. All use `validateCwd` and `emit/emitError`
following existing patterns. Result type naming: `git_<op>_result`.

### Stash

```ts
// git_stash_list → git_stash_list_result
type GitStashEntry = {
  index: number;        // stash@{0} index
  ref: string;          // "stash@{0}"
  message: string;      // stash message
  shortHash: string;    // abbreviated commit
  date: string;         // relative or ISO date
};
// result: { ok: true, stashes: GitStashEntry[] }

// git_stash_push → git_stash_result
//   payload: { cwd, message?: string, includeUntracked?: boolean }
//   result: { ok: true, message?: string }   // emitError on failure

// git_stash_pop → git_stash_result
//   payload: { cwd, index?: number }   // default 0
//   result: { ok: true, message?: string }

// git_stash_apply → git_stash_result
//   payload: { cwd, index?: number, keep?: boolean }
//   result: { ok: true, message?: string }

// git_stash_drop → git_stash_result
//   payload: { cwd, index?: number }
//   result: { ok: true, message?: string }
```

Stash mutations must acquire `_activeRepoMutations` lock (like checkout/merge).
On conflict (pop/apply), result must include `conflict: true` so the UI can
surface it.

### Log / file history

```ts
// git_log → git_log_result
//   payload: { cwd, path?: string, limit?: number, revisionRange?: string }
//     - path: repo-root-relative file/dir path; omit for full repo log
//     - limit: default 50, max 200
//     - revisionRange: e.g. "main..HEAD" or "abc123..def456"; omit for HEAD
type GitLogEntry = {
  hash: string;         // full or short (use short, 7+ chars)
  shortHash: string;
  author: string;
  authorDate: string;   // ISO
  commitDate: string;   // ISO
  subject: string;      // first line
  body: string;         // rest, may be ""
  refs: string[];       // branches/tags pointing at this commit (short names)
};
// result: { ok: true, entries: GitLogEntry[] }
```

Use `git log --format=...` with a parseable separator. Parse carefully.

### Diff two revisions

```ts
// git_diff_revs → git_diff_revs_result
//   payload: { cwd, base: string, head: string, path?: string }
//     - base/head: any revision (sha, branch, tag, HEAD~3, etc.)
//     - path: optional repo-root-relative path
//   result: { ok: true, diff: string }   // raw `git diff base head [-- path]` output
```

Resolve repo root like `handleDiff` does (paths are repo-root-relative).

### Blame

```ts
// git_blame → git_blame_result
//   payload: { cwd, path: string, revision?: string }
//     - path: repo-root-relative, REQUIRED
//     - revision: optional rev; default HEAD
type GitBlameLine = {
  hash: string;         // short commit hash
  author: string;
  authorDate: string;   // ISO
  summary: string;      // commit subject for the blamed commit
  finalLine: number;   // 1-indexed line in final file
  sourceLine: number;  // 1-indexed line in original
};
// result: { ok: true, lines: GitBlameLine[], content: string[] }
//   content: array of final file lines (so UI can render side-by-side without re-reading the file)
```

Use `git blame --line-porcelain` and parse. `content` = `git show <rev>:<path>` lines.

## Hook additions (useGitService.ts)

Add to `UseGitServiceReturn` interface AND implement:

```ts
// Stash
stashList: () => void;                              // reactive state: stashes
stashPush: (message?: string, includeUntracked?: boolean) => void;
stashPop: (index?: number) => void;
stashApply: (index?: number, keep?: boolean) => void;
stashDrop: (index?: number) => void;
stashes: GitStashEntry[];     // new reactive state

// History
fetchLog: (path?: string, limit?: number, revisionRange?: string) => Promise<GitLogEntry[]>;
log: GitLogEntry[];          // new reactive state (most recent fetchLog result)

// Diff two revs
fetchDiffRevs: (base: string, head: string, path?: string) => Promise<string>;

// Blame
fetchBlame: (path: string, revision?: string) => Promise<GitBlameLine[]>;
blame: { lines: GitBlameLine[]; content: string[] } | null;  // new reactive state
```

Export types `GitStashEntry`, `GitLogEntry`, `GitBlameLine` from the hook module.

Promise-based methods (`fetchLog`, `fetchDiffRevs`, `fetchBlame`) follow the
existing `fetchDiff` pattern: pending-request map keyed by requestId, resolve
on result message, reject/timeout on error. Stash mutations follow the existing
`commit`/`push` action pattern (fire-and-refresh; trigger status refresh after).
Add stash to the post-mutation refresh scheduler.

## New UI components (new files in packages/ui/src/components/git/)

All must be responsive (see Responsiveness section). Use existing shadcn/ui +
TailwindCSS v4 + lucide-react icons, matching existing component style.

- `GitStashList.tsx` — list `stashes` with push (message input + untracked
  checkbox), pop/apply/drop buttons per row. Confirm drop. Show operation
  feedback via existing `getGitOperationFeedback`.
- `GitHistoryView.tsx` — repo or file history. Props: `cwd`, optional `path`.
  Uses `fetchLog`. List of `GitLogEntry` rows (subject, author, relative date,
  short hash, refs badges). Click a commit → opens diff against its parent
  (calls `fetchDiffRevs(entry.hash, entry.hash + "^")` or `fetchDiffRevs` with
  selected pair when two are selected). "Show file history" mode: pass `path`.
- `GitBlameView.tsx` — props: `cwd`, `path`, optional `revision`. Uses
  `fetchBlame`. Renders blame gutter (hash + author + date) per line alongside
  `content`. Group consecutive lines with same hash. Click a line's hash →
  option to view that commit's diff.
- `GitDiffRevsView.tsx` — two-revision picker. Uses `branches` + recent
  `fetchLog` entries as rev options. Calls `fetchDiffRevs(base, head, path?)`.
  Reuses `GitDiffView`'s diff rendering (extract its diff-parsing/render if
  needed; if extraction would modify GitDiffView, DON'T — instead duplicate
  the render logic here to keep file ownership clean).

Update `index.ts` to export all four new components. Do NOT modify
`GitDiffView.tsx`, `GitPanel.tsx`, or any existing component.

## Responsiveness bar (applies to existing AND new)

Target: usable at phone portrait (min-width 360px) through ultrawide.

Rules:
- No fixed pixel widths; use `min-w-0`, `flex` with `min-w-0` children, and
  `truncate` for overflow text. Avoid horizontal scroll.
- Diff views: wrap long lines with horizontal-scroll only on the diff code
  block (not the whole panel). Use `overflow-x-auto` on the `<pre>`/code
  element, not its container.
- Staging area / branch selector / commit form: stack vertically below
  `sm:` breakpoint; side-by-side above. Use Tailwind responsive prefixes
  (`flex-col sm:flex-row`, `w-full sm:w-auto`).
- Buttons: full-width tap targets on mobile (`w-full sm:w-auto`), min height
  36px.
- Tables/lists: single-column on mobile, multi-column on `md:`.
- Avoid `min-w-[Npx]` that exceeds 360px. Test mental model: does it render at
  360×640 without horizontal page scroll?

## File ownership (DO NOT cross these boundaries)

- Backend agent: `packages/cli/src/runner/services/git-service.ts`,
  `packages/cli/src/runner/services/git-service.test.ts`
- Hook agent: `packages/ui/src/hooks/useGitService.ts`,
  `packages/ui/src/hooks/useGitService.test.ts` (create if missing)
- Components agent: NEW files `GitStashList.tsx`, `GitHistoryView.tsx`,
  `GitBlameView.tsx`, `GitDiffRevsView.tsx`, + `index.ts`
- Responsive agent: `GitStagingArea.tsx`, `GitBranchSelector.tsx`,
  `GitDiffView.tsx`, `GitWorktreeList.tsx`, `GitCommitForm.tsx`,
  `GitPanel.test.tsx`
- Integration (parent, not a subagent): `GitPanel.tsx` — wires status row +
  new component tabs, applies responsive layout to the panel shell.

Your local `bun run typecheck` may show errors from OTHER agents' not-yet-
landed files (e.g. components importing hook methods that the hook agent is
writing in parallel). That is expected. Adhere to this contract precisely;
the parent runs the final integrated typecheck.