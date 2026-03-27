## Inspection: Dish 002 — Custom Header Extension

### Quality Gates
- **Typecheck:** SKIPPED (pre-existing false positives only — `bun:test` / `bun:sqlite` module resolution errors unrelated to this PR; no new type errors introduced)
- **Tests:** PASS (20 tests, 0 failures — after `bun install` to resolve missing `redis` package in global preload, which is a pre-existing worktree env issue unrelated to this PR)

### Findings

#### P0 (Critical)
- None

#### P1 (Serious)
- None

#### P2 (Moderate)
- None

#### P3 (Minor)
- **Stale doc comment:** The file-level JSDoc says `"For narrow terminals (< 80 cols), falls back to a compact text-only header."` but the actual threshold in the code is `< 100`. The logic is correct; only the prose comment is wrong. Should read `< 100 cols`.
- **`padToWidth` has no truncation path:** When `visibleWidth(s) >= width` the function returns `s` unchanged, silently allowing content wider than `innerWidth` to escape into `boxLine`. In practice this is harmless because `buildHintLine` already bounds output to `innerWidth` using `rawLen` accounting — and all hint characters (ASCII + single-column Unicode like `⇧`, `↩`, `↑`, `·`) have `rawLen == visibleWidth`. But if the helper is ever reused with arbitrary content it could silently overflow. Recommend adding a truncation guard or renaming to `padAtLeastToWidth` to signal the intent.

### Completeness
- Wide mode (>=100): full box-drawing frame — ✅ (7 lines: `╭…╮`, 4× `│…│` rows, `├…┤` separator, `╰…╯`)
- Narrow mode (<100): simplified — ✅ (single compact line: emoji title + inline hints)
- Width constraint respected in BOTH modes — ✅
  - **Narrow:** char-by-char accumulation with `visibleWidth` per char prevents title overflow; `hintSpace = width - titleFitWidth - 2` correctly budgets remaining room; `buildHintLine` truncates by `rawLen` which equals `visibleWidth` for all hint chars used.
  - **Wide:** `topBorder` math verified: `2 (corners) + leftDashes + visibleWidth(title) + 1 (space) + rightDashes = width` exactly. `boxLine` pads to `innerWidth = width-4` and wraps with `│ … │` (4 chars) = `width`. `midBorder`/`bottomBorder` fill `width-2` dashes + 2 corners = `width`.
- Threshold is 100 (not 80) — ✅ (`if (width < 100)` in render; tests assert width=99 → narrow, width=100 → wide)
- Version from PizzaPi package.json — ✅ (`join(__dirname, "..", "..", "package.json")` resolves to `packages/cli/package.json`, which is the PizzaPi CLI package)
- Registered in factories.ts — ✅ (added to `buildPizzaPiExtensionFactories`; also present in `factories.test.ts` CORE_EXTENSIONS list)
- Tests verify width constraint — ✅ (dedicated tests: `"narrow mode: line visible width does not exceed given width"` loops widths 5–99; `"wide mode: all lines visible width does not exceed given width"` loops widths 100–200; `"wide top border visible width equals terminal width"` asserts exact equality)

### Verdict
**CLEAN_BILL**

### Summary
The implementation is correct and complete. Both wide and narrow modes rigorously respect the `width` parameter — the math checks out on all code paths, and 20 dedicated tests independently verify the constraints across a full range of widths. The only issues are a stale `< 80` in the file-level doc comment (the actual threshold is `100`) and a latent edge case in `padToWidth` where it silently skips truncation — neither affects runtime behavior given the current callers.
