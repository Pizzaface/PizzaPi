## Inspection: Dish 005 — CLI Help Refresh

### Quality Gates
- **Typecheck:** SKIPPED (worktree-level false positives — bun:test / bun:sqlite module resolution errors endemic to all inspector worktrees; no errors in the changed files themselves)
- **Tests:** PASS (9 tests, 0 failures — `cd packages/cli && bun test src/cli-colors.test.ts`; root-level `bun test packages/cli` fails with 108 errors due to pre-existing redis preload issue in worktree bunfig.toml, unrelated to this branch)

### Findings

#### P0 (Critical)
- None

#### P1 (Serious)
- **Gemini label NOT inverted to "used" per spec.** The spec requires "invert to 'used' for both bar AND label." The bar correctly inverts (`usedPct = (1 - remainingFraction) * 100` → passed to `usageBar()`), but the label still shows the raw remaining fraction: `` `${colorRemaining(bucket.remainingFraction * 100)} remaining` ``. The label should show the *used* percentage (e.g. via `colorPct(usedPct)`), not the remaining. Output looks like `[████░░░░░░] 30.0% remaining` — the bar fill and the label disagree semantically.

#### P2 (Moderate)
- **Boundary tests are NO_COLOR-only — color thresholds at 79.9/80.0/80.1 are never verified.** The test "colorPct 80% boundary is amber not red" sets `NO_COLOR=1` and only asserts plain-text output (no ANSI sequences), so it proves the calls don't crash but does **not** verify that 80.0% is actually amber-colored and 80.1% is red-colored. The test comment acknowledges this: "Since we can't fake isTTY in bun:test, we verify the logic path is correct by checking that the no-color fallback returns plain text." The threshold logic in `cli-colors.ts` is correct by inspection (`pct <= 80` for amber, `> 80` for red), but the tests provide no runtime proof.

#### P3 (Minor)
- None

### Completeness
- pizza --help colored — ✅
- pizza setup branded — ✅
- pizza usage with color bars — ✅
- pizza models grouped by provider — ✅
- pizza web --help colored — ✅
- NO_COLOR presence-based check (`in` operator) — ✅
  ```ts
  // packages/cli/src/cli-colors.ts line 11
  !("NO_COLOR" in process.env) &&
  ```
- Thresholds correct (80% amber, >80% red) — ✅ (`pct <= 80` → amber; else → red; exactly 80.0% → amber; 80.1% → red)
- Gemini remaining→used inversion (both bar AND label) — ❌ (bar ✅ inverted via `usedPct`; label ❌ still uses `remainingFraction * 100` labeled "remaining")
- NO_COLOR tests present — ✅ (4 tests covering `NO_COLOR="1"` and `NO_COLOR=""` for both `usageBar` and `colorPct`)
- Boundary tests (79.9/80.0/80.1) — ⚠️ (tests exist but only assert plain-text output in NO_COLOR mode; actual color semantics at boundaries not verified)

### Verdict
**CITATION**

### Summary
The branch delivers solid work: correct presence-based `NO_COLOR` detection, correct threshold logic (80% amber, >80% red), full color treatment across all CLI surfaces, and passing NO_COLOR tests. However it has one spec violation: the Gemini usage label is still displaying the raw remaining fraction (`colorRemaining(remainingFraction * 100) remaining`) rather than the inverted used percentage — the bar and label are semantically contradictory. Boundary tests exist but only exercise the no-color code path, leaving the actual color threshold logic unverified at runtime.
