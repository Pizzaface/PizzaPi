# Dish 003: Footer Polish

- **Cook Type:** sonnet
- **Complexity:** S
- **Godmother ID:** none — goal-driven
- **Dependencies:** 001 (theme must exist for color tokens)
- **Files:** packages/cli/src/extensions/remote-footer.ts (modify)
- **Verification:** bun run typecheck, bun test packages/cli
- **Status:** served
- **Confidence:** Band A (dispatchPriority=high)

## Task Description

Polish the existing remote footer extension to use themed colors consistently and improve the information display.

### Changes

1. **Themed status colors**: Use `theme.fg("success", ...)` for connected, `theme.fg("error", ...)` for disconnected, `theme.fg("warning", ...)` for reconnecting — instead of hardcoded color names
2. **Model badge**: Show provider in accent color, model name in muted
3. **Token stats**: Use `theme.fg("dim", ...)` for the stats line
4. **Session name**: Highlight in `theme.fg("accent", ...)` when present
5. **Git branch**: Show with a branch icon/symbol
6. **Context usage**: Use color gradient based on percentage — dim for low, warning for >70%, error for >90%

### Constraints

- Must not change the footer's layout structure (still 2 lines)
- Must remain responsive to terminal width
- Must keep all existing functionality (tokens, cost, relay status, model, context)
- Colors must use theme tokens, not hardcoded hex values

---

## Health Inspection — 2026-03-25
- **Inspector Model:** claude-sonnet-4-5 (Health Inspector)
- **Verdict:** 🟡 CITATION
- **Findings:** P2 — context gradient dim zone narrows to <50% instead of spec-implied <70%, leaving 50–69% usage unstyled. P3 — session name accent silently drops when truncated. P3 — line1Pad/line2Pad almost always zero.
- **Critic Missed:** P2 dim threshold gap and P3s. Critic override was correct for worktree env issues.
