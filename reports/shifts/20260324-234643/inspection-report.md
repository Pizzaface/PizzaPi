# Health Inspection — 2026-03-25

**Shift:** 20260324-234643
**Inspector:** Health Inspector (invoked 2026-03-25)
**Dishes Inspected:** 8 of 8 served
**PRs Under Review:** #302, #303, #304, #305, #306, #308, #309, #310

---

## Overall Grade

**D — Multiple violations. 3 of 4 on-the-fly dishes bypassed critic review entirely; 1 P1 slipped through 3 rounds of critic coverage on a planned dish.**

Grading scale:
- **A** — All clean bills. Critics caught everything.
- **B** — Citations only (P2/P3 misses). Minor gaps.
- **C** — 1–2 violations (P0/P1 misses). Significant gaps.
- **D** — Multiple violations. Critics were unreliable.
- **F** — Condemned dishes found. Do NOT merge without review.

> **Context note:** All 4 violations trace to systemic process gaps rather than catastrophic code quality. The 3 expedited on-the-fly dishes (006–008) were served with zero external critic coverage; their P1s were predictable consequences of that shortcut. Dish 005's P1 is more concerning — a spec deviation that survived 3 rounds of review. No dishes are condemned; all PRs are mergeable with targeted fixes.

---

## Per-Dish Results

---

### Dish 001: PizzaPi Dark Theme — PR #302

- **Critic Verdict:** LGTM (override — pre-existing worktree env false positives)
- **Inspector Verdict:** ✅ CLEAN BILL
- **Findings:** None. All 51 schema tokens present and correctly mapped. `$schema` URL, theme name, thinking gradient arc, and `pi.themes` registration are all correct.
- **Discrepancy:** None. Critic override was correct; the worktree failures were pre-existing Redis/bun type declaration issues unrelated to a JSON theme file.
- **Action:** None. Safe to merge.

---

### Dish 002: Custom Header Extension — PR #306

- **Critic Verdict:** LGTM (round 3 — real P1/P2 issues caught and fixed in earlier rounds)
- **Inspector Verdict:** 🟡 CITATION
- **Findings:**
  - **P3 — Stale doc comment:** File-level JSDoc states `"< 80 cols"` fallback threshold; actual code threshold is `< 100`. Comment-only error, logic is correct.
  - **P3 — `padToWidth` has no truncation path:** When `visibleWidth(s) >= width`, the function silently returns `s` unchanged. No runtime impact with current callers (all inputs are pre-bounded) but the helper is misleadingly named and could silently overflow if reused.
- **Discrepancy:** The round-3 critic approved cleanly. Both missed issues are P3 (doc comment staleness + latent API footgun) — below the violation threshold.
- **Action:** Godmother captured. Safe to merge.

---

### Dish 003: Footer Polish — PR #304

- **Critic Verdict:** LGTM (override — worktree env false positives)
- **Inspector Verdict:** 🟡 CITATION
- **Findings:**
  - **P2 — Context gradient dim zone narrower than spec implies:** Spec reads "dim=low, warning=>70%, error=>90%", implying dim for anything below the warning threshold (<70%). Implementation dims only below 50% and leaves 50–69% as unstyled default text — a 4-stage gradient instead of the implied 3-stage. Usage at 55% renders at default terminal brightness, appearing spuriously elevated against surrounding dim stats.
  - **P3 — Session name accent silently drops on truncation:** Accent applied only when `locationLine.left.endsWith(sessionSuffix)` — if `truncateMiddle` cuts into the name, the entire left side falls back to dim with no indicator that truncation occurred.
  - **P3 — `line1Pad`/`line2Pad` almost always zero:** Padding calculations produce 0-length strings in normal operation. Harmless but mildly misleading.
- **Discrepancy:** Critic override was correct for the worktree env issues. The P2 dim-zone gap and P3s were not caught. The P2 is a spec deviation, not a crash.
- **Action:** Godmother captured. Safe to merge; consider fixing dim threshold before merge.

---

### Dish 004: Terminal Title Override — PR #303

- **Critic Verdict:** LGTM (round 1 — clean)
- **Inspector Verdict:** ✅ CLEAN BILL
- **Findings:**
  - **P3 — Root-CWD trailing space:** `basename("/")` returns `""` on POSIX → title becomes `"🍕 PizzaPi — "` (dangling `— `). Explicitly acknowledged in the test suite. Near-zero real-world impact.
