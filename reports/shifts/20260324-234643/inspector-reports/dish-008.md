## Inspection: Dish 008 — Notifications Polish

### Quality Gates
- **Typecheck:** SKIPPED (pre-existing worktree false positives — `bun:test`/`bun:sqlite` module resolution errors unrelated to dish changes)
- **Tests:** FAIL (106 failures, 0 pass — all fail with `Cannot find package 'redis'` from server test harness preload; worktree environment issue, not dish-related)

### Findings

#### P0 (Critical)
- None

#### P1 (Serious)
- **Hardcoded RGB `\x1b[38;2;232;180;248m` bypasses theme system** — `claude-plugins.ts:511,545,571,629,635` and `remote/index.ts:787,1059,1066` (8 occurrences). The plum brand color (#E8B4F8) is hardcoded as a 24-bit ANSI RGB escape directly in strings throughout. The task spec explicitly requires using theme tokens, not hardcoded hex/RGB. The pi theme system exposes `theme.fg("accent", text)` and similar semantic tokens; the correct approach is to map this plum color to the `accent` token (or similar) in the theme and call `theme.fg(...)` from a context that has access to the theme object (e.g., via `ctx.ui.theme` in the extension API). As written, this color is fully invisible to the theme and cannot be overridden by users with custom themes.

#### P2 (Moderate)
- **`\x1b[0m` full-reset inside theme-wrapped messages breaks outer color** — `claude-plugins.ts:635` (skipped-plugins `"warning"` notify), `remote/index.ts:784,785,1059,1060,1066`. The `showWarning()` / `showStatus()` functions in pi wrap the entire message in `theme.fg("warning"/"dim", message)`, which prepends a theme ANSI sequence and appends a `\x1b[39m` foreground-only reset. Inner `\x1b[0m` full resets (used pervasively throughout the dish) cancel **all** SGR attributes mid-message — including the outer wrapper color — causing text after each reset to render in the terminal's default foreground. In warning-typed notifications, this means segments intended to be warning-colored will revert to default instead. Example: `skipped plugins` notification sends `\x1b[0m Use \x1b[38;2;...m...` to `showWarning()`, so "Use" is uncolored (not warning-colored as the theme intends) and the plum color is applied over a reset baseline — correct by accident, not design.

- **All `ctx.ui.notify()` content also passes through `theme.fg("dim", ...)` in `showStatus()`** — `remote/index.ts:1044,1052,1057,1062`. The `/remote` status notifications embed green/red success/error ANSI codes (`\x1b[32m`, `\x1b[31m`) but default to the `"info"` type (no second argument), which routes to `showStatus()`. That method wraps the full message in `theme.fg("dim", ...)` — a muted gray. The embedded colored ANSI codes will still take effect where they appear, but after any inner `\x1b[0m` reset the text falls back to terminal default rather than the intended dim wrapper. The embedded bold/success/error semantics fight the dim wrapper rather than cooperating with it.

#### P3 (Minor)
- **Sandbox violation count uses warning yellow, not error red** — `sandbox-events.ts:80`. `violations.length > 0` is colored `\x1b[33m` (yellow/warning). Sandbox violations are blocked access attempts — a more severe signal closer to "error" than "warning." Using `\x1b[31m` (error red) when violations > 0 would align with the error semantics used elsewhere (e.g., `isSandboxActive() === false` uses red).

- **`sandbox-events.ts` ANSI in `/sandbox` output not gated on TTY** — `sandbox-events.ts:79–131`. The `formatStatus()` and `formatViolations()` formatters embed raw ANSI unconditionally. In RPC/headless mode, `ctx.ui.notify()` forwards the raw string as JSON; downstream receivers (web UI) will see literal escape sequences. The safe mode banner in `index.ts:423` correctly gates colors on `process.stdout.isTTY` — the same pattern should apply here (or the formatters should be aware of their rendering context).

### Completeness
- Relay status notifications colored — ✅ (`remote/index.ts`: "not configured", "connected", "disconnected", "reconnecting")
- Plugin trust prompts colored — ✅ (`claude-plugins.ts`: trust confirm dialog + skip notification colored)
- Safe mode banner colored — ✅ (`index.ts`: TTY-gated, proper fallback to plain text)
- Sandbox events colored — ✅ (`sandbox-events.ts`: `/sandbox status` and `/sandbox violations` output colored)
- Theme tokens used (no hardcoded hex) — ❌ (8 occurrences of `\x1b[38;2;232;180;248m` hardcoded RGB across `claude-plugins.ts` and `remote/index.ts`; standard ANSI named colors `\x1b[31m`/`\x1b[32m`/`\x1b[33m` are acceptable since the theme system also uses raw ANSI internally, but the 24-bit plum RGB should be a theme token)
- Color semantics correct — ⚠️ (mostly correct: errors in red, warnings in yellow, success in green; minor exception: sandbox violation count shown in warning yellow rather than error red)

### Verdict
**CITATION**

### Summary
Dish 008 successfully colors all four specified surfaces (relay status, plugin trust, safe mode banner, sandbox events), and the safe mode banner correctly implements TTY-gating with a clean plain-text fallback. However, the dish violates its own stated requirement of "use theme tokens where possible (not hardcoded hex)" — the plum brand color `#E8B4F8` is hardcoded as a raw 24-bit ANSI sequence (`\x1b[38;2;232;180;248m`) in 8 places across two files, making it invisible to the theme system and non-overridable by custom themes. Additionally, pervasive use of `\x1b[0m` full-resets inside theme-wrapped notification messages causes the outer wrapper color to bleed off mid-message, which is visually inconsistent and structurally fragile. Fix: map the plum color to a semantic theme token (`accent` or a new `brand` token) and use `ctx.theme.fg(...)` or pass it through the theme API rather than embedding raw RGB bytes.
