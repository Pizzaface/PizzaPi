# Dish 002: Custom Header Extension

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** none — goal-driven
- **Dependencies:** 001 (theme must exist for color tokens)
- **Files:** packages/cli/src/extensions/pizzapi-header.ts (new), packages/cli/src/extensions/factories.ts (modify)
- **Verification:** bun run typecheck, bun test packages/cli, manual verification header renders
- **Status:** served
- **Confidence:** Band A (dispatchPriority=high)

## Task Description

Create a new extension that replaces pi's built-in header with a PizzaPi-branded "balanced control panel" header.

### Design: Balanced Control Panel

```
╭─────────────────────────── 🍕 PizzaPi v0.4.0 ───────────────────────────╮
│ Ctrl+C interrupt · Ctrl+D exit · Ctrl+Z suspend · Ctrl+K delete to end  │
├──────────────────────────────────────────────────────────────────────────┤
│ ⇧Tab thinking · Ctrl+R thinking · Ctrl+J/K cycle models · Ctrl+L select │
│ Ctrl+E tools · Ctrl+O editor · Ctrl+F follow-up · Ctrl+G dequeue        │
│ / commands · ! bash · !! bash (no ctx) · Ctrl+V paste · drop files       │
╰──────────────────────────────────────────────────────────────────────────╯
```

### Implementation

1. Create `packages/cli/src/extensions/pizzapi-header.ts`
2. Use the `ctx.ui.setHeader(factory)` extension API
3. The factory receives `(tui, theme)` — use `theme.fg("accent", ...)`, `theme.fg("dim", ...)`, `theme.fg("border", ...)` for colors
4. Return a `Component` with `render(width)`, `invalidate()`, and optional `dispose()`
5. The header MUST be responsive to terminal width:
   - Wide (≥100 cols): full box-drawing frame, centered title in top border
   - Narrow (< 80 cols): simplified, no box frame, just text lines
6. Read keybindings from the `KeybindingsManager` if accessible, otherwise use the default keys
7. Use box-drawing characters: `╭╮╰╯│─├┤`
8. Version should come from the PizzaPi package.json, NOT from pi's VERSION

### Integration

- Register in `buildPizzaPiExtensionFactories()` in `factories.ts`
- Should run AFTER remote extension (so relay status is available)
- Must not conflict with the existing remote-footer extension

### Key Reference

Read the actual keybinding defaults from pi's source. The hints shown above are approximate — the extension should use the real configured keybinding names, not hardcoded strings.

---

## Kitchen Disconnect — Fixer Diagnosis

**Sent back:** P1 — Width constraint violated in narrow mode; threshold off-by-20 cols.

### Root Causes

**1. Hardcoded string in narrow fallback (P1)**

The narrow-mode branch returned a statically composed string:

```ts
theme.fg("accent", `🍕 PizzaPi v${version}`) +
theme.fg("dim", "  Ctrl+C clear · Ctrl+D exit · Ctrl+Z suspend")
```

This line is ~62 visible characters at runtime regardless of the `width` parameter. The `width` argument was checked only as a gate (`if (width < 80)`) but never used to constrain the output.

The cook *did* implement `buildHintLine` — a helper that takes `innerWidth` and truncates hints — for the wide-mode rows. But the narrow branch bypassed it entirely, assembling hints as a hand-written string literal instead. The pattern needed was the same one already written two dozen lines above; it simply wasn't applied here.

**2. Wrong threshold (P2)**

The spec states:
- Wide (≥100 cols): full box-drawing frame
- Narrow (< 80 cols): simplified text

The cook wrote `if (width < 80)` — taking the narrow threshold without cross-referencing the wide threshold. This creates an undocumented 80–99 band that receives the wide (7-line box) layout despite being labeled narrow, and leaves a 20-col gap where neither mode was intentionally specified.

### Fix Applied

- Threshold changed from `< 80` to `< 100`.
- Narrow mode now iterates over the title character-by-character using `visibleWidth` to build a `titleFit` string capped at `width` visible chars.
- Remaining space (`width - titleFitWidth - 2`) is passed to `buildHintLine`, which truncates hint segments the same way wide-mode rows do.
- Tests updated: descriptions corrected to `>= 100`/`< 100`; added boundary tests (`width=99` → narrow, `width=100` → wide) and explicit width-constraint assertion loops for both modes.

**Commit:** `fix: respect width constraint in header narrow mode`  
**Branch:** `nightshift/dish-002-custom-header`

---

## Health Inspection — 2026-03-25
- **Inspector Model:** claude-sonnet-4-5 (Health Inspector)
- **Verdict:** 🟡 CITATION
- **Findings:** P3 — stale `< 80` in file-level JSDoc (actual threshold is `< 100`). P3 — `padToWidth()` has no truncation path; silently returns oversized content. No runtime impact with current callers but latent API footgun.
- **Critic Missed:** Both P3s (below violation threshold; critics focused on real P1/P2 issues in prior rounds).