- **Discrepancy:** The P3 edge case was known and documented in tests. The inspector confirms the critic's LGTM verdict; this does not rise to Citation.
- **Action:** None. Safe to merge.

---

### Dish 005: CLI Help Refresh — PR #305

- **Critic Verdict:** LGTM (round 3 — NO_COLOR, color inversion, 80% threshold all addressed)
- **Inspector Verdict:** 🔴 VIOLATION
- **Findings:**
  - **P1 — Gemini usage label NOT inverted to "used":** The spec requires the Gemini bar AND label to invert to "used percentage." The bar correctly inverts (`usedPct = (1 - remainingFraction) * 100`), but the label still displays the raw remaining fraction: `` colorRemaining(bucket.remainingFraction * 100) remaining ``. Output reads e.g. `[████░░░░░░] 30.0% remaining` — bar fill and label are semantically contradictory.
  - **P2 — Color threshold tests are NO_COLOR-only:** Tests assert plain-text output with `NO_COLOR=1`. The actual color logic at the 79.9/80.0/80.1 boundary is never verified at runtime. The threshold logic in `cli-colors.ts` is correct by inspection (`pct <= 80` → amber, `> 80` → red) but has no runtime proof.
- **Discrepancy:** The round-3 critic gave a clean LGTM. The P1 — the single most visible output the spec called out — was missed. This is a meaningful critic failure: a clear spec requirement that survived 3 review rounds undetected.
- **Action:** Godmother captured. **Fix required before merge.** Update Gemini label to use `colorPct(usedPct)` with `"used"` suffix.

---

### Dish 006: Plan Mode TUI Display — PR #308

- **Critic Verdict:** Cook-verified only (no external critic assigned)
- **Inspector Verdict:** 🔴 VIOLATION
- **Findings:**
  - **P1 — Zero tests for new rendering logic:** ~80 lines of box-drawing, word-wrap, ANSI styling, and two-column layout added with no test coverage. All helpers (`vlen()`, `wrap()`, `row()`, `makeOptRow()`) are pure functions and easily unit-testable. AGENTS.md is explicit: all new code must include tests.
  - **P2 — `wrap()` does not break long words:** A single word exceeding `maxWidth` is placed on its own line without splitting, causing silent border overflow. URLs and camelCase identifiers in step descriptions will bust the box alignment.
  - **P3 — `wrap()` uses `cur.length` (code-unit count) not `vlen()`:** `vlen()` already exists but is unused inside the wrap loop; CJK/emoji content will miscalculate wrap threshold.
  - **P3 — `INNER` box width grows unboundedly with title length:** `Math.max(62, title.length + 16)` has no upper cap. A pathologically long title (from a misbehaving model) will produce a box wider than any terminal. Needs a `Math.min(process.stdout.columns - 4, …)` cap.
- **Discrepancy:** No external critic was assigned. The on-the-fly expedite meant this shipped cook-verified only. Inspector found a P1 (missing tests per AGENTS.md) and a P2 (rendering overflow).
- **Action:** Godmother captured. Fix required before merge. Add unit tests; add long-word splitting to `wrap()`; cap `INNER` width to terminal columns.

---

### Dish 007: AskUserQuestion TUI Display — PR #309

- **Critic Verdict:** Cook-verified only (no external critic assigned)
- **Inspector Verdict:** 🔴 VIOLATION
- **Findings:**
  - **P1 — Long text silently overflows box borders:** `padTo()` correctly pads short strings to `BOX_W=58` but does nothing when content exceeds that width — `Math.max(0, BOX_W - visLen(s))` adds 0 padding silently, pushing the right `│` border rightward. Available interior budget is 56 chars after 2-char indent; real-world LLM-generated questions routinely exceed this. Numbered option lines have an even tighter budget (~53 chars after `(N) ` prefix). No wrapping, truncation, or ellipsis applied.
  - **P2 — Zero test coverage for all new display code:** The entire `buildBox` / `typeLabel` / `visLen` / `padTo` / `bRow` implementation is untested. All helpers are defined inside the private `askUserQuestion` function scope, making unit testing impossible without a refactor to export them.
  - **P2 — `visLen` does not account for wide (2-column) Unicode:** ANSI-stripping regex produces the correct char count but emoji and CJK characters occupy 2 terminal columns while `.length` returns 1 (or 2 for surrogate pairs). An option like `"🍕 Neapolitan"` will shift the right border.
  - **P3 — `hdrDashes` magic formula undocumented:** `BOX_W - 1 - hdr.length` requires mental arithmetic to verify; a brief inline comment would clarify the border math.
  - **P3 — No test for empty-options layout:** The `q.options.length > 0` guard is correct but the path is entirely unexercised in the test suite.
