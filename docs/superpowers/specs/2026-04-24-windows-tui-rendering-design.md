# Windows TUI Rendering Design

**Problem**

On Windows, PizzaPi's TUI emits Unicode box-drawing and block glyphs directly (`╭│─█░`). Upstream `pi-tui` enables Windows VT **input**, but not Windows VT **output** or UTF-8 console output. As a result, modern terminals may still display borders and bars incorrectly when console output mode or code page is not configured for Unicode rendering.

**Goal**

Make PizzaPi's TUI render correctly on Windows by:

1. enabling the best available Windows console output path in upstream `pi-tui`, and
2. providing a PizzaPi-owned ASCII fallback for renderers that currently hardcode Unicode glyphs.

## Scope

In scope:
- Upstream `pi-tui` Windows terminal startup and teardown behavior
- PizzaPi-owned TUI renderers that currently hardcode box/bar glyphs or depend on Unicode-only symbols on the affected surfaces
- Regression tests for Windows startup patching and ASCII/Unicode rendering selection
- Patch plumbing required to ship a new `@mariozechner/pi-tui` patch from this repo

Out of scope:
- Redesigning the TUI layout
- Changing non-Windows rendering behavior except where shared glyph helpers simplify the code
- Attempting to detect every possible Windows font limitation at runtime

## Recommended Approach

Use a hybrid strategy:

- **Primary path:** patch upstream `pi-tui` so Windows startup enables VT output and UTF-8 console output when possible.
- **Fallback path:** move PizzaPi-owned border/bar characters behind a small glyph helper that can return either Unicode glyphs or ASCII-safe equivalents.

This keeps the default experience rich on capable terminals while giving PizzaPi a deterministic fallback for terminals that still cannot render Unicode cleanly.

## Architecture

### 1. Upstream Windows console initialization

Patch `@mariozechner/pi-tui`'s `ProcessTerminal.start()` Windows path to do output-side setup in addition to the existing input-side setup.

Expected startup sequence on Windows:
- preserve existing raw-mode/input setup
- capture original per-handle console modes for stdin/stdout/stderr when available
- capture original console-wide input/output code pages when available
- enable VT input (already present)
- enable VT output on stdout/stderr when attached to a console
- attempt to switch console input/output code pages to UTF-8 where supported
- store a process-wide capability result that downstream renderers can read
- continue even if any step fails

Expected teardown sequence on Windows:
- best-effort restore original per-handle console modes during terminal shutdown
- best-effort restore original console-wide input/output code pages during terminal shutdown
- never crash if restore fails or the process is no longer attached to a console

Lifecycle requirement:
- console init/restore must be safe across repeated starts in the same process
- restoration must be generation-owned or reference-counted so an older terminal instance cannot restore stale state after a newer instance has already started
- handle-mode ownership and console-wide code-page ownership must be tracked separately so mixed success/failure does not restore the wrong baseline
- partial-failure paths must still leave ownership bookkeeping consistent

This must be best-effort and non-fatal. The TUI should still start if the console API calls are unavailable.

### 2. PizzaPi glyph abstraction

Introduce a focused helper in `packages/cli/src/` that centralizes glyph selection for:
- horizontal/vertical borders
- corners/separators
- progress/usage bars

The helper should expose two glyph sets:
- **Unicode**: `╭ ╮ ╰ ╯ │ ─ ├ ┤ █ ░` plus any surface-specific symbols that are part of the rendered output
- **ASCII**: `+ + + + | - + + # .` plus ASCII-safe replacements for the same surface-specific symbols

For the currently affected surfaces, ASCII mode should also replace visible Unicode-only symbols that would otherwise remain in the output, including:
- header title/icon and key labels where needed (for example `🍕`, `⇧`, `↩`, `↑`)
- any section dividers or bullets emitted by the same renderer

The helper should pick the Unicode set by default, but allow ASCII selection when:
- patched `pi-tui` reports that Windows Unicode output setup failed or is unavailable, or
- a canonical override env var is set, or
- output is clearly non-interactive / unsafe for rich glyph rendering

Canonical override contract:
- `PIZZAPI_TUI_GLYPHS=auto|ascii|unicode`
- default: `auto`
- `ascii`: force ASCII-safe glyphs
- `unicode`: force Unicode glyphs for debugging/verification even when auto-mode would have fallen back to ASCII
- `auto`: use the precedence rules below

For v1, "unsafe output" means:
- `process.stdout.isTTY !== true`, or
- `TERM=dumb`

### 3. PizzaPi-owned call sites

Start with a repo-wide audit of PizzaPi-owned TUI/terminal-visible glyph emitters, then route the in-scope renderers through the glyph helper.

Required deliverable before implementation is considered complete:
- a checked-in audit table in the spec or plan listing every currently known PizzaPi-owned TUI/terminal-visible Unicode emitter reviewed for this task, its status (`fixed now` / `safe to leave` / `follow-up filed`), and the reason

Minimum required implementation call-site set:
- `packages/cli/src/extensions/pizzapi-header.ts`
- `packages/cli/src/extensions/remote-ask-user.ts`
- `packages/cli/src/extensions/remote-plan-mode.ts`
- `packages/cli/src/extensions/subagent/render.ts`
- `packages/cli/src/cli-colors.ts`
- currently known adjacent surfaces to resolve via the audit: `packages/cli/src/extensions/remote-footer.ts`, `packages/cli/src/extensions/subagent/format.ts`, `packages/cli/src/extensions/pizzapi-title.ts`

If any known surface is not fixed in this implementation, capture a follow-up issue before closing the task.

This keeps glyph policy in one place and avoids future drift.

## Behavior

