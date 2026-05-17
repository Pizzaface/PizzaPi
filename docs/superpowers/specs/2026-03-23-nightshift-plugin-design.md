# Night Shift Plugin — Design Spec

**Date:** 2026-03-23
**Status:** Draft (rev 3 — P0/P1 fixes)
**Plugin path:** `~/.pizzapi/plugins/nightshift/`

---

## Overview

The Night Shift is a PizzaPi plugin that orchestrates autonomous overnight coding sessions using the restaurant metaphor. A "maître d'" agent delegates all work to specialized "staff" — cooks, critics, and sidework agents — monitoring usage budgets and managing failures through a restaurant-inspired taxonomy.

The plugin integrates with Godmother (task sourcing), jules-dispatch (async coding), review-loop (quality gates), and the full model roster (Anthropic, OpenAI, Google) to produce PRs, reviews, and a morning report ready for human review at day start.

**Core principle:** The maître d' never writes code. It delegates, monitors, and makes the call. It stays alive until all work is done or Protocol 86 fires.

---

## Invocation

The night shift is invoked by running a session with the `maitre-d` agent definition:

```bash
# Via PizzaPi skill invocation (in an agent session)
/skill:nightshift                              # Autonomous — survey Godmother and decide
/skill:nightshift --epic <epic-id>             # Work a specific epic
/skill:nightshift --ideas <id1> <id2>          # Specific Godmother ideas
/skill:nightshift --goal "ship auth refactor"  # Goal-directed
/skill:nightshift --p86-threshold 15           # Custom Protocol 86 threshold (default: 10)
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `--epic` | string | none | Godmother epic ID to pull ideas from |
| `--ideas` | string[] | none | Specific Godmother idea IDs |
| `--goal` | string | none | Free-text goal description |
| `--p86-threshold` | number | 10 | Remaining usage % that triggers Protocol 86 |
| `--dry-run` | flag | false | Run Prep only, output the menu, don't start Kitchen |
| (no args) | — | — | Autonomous mode — survey Godmother backlog |

The skill parses these from the user's message. The maître d' agent definition (`agents/maitre-d.md`) provides personality and identity; the skill (`skills/nightshift/SKILL.md`) provides the procedural playbook.

---

## Plugin Structure

```
~/.pizzapi/plugins/nightshift/
├── plugin.json                  # Plugin metadata
├── README.md                    # Human-readable overview
├── agents/
│   └── maitre-d.md              # Agent identity — personality, Protocol 86, failure taxonomy
├── skills/
│   └── nightshift/
│       └── SKILL.md             # Full shift procedure (Prep → Kitchen → Critics → Sidework)
├── rules/
│   └── nightshift.md            # Rules injected into all shift sessions
├── templates/                   # Prompt templates for spawned sessions
│   ├── prep-brainstorm.md       # Opus orchestrator prompt for brainstorming phase
│   ├── kitchen-cook.md          # Sonnet/Haiku cook prompt template
│   ├── kitchen-jules.md         # Jules dispatch prompt template
│   ├── critic-review.md         # Opus/Codex critic prompt template
│   ├── fixer.md                 # Fixer session prompt (expo failures + critic findings)
│   └── sidework-cleanup.md      # Sidework agent prompt template
└── reports/                     # .gitignored — shift reports and critic clippings
    ├── .gitkeep
    ├── critic-clippings.md      # Append-only institutional memory
    ├── YYYY-MM-DD-shift-report.md  # Morning reports (one per shift)
    └── shifts/                  # Per-shift working state
        └── YYYYMMDD-HHMMSS/     # One folder per shift
            ├── manifest.md      # Session manifest (appended as sessions spawn)
            ├── menu.md          # Tonight's menu
            ├── forecast.md      # Reservations / capacity forecast
            ├── incidents.md     # Append-only incident log
            ├── dishes/          # Per-dish status files
            │   └── NNN-slug.md  # Status, session ID, PR#, critic notes
            ├── usage-snapshots/ # Periodic usage data
            │   └── HHMM.md
            └── ratings.md       # Batch critic output
