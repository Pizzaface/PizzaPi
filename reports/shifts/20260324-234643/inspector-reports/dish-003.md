## Inspection: Dish 003 — Footer Polish

### Quality Gates
- **Typecheck:** SKIPPED — worktree environment failures only (missing `bun:test` types, `redis`, `better-auth`, `socket.io`, etc. across multiple packages). Zero errors attributable to `remote-footer.ts`. Main branch typechecks clean.
- **Tests:** SKIPPED — all 106 tests fail with `Cannot find package 'redis'` from a server preload, a pre-existing worktree dependency gap unrelated to this diff.

### Findings

#### P0 (Critical)
- None

#### P1 (Serious)
- None

#### P2 (Moderate)
- **Context gradient dim threshold is narrower than spec implies.** The spec states "dim=low, warning=>70%, error=>90%", which reads as: dim for anything below the warning threshold (i.e. <70%). The implementation dims only below 50% and leaves the 50–69% range as unstyled default text (`contextColor = null`). This creates a 4-stage gradient (dim → default → warning → error) instead of the cleaner 3-stage (dim → warning → error) implied. Usage at 55% will render at default terminal brightness — visually elevated relative to surrounding dim stats — which may read as spuriously highlighted.

#### P3 (Minor)
- **Session name accent silently drops on truncation.** The accent is applied only when `locationLine.left.endsWith(sessionSuffix)`. If the session name is long and `truncateMiddle` cuts into it, the entire left side falls back to dim with no accent and no indication that the name was elided. This is defensively correct but means the accent feature has an invisible off switch under pressure.
- **`line1Pad` / `line2Pad` are almost always 0.** `layoutLeftRight` guarantees `left + pad + right == width` in the normal case, so these extra padding calculations produce a zero-length string except in the two rare early-return edge cases. Harmless but slightly misleading.

### Completeness
- Relay status themed (success/error/warning) — ✅ (`"success" | "warning" | "error"` literal type; "reconnecting"/"connecting" correctly mapped to "warning")
- Model badge (accent provider, muted name) — ✅ (provider tag in `theme.fg("accent", ...)`, full right side otherwise in `theme.fg("muted", ...)`)
- Stats dim — ✅ (`theme.fg("dim", beforeCtx)` for token counts before context part)
- Session name accent — ✅ (`theme.fg("accent", sessionSuffix)` when suffix survives truncation)
- Git branch with ⎇ symbol — ✅ (`` ` ⎇ ${branch}` `` literal used)
- Context usage gradient (warn>70%, err>90%) — ⚠️ (thresholds correct; dim cutoff at 50% leaves 50–69% unstyled, narrower than spec's "dim=low" implies)
- No hardcoded hex colors — ✅ (grep found zero hardcoded hex or raw ANSI sequences in production code; `sanitizeStatusText` strips inbound ANSI from relay text, which is correct and unrelated)
- Width responsiveness maintained — ✅ (all coloring built on plain-text `layoutLeftRight` results; padding recomputed from raw lengths)

### Verdict
**CITATION**

### Summary
The implementation delivers all spec features — themed relay status with a new "connecting" warning state, accented session name and provider, muted model name, dim stats, ⎇ branch symbol, and a context gradient using correct 70%/90% thresholds — with no hardcoded colors and full width responsiveness. The single notable gap is the context gradient's dim zone: the spec implies dim for anything below the warning threshold (70%), but the code dims only below 50% and leaves the 50–69% band unstyled, creating an unintended visual bump in that range. All other logic is clean, properly typed, and the `as any` cast from the original code was correctly removed.
