# Dish 005: System Prompt Guidance — Parent Agents + session_complete Triggers

- **Cook Type:** jules
- **Complexity:** S
- **Band:** A (clarityScore=78, riskScore=13, confidenceScore=70)
- **Godmother ID:** CTzqSajA
- **Pairing:** solo
- **Paired:** false
- **Dependencies:** none
- **dispatchPriority:** high
- **Files:**
  - `packages/cli/src/config.ts` (update BUILTIN_SYSTEM_PROMPT)
- **Verification:** grep for added text + `bun run typecheck`
- **Jules candidate:** yes (single-file string addition, < 20 lines, clear verification)
- **Status:** served (solo — Jules PR created)
- **Jules Session:** 9539806504133081068
- **PR:** #337 — https://github.com/Pizzaface/PizzaPi/pull/337
- **Branch:** feat/system-prompt-trigger-guidance-9539806504133081068

## Jules Output
Single-line addition to `packages/cli/src/config/system-prompt.ts` — adds intermediate vs. final child completion guidance after the existing session_complete/ack/followUp docs. Clean diff, correct placement.

No Ramsey needed (Jules solo dish with auto-PR). Skipping critic — single-line string addition below complexity threshold.

## Task Description

### Objective
Add clear guidance to `BUILTIN_SYSTEM_PROMPT` in `packages/cli/src/config.ts` telling parent agents NOT to respond to every `session_complete` trigger from a child. Currently the prompt tells agents how to respond (ack/followUp actions) but doesn't tell them they can safely ignore intermediate completions from children that have spawned their own sub-children.

### The Problem
When a parent spawns a child (e.g., Opus brainstormer) and that child spawns its own children (Sonnet workers), the parent receives `session_complete` triggers each time the child's turn completes. The parent feels obligated to respond, wasting tokens and polluting context. The child is still running (its own children keep it alive), so the parent's response is unnecessary.

### The Fix
In `packages/cli/src/config.ts`, find `BUILTIN_SYSTEM_PROMPT` (it's a template literal string). Add a new paragraph to the section about triggers (look for the section discussing `session_complete`, `ack`, and `followUp`).

Add guidance similar to:
```
**Intermediate vs. final child completions:** When a child session has spawned its own
sub-children, it may fire `session_complete` triggers between sub-tasks as its context
window cycles. You do NOT need to respond to every trigger. If the child's output in
the trigger message indicates it is still working (e.g., "dispatching workers", 
"waiting for results", "brainstorming"), use `action: "ack"` and wait for the next
trigger rather than sending a `followUp` that interrupts the child's flow. Only send
a `followUp` when the child's output indicates it has finished and is awaiting your
direction. If you are unsure, `ack` is always safe — it acknowledges without sending
new instructions.
```

### Verification
```bash
# Confirm the text is present
grep -n "Intermediate\|intermediate.*trigger\|followUp.*ack\|do NOT need to respond" packages/cli/src/config.ts

# Type check
bun run typecheck
```

### Branch + PR
```bash
git checkout -b feat/system-prompt-trigger-guidance
# Edit packages/cli/src/config.ts
git add packages/cli/src/config.ts
git commit -m "docs(cli): add system prompt guidance on intermediate session_complete triggers

Parent agents no longer need to respond to every child trigger — add
clear guidance that ack is safe when the child is still working.

Closes: CTzqSajA"
gh pr create --base main --title "docs(cli): parent agent trigger guidance for intermediate completions" --body "..."
```

### Jules Notes
Jules should:
1. Read `packages/cli/src/config.ts` in full to find BUILTIN_SYSTEM_PROMPT
2. Find the section discussing `session_complete` triggers and respond/ack/followUp actions
3. Add the new paragraph in context (not at random location — after the existing trigger guidance)
4. Verify the string compiles (no broken template literals)
5. Create a PR from `feat/system-prompt-trigger-guidance` to `main`
