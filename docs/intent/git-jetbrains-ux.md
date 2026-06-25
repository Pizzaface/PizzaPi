# Intent: JetBrains-grade git UX in PizzaPi

Confirmed intent from interview-me session (2026-06-25).

## Outcome
A git experience in PizzaPi that approaches JetBrains, with groundwork laid so a future per-session "what the agent changed" changelist can reuse the same infrastructure.

## User
Jordan — using PizzaPi from mobile *and* desktop browsers, often without terminal access.

## Why now
Existing `GitPanel`/`GitService` are solid for mutations (checkout/stage/commit/push/pull/merge/rebase/worktree) but gaps make it feel incomplete vs an IDE: no history navigation, no stash, status buried, panel doesn't reflow on narrow screens.

## Success criteria
- **Status on demand:** compact status row *inside* the GitPanel (branch + dirty + last commit). No header strip.
- **History navigation:** blame/annotate, per-file history, diff any two revisions — all from the UI.
- **Stash:** list/pop/apply/drop from the panel.
- **Responsive:** existing GitPanel *and* every new surface reflow cleanly down to phone-portrait width.
- **Changelist-ready:** diff/history infrastructure designed so a future per-session changelist (diff session-start commit → HEAD + working changes) can reuse it. Changelist UI itself is *not* built this round.

## Constraints
- May use a well-established git library (e.g. `simple-git`). Not mandatory; shell-out still fine where simpler.
- Build on the existing `GitService` `service_message` channel architecture.
- Responsiveness bar applies to the existing panel too, not just new surfaces.

## Out of scope
- The per-session changelist UI itself (groundwork only this round).
- A per-session commit/PR timeline.

## Execution
- Worktree: `feat/git-history-stash-responsive` off `origin/main`.
- Fan out subagents on `kimi-k2.7-code`; `deepseek-v4-pro` validates.
- Godmother idea: `E2S0sgbl` (epic `28Q-_3KuSY53ZwHa6rmxY`).