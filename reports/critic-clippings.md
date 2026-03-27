
## 2026-03-25 Shift (CLI TUI Refresh)

### What Went Well
- **Sonnet cooks delivered consistently**: 8/8 dishes plated, zero kitchen stoppages
- **Codex critics caught real bugs**: Width overflow in header narrow mode (P1), NO_COLOR spec violation (P2), Gemini color inversion (P2)
- **On-the-fly dishes worked smoothly**: 3 rush orders added mid-service, all served

### What Didn't
- **Worktree false positives**: Critics flagged pre-existing dependency issues (missing bun:test, redis types) as dish failures. 2 of 5 critic reviews were overridden for this reason.
- **Fixer overcorrection on dish 005**: First fixer converted remaining→used for both color AND display number. Round 2 fixer was needed.

### Kitchen Disconnects
- **Dish 002**: Cook didn't test narrow mode edge cases (width < title length). Prompt should have emphasized "test with width=20"
- **Dish 005**: NO_COLOR presence-based semantics weren't in the prompt. Gemini "remaining" vs "used" confusion — prompt should have explicitly flagged the inversion risk.

### Model Insights
- Sonnet 4.6 as cook: reliable for S and M complexity, good at ANSI/box-drawing work
- Codex 5.3 as critic: thorough on width/alignment bugs, good at spec compliance checking, but trips on worktree dependency false positives
- **Recommendation**: Add a note to critic prompts: "Pre-existing typecheck failures from missing bun:test/bun:sqlite types in worktrees are NOT caused by the dish — ignore them."

## 2026-03-25 Shift

### What Went Well
- **Critic security catch**: gpt-5.3-codex correctly identified the P1 fail-open auth pattern in TunnelService (null userId bypass). Security-critical code caught before merge.
- **Two-point announce strategy**: When fixer correctly diagnosed the service_announce timing problem (needs both runner_registered AND session_ready), critics confirmed it on next round.
- **Additive protocol approach**: Dish 002's "additive only" constraint made review tractable — critics could focus on new paths without regression concerns.

### What Didn't
- **Ad-hoc dual-emit is fragile**: Three separate P1s across two dishes came from "apply dual-emit manually to each call site" — cook always missed error/validation paths. An explicit helper requirement in the spec (grep to zero direct calls) would have caught these in expo.
- **Dispatch sequencing**: 003 dispatched before 002 was fully fixed → stale merge caused an unnecessary critic round + merge-forward fixer. Policy: wait for dependency LGTM before dispatching downstream.
- **Timing dependency blindness**: "Emit service_announce after initAll()" spec was ambiguous about the registration handshake. Two consecutive critic rounds found the same class of timing issue.

### Kitchen Disconnects
- **prompt-gap** (4x): Spec didn't require helper function for dual-emit; ad-hoc application always misses non-happy paths
- **missing-context** (2x): Timing dependencies (runnerId, runnerSessionIds population) not called out in spec
- **sequencing-gap** (1x): Parallel dispatch before dependency LGTM

### Model Insights
- gpt-5.3-codex critics: strong on security patterns (auth fail-open caught), thorough on grep verification when instructed
- claude-sonnet-4-6 cooks: reliable at structural refactors; needs explicit helper pattern guidance for complete coverage of all code paths
- False positive rate: 1/9 critic findings (Dish 001 disposeAll on disconnect) — Maître d' correctly overrode

## 2026-03-25 Shift (Extension System Polish — Night Shift 2)

### What Went Well
- **All 4 dishes LGTM first pass**: Zero send-backs across the entire shift. Tight specs produced clean code.
- **Band A dishes delivered fastest**: Dishes 001 and 002 had the clearest specs and highest confidence scores — both plated and served without any issues.
- **Codex critic accuracy**: All 4 critics delivered accurate verdicts. P3 observation on `respond_to_trigger`'s `text.includes("error")` was correct but appropriately non-blocking.
- **Maître d' commit rescue**: Dish 004's cook left changes unstaged. Maître d' caught this via worktree inspection and committed directly — no fixer needed.

### What Didn't
- **Cook left changes unstaged (dish 004)**: Cook completed all 5 changes but failed to `git add` and commit. Maître d' had to commit and push directly. Symptom: cook reported "PR created" but branch was not in remote.
- **PR contamination from local main**: All 4 dish PRs include NS1 cli-colors commits because local main is 3 ahead of origin/main. Future shifts: either ensure local main = origin/main before worktree creation, OR use explicit `--base origin/main` in ns-worktree.sh.
- **Rebase blocked by worktrees**: ns-rebase-prs.sh failed because branches were still checked out in active worktrees. Worktree cleanup must come BEFORE rebase, not after.

### Kitchen Disconnects
- **Dish 004**: Cook completed the task but didn't commit (Kitchen Disconnect category: incomplete delivery). Spec should include explicit "verify `git log` shows your commit" step.

### Model Insights
- Sonnet 4.6 cooks: All delivered correctly. S-complexity dishes need tighter commit-verification in prompts.
- Codex 5.3 critics: High accuracy again. Fast turnaround.
- The Maître d' pattern of reading worktree directly when cook claims success but PR is absent is effective.

### Process Improvements
- Add "verify with `git log --oneline -2` that your commit exists" to cook template's "When Done" section
- Add worktree cleanup step BEFORE rebase in Sidework Step 1