```

### `plugin.json` Schema

```json
{
  "name": "nightshift",
  "description": "Autonomous overnight coding orchestrator using the restaurant metaphor",
  "version": "0.1.0",
  "author": "jordan",
  "keywords": ["nightshift", "orchestration", "autonomous", "overnight"]
}
```

### Component Responsibilities

- **`agents/maitre-d.md`** — Establishes the maître d' identity: restaurant metaphor, failure classifications, Protocol 86 awareness, delegation-only principle. This is *who* the agent is.
- **`skills/nightshift/SKILL.md`** — The procedural playbook: phase-by-phase instructions. This is *what* the agent does.
- **`rules/nightshift.md`** — Injected into all child sessions during a shift. Establishes restaurant terminology so cooks and critics stay in character.
- **`templates/`** — Prompt templates with `{{variables}}` for spawning specialized agents. See Template Variable Contracts below.
- **`reports/`** — Gitignored output directory. Contains per-shift folders (`shifts/<YYYYMMDD-HHMMSS>/`) with manifest, menu, incidents, per-dish status, and usage snapshots. Also contains the top-level morning reports and critic clippings. Shift folders are the maître d's persistent state — written to disk as the shift progresses for crash recovery and batch critic review.

---

## Template Variable Contracts

Each template receives variables injected by the maître d' before spawning a session.

### `prep-brainstorm.md`
| Variable | Type | Description |
|----------|------|-------------|
| `{{TASK_LIST}}` | markdown | List of tasks to brainstorm, one per item |
| `{{PROJECT}}` | string | Godmother project name |
| `{{SKIP_CRITERIA}}` | markdown | Tasks pre-marked as "skip brainstorming" with reason |

### `kitchen-cook.md`
| Variable | Type | Description |
|----------|------|-------------|
| `{{DISH_ID}}` | string | Unique dish identifier from the menu |
| `{{TASK_DESCRIPTION}}` | markdown | Full task spec (from brainstorming or raw idea) |
| `{{FILE_PATHS}}` | string[] | Target files to modify |
| `{{VERIFICATION}}` | markdown | Commands to run for verification (typecheck, tests) |
| `{{WORKTREE_PATH}}` | string | Absolute path to this dish's worktree |
| `{{BRANCH_NAME}}` | string | Git branch name for this dish |
| `{{DISH_TITLE}}` | string | Human-readable dish title (for PR title) |

Cook template includes: "Create a PR targeting `main` using `gh pr create`. Use Haiku for all `subagent` tool calls."

### `kitchen-jules.md`
| Variable | Type | Description |
|----------|------|-------------|
| `{{TASK_DESCRIPTION}}` | markdown | Scoped task description (what to change) |
| `{{FILE_PATHS}}` | string | Target file path(s) |
| `{{STEPS}}` | markdown | Numbered implementation steps |
| `{{TEST_SCOPE}}` | string | Test scope for verification (e.g., `packages/server`) |

### `critic-review.md`
| Variable | Type | Description |
|----------|------|-------------|
| `{{PR_NUMBER}}` | number | GitHub PR number to review |
| `{{BRANCH_NAME}}` | string | Branch name |
| `{{WORKTREE_PATH}}` | string | Path to worktree (for local file access) |
| `{{DISH_TASK}}` | markdown | Original task description (so critic knows intent) |

### `fixer.md` (added — was missing from original template list)
| Variable | Type | Description |
|----------|------|-------------|
| `{{ORIGINAL_TASK}}` | markdown | Original dish task description |
| `{{FAILURE_OUTPUT}}` | markdown | Specific failure (typecheck errors, test failures, or critic findings) |
| `{{WORKTREE_PATH}}` | string | Worktree path to work in |
| `{{VERIFICATION}}` | markdown | Verification commands to run after fixing |
| `{{SHIFT_FOLDER}}` | string | Path to the current shift folder (e.g., `reports/shifts/20260323-233200`) |
| `{{DISH_FILE}}` | string | Dish status filename (e.g., `001-mime-validation.md`) |
| `{{TIMESTAMP}}` | string | Current timestamp for the log entry |

Fixer template has 3 phases: (1) **Diagnose** the Kitchen Disconnect — categorize why the cook failed (prompt-gap, scope-creep, wrong-approach, missing-context, tool-failure, genuine-difficulty), (2) **Fix** the issues informed by diagnosis, (3) **Log** the disconnect and fix to the shift's dish file. All three phases are mandatory.

### `sidework-cleanup.md`
| Variable | Type | Description |
|----------|------|-------------|
| `{{WORKTREE_PATHS}}` | string[] | Worktrees to clean up |
| `{{PR_LIST}}` | markdown | PRs to rebase |
| `{{GODMOTHER_UPDATES}}` | markdown | Status changes to apply |

---

## Worktree Naming Convention

All worktrees are created under `<repo-root>/.worktrees/nightshift-<YYYYMMDD>/`:

```
.worktrees/
  nightshift-20260323/
    dish-001-mime-validation/     # dish-<ID>-<slugified-title>
    dish-002-session-refactor/
    dish-003-race-condition/
    jules-dish-004/               # Jules dishes get worktrees for expo only (fetched from PR branch)
