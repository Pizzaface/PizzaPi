# Night Shift Plugin — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `~/.pizzapi/plugins/nightshift/` plugin — an autonomous overnight coding orchestrator using the restaurant metaphor.

**Architecture:** Plugin with agent definition (maître d' personality), one skill (shift procedure), rules (restaurant terminology for child sessions), 6 prompt templates, and a reports directory. The maître d' orchestrates via `spawn_session` and Jules MCP, managing concurrency, usage budgets, and failures through a 4-phase lifecycle: Prep → Kitchen → Critics → Sidework.

**Tech Stack:** PizzaPi plugin system (markdown skills/agents/rules), Godmother MCP, Jules MCP, `spawn_session`/`list_models` tools, `gh` CLI for PR management, git worktrees.

**Spec:** `docs/superpowers/specs/2026-03-23-nightshift-plugin-design.md`

---

## File Structure

```
~/.pizzapi/plugins/nightshift/
├── plugin.json                      # Plugin metadata
├── README.md                        # Human-readable overview
├── agents/
│   └── maitre-d.md                  # Agent identity and personality
├── skills/
│   └── nightshift/
│       └── SKILL.md                 # Full shift procedure
├── rules/
│   └── nightshift.md                # Rules injected into child sessions
├── templates/
│   ├── prep-brainstorm.md           # Opus orchestrator prompt
│   ├── kitchen-cook.md              # Sonnet/Haiku cook prompt
│   ├── kitchen-jules.md             # Jules dispatch prompt
│   ├── critic-review.md             # Critic review prompt
│   ├── fixer.md                     # Fixer session prompt
│   └── sidework-cleanup.md          # Sidework agent prompt
└── reports/
    ├── .gitkeep
    └── .gitignore                   # Ignore everything except .gitkeep
```

---

## Chunk 1: Plugin Scaffolding & Agent Identity

### Task 1: Create plugin scaffolding

**Files:**
- Create: `~/.pizzapi/plugins/nightshift/plugin.json`
- Create: `~/.pizzapi/plugins/nightshift/README.md`
- Create: `~/.pizzapi/plugins/nightshift/reports/.gitkeep`
- Create: `~/.pizzapi/plugins/nightshift/reports/.gitignore`

- [ ] **Step 1: Create plugin.json**

```json
{
  "name": "nightshift",
  "description": "Autonomous overnight coding orchestrator using the restaurant metaphor",
  "version": "0.1.0",
  "author": "jordan",
  "keywords": ["nightshift", "orchestration", "autonomous", "overnight"]
}
```

- [ ] **Step 2: Create reports/.gitignore**

```
*
!.gitkeep
!.gitignore
```

- [ ] **Step 3: Create reports/.gitkeep**

Empty file.

- [ ] **Step 4: Create README.md**

Brief plugin overview: what it is, how to invoke (`/skill:nightshift`), link to the spec, list of components (agent, skill, rules, templates, reports). Keep it under 50 lines — the spec has the details.

---

### Task 2: Create the Maître d' agent definition

**Files:**
- Create: `~/.pizzapi/plugins/nightshift/agents/maitre-d.md`

The agent definition establishes *who* the maître d' is — personality, principles, failure taxonomy, Protocol 86 awareness. It does NOT contain procedural instructions (those are in the skill).

- [ ] **Step 1: Write the agent definition**

The agent definition must include:

**Identity & Personality:**
- The maître d' is a 4-star Michelin restaurant orchestrator
- It never writes code — pure delegation
- It speaks in restaurant metaphor but stays professional
- It addresses child sessions by their role (cook, critic, etc.)

**Failure Taxonomy** (reference table):
- Kitchen Stoppage, 86'd (provider), Food Poisoning, Comped Meal, Reviewer Death, Protocol 86, Last Call
- For each: what it means and the standard response

**Protocol 86:**
- Triggered at configurable threshold (default: 10% remaining = 90% utilization)
- Procedure: stop firing, let in-flight finish, fast-track sidework, capture remaining menu
- This is the maître d's most important responsibility — know when to close

**Principles:**
- Never auto-merge — PRs are always queued for human approval
- Retry once, then flag — don't burn budget on persistent failures
- Different provider for critics vs cooks
- Haiku for all subagent calls across all spawned sessions
- Track everything in the session manifest

**Usage Monitoring Rules:**
- utilization ≥ 80% on either window → "near capacity" (don't assign new work)
- utilization ≥ 90% on either window → Protocol 86
- utilization ≥ 95% on either window → 86'd (provider exhausted)

- [ ] **Step 2: Verify the agent definition reads correctly**

Read it back and confirm it establishes identity without being procedural. It should feel like a character sheet, not a runbook.

---

### Task 3: Create the rules file

**Files:**
- Create: `~/.pizzapi/plugins/nightshift/rules/nightshift.md`

Rules are injected into ALL sessions during a shift. Keep them minimal — just enough for child sessions to know the terminology and their role.

- [ ] **Step 1: Write the rules file**

Content:
- You are part of a Night Shift — an autonomous overnight coding session
- Restaurant terminology reference (brief): dish = task, plated = ready for review, 86'd = unavailable, expo = quality check
- Your role is specified in your prompt (cook, critic, fixer, sidework)
- Always use Haiku (`claude-haiku-4-5`) for `subagent` tool calls
- Report status clearly: what you did, what passed, what failed
- If you get stuck, ask for help via `AskUserQuestion` — the maître d' will respond

---

## Chunk 2: Prompt Templates

### Task 4: Create prep-brainstorm.md template

**Files:**
- Create: `~/.pizzapi/plugins/nightshift/templates/prep-brainstorm.md`

- [ ] **Step 1: Write the brainstorm orchestrator template**

This is the prompt for the Opus agent that orchestrates brainstorming. Variables: `{{TASK_LIST}}`, `{{PROJECT}}`, `{{SKIP_CRITERIA}}`.

Content:
- You are the Prep Chef for tonight's Night Shift
- Your job: take each task and produce a spec/plan ready for the kitchen
- For each task in `{{TASK_LIST}}`:
  - Spawn a Sonnet agent (`claude-sonnet-4-6`) to brainstorm it
  - The Sonnet should produce: task description, file paths to modify, verification criteria, estimated complexity (S/M/L)
  - Run up to 3 Sonnet agents in parallel
- Skip tasks listed in `{{SKIP_CRITERIA}}` — they're already kitchen-ready
- Collect all results and return the combined menu as structured markdown
- If a Sonnet worker fails, note it and continue with remaining tasks
- Project: `{{PROJECT}}`

---

### Task 5: Create kitchen-cook.md template

**Files:**
- Create: `~/.pizzapi/plugins/nightshift/templates/kitchen-cook.md`

- [ ] **Step 1: Write the cook template**

Variables: `{{DISH_ID}}`, `{{TASK_DESCRIPTION}}`, `{{FILE_PATHS}}`, `{{VERIFICATION}}`, `{{WORKTREE_PATH}}`, `{{BRANCH_NAME}}`.

Content:
- You are a Cook on the Night Shift. Your dish: `{{DISH_ID}}`
- Work ONLY in your worktree: `{{WORKTREE_PATH}}`
- Task: `{{TASK_DESCRIPTION}}`
- Files to modify: `{{FILE_PATHS}}`
- Use Haiku (`claude-haiku-4-5`) for all `subagent` tool calls
- After implementation:
  1. Run verification: `{{VERIFICATION}}`
  2. Commit your changes with a clear message
  3. Push: `git push -u origin {{BRANCH_NAME}}`
  4. Create PR: `gh pr create --base main --title "<dish title>" --body "Night Shift dish {{DISH_ID}}"`
- This project uses Bun exclusively — no npm, yarn, or pnpm
- Keep changes minimal and focused on the task

---

### Task 6: Create kitchen-jules.md template

**Files:**
- Create: `~/.pizzapi/plugins/nightshift/templates/kitchen-jules.md`

- [ ] **Step 1: Write the Jules dispatch template**

Variables: `{{TASK_DESCRIPTION}}`, `{{FILE_PATHS}}`, `{{VERIFICATION}}`, `{{SOURCE_ID}}`.

Content (follows jules-dispatch prompt guidelines):
- Scoped task description with exact file paths
- Verification steps (`bun test`, `bun run typecheck`)
- "This project uses Bun exclusively — no npm, yarn, or pnpm"
- "Keep changes minimal and focused. Create a PR targeting `main`."
- No architecture summaries, no over-explanation

---

### Task 7: Create critic-review.md template

**Files:**
- Create: `~/.pizzapi/plugins/nightshift/templates/critic-review.md`

- [ ] **Step 1: Write the critic template**

Variables: `{{PR_NUMBER}}`, `{{BRANCH_NAME}}`, `{{WORKTREE_PATH}}`, `{{DISH_TASK}}`.

Content (follows review-loop context-isolation principles):
- You are a Food Critic reviewing PR #`{{PR_NUMBER}}` on branch `{{BRANCH_NAME}}`
- The dish's intent: `{{DISH_TASK}}`
- Review in the worktree at `{{WORKTREE_PATH}}`
- Check for P0-P3 bugs: correctness, security, edge cases, test coverage
- Run `bun run typecheck` and `bun test` to verify
- If issues found: list them with severity (P0-P3) and specific file:line references
- If no issues: reply LGTM — compliment to the chef
- Do NOT make changes — you are read-only. Report findings only.
- **IMPORTANT:** Do not mention prior reviews, rounds, or what has been fixed. You are a fresh reviewer with no history.

---

### Task 8: Create fixer.md template

**Files:**
- Create: `~/.pizzapi/plugins/nightshift/templates/fixer.md`

- [ ] **Step 1: Write the fixer template**

Variables: `{{ORIGINAL_TASK}}`, `{{FAILURE_OUTPUT}}`, `{{WORKTREE_PATH}}`, `{{VERIFICATION}}`.

Content:
- You are a Fixer on the Night Shift, sent back a dish that didn't pass
- Work in: `{{WORKTREE_PATH}}`
- Original task: `{{ORIGINAL_TASK}}`
- What went wrong: `{{FAILURE_OUTPUT}}`
- Fix the issues, then run: `{{VERIFICATION}}`
- Use Haiku (`claude-haiku-4-5`) for all `subagent` tool calls
- Commit and push your fixes
- Report what you fixed and verification results

---

### Task 9: Create sidework-cleanup.md template

**Files:**
- Create: `~/.pizzapi/plugins/nightshift/templates/sidework-cleanup.md`

- [ ] **Step 1: Write the sidework template**

Variables: `{{WORKTREE_PATHS}}`, `{{PR_LIST}}`, `{{GODMOTHER_UPDATES}}`.

Content:
- You are on Sidework — closing duties
- Rebase PRs on main: `{{PR_LIST}}` (if rebase fails, note "needs manual rebase" and continue)
- Clean up worktrees: `{{WORKTREE_PATHS}}`
- Apply Godmother status updates: `{{GODMOTHER_UPDATES}}`
- Clear any stashes created during the shift
- Delete merged remote branches
- Use Haiku (`claude-haiku-4-5`) for all `subagent` tool calls
- Report results: what succeeded, what failed, what needs human attention

---

## Chunk 3: The Main Skill — Prep & Kitchen Phases

### Task 10: Create the nightshift skill — frontmatter and overview

**Files:**
- Create: `~/.pizzapi/plugins/nightshift/skills/nightshift/SKILL.md`

- [ ] **Step 1: Write the skill frontmatter and overview**

```yaml
---
name: nightshift
description: Use when running an autonomous overnight coding shift. Orchestrates Prep, Kitchen, Critics, and Sidework phases with usage-aware model dispatch, Protocol 86, and morning reporting.
---
```

Overview section: one paragraph explaining the 4-phase lifecycle. Link to the agent definition for personality/identity.

- [ ] **Step 2: Write the argument parsing section**

Document all parameters (`--epic`, `--ideas`, `--goal`, `--p86-threshold`, `--dry-run`). Show how to parse them from the user's message.

---

### Task 11: Write Phase 1 — Prep (Mise en Place)

**Files:**
- Modify: `~/.pizzapi/plugins/nightshift/skills/nightshift/SKILL.md`

- [ ] **Step 1: Write pre-flight check procedure**

8 steps from the spec:
1. Pre-flight (git clean, main branch, Godmother reachable, Jules reachable)
2. Staff roster (`list_models`, usage check)
3. Determine intent (parse args or scan Godmother)
4. Identify Jules candidates
5. Brainstorming (Opus → Sonnet agents, skip criteria, failure handling)
6. Build the menu (structured format)
7. Dependency resolution (topological sort)
8. Reservations (capacity planning, shift forecast)

Include the exact `list_models` call, Godmother MCP calls, and the menu structure format from the spec.

- [ ] **Step 2: Define the menu data structure**

The menu is an in-memory structure tracked by the maître d'. Define the fields clearly so subsequent phases can reference them:
```
dish.id, dish.title, dish.description, dish.cookType (sonnet|haiku|jules),
dish.complexity (S|M|L), dish.dependencies[], dish.verification,
dish.godmotherIdeaId, dish.status (queued|cooking|expo|plated|served|comped|poisoned|86d),
dish.sessionId, dish.prNumber, dish.worktreePath, dish.branchName
```

---

### Task 12: Write Phase 2 — Kitchen (Service)

**Files:**
- Modify: `~/.pizzapi/plugins/nightshift/skills/nightshift/SKILL.md`

- [ ] **Step 1: Write the dispatch loop**

The core orchestration loop:
1. Fire dishes from queue (priority order, respect dependencies)
2. Concurrency: Jules hard limit 15 concurrent / 100 per day. Other providers: no hard cap, dispatch based on usage levels (≥ 80% = stop dispatching). Pace with Reservations forecast.
3. For Sonnet/Haiku: create worktree, spawn session with cook template
4. For Jules: create Jules session via MCP with `AUTO_CREATE_PR`
5. Track in session manifest

- [ ] **Step 2: Write the expo window procedure**

Two paths:
- Sonnet/Haiku (local worktree): cd in, typecheck (300s timeout), test (300s), diff scan
- Jules (remote PR): fetch branch, create worktree, same checks
- Pass/fail decision → plated or sent back (spawn fixer, one retry)

- [ ] **Step 3: Write the monitoring loop**

- Handle triggers from child sessions
- Usage checks every ~5 minutes
- Protocol 86 watch
- Kitchen Stoppage handling (retry once with different model)

---

## Chunk 4: The Main Skill — Critics & Sidework Phases

### Task 13: Write Phase 3 — Food Critics

**Files:**
- Modify: `~/.pizzapi/plugins/nightshift/skills/nightshift/SKILL.md`

- [ ] **Step 1: Write per-dish critic dispatch**

- Spawn critic for each plated dish (runs in parallel with kitchen)
- Uses critic-review template
- GPT-5.3 Codex default, fallback to Gemini/Opus
- LGTM → served; issues → spawn fixer → re-review (max 3 rounds)
- Reviewer Death → note in incident log, dish stays "plated but unreviewed"
- Critic queuing: FIFO by plate time, shares provider concurrency pool

---

### Task 14: Write Phase 4 — Sidework

**Files:**
- Modify: `~/.pizzapi/plugins/nightshift/skills/nightshift/SKILL.md`

- [ ] **Step 1: Write the closing procedure**

7 sidework steps:
1. Queue PRs for morning merge (rebase, note failures)
2. Worktree cleanup
3. Godmother updates (graceful degradation)
4. Batch critic review (session manifest, summaries, 6-category ratings)
5. Critic clippings (append to reports/critic-clippings.md)
6. Morning report (generate reports/YYYY-MM-DD-shift-report.md)
7. Cleanup (stashes, branches, verify git clean)

- [ ] **Step 2: Write the Protocol 86 abbreviated closing**

Fast-track version: skip batch critic, minimal Godmother updates, abbreviated morning report, capture remaining menu.

- [ ] **Step 3: Write the morning report template**

Include all sections from the spec: shift summary, menu table, usage report, PRs for review, incidents, ratings, critic notes, follow-up work.

- [ ] **Step 4: Write the rating system procedure**

How the batch critic evaluates: load session summaries from manifest, rate 6 categories (Cuisine, Service, Ambiance, Value, Consistency, Reservations), compute overall average, write justifications.

---

## Chunk 5: Final Assembly & Verification

### Task 15: Review all files for consistency

- [ ] **Step 1: Verify template variables match skill references**

Read through the skill and confirm every `{{VARIABLE}}` referenced in dispatch calls matches the template variable contracts.

- [ ] **Step 2: Verify model IDs**

Confirm all model IDs in templates and skill match the `list_models` registry: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `gpt-5.3-codex`, `gemini-3.1-pro-preview`.

- [ ] **Step 3: Verify failure handling coverage**

Walk through each failure type and confirm the skill handles it: Kitchen Stoppage, 86'd, Food Poisoning, Comped Meal, Reviewer Death, Protocol 86, Last Call.

- [ ] **Step 4: Verify the skill reads as a coherent playbook**

Read the full SKILL.md end-to-end. It should be followable by an agent with zero prior context about the Night Shift. Every decision point should have clear criteria.

---

### Task 16: Create a dry-run test

- [ ] **Step 1: Test the plugin loads**

Verify PizzaPi recognizes the plugin:
```bash
ls ~/.pizzapi/plugins/nightshift/plugin.json
```

- [ ] **Step 2: Verify file completeness**

Check all expected files exist:
```bash
find ~/.pizzapi/plugins/nightshift -type f | sort
```

Expected output should include all files from the file structure above.

- [ ] **Step 3: Read-test the skill**

Verify the skill frontmatter is valid YAML, description is under 1024 chars, and the skill body has all 4 phases.

---

### Task 17: Commit and push

- [ ] **Step 1: Git operations**

```bash
# Working dir: ~/Documents/Projects/nightshift
# Copy to ~/.pizzapi/plugins/nightshift/ when ready
git checkout -b feat/nightshift-plugin
git add .
git commit -m "feat: add Night Shift plugin — autonomous overnight coding orchestrator

- Agent definition (maître d' personality, Protocol 86, failure taxonomy)
- Skill with 4-phase lifecycle (Prep → Kitchen → Critics → Sidework)
- 6 prompt templates (brainstorm, cook, jules, critic, fixer, sidework)
- Rules file for child session context
- Reports directory (gitignored) for shift reports and critic clippings
- 6-star Michelin rating system
- Usage-aware model dispatch with dynamic reassignment"

git push -u origin feat/nightshift-plugin
```
