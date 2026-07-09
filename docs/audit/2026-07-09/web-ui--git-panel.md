# Audit: web-ui/git-panel.mdx
Verdict: MAJOR ISSUES
Claims checked: 34 | Failed: 13

## Findings

### [P0] Limitations section denies features the panel actually has
- Claim (Limitations): "No interactive rebase, merge conflict resolution, or stash management." and "No commit amend or history browsing."
- Reality: The panel has a **Stash** tab (`GitStashList`) with push/pop/apply/drop, a **History** tab (`GitHistoryView` + `git_log`), a **Compare** tab (`GitDiffRevsView`), a **Sync** dropdown offering Pull (fast-forward), Pull --rebase, Merge into current, and Rebase onto, plus a conflict-resolution bar with **Continue**/**Abort** rebase and **Abort Merge** buttons. `GitPanel.tsx:30-37` (GIT_TABS), `GitPanel.tsx:108-114` (handleMerge/handleRebase), `GitPanel.tsx:230-285` (Sync dropdown), `GitPanel.tsx:333-385` (conflict bar), `git-service.ts:243-294` (git_pull/merge/merge_abort/rebase/rebase_abort/rebase_continue/stash_*/log/diff_revs/blame). Stash management, history browsing, merge, and rebase all exist; only interactive rebase and amend are genuinely absent.
- Fix: Rewrite Limitations to reflect reality — list what's missing (interactive rebase, amend, hunk staging, discard) and stop claiming stash/history/merge/rebase are unsupported.

### [P1] Doc omits the entire tab system and Sync dropdown
- Claim (panel overview / pushing changes): The page describes only a Staged/Unstaged staging area and a Push/Publish button, with no mention of tabs or sync operations.
- Reality: `GitPanel.tsx:30-37` defines four tabs (Changes, Stash, History, Compare) rendered at `GitPanel.tsx:404-426`; the header has a "Sync" dropdown (`GitPanel.tsx:236-285`) with Pull (ff), Pull --rebase, Merge, Rebase; a separate **Pull** button appears when behind (`GitPanel.tsx:287-302`). None of this is documented.
- Fix: Add a "Tabs" subsection and a "Sync (pull / merge / rebase)" subsection documenting the dropdown and conflict bar.

### [P1] "No upstream" push toast misdescribed
- Claim (Pushing changes): "If the push fails because there is no upstream, the panel shows a toast suggesting you click Publish to retry with --set-upstream."
- Reality: When there is no upstream, the header button itself reads **Publish** and calls `git.push(true)` which runs `push --set-upstream` (`GitPanel.tsx:304-318`, `git-service.ts:1611-1613`), so the user never hits a "no upstream" failure via the button. If a push *does* fail with no upstream, `git-service.ts:1624-1630` sets `noUpstream:true`, and `git-operation-feedback.ts:33-40` renders the toast "This branch has no upstream configured. Set an upstream branch, then pull again." with a **Set upstream…** action (which opens a `window.prompt`, `GitPanel.tsx:88-105`) — not a "Publish" button.
- Fix: Replace the Publish-retry claim with the real "Set upstream…" prompt behavior; clarify the header button already auto-publishes.

### [P1] Unstage command named incorrectly
- Claim (Staging and unstaging): "Click − on a staged file to run `git reset HEAD` on that file."
- Reality: Unstage runs `git restore --staged` (`git-service.ts:1106-1107`: `["restore", "--staged", ":/"]` or `["restore", "--staged", "--", ...paths]`). `git reset HEAD` is not used.
- Fix: Change to "`git restore --staged`".

### [P2] "Collapsible groups" claim is false
- Claim (panel overview): "changes are split into two collapsible groups: Staged Changes / Changes."
- Reality: `GitStagingArea.tsx` renders the two groups as static section headers with no collapse/toggle state; there is, however, an undocumented **list/tree view toggle** at the bottom (`GitStagingArea.tsx:153-172`) and a tree view (`GitChangesTree`).
- Fix: Drop "collapsible"; document the list/tree toggle.

### [P2] Commit form "pinned to the bottom whenever there are changes" is incomplete
- Claim (Writing a commit): "The commit form is pinned to the bottom of the panel whenever there are changes in the working tree."
- Reality: The commit form is rendered only on the **Changes** tab and only when `hasChanges` (`GitPanel.tsx:438-445`, gated by `activeTab === "changes" && hasChanges`). On Stash/History/Compare tabs it is absent.
- Fix: Note the form is shown only on the Changes tab.

### [P2] Pull button and pull/rebase flows undocumented
- Claim (Pushing changes / Branch selector): The page only documents Push/Publish; no Pull.
- Reality: A **Pull** button appears when `behind > 0 && hasUpstream` (`GitPanel.tsx:287-302`), and the Sync dropdown offers Pull (fast-forward) and Pull --rebase (`GitPanel.tsx:240-258`). Pull --rebase resolves upstream and rebases (`git-service.ts:1385-1409`).
- Fix: Document Pull and the two pull modes.