### Default behavior
- macOS/Linux: unchanged, continue using Unicode glyphs
- Windows with successful console initialization: use Unicode glyphs
- Windows when output setup fails or ASCII is forced: use ASCII glyphs

### Capability contract and precedence
The upstream/app boundary must use a structured, explicit contract rather than an ad hoc boolean.

Recommended contract:
- `globalThis.__PI_WINDOWS_CONSOLE_CAPS__ = { stdoutMode: "unicode" | "ascii" | "unknown", stderrMode: "unicode" | "ascii" | "unknown", source: "pi-tui" }`

PizzaPi glyph selection should treat `stdoutMode` as authoritative because the TUI renders to stdout. `stderrMode` is still worth configuring/restoring, but it is non-authoritative for glyph selection.

Required decision table for startup classification:
- stdout already in a usable Unicode-capable state before mutation => `stdoutMode: "unicode"`
- stdout VT/UTF-8 enablement succeeds or readback confirms usable Unicode output => `stdoutMode: "unicode"`
- stdout console API calls fail, stdout is not a console, or usable Unicode output cannot be confirmed => `stdoutMode: "ascii"` in PizzaPi auto mode
- stdout state cannot be probed confidently but stdout is still interactive => publish `stdoutMode: "unknown"`; PizzaPi auto mode must still downgrade that to ASCII
- classify `stderrMode` independently using the same rules

Required precedence in the PizzaPi glyph helper:
1. explicit env override forcing ASCII
2. explicit env override forcing Unicode (if supported for debugging)
3. non-interactive / obviously unsafe output => ASCII
4. Windows capability contract from patched `pi-tui`
5. safe default when capability is absent: treat Windows as `unknown` and fall back to ASCII for PizzaPi-owned rich renderers
6. non-Windows default => Unicode

### Failure handling
- Console API failures must not crash startup
- If VT/UTF-8 enablement cannot be confirmed, PizzaPi should still render using the fallback glyph set where it controls the rendering
- Upstream-only surfaces may still depend on terminal capability, but the goal is to improve that path as much as possible without making startup brittle

## Testing Strategy

### Upstream patch coverage
Add/update patch verification in `packages/cli/src/patches.test.ts` to assert that the upstream `pi-tui` patch contains the Windows output initialization, capability publication, and teardown/restore logic.

Also add behavior-level tests around a small mockable Windows console-init helper so the implementation verifies more than patch text:
- successful startup path publishes the expected capability state
- failed startup path publishes the expected fallback state
- restore only runs for the owning generation / active instance
- repeated starts do not clobber the wrong baseline state

Also update repo patch plumbing:
- add `@mariozechner/pi-tui@0.67.5` to `patchedDependencies` in the root `package.json`
- document the new patch in `patches/README.md`

### PizzaPi unit coverage
Add tests for the glyph helper to verify:
- default Unicode selection on non-Windows
- Windows + capability success => Unicode
- Windows + capability failure => ASCII
- Windows + capability unavailable => ASCII
- env override precedence over capability state
- stable returned glyphs for bars, borders, and any ASCII-safe replacements used by the touched surfaces

Update existing renderer tests so they can validate both modes where appropriate:
- header rendering with Unicode glyphs
- header rendering with ASCII glyphs, including ASCII-safe replacements for title/icon/key labels on that surface
- AskUserQuestion box rendering with Unicode glyphs
- AskUserQuestion box rendering with ASCII glyphs
- remote plan-mode rendering with Unicode glyphs
- remote plan-mode rendering with ASCII glyphs
- subagent renderer output with Unicode glyphs
- subagent renderer output with ASCII glyphs
- usage bar rendering with Unicode glyphs
- usage bar rendering with ASCII glyphs

Add explicit layout-integrity assertions in both glyph modes:
- no line exceeds the requested width
- border lines still start/end with the expected glyphs for the selected mode
- breakpoint widths near current thresholds (for example 99/100 and very narrow widths) remain stable after ASCII substitutions that lengthen labels

### Verification
Run at minimum:
- `bun test packages/cli/src/extensions/pizzapi-header.test.ts`
- `bun test packages/cli/src/extensions/remote-ask-user.test.ts`
- `bun test packages/cli/src/extensions/remote-plan-mode.test.ts`
- `bun test packages/cli/src/extensions/subagent*.test.ts`
- `bun test packages/cli/src/cli-colors.test.ts`
- `bun test packages/cli/src/patches.test.ts`
- targeted tests for any additionally-audited affected surfaces fixed in this task
- if `remote-footer.ts`, `subagent/format.ts`, or `pizzapi-title.ts` are marked `fixed now` by the audit, add dedicated regression tests for those surfaces in this task
- relevant typecheck/build checks if touched files require it

Manual Windows acceptance checklist:
- verify Unicode mode in a modern Windows terminal (Windows Terminal)
- verify safe fallback behavior when ASCII is forced via `PIZZAPI_TUI_GLYPHS=ascii`
- verify one degraded/unavailable-console path (for example API unavailable or non-console stdout) does not crash and selects ASCII for PizzaPi-owned renderers

## Risks and Trade-offs

### Why not fallback-only?
Fallback-only avoids the upstream patch but leaves the broader TUI stack unfixed on Windows. That would solve only PizzaPi-owned surfaces.

### Why not output-init-only?
Output initialization improves the common case, but some Windows environments still render poorly due to terminal/font limitations. Without a fallback, PizzaPi remains fragile.

### Main trade-off
The hybrid approach adds a small amount of code and test surface, but it provides the best user outcome and the cleanest ownership boundary.

## Implementation Notes

- Keep the glyph helper small and pure.
- Avoid spreading Windows detection logic through each renderer.
- Do not make Windows startup depend on successful native console API loading.
- Keep the patch localized so future upstream version bumps are easy to review.