### Health Inspector Findings (2026-03-25 Night Shift 2)
- **Critic accuracy (P0/P1):** 75% (3/4 dishes correctly cleared)
- **Citations:** 2 (Dishes 001, 002 — P3 misses, cosmetic/defensive)
- **Violations:** 1 (Dish 003 — P1 missed by both per-dish and batch critic)
- **Common misses:** Fixer-introduced gaps not caught by re-reviewer; `execute()` return-value enumeration incomplete
- **Model blind spots:** Codex critics strong on spec compliance checking, weak on "did the fixer cover all paths?" enumeration. Batch critic used stale diff context for Dish 003 (reviewed pre-fixer code pattern after fixer had already changed it).
- **Action required:** PR #321 needs manual one-line fix (`|| text.startsWith("Follow-up sent")`) before merge.

### Health Inspector Findings — 2026-03-25 Shift (Runner Service System)
- **Critic accuracy:** 0% (0/4 clean bills — all dishes had missed issues)
- **Common misses:**
  - End-to-end message routing not traced (missed P1 namespace mismatch in Dish 002)
  - SSRF redirect-following not checked despite explicit SSRF review (missed 2x P1 in Dish 004)
  - State lifecycle across reconnect cycles — critics caught initial lifecycle, missed stale state (Dish 003)
  - Listener accumulation risk on init/dispose cycling (Dish 001 P2)
- **Model blind spots:** gpt-5.3-codex strong at pattern matching and grep verification; weak at end-to-end flow tracing and SSRF bypass vectors (redirect, URL authority parsing)
- **Inspector model:** claude-opus-4-6 × 4 (independent sessions, zero critic context)
- **Grade:** D — 2 violations, 2 citations

## 2026-03-25 Shift (Bug Bash — Night Shift 3)

### What Went Well
- **All 4 dishes LGTM first pass**: Zero send-backs. Tight, well-specified tasks with exact line numbers and clear acceptance criteria produced clean, surgical fixes.
- **Band A confidence band accuracy**: All 3 Band-A dishes (001, 002, 004) were genuinely simple — they delivered exactly as specified. Band B (003) also delivered correctly despite the investigation requirement.
- **Codex critics**: Reliable on all P0/P1/P2 issues. 100% accuracy on material concerns across 4 dishes.
- **Health Inspector grade B**: Only P3 citations — no functional issues missed by critics. Safest shift yet.

### What Didn't
- **Derived math not re-verified after constant change (Dish 004)**: Cook updated the constant label in a comment (8MB→6MB) but didn't re-derive the downstream ceiling (≤4→≤3 messages). Pattern: arithmetic in comments needs re-computation when constants change, not just label update.
- **Residual type assertion after `as any` removal (Dish 003)**: After eliminating `as any`, the replacement cast `(session as BetterAuthSession)` was left in place even though direct property access (`session?.user?.id`) compiles without a cast elsewhere in the same function.
- **No shift-report.md from Sidework**: Sidework phase did not produce a shift-report.md. Health Inspector had to create it retroactively.

### Kitchen Disconnects
- **Dish 004**: Math in comments not fully re-derived after constant change. Spec should require explicit math re-verification step for numeric-constant annotation updates.
- **Dish 003**: Post-cast-removal audit step missing. Spec should require: "after removing `as any`, check if replacement cast can also be dropped."

### Model Insights
- gpt-5.3-codex critics: Consistent P0/P1/P2 accuracy. Tend to miss P3 documentation/style gaps (math in comments, residual-cast noise). This is acceptable behavior for a first-pass reviewer.
- claude-sonnet-4-6 cooks: Accurate on all 4 dishes. surgical fix discipline maintained (no scope creep observed).
- Health Inspector (claude-sonnet-4-6): Caught 2 P3 issues missed by critics. Grade B is appropriate.

### Process Improvements
- Add to dish spec template for comment-update dishes: "Re-derive ALL math expressed in comments (e.g., ≤N items fit in X MB) using the new constants. Don't just update the label."
- Add to type-assertion-removal dish template: "After removing `as any`, verify the replacement cast is actually needed. Try direct property access first."
- Fix Sidework to always produce shift-report.md even if shift was unattended.

### Health Inspector Findings (2026-03-25 Night Shift 3 — Bug Bash)
- **Critic accuracy (P0/P1/P2):** 100% (4/4 dishes — no material issues missed)
- **Citations:** 2 (Dishes 003, 004 — P3 only)
- **Violations:** 0
- **Condemned:** 0
- **Common misses:** Derived math not re-verified after constant label change; residual type-assertion noise after `as any` removal
- **Model blind spots:** Codex critics accurate on correctness checks but less thorough on "is this comment still mathematically correct?" and "is this cast now unnecessary?"

## 2026-03-27 Shift (Stability & Infrastructure)

### What Went Well
- **Codex 5.3 as kitchen cook**: 11/13 completed dishes used Codex. Zero Ramsey send-backs from Codex cooks. Excellent on research (tunnel audit: 6 bugs), strong on M-complexity features (1,263-line Godmother panel).
- **Pairing assembly**: 3 pairings assembled with zero merge conflicts across 10 dish branches
- **Godmother triage**: 21 ideas confirmed shipped, net backlog reduced by 16

### What Didn't
- **Session delink**: All 8 child sessions delinked mid-shift. 5 had finished; 3 needed respawning. No work lost but ~30 min delay.
- **L-complexity dishes stall on Codex**: Panel Grid System (L) never committed. Codex strong up to M but may need Opus/brainstorm support for L.
- **Scope creep**: Dish 005 cook included dish 010's clearSelection refactor without being asked.

### Kitchen Disconnects
- **scope-creep** (1x): Cook expanded beyond spec to include neighboring refactor
- **stall** (2x): L and S dishes with no commits — likely model timeout or context exhaustion

### Model Insights
- **Codex 5.3 cook**: Reliable for S–M, excellent on research. Stalls on L.
- **Sonnet 4.6 cook**: Reliable for S, mixed on scope discipline (dish 005 scope creep)
- **Haiku subagents**: Effective for Ramsey expo and reality checks