- **Discrepancy:** No external critic was assigned. Inspector found a P1 (silent overflow on any question exceeding 56 chars) and two P2s (no tests + wide-char miscounting).
- **Action:** Godmother captured. Fix required before merge. Add text wrapping/truncation to `buildBox`; refactor helpers into exportable scope and add unit tests; fix `visLen` for wide Unicode.

---

### Dish 008: Notifications Polish — PR #310

- **Critic Verdict:** Cook-verified only (no external critic assigned)
- **Inspector Verdict:** 🔴 VIOLATION
- **Findings:**
  - **P1 — Hardcoded RGB `\x1b[38;2;232;180;248m` bypasses theme system:** The plum brand color (#E8B4F8) is embedded as raw 24-bit ANSI RGB in 8 places across `claude-plugins.ts` (lines 511, 545, 571, 629, 635) and `remote/index.ts` (lines 787, 1059, 1066). The task spec explicitly required using theme tokens. The correct approach is `theme.fg("accent", text)` via `ctx.ui.theme`. As written, this color is invisible to the theme system and cannot be overridden by custom themes.
  - **P2 — `\x1b[0m` full-reset inside theme-wrapped messages breaks outer color:** `showWarning()` / `showStatus()` wrap entire messages in `theme.fg("warning"/"dim", …)`. Inner `\x1b[0m` full-resets cancel all SGR attributes mid-message, including the outer wrapper. Text after each reset renders in terminal default foreground instead of the intended warning/dim color. This is present in multiple notification sites.
  - **P2 — Embedded color codes fight `showStatus()`'s dim wrapper:** `/remote` status notifications embed green/red ANSI (`\x1b[32m`, `\x1b[31m`) but route through `showStatus()` which wraps the full message in `theme.fg("dim", …)`. Embedded colors take effect locally, but after any inner `\x1b[0m` the text falls back to terminal default, not dim.
  - **P3 — Sandbox violation count uses warning yellow, not error red:** `violations.length > 0` colored `\x1b[33m`. Sandbox violations are blocked access attempts — closer to error than warning in severity.
  - **P3 — `sandbox-events.ts` ANSI not gated on TTY:** `formatStatus()` / `formatViolations()` embed raw ANSI unconditionally. In headless/RPC mode, downstream receivers will see literal escape sequences. The safe mode banner in `index.ts:423` correctly gates colors on `process.stdout.isTTY`; the same pattern should apply here.
- **Discrepancy:** No external critic assigned. Inspector found a P1 (hardcoded RGB violates the spec's explicit requirement for theme tokens) and two P2s (ANSI reset conflicts + TTY gating).
- **Action:** Godmother captured. Fix required before merge. Replace all `\x1b[38;2;232;180;248m` occurrences with `theme.fg("accent", …)`; replace `\x1b[0m` with targeted SGR resets (`\x1b[22m`, `\x1b[39m`); gate sandbox formatter ANSI on `isTTY`.

---

## Critic Accuracy Summary

| Metric | Value |
|--------|-------|
| Dishes inspected | 8 |
| Clean bills (critic confirmed) | 2 (dishes 001, 004) |
| Citations (critic missed minor P2/P3) | 2 (dishes 002, 003) |
| Violations (P0/P1 missed or uncritiqued) | 4 (dishes 005, 006, 007, 008) |
| Condemned | 0 |
| External critic coverage | 5 of 8 dishes |
| On-the-fly dishes without critic | 3 (dishes 006, 007, 008) |
| Critic accuracy on covered dishes | 60% (3 clean/5 externally reviewed; 005 was a miss) |
| Violations attributable to no critic | 3 of 4 |
| Violations attributable to critic miss | 1 of 4 (dish 005, P1 through 3 rounds) |

---

## Systemic Patterns

### Pattern 1: On-the-Fly Dishes Bypass Quality Gates
All 3 on-the-fly dishes (006, 007, 008) were served cook-verified only. All 3 have P1 issues. This is not coincidence — it is a direct consequence of expediting without external critic coverage. The Night Shift protocol has no requirement that on-the-fly dishes receive a critic pass before being served.

**The fix is protocol-level:** On-the-fly dishes MUST have at least one critic pass, even if the complexity is rated S. The alternative (allowed by the protocol) — mark them as "experimental, unreviewed, fix-before-merge" — was not done. These PRs are in the review queue with no such caveat.

### Pattern 2: Box-Drawing Components Share Overflow Vulnerability
Dishes 006 and 007 both implement fixed-width box-drawing components with the same latent overflow bug: when content exceeds the interior budget, `padTo()`/`pad()` silently returns content unmodified, pushing the right border out of alignment. No wrapping or truncation. This is the same error written twice, by the same cook, in the same shift. The cook's template or approach needs a standard "content budget" pattern for box-drawing.

### Pattern 3: Box-Drawing Components Lack Tests
Both dishes 006 and 007 added box-drawing rendering logic with zero test coverage. The pattern in dish 002 (20 width-range tests) and dish 005 (9 tests) was not followed for the on-the-fly dishes. Cook was working under time pressure and likely deprioritized tests. Neither dish file contained a test-writing requirement — on-the-fly prompts need AGENTS.md testing mandate explicit in the task description.

### Pattern 4: Theme Token Discipline Eroded Late in Shift
Dish 008 explicitly hardcoded a theme color it was told not to hardcode. The task spec said "use theme tokens where possible (not hardcoded hex)" and then hardcoded that exact hex 8 times. This is most likely a context/fatigue issue in a long overnight shift — the later on-the-fly dishes had less scrutiny in both cook prompting and critic coverage.

### Pattern 5: Dish 005 P1 Survived 3 Critic Rounds
The Gemini usage label inversion was a single-line, visually obvious spec requirement. It survived 3 rounds of Codex critic review. This may indicate:
- The Codex critics were evaluating "does the code work" rather than "does the code match the spec"
- The spec requirement for label inversion was not prominent enough in the critic prompt
- Round 3 critics may have been primed to find "is it fixed from round 2" rather than re-reading the full spec

---

## Recommendations

### Process
1. **On-the-fly dishes must receive external critic coverage before being served.** Update the Night Shift skill to make critic assignment mandatory for all on-the-fly dishes, regardless of complexity rating. Minimum 1 critic pass. Flag dishes served without it as "unreviewed — pending critic" in the PR description.

2. **Cook prompts for box-drawing components should include a mandatory "content overflow" test.** Any dish implementing a fixed-width box must include a test asserting that content wider than the box's interior budget is handled (wrapped, truncated, or explicitly rejected). The width-range test pattern from dish 002 should be the template.

3. **Testing requirements should be explicit in on-the-fly task descriptions.** On-the-fly dishes are generated quickly; AGENTS.md's test requirement needs to appear verbatim in the task description, not just in the global context.

4. **Critic prompts should require full spec re-read on every round**, not just "check what the fixer changed." Round N should evaluate spec compliance from scratch, not just fixer delta. The dish 005 miss strongly suggests round-3 critics were doing delta-review only.

### Technical Debt Captured
See Godmother ideas below. Five ideas captured covering:
- Dish 005 P1 fix (Gemini label inversion)
- Dish 006/007 box-drawing test gap + overflow fix
- Dish 008 theme token cleanup
- Protocol gap: on-the-fly dishes without critic coverage

---

## Godmother Ideas Captured

| Idea | Dish | Severity | Topic | Godmother ID |
|------|------|----------|-------|--------------|
| Fix Gemini usage label inversion in pizza usage | 005 | P1 violation | cli, bug | `bT9HJH06` |
| Add tests + fix long-word overflow in plan mode TUI box | 006 | P1 violation | cli, tests, bug | `ytp3CxST` |
| Add tests + fix text overflow in AskUserQuestion TUI box | 007 | P1 violation | cli, tests, bug | `37dkOn5v` |
| Replace hardcoded RGB with theme token in notifications | 008 | P1 violation | cli, theme, bug | `8PdKrUDQ` |
| Night Shift protocol: on-the-fly dishes must have critic coverage | process | systemic | nightshift, process | `Ij1lcpaH` |

---

*Health Inspection complete. Report written 2026-03-25.*
