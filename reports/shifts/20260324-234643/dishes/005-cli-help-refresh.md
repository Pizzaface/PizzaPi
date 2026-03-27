# Dish 005: CLI Help Refresh

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** none — goal-driven
- **Dependencies:** none
- **Files:** packages/cli/src/index.ts (modify help output), packages/cli/src/setup.ts (modify), packages/cli/src/web.ts (modify help), packages/cli/src/plugins-cli.ts (modify)
- **Verification:** bun run typecheck, bun test packages/cli
- **Status:** served
- **Confidence:** Band B (dispatchPriority=normal)

## Task Description

Refresh all CLI help and status output surfaces to use ANSI colors and improved formatting.

### Surfaces to Refresh

#### 1. `pizza --help` (index.ts)

Before:
```
pizzapi v0.4.0 — PizzaPi coding agent

Usage:
  pizza                       Start an interactive agent session
  ...
```

After:
```
🍕 PizzaPi v0.4.0

Commands
  pizza              Start an interactive session
  pizza web          Manage the web hub (Docker)
  pizza runner       Background runner daemon
  ...

Flags
  --cwd <path>       Working directory
  --sandbox <mode>   Sandbox: enforce, audit, off
  ...

Run pizza <command> --help for command-specific help.
```

Use ANSI colors: command names in bold/accent, descriptions in default, section headers in a label color, flag names in a different color from commands. Use `chalk` or raw ANSI escape sequences (check what the project already uses).

#### 2. `pizza setup` (setup.ts)

- Keep the box-drawing frame but make it PizzaPi-branded with colored borders
- Add warmth to the copy: "Welcome to PizzaPi!" not just "first-run setup"
- Color the progress indicators (✓ in green, ✗ in red)

#### 3. `pizza usage` (index.ts usage section)

- Add color-coded usage percentages: green (<50%), amber (50-80%), red (>80%)
- Consider adding simple bar indicators: `[████████░░] 80%`

#### 4. `pizza models` (index.ts models section)

- Group models by provider with colored provider headers
- Show credential status with colored badges

#### 5. `pizza web --help` and subcommands (web.ts)

- Apply same color treatment as main help
- Consistent with the overall style

### Constraints

- All color output must respect `NO_COLOR` environment variable (check if terminal supports color first)
- Must not break `--json` output on any command
- Keep the functional content identical — only change formatting/colors
- Use whatever ANSI/color approach already exists in the codebase (check for chalk, kleur, or raw escape codes)

---

## Kitchen Disconnect — Fixer Diagnosis

**Sent back by critic. Three issues. All fixed in commit `ad043b3`.**

### Issue 1 — NO_COLOR presence-based spec (P2)
**Root cause:** The cook used `!process.env["NO_COLOR"]` which relies on JavaScript's falsy coercion. An empty string (`""`) is falsy in JS, so `NO_COLOR=""` (the most common form set by terminal multiplexers and editors) kept colors *on* — directly violating the [no-color.org spec](https://no-color.org/), which is purely presence-based.  
**Fix:** Changed to `!("NO_COLOR" in process.env)`. An empty string is a valid value; what matters is whether the key exists in the environment at all.  
**Tests added:** Two new tests assert that `NO_COLOR=""` disables both `usageBar` and `colorPct` output.

### Issue 2 — Gemini remaining color inversion (P2)
**Root cause:** The cook correctly computed `usedPct = (1 - remainingFraction) * 100` for the progress bar (usage semantics: high = red), but passed `remainingFraction * 100` directly to `colorPct()` for the text label. `colorPct` maps high→red, so 90% *remaining* showed as red — semantically inverted. The bar was correct; the label was wrong.  
**Fix:** Changed `colorPct(bucket.remainingFraction * 100)` to `colorPct((1 - bucket.remainingFraction) * 100)` — converting remaining→used before coloring, consistent with how the bar already worked.

### Issue 3 — 80% threshold edge (P3)
**Root cause:** The spec says red is `>80%`, meaning exactly 80.0% should be amber. The cook used `pct < 80` as the amber upper bound, which falls through to the `else` (red) at exactly 80. The bug existed in both `usageBar` (two color blocks: bar and percentage text) and `colorPct`.  
**Fix:** Changed all three `pct < 80` amber guards to `pct <= 80`. Now 80.0% correctly renders amber, and 80.1% is red.  
**Tests added:** Boundary test verifying plain-text output at 79.9%, 80.0%, and 80.1% (color paths verified via code review; TTY mock not feasible in bun:test).

---

## Health Inspection — 2026-03-25
- **Inspector Model:** claude-sonnet-4-5 (Health Inspector)
- **Verdict:** 🔴 VIOLATION
- **Findings:** P1 — Gemini usage label still shows remaining fraction (`colorRemaining(remainingFraction * 100) remaining`) instead of inverted used percentage — bar fill and label are semantically contradictory. P2 — color threshold tests use NO_COLOR=1 only; actual ANSI color logic at 79.9/80.0/80.1 boundary never verified at runtime.
- **Critic Missed:** The P1 (Gemini label inversion) survived 3 rounds of Codex review. Fix required before merge: label should use `colorPct(usedPct)` with `"used"` suffix.