### [P2] Diff view "staged vs unstaged" by section — accurate but the entry point omits tree view
- Claim (Diff view): "clicking a file in the Staged Changes section shows the staged diff, while clicking one in Changes shows the working-tree diff."
- Reality: Verified — staged rows call `onViewDiff(path, true)` and unstaged tracked rows call `onViewDiff(path)` (`GitStagingArea.tsx:69, 137`), routed through `git.fetchDiff(path, staged)` (`GitPanel.tsx:117-128`) which selects `diff --cached` vs `diff` (`git-service.ts:817-818`). Accurate. (No failure.)
- Fix: None needed; note tree-view mode also routes identically.

### [P2] Diff colors table accurate but misses metadata nuance
- Claim (Diff view): Green=added, Red=removed, Blue=hunk headers, Muted=context and metadata.
- Reality: `GitDiffView.tsx:23-29` matches: `+`→green, `-`→red, `@@`→blue, `diff `/`index `→muted/70, default→muted. Accurate. (No failure.)
- Fix: None.

### [P2] Status-code table omits Ignored (`!!`)
- Claim (panel overview table): Lists M, A, D, R, C, ??, MM, AM.
- Reality: `GitStagingArea.tsx:21-50` also handles `!!` (Ignored). The table omits it.
- Fix: Add an `!!` = Ignored row.

### [P2] Toast scope understated
- Claim (Toast notifications): "After each operation (commit, push, checkout, stage, unstage)…"
- Reality: Toasts also fire for pull, merge, rebase (continue/abort), stash ops, set-upstream, and worktree add/remove — any `lastOperationResult` change triggers the toast (`GitPanel.tsx:130-136`). The 5-second auto-dismiss (`GitPanel.tsx:134`) and manual close (`GitPanel.tsx:155-162`) are accurate.
- Fix: Generalize the operation list or say "after any git operation".

### [P3] "branch icon button in the session header toolbar" / mobile overflow — accurate
- Claim (Opening the panel): Desktop branch-icon button; mobile overflow → Git.
- Reality: `SessionViewer.tsx:683-695` renders a `GitBranch` icon button (hidden below md) in the header toolbar; `header-badge.tsx:276-281` adds a "Git" item in the mobile overflow dropdown. Docked/draggable panel wiring via `usePanelLayout.ts:391-395` and `App.tsx:4695-4701`. Accurate. (No failure.)
- Fix: None.

### [P3] "No REST endpoints" — accurate
- Claim (Aside): "communicates with the runner's GitService over a real-time WebSocket channel — there are no REST endpoints involved."
- Reality: `routes/runners.ts:1072-1073` comment: "serviceId='git' which are relayed to the runner's GitService. No REST routes needed — see git-service.ts." Service registered at `daemon.ts:426`. Accurate. (Note: `routes/README.md:73-74` lists `/api/runners/:id/git-status` and `git-diff` routes, but those README entries are stale — no such routes exist in `runners.ts`.)
- Fix: None for this page; consider fixing the stale routes/README.md separately.

## Redesign notes
- The page is structured around an older single-view version of the panel and reads as if Stash/History/Compare/Sync/Worktrees don't exist. Restructure around the four tabs and the Sync dropdown as first-class sections.
- The Limitations section should be a short, accurate "What's not supported" list: interactive rebase, amend, hunk-level staging, working-tree discard, multi-remote push selection.
- Replace the two-status-group "collapsible" framing with: list/tree view toggle + Staged/Changes sections.
- Add a "Sync & conflict resolution" section covering Pull (ff), Pull --rebase, Merge, Rebase, and the conflict bar (Continue/Abort).
- The toast/feedback description should reference the "Set upstream…" action and the warning (nonFastForward) toast type, not just success/error.
- The "Pushing changes" section conflates the header Publish button with a failure-retry toast; split into "Publish (first push)" and "Push" plus the real upstream-prompt fallback.

## Code UX opportunities
- The no-upstream failure toast says "…then pull again" even when the failure came from a *push* (`git-operation-feedback.ts:36`); the message should be operation-aware.
- `handleSetUpstream` uses `window.prompt` (`GitPanel.tsx:88-105`) — a poor mobile experience; a branch-picker would be better and could reuse `GitBranchSelector`'s remote list.
- Merge/Rebase entry points are also `window.prompt` (`GitPanel.tsx:110, 124`); a branch picker dropdown would be more discoverable and consistent with the checkout flow.
- The Sync dropdown is labeled only "Sync" with a `MoreHorizontal` icon (`GitPanel.tsx:236-246`); Pull/Merge/Rebase are hard to discover — consider explicit buttons or a clearer label.
- The Stash/History/Compare tabs have no empty-state guidance for repos with no stash/commits; the diff-revs view could pre-populate base/head from current branch ahead/behind.
- The stale `routes/README.md` entries (`git-status`, `git-diff`) should be removed to avoid confusing future readers about the "no REST" contract.
