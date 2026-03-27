## Inspection: Dish 006 — Plan Mode TUI Display

### Quality Gates
- **Typecheck:** SKIPPED (all errors are pre-existing false positives — `bun:test`, `bun:sqlite`, `Bun` global; no new errors from changed file)
- **Tests:** FAIL (0 pass, 106 fail — all failures are pre-existing redis/bun runtime issue unrelated to this change; no `remote-plan-mode.test.ts` exists)

### Findings

#### P0 (Critical)
- None

#### P1 (Serious)
- **No tests for new rendering logic.** `packages/cli/src/extensions/remote-plan-mode.ts` adds ~80 lines of box-drawing, word-wrap, ANSI styling, and two-column layout logic with zero test coverage. AGENTS.md requires "All new code must include tests." Functions like `vlen()`, `wrap()`, `row()`, and `makeOptRow()` are pure and easily unit-testable. (`remote-plan-mode.ts:142–239`)

#### P2 (Moderate)
- **`wrap()` doesn't break long words.** If any single word exceeds `maxWidth`, the loop appends it to its own line without splitting. That word overflows the box boundary. For a step description containing a long URL or camelCase identifier this will silently bust the border alignment. (`remote-plan-mode.ts:168–179`)

#### P3 (Minor)
- **`wrap()` measures with `cur.length` (code-unit count) rather than visible width.** For CJK characters or multi-codepoint emoji inside description text, the wrap threshold is inaccurate — `vlen()` already exists but is unused inside the wrap loop. (`remote-plan-mode.ts:173`)
- **`INNER` grows unboundedly with title length.** `Math.max(62, title.length + 16)` has no upper cap. A pathologically long title (e.g. 300 chars from a misbehaving model) will produce a box wider than any terminal. A cap of e.g. `Math.min(process.stdout.columns - 4, …)` would be safer. (`remote-plan-mode.ts:188`)

### Completeness

- Box-drawing frame — ✅ (`╭ ─ ╮ / │ / ├ ─ ┤ / ╰ ─ ╯` with mid-bar separator before options)
- Word-wrap — ⚠️ (works for normal prose; fails silently on single tokens longer than maxWidth)
- Numbered steps — ✅ (bold-accented number + bold title, dim-wrapped description lines)
- Two-column options — ✅ (`(1)/(2)` on row 1, `(3)/(4)` on row 2; column width governed by `COL1=30` with `vlen`-aware gap)
- PizzaPi visual style (warm plum) — ✅ (`accent` = `rgb(232,180,248)`, `bc` = `rgb(196,167,224)`; bold/dim helpers; consistent with existing palette)
- Integrates with pi plan_mode hook — ✅ (renders through `ctx.ui.input()`; same mechanism as pre-existing code; option-key → action mapping unchanged and correct)
- Handles edge cases (empty steps, long text) — ⚠️ (empty steps array guarded; long words overflow; no terminal-width cap on box)

### Verdict
**CITATION**

### Summary
The box-drawing frame, two-column option layout, numbered steps, and warm plum palette are all correctly implemented and visually solid. The primary deficiency is the complete absence of unit tests for a sizeable block of pure rendering logic — a clear violation of project standards. Two secondary issues (long-word overflow in `wrap()` and unbounded box width on extreme titles) represent correctness gaps under edge inputs rather than normal operation.