```

- **Sonnet/Haiku cooks:** Worktree created before dispatch, cook works inside it
- **Jules dishes:** Worktree created AFTER Jules PR lands, by fetching the PR branch for expo window
- **Sidework cleanup:** Removes the entire `nightshift-<YYYYMMDD>/` directory

---

## Input Modes

The maître d' supports multiple input modes:

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Epic-focused** | User specifies an epic | Pull all ideas from that epic |
| **Goal-directed** | User states a goal ("ship these 3 PRs") | Parse intent, pull related Godmother ideas |
| **Backlog sweep** | User says "work the backlog" | Pull from `plan`/`execute` status ideas |
| **Autonomous** | No user input | Survey Godmother, identify highest-value targets, build menu |

In all modes, the maître d' also checks for open PRs needing merge (leftover prep from previous shifts).

---

## Shift Lifecycle

### Phase 1: Prep (Mise en Place)

1. **Pre-flight Check:**
   - Verify `git status` is clean (no uncommitted changes). If dirty, abort with error.
   - Verify on `main` branch and up to date with remote
   - Verify Godmother MCP is reachable (call `mcp_godmother_list_projects`). **Godmother is required at shift start** — abort if unavailable. If Godmother goes down mid-shift, degrade gracefully (skip status updates, log "Godmother offline").
   - Verify Jules MCP is reachable if Jules tasks are planned (call `mcp_jules_list_sources`). **If Jules is unreachable**, reassign all Jules-candidate dishes to Sonnet cooks (they become regular kitchen dishes with worktrees). Log "Jules unavailable — reassigned N dishes to Sonnet."

2. **Staff Roster** — Call `list_models` to check usage across all providers. Determine available "staff" for tonight. Models at or near capacity are not assigned work.

3. **Determine Intent** — Parse user input or scan Godmother:
   - Specified epic/goal → pull ideas from that epic/context
   - Autonomous → scan ideas in `plan`/`execute` status, rank by value
   - Check open PRs from previous shifts

4. **Identify Jules Candidates** — Filter ideas matching jules-dispatch criteria:
   - < 50 line changes
   - Single-concern, clear verification
   - No cross-package refactors or architectural decisions

5. **Brainstorming** — Spawn an Opus agent that receives the full task list. The Opus agent:
   - For each task, spawns a Sonnet agent running the brainstorming skill
   - Sonnet agents run in parallel (up to 3 concurrent)
   - Each Sonnet produces a spec/plan for its task
   - Opus collects results via triggers and returns the combined output
   - **Skip criteria:** Tasks are skipped for brainstorming if they meet ALL of: (a) Jules candidate, (b) estimated < 20 line changes, (c) single file scope, (d) clear verification criteria already exist. These go straight to the menu as-is.
   - **Failure handling:** If the Opus orchestrator crashes → retry once with Sonnet as orchestrator. If a Sonnet brainstorm worker crashes → that task goes to the menu with its raw Godmother description (no spec). If brainstorming produces an empty menu → abort the shift with "Prep failure — no dishes on the menu." If brainstorming partially completes (some specs, some failures) → proceed with what's available, note incomplete specs in the menu.

6. **Build the Menu** — Structured list of dishes:
   ```
   - Dish ID, title, description
   - Assigned cook type (Sonnet / Haiku / Jules)
   - Estimated complexity (S / M / L)
   - Dependencies (must dish X complete before Y?)
   - Verification criteria (tests, typecheck, specific assertions)
   - Source Godmother idea ID (for status tracking)
   ```

7. **Dependency Resolution** — If the menu contains dishes with dependencies:
   - Build a dependency graph (topological sort)
   - Dishes with no dependencies are eligible immediately
   - A dish becomes eligible only when all its dependencies are "plated" (passed expo)
   - If a dependency fails (Kitchen Stoppage or Food Poisoning), all downstream dishes are marked "86'd — blocked by failed dependency" and captured as Godmother ideas

8. **Reservations** (Capacity Planning) — Estimate shift duration:
   - Count dishes by cook type
   - Estimate duration per dish by complexity
   - Check if staff roster (available usage) can handle the full menu
   - If not → trim the menu (86 items before service starts)
   - Produce a **Shift Forecast** for the morning report

**Prep output:** Tonight's Menu + Shift Forecast

---

### Phase 2: Kitchen (Service)

The hot line — dispatching work and managing flow.

1. **Fire dishes in priority order:**
   - **Jules dishes** → `jules-dispatch` pattern: create session with `AUTO_CREATE_PR`, monitor via polling
   - **Sonnet/Haiku dishes** → `spawn_session` with cook template, scoped to git worktrees. Cook template instructs: `git push -u origin {{BRANCH_NAME}} && gh pr create --base main --title "{{DISH_TITLE}}" --body "Night Shift dish {{DISH_ID}}"`. PR creation is part of the cook's job.
   - All cooks use **Haiku** for their `subagent` tool calls (explicit `model` override)

2. **Concurrency management** — The maître d' manages concurrency based on usage, not hard caps. Guidelines:
   - **Jules:** Hard limit of 15 concurrent sessions, 100 sessions per day (platform limit)
   - **Anthropic / OpenAI / Gemini:** No hard concurrency cap — the maître d' decides how many to run based on current usage levels. If a provider is "near capacity" (≥ 80% utilization), stop dispatching to it. Otherwise, fire as many as the menu demands.
   - As dishes complete, fire the next from the queue in **priority order** (dependencies first, then by menu position)
   - If a dish has unresolved dependencies (blocked by unfinished dish), skip it and fire the next eligible dish
   - The maître d' should be judicious — running 20 Sonnet sessions simultaneously will burn through budget fast. Use the Reservations forecast to pace dispatch.

3. **Expo Window** — Before a dish is "plated," the maître d' inspects it. The process differs by cook type:

   **For Sonnet/Haiku cook sessions (have local worktrees):**
   - `cd` into the cook's worktree
   - Run `bun run typecheck` (timeout: 300s) — must exit 0
   - Run `bun test` (scoped to changed packages, timeout: 300s) — must exit 0
   - Pull the PR diff (`git diff main...HEAD`) and scan for: empty files, `TODO`/`FIXME` comments, `test.skip`/`.only`, placeholder implementations
   
   **For Jules dishes (remote PRs, no local worktree yet):**
   - Wait for Jules session to reach `COMPLETED` state with a PR
   - Fetch the PR branch: `git fetch origin <branch> && git worktree add .worktrees/nightshift-<date>/jules-dish-<id> <branch>`
   - Run the same quality gates in the fetched worktree
   
   **For all dishes after quality gate check:**
   - If all pass → "plated," queued for critics
   - If quality gates fail → "sent back" — spawn a new fixer session (using `fixer.md` template) in the worktree with:
     - Original task description from the menu
     - The specific failure output (typecheck errors, test failures, diff issues)
     - Instruction: "Fix these issues, then run typecheck and tests to verify"
     - One retry. If the fixer also fails expo → flag as Kitchen Stoppage

4. **Monitor and expedite:**
   - Poll child sessions, handle triggers
   - Child asks a question → maître d' answers from context or escalates to human
   - Child completes → run expo window
   - Child fails → retry once with different approach, then flag as Kitchen Stoppage

5. **Usage checks** — Every ~5 minutes, re-check `list_models` usage. Send workers home as providers get hot.

6. **Protocol 86 watch** — If the maître d's own model drops below threshold (default: 10% remaining), immediately stop firing new dishes and begin closing.

**Kitchen output:** Set of "plated" PRs ready for critics, plus incident log

---

### Phase 3: Food Critics (Review)

#### Per-Dish Reviews (During Service)

Critic sessions run **in parallel with kitchen cooks** — as soon as a dish is plated (passes expo), a critic is spawned for it. Critics don't block kitchen throughput. The maître d' tracks both kitchen and critic sessions in the same dispatch loop.

- Use GPT-5.3 Codex (or fallback model) — different provider than the cook for fresh perspective
- Follow `review-loop` pattern: fresh context each round, no priming about prior rounds
- Target: LGTM from critic = "compliment to the chef"
- If critic finds issues → send back to kitchen: spawn a **fixer session** in the dish's worktree with:
  - Original task description
  - Critic's specific findings (the review output)
  - Instruction: "Address these review findings, then run typecheck and tests"
  - Fixer uses **Sonnet** (same as cook), with **Haiku** for subagent calls
- Retry cycle: fix → re-review (fresh critic, new session) → if still failing after 3 rounds, flag as Food Poisoning
- **Reviewer Death:** If a critic session crashes, note it in the incident log but do NOT retry. The dish stays "plated but unreviewed" — noted in the morning report for human attention.
- **Critic queuing:** Critics share the same provider concurrency limits as cooks. If OpenAI (max 2) is saturated, critic sessions queue FIFO by plate time. The maître d' tracks a unified dispatch queue across all providers — kitchen and critics draw from the same pool.

#### Batch Review at Closing (Phase 4)

See Sidework phase — the batch critic reviews all sessions including critic sessions themselves.

**Critics output:** Per-dish LGTM/rejection status, critic notes per dish

---

### Phase 4: Sidework (Closing)

End-of-shift cleanup and reporting.

1. **Queue PRs for morning merge** — All approved PRs are rebased on main but NOT auto-merged. Queued for user approval in the morning report. If rebase fails (merge conflict), note it in the morning report as "needs manual rebase" and move on — don't abort sidework.

2. **Worktree cleanup** — Remove all `.worktrees/` created during the shift. If removal fails (locked files, etc.), log a warning and continue.

3. **Godmother updates** (if Godmother MCP is available — if not, log "Godmother unavailable, status updates skipped" and continue):
   - Approved PRs → `mcp_godmother_move_idea(id, "review")` (pending morning merge)
   - Comped dishes → `mcp_godmother_branch_idea` with polish context
   - Poisoned dishes → `mcp_godmother_branch_idea` with full failure context
   - New discoveries (bugs found during cooking) → `mcp_godmother_capture_idea`
   - Remaining menu items → left in `plan` status, no changes

4. **Batch Critic Review** — The maître d' maintains a **shift folder** (`reports/shifts/<YYYYMMDD-HHMMSS>/`) with per-dish status files, a session manifest, incident log, and usage snapshots — all written to disk as the shift progresses. At closing, the batch critic reads this folder directly (plus session transcripts from `~/.pi/sessions/` / `~/.pizzapi/sessions/` for the session IDs listed in the manifest). To manage context limits, the batch critic receives **summaries** of each session (last 200 lines or a distilled summary) rather than full transcripts. If more than 20 sessions exist, batch into groups and synthesize. The batch critic explicitly reviews the quality of the critics themselves — this is intentional (critics grading critics):
   - Cook sessions (what was produced)
   - Per-dish critic sessions (review quality)
   - Maître d' orchestration decisions
   - Rates the shift across 6 categories (see Rating System below)
   - Generates holistic Critic Notes

5. **Critic Clippings** — Append to `reports/critic-clippings.md`:
   - Date, shift summary
   - What went well and *how* (specific patterns, model choices, prompt structures)
   - What failed and why
   - AGENTS.md update proposals (if warranted — proposed, not auto-applied)

6. **Morning Report** — Generate `reports/YYYY-MM-DD-shift-report.md` (see Morning Report section)

7. **Cleanup:**
   - Clear any stashes created during the shift
   - Delete merged remote branches
   - Verify git state is clean

---

## Rating System (The Michelin Stars)

The batch critic at closing rates the shift across 6 fixed categories, each 1-5 stars:

| # | Category | What It Measures |
|---|----------|-----------------|
| ⭐ | **Cuisine** (Code Quality) | Correctness, testing, cleanliness of code produced |
| ⭐ | **Service** (Execution) | Shift smoothness — stoppages, retries, timeouts |
| ⭐ | **Ambiance** (Developer Experience) | PR descriptions, commit messages, morning readability |
| ⭐ | **Value** (Efficiency) | Token ROI — output quality per token consumed |
| ⭐ | **Consistency** (Reliability) | Quality variance across similar tasks |
| ⭐ | **Reservations** (Planning Accuracy) | Forecast vs reality — menu completion, time estimates |

**Overall shift rating** = average of all 6 categories. Displayed as stars in the morning report header.

Each rating includes a brief justification. Ratings go into both the morning report and the critic clippings.

---

## Failure Taxonomy

| Failure | Restaurant Term | Trigger | Response |
|---------|----------------|---------|----------|
| Agent session crash/timeout | **Kitchen Stoppage** | Child session dies or hangs | Retry once with different model, then flag |
| Rate limit / usage exhaustion | **86'd** (provider) | Provider hits usage ceiling | Send that provider's workers home, reassign |
| Code fails critic 3x | **Food Poisoning** | Same dish fails review 3 rounds | Quarantine — capture as Godmother idea |
| Work done but below quality bar | **Comped Meal** | Passes but not restaurant-quality | Capture as Godmother idea needing polish |
| Critic session crash | **Reviewer Death** | Critic agent dies (usually usage) | Note it, don't retry — budget is precious |
| Maître d' below threshold | **Protocol 86** | Own model usage ≥ configured threshold | Immediate closing procedure |
| All providers exhausted | **Last Call** | No models available for new work | Stop dispatches, finish in-flight, begin closing (same procedure as Protocol 86) |

---

## Protocol 86

Triggered when the maître d's own model drops below a configurable usage threshold (default: 10% remaining on either 5-hour or 7-day window).

**Procedure:**
1. Stop firing new dishes — no new `spawn_session` or jules-dispatch calls
2. Let in-flight work complete — don't kill running sessions
3. Fast-track sidework — skip batch critic review, do minimal cleanup:
   - Update Godmother statuses for completed work
   - Generate abbreviated morning report
   - Note "Protocol 86 — shift ended early"
4. Capture remaining menu as Godmother ideas in `plan` status
5. Write final report entry and exit gracefully

**Threshold is configurable:** Pass `--p86-threshold 15` to adjust from the default 10%.

### Usage Monitoring Details

`list_models` returns **utilization percentages** (e.g., `"5-hour: 47%, 7-day: 51%"`). The spec uses "remaining" language for readability, but implementation must invert:

| Spec Language | Implementation |
|---------------|---------------|
| "10% remaining" (Protocol 86) | utilization ≥ 90% on **either** 5-hour or 7-day window |
| "near capacity" (don't assign) | utilization ≥ 80% on either window |
| "86'd" (provider exhausted) | utilization ≥ 95% on either window |

The maître d' checks **both** the 5-hour and 7-day windows. The more restrictive one wins. For example, if 5-hour is at 85% but 7-day is at 50%, the provider is "near capacity" (85% ≥ 80%).

Jules polling uses the `jules-dispatch` skill's cadence: check `mcp_jules_get_session` every 60-90 seconds. Pi sessions use push-based triggers (linked sessions) — no polling needed.

---

## Default Staff Roster

| Role | Default Model ID | Provider | Rationale |
|------|------------------|----------|-----------|
| **Maître d'** | User's session model | User's choice | Orchestrator — user picks |
| **Prep Brainstormer** | `claude-opus-4-6` | `anthropic` | High-level design thinking |
| **Brainstorm Workers** | `claude-sonnet-4-6` | `anthropic` | Quality/speed balance for specs |
| **Kitchen Cooks** | `claude-sonnet-4-6` | `anthropic` | Best coding model for the cost |
| **Kitchen Sous-chefs** (subagent) | `claude-haiku-4-5` | `anthropic` | Cheap, fast for small tasks |
| **Kitchen Line Cooks** | Jules via MCP | `google` (Jules MCP) | Async, for < 50 line changes |
| **Food Critics** (per-dish) | `gpt-5.3-codex` | `openai-codex` | Different provider = fresh eyes |
| **Batch Critic** | `claude-opus-4-6` | `anthropic` | Needs to synthesize across all sessions |
| **Sidework Agents** | `claude-haiku-4-5` | `anthropic` | Mechanical cleanup tasks |

Model IDs match the `list_models` registry. The maître d' resolves model IDs at shift start via `list_models` and falls back if a model is unavailable.

**Dynamic reassignment** when a provider is 86'd:
- Anthropic cooks → `gemini-3.1-pro-preview` or `gpt-5.2-codex`
- OpenAI critics → `gemini-3.1-pro-preview` or `claude-opus-4-6` (if budget allows)
- Anthropic brainstormers → `gpt-5.4`
- If the fallback model is also unavailable, the dish is 86'd from the menu

---

## Morning Report

Generated at `reports/YYYY-MM-DD-shift-report.md`:

```markdown
# Night Shift Report — YYYY-MM-DD

