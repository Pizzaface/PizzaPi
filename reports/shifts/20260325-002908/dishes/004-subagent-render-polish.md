# Dish 004: Subagent Render.ts Plum Palette Audit + Polish

- **Cook Type:** claude-sonnet-4-6
- **Complexity:** S
- **Band:** B (clarityScore=63, riskScore=18, confidenceScore=52)
- **Godmother ID:** —
- **Dependencies:** 001 (Soft: theme file needed to evaluate token values; can audit without it if 001 is delayed)
- **dispatchPriority:** normal
- **Files:**
  - `packages/cli/src/extensions/subagent/render.ts`
- **Verification:** `bun run typecheck`, `bun test packages/cli/src/extensions/subagent`
- **Status:** served
- **PR:** #322
- **Expo:** PASS — 5 changes applied correctly; test failures are pre-existing redis/bun:test worktree false positives; cook left changes unstaged (Maître d' committed + pushed directly)

## Task Description

The subagent `render.ts` was designed before the pizzapi-dark theme was created. With the plum palette (`accent=#e8b4f8`, `muted=#9a8aad`, `dim=#706080`, `border=#c4a7e0`), audit the token usage and make targeted refinements.

### Current token usage in render.ts

- Agent names: `theme.fg("toolTitle", theme.bold(r.agent))` — `toolTitle=""` means **default terminal fg** (white/bright). This is fine for readability.
- Agent source: `theme.fg("muted", ` (${r.agentSource})`)` — muted purple `#9a8aad`. Good.
- Section separators (`─── Task ───`, `─── Output ───`, `─── Step N:`): `theme.fg("muted", ...)` — muted purple. These are visual dividers, `muted` is appropriate.
- Icons: `✓` in `success`, `✗` in `error`, `⏳` in `warning`. Good.
- Usage stats: `theme.fg("dim", usageStr)` — dim `#706080`. Appropriate for secondary info.
- Task preview: `theme.fg("dim", ...)`. Appropriate.
- Output text: `theme.fg("toolOutput", ...)` — in pizzapi-dark `toolOutput="muted"` so `#9a8aad`. Fine.

### Specific refinements needed

1. **Section separators use longer box-drawing lines** — Currently `─── Task ───` and `─── Output ───` are plain. With the plum palette, using `border` color (#c4a7e0, medium plum) for separators would create better visual hierarchy. Change `theme.fg("muted", "─── Task ───")` to `theme.fg("border", "─── Task ───")`.

2. **Subagent call header** — The subagent call render shows:
   ```
   subagent  chain (N steps)  [scope]
   ```
   The word "subagent" uses `theme.fg("toolTitle", theme.bold("subagent "))`. Since `toolTitle=""` this is bold default-fg. Add a subtle 🍕 or `◈` PizzaPi marker ONLY for chain/parallel modes (these are PizzaPi-specific orchestration tools). For single mode, keep as-is.
   
   For parallel and chain headers, change:
   ```typescript
   theme.fg("toolTitle", theme.bold("subagent "))
   ```
   to:
   ```typescript
   theme.fg("accent", "◈ ") + theme.fg("toolTitle", theme.bold("subagent"))
   ```
   This adds a diamond accent marker in plum to distinguish orchestration modes visually.
   
   For single mode (not chain/parallel), keep the existing format.

3. **Step indicators in chain/parallel** — Currently uses `theme.fg("muted", "─── Step N: ")`. Change to `theme.fg("border", "─── ")` + `theme.fg("muted", "Step ")` + `theme.fg("accent", `${r.step}:`)` + `theme.fg("muted", " ")` for slightly better visual distinction of step numbers.

4. **"Total:" label** — For chain/parallel, the total usage line uses `theme.fg("dim", `Total: ${usageStr}`)`. Change to `theme.fg("muted", "Total: ") + theme.fg("dim", usageStr)` so the label is slightly more visible.

5. **Parallel mode "─── agent" headers** — The `─── agentName` pattern for parallel results: use `theme.fg("border", "─── ")` + `theme.fg("accent", r.agent)` for the agent name.

### What NOT to change

- ✓/✗/⏳ icons — correct token usage, leave as-is
- Usage stats format — appropriate dim treatment
- Error message colors — correct
- `COLLAPSED_ITEM_COUNT` behavior — leave as-is
- Fallback rendering — leave as-is

### Verification

1. `bun run typecheck` passes with 0 errors
2. `bun test packages/cli/src/extensions/subagent` passes
3. No functional behavior changed — only visual token changes
4. Changes are minimal and targeted (5 specific improvements, not a full rewrite)


## Health Inspection — 2026-03-25T11:44Z
- **Inspector Model:** claude-opus-4-6
- **Verdict:** CLEAN_BILL
- **Findings:** None. Trivial P3 note: trailing space inside accent span in step indicator (`theme.fg("accent", \`${r.step}: \`)`) where spec suggested placing space outside. Functionally identical — space is invisible against same-color next token. All 5 changes verified applied consistently across expanded/collapsed/text paths. Single mode confirmed unchanged.
- **Critic Missed:** Nothing — critic verdict confirmed.
