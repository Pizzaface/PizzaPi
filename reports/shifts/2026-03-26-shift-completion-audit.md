# Night Shift Completion Audit — 2026-03-26

**Inspector:** Health Inspector (Shift Completion Focus)
**Scope:** All shifts from 2026-03-25 evening through 2026-03-26 morning
**Focus:** Agent failure to complete shifts — friction points where agents get lost

---

## Executive Summary

**Zero out of three shifts from last night completed the full lifecycle.** The cooks largely did their jobs — dishes were coded, tested, pushed, and PRs created. But the Maître d' (orchestrator agent) failed to reach Sidework in every case, leaving shifts without morning reports, Godmother updates, batch critic reviews, or worktree cleanup.

This is the dominant failure mode: **the orchestrator dies while the workers survive.**

---

## Shifts Audited

| Shift ID | Type | Phase Reached | Shift Report? | Dishes Planned | Dishes Served | PRs Created |
|----------|------|---------------|---------------|----------------|---------------|-------------|
| 20260325-224805-abandoned | Main | Prep (brainstorm) | ❌ | 0 | 0 | 0 |
| 20260325-231756 | Main | Kitchen (partial Sidework) | ❌ | 5 | 5* | #337–339 |
| 20260325-231756-cc | Critic's Choice | Kitchen (waves complete) | ❌ | 4 waves | 4 waves | #340–343 |
| 20260326-054519 | Follow-up | Kitchen (cooks dispatched) | ❌ | 5 | ~4* | #345–348 |

\* Dishes were cooked and PRs created by autonomous cook sessions, but the Maître d' never recorded their completion.

### Additional Context: Older Abandoned Shifts (Pattern Confirmation)

| Shift ID | Phase Reached | Notes |
|----------|---------------|-------|
| 20260324-000604-abandoned | Pre-Prep | Empty manifest, empty incidents — died immediately |
| 20260324-230435 | Pre-Prep | Empty files — agent never logged anything |
| 20260324-230928 | Pre-Prep | Empty files — third consecutive silent death |
| 20260325-043904-abandoned | Served (4 dishes) | All 4 dishes served, but shift was abandoned when a new shift started. D-grade inspection. |

---

## Friction Point Analysis

### FP-1: Maître d' Context Window Exhaustion (CRITICAL — Root Cause)

**Impact:** Every shift from last night  
**Severity:** P0  
**Pattern:** The Maître d' runs out of context during Kitchen orchestration and silently stops tracking the shift.