## ⭐⭐⭐⭐ 4.2/5 — Shift Rating

## Shift Summary
- **Started:** HH:MM | **Ended:** HH:MM
- **Status:** ✅ Service Complete / ⚠️ Protocol 86 / ❌ Last Call
- **Menu Items:** N planned → X served, Y comped, Z poisoned, W remaining

## Tonight's Menu
| # | Dish | Type | Cook | Status | PR |
|---|------|------|------|--------|----|
| ... | ... | ... | ... | ... | ... |

## Usage Report
| Provider | Start | End | Consumed |
|----------|-------|-----|----------|
| ... | ... | ... | ... |

## PRs Ready for Morning Review
(List of PRs needing user merge approval)

## Kitchen Incidents
(Kitchen Stoppages, Food Poisoning, Reviewer Deaths)

## Shift Ratings
| Category | Stars | Notes |
|----------|-------|-------|
| Cuisine | ⭐⭐⭐⭐ | ... |
| Service | ⭐⭐⭐⭐⭐ | ... |
| Ambiance | ⭐⭐⭐ | ... |
| Value | ⭐⭐⭐⭐ | ... |
| Consistency | ⭐⭐⭐⭐⭐ | ... |
| Reservations | ⭐⭐⭐ | ... |

## Critic Notes
(Patterns, anti-patterns, AGENTS.md update proposals)