**Evidence:**
- Shift `20260325-231756`: All 5 dishes passed Ramsey, PRs were created (#337-339), but:
  - Session-viewer-polish pairing file still shows `status: queued` despite PR #339 having 4 real commits
  - No shift-report.md, no batch critic, no Godmother updates
  - The Maître d' transitioned to a Critic's Choice continuation shift instead of completing Sidework
- Shift `20260325-231756-cc`: 6 scouts dispatched, 62 bugs found, 4 waves served (PRs #340-343), but no Sidework
- Shift `20260326-054519`: 4 cooks dispatched and completed their work (PRs #345-348 exist with real commits), but:
  - Dish files still show `status: cooking` — never updated
  - Manifest still shows sessions as `cooking` — never updated
  - Dish 002 (hub-socket-dedup) shows `status: queued` despite the branch having commits AND the pairing being assembled

**Root Cause:** The SKILL.md is 1542 lines (50KB). A single shift requires the Maître d' to:
1. Read the full skill (~50KB)
2. Read the maitre-d.md agent identity
3. Read 5+ prior shift reports (Step 5) — easily another 30-50KB
4. Spawn brainstormers and process their output
5. Score confidence for each dish
6. Enter Kitchen and handle triggers from N concurrent cook sessions
7. Run Ramsey expo for each dish
8. Handle pairing assembly
9. Dispatch critics and process their triggers
10. Complete Sidework (6 steps)

The "Clear Context & Begin" handoff at Step 14 helps, but after clearing, the agent must re-read the skill and reconstruct state from disk. Kitchen orchestration with 4-5 parallel cooks generates massive trigger traffic that rapidly fills the new context window.

**The result:** Cooks autonomously complete their work and push PRs. The Maître d' loses track and never completes the bookkeeping.

### FP-2: Silent Pre-Prep Death (HIGH)

**Impact:** 3 shifts (20260324-000604, 20260324-230435, 20260324-230928)  
**Severity:** P1  
**Pattern:** Agent creates the shift folder, initializes empty files, then dies without logging anything.

**Evidence:**
- Three shifts with completely empty `manifest.md` and `incidents.md`
- No error messages, no incidents, no diagnostic info
- The shift folders exist with the empty scaffolding but zero content

**Root Cause Hypotheses:**
1. Pre-flight check fails silently (git pull conflict, MCP unreachable) and the agent crashes rather than logging the failure
2. The agent hits an error reading the massive SKILL.md file and loses its thread
3. Context was already partially consumed from a prior session, leaving insufficient room for Prep
4. The runner session itself was killed/restarted (LaunchAgent restart, machine sleep)

**Gap:** There is no "heartbeat" or "shift-started" sentinel that would help diagnose these. The empty files tell us the agent _began_ but not _why_ it stopped.

### FP-3: Prep → Kitchen Handoff Fragility (HIGH)

**Impact:** Shift 20260325-224805-abandoned  
**Severity:** P1  
**Pattern:** The Prep phase consumes so much context that the agent can't survive to Kitchen.

**Evidence:**
- Shift 20260325-224805-abandoned completed:
  - Prior-shifts review (3.2KB)
  - Reality check (1.4KB) — found 9 ideas, classified each
  - Usage snapshot
  - Manifest shows a prep-brainstormer was spawned (still "cooking" when abandoned)
  - But Kitchen was never entered
- The brainstormer was spawned using Opus (the most expensive model), and the Maître d' was waiting for its trigger — but either the trigger never arrived or the Maître d' died while waiting

**Root Cause:** Step 5 (Prior Shift Review) alone reads 5 shift reports, each with multiple sub-files. Step 9 (Reality Check) dispatches a parallel swarm. Step 10 (Brainstorming) spawns Opus. Each of these fills the context window. By the time Step 14 arrives, there may not be enough context left for a meaningful Kitchen run even after clearing.

### FP-4: Shift Status Files Never Updated (HIGH)

**Impact:** Shifts 20260325-231756 and 20260326-054519  
**Severity:** P1  
**Pattern:** Dish files and pairing files are written during Prep but never updated during Kitchen. Status tracking is orphaned.

**Evidence:**
- Shift `20260326-054519`:
  - Dish 001: file says `status: cooking`, session dispatched — but branch has a real commit and PR #348 exists with merged pairing
  - Dish 002: file says `status: queued` — but it was actually cooked and merged into the pairing branch
  - Dish 003-005: all say `cooking` — but PRs #345-346 exist
  - Pairing file says `status: queued` — but the pairing branch was assembled with merge commits
- Shift `20260325-231756`:
  - Session-viewer-polish pairing says `status: queued` — but PR #339 has 4 commits from the assembled pairing

**Root Cause:** The Maître d' dispatches cooks, writes initial statuses, then loses context before processing completion triggers. The cooks complete autonomously (they push branches and sometimes even create PRs), but there's no mechanism for the shift artifacts to reflect this.

### FP-5: CC Shift Parasitizes Main Shift's Sidework (MEDIUM)

**Impact:** Shift 20260325-231756  
**Severity:** P2  
**Pattern:** After the main shift's Kitchen phase completed, the Maître d' transitioned to a Critic's Choice bug hunt instead of entering Sidework.

**Evidence:**
- Main shift `20260325-231756` has 5 dishes all ramsey-cleared, PRs created
- But instead of Sidework, a CC shift (`20260325-231756-cc`) was spawned at 03:35 UTC
- The CC shift completed its own Kitchen (4 waves of fixes) but also never did Sidework
- Then a _third_ shift (`20260326-054519`) was started for deferred CC bugs

**Root Cause:** The shift process has no "checkpoint" mechanism. The Maître d' sees Kitchen as complete and, rather than methodically entering Sidework, pivots to the next initiative (CC bug hunt). The Sidework phase is the most commonly skipped phase because:
1. It feels like "cleanup" work — less urgent than starting new dishes
2. It requires reading many dish files and writing reports — expensive context
3. There's no mechanism to force the agent to complete Sidework before starting a new shift

### FP-6: Cooks Create PRs Directly (MEDIUM — Workaround Masking Root Issue)

**Impact:** Shifts 20260325-231756 and 20260326-054519  
**Severity:** P2  
**Pattern:** Cook sessions create PRs themselves when the Maître d' fails to handle pairing assembly and PR creation.

**Evidence:**
- PR #345-347 were created by individual cook sessions, not by the Maître d's pairing assembly process
- PR #347 was closed (not merged) — likely because it was a solo PR that should have been a pairing
- PR #348 was created separately as the pairing PR

**Impact:** This workaround means dishes get shipped, but:
- Solo PRs are created when pairings were intended, leading to duplicate/conflicting PRs
- The pairing assembly step (combined Ramsey, conflict resolution) is skipped
- PR descriptions don't follow the pairing template

### FP-7: No Shift Completion Enforcement (MEDIUM)

**Impact:** All shifts  
**Severity:** P2  
**Pattern:** There is no mechanism to ensure a shift reaches Sidework. A shift can start, do partial work, and be abandoned with no alarm.

**Evidence:**
- 4 of the 4 shifts from last night lack `shift-report.md`
- 3 of the older shifts also lack it
- Only shifts from March 22-24 have actual shift reports
- There's no "shift timeout" or "Sidework checkpoint" that forces completion

---

## Systemic Analysis: The Orchestrator Problem

The Night Shift architecture has a fundamental tension:

```
        ┌─ Cook 1 (autonomous, stateless, succeeds 90%+)
        ├─ Cook 2 (autonomous, stateless, succeeds 90%+)
Maître d' ─┼─ Cook 3 (autonomous, stateless, succeeds 90%+)
(stateful)  ├─ Critic 1 (autonomous, stateless)
        ├─ Fixer 1 (autonomous, stateless)
        └─ ... (N more sessions)
```

**The cooks are robust because they're stateless.** Each cook gets a self-contained prompt with a dish spec, worktree path, and verification commands. They code, test, commit, push, and die. They don't need to track anything beyond their own dish.

**The Maître d' is fragile because it's stateful.** It must maintain a mental model of:
- Which dishes are in what status
- Which cooks are running
- Which pairings need assembly
- Which critics are pending
- Protocol 86 state
- Usage tracking
- Dependency graph resolution
- On-the-fly order processing

This state is implicit (in context) rather than explicit (on disk). When the Maître d' runs out of context, all this state is lost. The dish files on disk are supposed to be the source of truth, but the Maître d' writes them once (during Prep) and rarely updates them during Kitchen.

---

## Recommendations

### R-1: Checkpoint-Based Orchestration (Addresses FP-1, FP-4, FP-5, FP-7)

The Maître d' should not carry state in context. Instead, implement a **checkpoint-and-resume** pattern:

1. After every significant event (cook completes, Ramsey passes, critic returns), immediately update the dish/pairing files on disk
2. At the start of every dispatch loop iteration, read state from disk rather than from context
3. Add a "reconstruct state from disk" function that the Maître d' can call after a context clear or crash recovery

This makes the Maître d' stateless — it can crash and restart from the last checkpoint.

### R-2: Split the Maître d' Into Phases (Addresses FP-1, FP-3)

Instead of one agent running Prep → Kitchen → Sidework, use three separate agents:

1. **Prep Agent** — Runs Steps 1-14, produces menu.md and dish files, exits
2. **Kitchen Agent** — Reads menu, runs the dispatch loop, updates dish files, exits when all dishes are terminal
3. **Sidework Agent** — Reads completed dish files, writes reports, creates PRs, does cleanup

Each phase is a separate `spawn_session` with a focused prompt. The parent orchestrator just chains them. This prevents context exhaustion from one phase bleeding into the next.

### R-3: Mandatory Sidework Gate (Addresses FP-5, FP-7)

Add a hard rule: **No new shift can start until the previous shift's Sidework is complete (or explicitly marked abandoned).** The pre-flight check (Step 1) should verify this. If the previous shift exists without a `shift-report.md`, the Maître d' must complete its Sidework first.

### R-4: Shift Heartbeat Sentinel (Addresses FP-2)

At shift start, immediately write a structured "shift started" entry to the manifest with a timestamp. Then write periodic "still running" entries. This provides diagnostic breadcrumbs when shifts die silently.

```markdown
## Heartbeat
| Time | Phase | Event |
|------|-------|-------|
| 22:48 | prep | shift-created |
| 22:48 | prep | pre-flight-pass |
| 22:50 | prep | prior-shifts-loaded (5 shifts) |
| 22:55 | prep | reality-check-complete (9 ideas, 2 fixed) |
| ... |
```

### R-5: Slim Down the SKILL.md (Addresses FP-1, FP-3)

The 1542-line SKILL.md is the elephant in the room. Each read consumes ~50KB of context. Options:
- Split into separate phase files (prep.md, kitchen.md, sidework.md) — each agent only reads its phase
- Move the confidence policy, pairing assembly, and on-the-fly order sections into reference docs that are only read when needed
- Create a "cheat sheet" version (~200 lines) with just the critical paths and decision tables

### R-6: Autonomous Cook PR Creation as Feature, Not Bug (Addresses FP-6)

If cooks are going to create PRs autonomously (which they do), lean into it:
- Add explicit "create your own PR" instructions to the cook template for solo dishes
- For pairings, have the Maître d' create the pairing PR during Prep (empty branch), and cooks push to it
- Move pairing assembly into a separate lightweight agent that runs when all partner cooks complete

### R-7: Shift State Dashboard Script (Addresses FP-4)

Create `ns-shift-status.sh` that reads all dish files, pairing files, and git branch state, then produces a current status summary. The Maître d' can call this at the top of each dispatch loop iteration to rebuild state from disk rather than relying on context memory.

---

## Appendix: Per-Shift Detailed Timeline

### Shift 20260325-224805-abandoned
```
22:48  Shift folder created
22:48  Usage snapshot taken
22:48–22:52  Prior-shifts review (read 5 shifts)
22:52–22:55  Reality check (9 ideas, 2 already fixed)
22:55  Brainstormer spawned (Opus, session 06cf2b4c)
???    Maître d' died — brainstormer status: "cooking" (trigger never processed)
       → Shift abandoned when 20260325-231756 started
```

### Shift 20260325-231756
```
23:17  Shift created (autonomous mode)
23:21  Usage snapshot, prior-shifts review
23:28  Reality check (5 ideas verified)
23:29  Menu built (5 dishes), forecast written
23:31  Pairings created (tunnel-overhaul, session-viewer-polish)
23:33  Cooks dispatched: 001, 002, 003, 005 (Jules)
03:33  All 4 Sonnet cooks running
03:46  Dish 001 Ramsey send-back (P1: WS forwardHeaders)
03:47  Dish 001 fixer dispatched
03:49  Dish 002 Ramsey pass (P2+P3 only)
03:54  Dish 003 Ramsey pass (P2+P3 only)
03:57  Dish 004 Ramsey pass (P3 only)
04:06  Tunnel-overhaul critic (Codex): issues found (P1 credential leak)
04:15  Dish 004 Ramsey pass
04:18  Tunnel-overhaul fixer complete
04:24  Tunnel-overhaul critic R2: accepted with P2 demerits
04:28  Session-viewer-polish critic R3: LGTM
~04:30  PRs #337-339 created
       → BUT: No Sidework. Maître d' transitions to CC shift instead.
```

### Shift 20260325-231756-cc (Critic's Choice)
```
03:35  CC shift started (continuation of 231756)
03:36  6 scouts dispatched (Sonnet)
03:50–04:08  All scouts complete — 62 bugs found
04:08  Triage complete — 4 waves formed
04:12  Wave 1 (Security) + Wave 3 (Triggers) dispatched
04:20  Wave 2 (Reconnection) dispatched
04:26  Wave 4 (Mobile) dispatched
~04:30  All 4 waves served, PRs #340-343 created
       → BUT: No Sidework. No morning report. No Godmother updates.
```

### Shift 20260326-054519
```
05:44  Stale branches cleaned
05:45  Shift created (unattended mode)
05:50  Reality check (6 ideas, 1 already fixed)
05:52  Confidence scoring for 5 dishes
05:53  Unattended handoff — skipping plan_mode
05:55  Round 1 dispatched: Dish 003 + Dish 005
05:57  Round 2 dispatched: Dish 001 + Dish 004
???    Maître d' lost context — never processed cook completion triggers
       Dish files still show "cooking"
       BUT: PRs #345-348 were created by the cooks themselves
       → No Sidework. No morning report.
```