## Follow-Up Work (Captured in Godmother)
(New ideas with IDs)
```

---

## Critic Clippings

Append-only file at `reports/critic-clippings.md`. Gitignored. Each shift appends:

```markdown
## YYYY-MM-DD Shift

### What Went Well
- **Pattern name**: Description of what worked
  - *How*: Specific technique, model choice, or prompt structure that made it work

### What Didn't
- **Pattern name**: What failed and why

### Model Insights
- Which model combinations produced the best results
- Where fallback reassignment worked / didn't
```

This file persists across shifts and serves as institutional memory — "review clippings on the wall" that guide future shifts.

---

## Integration Points

| System | How Night Shift Uses It |
|--------|------------------------|
| **Godmother** | Task sourcing (epics/ideas), status updates, follow-up capture |
| **jules-dispatch** | Async task execution for Jules-appropriate work |
| **review-loop** | Per-dish critic review pattern (fresh context, no priming) |
| **pr-sweep** | Worktree isolation pattern for parallel cooks |
| **brainstorming** (superpowers) | Prep phase spec generation |
| **`list_models`** | Usage monitoring, staff roster management |
| **`spawn_session`** | Dispatching cooks, critics, sidework agents |
| **`~/.pi/sessions/`** | Batch critic loads session transcripts for shift review |

---

## API References

The following MCP tools are used throughout and are verified available:

- **Godmother:** `mcp_godmother_list_ideas`, `mcp_godmother_get_idea`, `mcp_godmother_get_epic`, `mcp_godmother_move_idea`, `mcp_godmother_branch_idea`, `mcp_godmother_capture_idea`, `mcp_godmother_search_ideas`, `mcp_godmother_list_projects`
- **Jules:** `mcp_jules_create_session`, `mcp_jules_get_session`, `mcp_jules_send_message`, `mcp_jules_list_sessions`, `mcp_jules_list_sources`
- **PizzaPi:** `spawn_session`, `list_models`, `subagent`, `send_message`, `wait_for_message`

Jules session creation uses `automationMode: "AUTO_CREATE_PR"` and the monitoring pattern is defined in the `jules-dispatch` skill.

---

## Key Design Decisions

1. **Maître d' never writes code** — pure delegation and orchestration
2. **Merging always requires user approval** — PRs are queued, not auto-merged
3. **All spawned sessions use Haiku for subagent calls** — cooks, fixers, sidework agents all pass explicit `model: haiku` to their subagent tool
4. **Critics use a different provider than cooks** — fresh perspective, avoids same-model blind spots
5. **Protocol 86 threshold is configurable** — default 10%, adjustable per shift
6. **Expo window before critic review** — catch obvious failures early, save critic budget
7. **Retry once, then flag** — don't burn budget on persistent failures
8. **AGENTS.md updates are proposals** — never auto-applied. Surfaced in the morning report as a fenced markdown diff block (```diff) that the user can review and manually apply
9. **Critic clippings are gitignored** — institutional memory that doesn't pollute the repo
