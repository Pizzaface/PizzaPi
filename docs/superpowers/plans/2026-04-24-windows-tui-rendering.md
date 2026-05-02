# Windows TUI Rendering Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows TUI rendering reliable by patching upstream `@mariozechner/pi-tui` for output-side console setup and adding a PizzaPi glyph fallback layer for Unicode-sensitive terminal surfaces.

**Architecture:** Split the work into two seams. First, patch `@mariozechner/pi-tui` so Windows terminal startup/teardown manages output VT mode, UTF-8 code pages, and publishes a structured capability signal. Second, add a small PizzaPi glyph helper that selects Unicode vs ASCII per policy and migrate all audited PizzaPi-owned terminal-visible renderers to use it.

**Tech Stack:** Bun, TypeScript, Bun test, Bun patchedDependencies, `@mariozechner/pi-tui`, PizzaPi CLI extensions.

---

## File Structure

### Upstream patching / patch maintenance
- Modify: `package.json`
- Modify: `patches/README.md`
- Create/Modify: `patches/@mariozechner%2Fpi-tui@0.67.5.patch`
- Modify: `packages/cli/src/patches.test.ts`

### Glyph policy + renderers
- Create: `packages/cli/src/tui-glyphs.ts`
- Create: `packages/cli/src/tui-glyphs.test.ts`
- Modify: `packages/cli/src/extensions/pizzapi-header.ts`
- Modify: `packages/cli/src/extensions/pizzapi-header.test.ts`
- Modify: `packages/cli/src/extensions/remote-ask-user.ts`
- Modify: `packages/cli/src/extensions/remote-ask-user.test.ts`
- Modify: `packages/cli/src/extensions/remote-plan-mode.ts`
- Modify: `packages/cli/src/extensions/remote-plan-mode.test.ts`
- Modify: `packages/cli/src/extensions/subagent/render.ts`
- Modify: `packages/cli/src/extensions/subagent.test.ts`
- Modify: `packages/cli/src/cli-colors.ts`
- Modify: `packages/cli/src/cli-colors.test.ts`

### Audit-driven adjacent surfaces
- Review / optionally modify: `packages/cli/src/extensions/remote-footer.ts`
- Review / optionally modify: `packages/cli/src/extensions/remote-footer.test.ts`
- Review / optionally modify: `packages/cli/src/extensions/subagent/format.ts`
- Review / optionally modify: tests covering subagent formatted output
- Review / optionally modify: `packages/cli/src/extensions/pizzapi-title.ts`
- Review / optionally modify: `packages/cli/src/extensions/pizzapi-title.test.ts`
- Modify: `docs/superpowers/specs/2026-04-24-windows-tui-rendering-design.md` (add checked-in audit table if not already present)

### Docs
- Modify: `packages/docs/src/content/docs/customization/configuration.mdx`
- Modify: `packages/docs/src/content/docs/reference/environment-variables.mdx`

---

## Chunk 1: Audit surface area before finalizing the helper API

### Task 1: Inventory all PizzaPi-owned terminal-visible Unicode emitters

**Files:**
- Review / optionally modify: `packages/cli/src/extensions/remote-footer.ts`
- Review / optionally modify: `packages/cli/src/extensions/remote-footer.test.ts`
- Review / optionally modify: `packages/cli/src/extensions/subagent/format.ts`
- Review / optionally modify: tests covering subagent formatted output
- Review / optionally modify: `packages/cli/src/extensions/pizzapi-title.ts`
- Review / optionally modify: `packages/cli/src/extensions/pizzapi-title.test.ts`
- Modify: `docs/superpowers/specs/2026-04-24-windows-tui-rendering-design.md`

- [ ] **Step 1: Audit known renderer and formatter surfaces**
  - Build the checked-in audit table before helper design is finalized.
  - Mark each reviewed surface `fixed now`, `safe to leave`, or `follow-up filed`.

- [ ] **Step 2: File follow-up work immediately for any deferred surface**
  - Do not leave known Unicode emitters undocumented.

- [ ] **Step 3: Reconcile the helper symbol inventory with the audit**
  - Use the audit results to finalize which border/bar/icon replacements the helper must own in v1.

## Chunk 2: Patch upstream `pi-tui` Windows output lifecycle

### Task 2: Lock down patch-plumbing expectations with failing tests

**Files:**
- Test: `packages/cli/src/patches.test.ts`
- Modify: `package.json`
- Modify: `patches/README.md`

- [ ] **Step 1: Add failing patch-plumbing assertions**
  - Add test coverage that expects:
    - a `patchedDependencies` entry for `@mariozechner/pi-tui@0.67.5`
    - patch-source inspection for Windows output init, capability publication, and restore logic
    - a behavior-level test seam for the helper/lifecycle contract
  - Keep the new assertions narrowly scoped so they fail only because the patch is not present yet.

- [ ] **Step 2: Run the targeted patch test and verify RED**
  - Run: `bun test packages/cli/src/patches.test.ts`
  - Expected: FAIL because the `pi-tui` patch entry / source checks do not exist yet.

- [ ] **Step 3: Register the new patch in repo plumbing**
  - Add `@mariozechner/pi-tui@0.67.5` to `patchedDependencies` in `package.json`.
  - Document the new patch in `patches/README.md`.

- [ ] **Step 4: Apply patched dependencies locally**
  - Run: `bun install`
  - Expected: the patched `@mariozechner/pi-tui` dependency is re-linked with the repo patch applied.

- [ ] **Step 5: Re-run patch test and confirm it still fails for the missing patch body**
  - Run: `bun test packages/cli/src/patches.test.ts`
  - Expected: still FAIL, but now only because the patch contents are not implemented yet.

### Task 3: Add the Windows console lifecycle patch

**Files:**
- Create/Modify: `patches/@mariozechner%2Fpi-tui@0.67.5.patch`
- Test: `packages/cli/src/patches.test.ts`

- [ ] **Step 1: Generate the upstream patch scaffold**
  - Use Bun patch workflow for `@mariozechner/pi-tui@0.67.5`.
  - Touch only the minimal upstream files needed for terminal startup/teardown behavior.

- [ ] **Step 2: Add a small Windows console helper inside the patched upstream package**
  - Implement best-effort logic for:
    - capturing per-handle console modes
    - capturing console-wide input/output code pages
    - enabling VT output
    - switching code pages toward UTF-8 where possible
    - publishing `globalThis.__PI_WINDOWS_CONSOLE_CAPS__`
    - ownership-safe restore on teardown
  - Keep classification explicit: `stdoutMode` and `stderrMode` each become `"unicode" | "ascii" | "unknown"`.
  - Make the helper mockable enough to behavior-test capability publication, non-fatal startup failure, stale-global cleanup on teardown/startup failure, mixed `stdout`/`stderr` outcomes, and "do not restore over a newer instance" behavior.

- [ ] **Step 3: Wire startup/teardown into `ProcessTerminal`**
  - Ensure startup remains non-fatal.
  - Ensure restore cannot clobber a newer terminal instance.
  - Ensure `globalThis.__PI_WINDOWS_CONSOLE_CAPS__` is cleared or replaced safely on teardown and startup failure so stale state cannot force Unicode after a prior session exits.

- [ ] **Step 4: Update patch tests to assert the concrete source hooks**
  - Check for the exact contract name `__PI_WINDOWS_CONSOLE_CAPS__`.
  - Check for startup and teardown/restore logic.

- [ ] **Step 5: Run targeted patch tests and verify GREEN**
  - Run: `bun test packages/cli/src/patches.test.ts`
  - Expected: PASS.

---

## Chunk 3: Add glyph policy and migrate core renderers

### Task 4: Add a failing glyph-policy test suite

**Files:**
- Create: `packages/cli/src/tui-glyphs.ts`
- Create: `packages/cli/src/tui-glyphs.test.ts`

- [ ] **Step 1: Write failing tests for glyph selection policy**
  - Cover:
    - non-Windows default => Unicode
    - `PIZZAPI_TUI_GLYPHS=ascii` => ASCII
    - `PIZZAPI_TUI_GLYPHS=unicode` => Unicode
    - Windows + `stdoutMode: "unicode"` => Unicode
    - Windows + `stdoutMode: "ascii"` => ASCII
    - Windows + `stdoutMode: "unknown"` => ASCII in auto mode
    - `process.stdout.isTTY !== true` or `TERM=dumb` => ASCII in auto mode
    - stable symbol tables for borders, bars, and audited ASCII-safe replacements

- [ ] **Step 2: Run the new test file and verify RED**
  - Run: `bun test packages/cli/src/tui-glyphs.test.ts`
  - Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Implement the minimal glyph helper**
  - Export a small typed API for:
    - policy selection
    - border glyphs
    - bar glyphs
    - surface-safe replacements for audited visible symbols
  - Keep the helper pure by taking an injected environment snapshot/config object for tests (platform, TTY state, TERM, env policy, Windows caps).
  - Treat invalid `PIZZAPI_TUI_GLYPHS` values and malformed/missing `__PI_WINDOWS_CONSOLE_CAPS__` as safe fallback cases.

- [ ] **Step 4: Run glyph tests and verify GREEN**
  - Run: `bun test packages/cli/src/tui-glyphs.test.ts`
  - Expected: PASS, including invalid env values and stale/malformed capability globals falling back safely.

### Task 5: Migrate the highest-visibility renderers first

**Files:**
- Modify: `packages/cli/src/extensions/pizzapi-header.ts`
- Modify: `packages/cli/src/extensions/pizzapi-header.test.ts`
- Modify: `packages/cli/src/extensions/remote-ask-user.ts`
- Modify: `packages/cli/src/extensions/remote-ask-user.test.ts`
- Modify: `packages/cli/src/cli-colors.ts`
- Modify: `packages/cli/src/cli-colors.test.ts`

- [ ] **Step 1: Add failing renderer tests for ASCII mode**
  - Extend tests to cover both Unicode and ASCII modes.
  - Include layout-integrity assertions:
    - no line exceeds requested width
    - border start/end glyphs match selected mode
    - width boundaries remain stable near breakpoints

- [ ] **Step 2: Run those targeted tests and verify RED**
  - Run: `bun test packages/cli/src/extensions/pizzapi-header.test.ts packages/cli/src/extensions/remote-ask-user.test.ts packages/cli/src/cli-colors.test.ts`
  - Expected: FAIL because renderers still hardcode Unicode glyphs.

- [ ] **Step 3: Migrate renderers to the glyph helper**
  - Replace direct box/bar glyph literals with helper lookups.
  - For header ASCII mode, replace Unicode-only visible symbols that would otherwise break fallback on that surface.

- [ ] **Step 4: Re-run targeted tests and verify GREEN**
  - Run: `bun test packages/cli/src/extensions/pizzapi-header.test.ts packages/cli/src/extensions/remote-ask-user.test.ts packages/cli/src/cli-colors.test.ts packages/cli/src/tui-glyphs.test.ts`
  - Expected: PASS.

---

## Chunk 4: Finish audited surfaces, docs, and full verification

### Task 6: Audit-driven migrations, docs, and remaining PizzaPi-owned TUI surfaces

**Files:**
- Modify: `docs/superpowers/specs/2026-04-24-windows-tui-rendering-design.md`
- Modify: `packages/cli/src/extensions/remote-plan-mode.ts`
- Modify: `packages/cli/src/extensions/remote-plan-mode.test.ts`
- Modify: `packages/cli/src/extensions/subagent/render.ts`
- Modify: `packages/cli/src/extensions/subagent.test.ts`
- Review / optionally modify: `packages/cli/src/extensions/remote-footer.ts`
- Review / optionally modify: `packages/cli/src/extensions/remote-footer.test.ts`
- Review / optionally modify: `packages/cli/src/extensions/subagent/format.ts`
- Review / optionally modify: subagent formatting tests
- Review / optionally modify: `packages/cli/src/extensions/pizzapi-title.ts`
- Review / optionally modify: `packages/cli/src/extensions/pizzapi-title.test.ts`

- [ ] **Step 1: Confirm the audit table is complete and current**
  - Record every known PizzaPi-owned TUI Unicode emitter reviewed for this task.
  - Mark each row `fixed now`, `safe to leave`, or `follow-up filed`.

- [ ] **Step 2: Write failing tests for `remote-plan-mode` and subagent rendering in ASCII mode**
  - Run targeted tests first to verify missing fallback coverage.

- [ ] **Step 3: Migrate `remote-plan-mode` and subagent rendering**
  - Route their border/separator output through the helper.

- [ ] **Step 4: Resolve audited adjacent surfaces**
  - If `remote-footer`, `subagent/format`, or `pizzapi-title` are part of the broken Windows experience, migrate them now and add dedicated tests.
  - If any remain out of scope, capture follow-up issue(s) before marking the task complete.

- [ ] **Step 5: Update docs for the new glyph-policy override**
  - Document `PIZZAPI_TUI_GLYPHS=auto|ascii|unicode` in:
    - `packages/docs/src/content/docs/customization/configuration.mdx`
    - `packages/docs/src/content/docs/reference/environment-variables.mdx`
  - Explain defaults and Windows fallback behavior.

- [ ] **Step 6: Run the renderer/docs test set and verify GREEN**
  - Run: `bun test packages/cli/src/extensions/remote-plan-mode.test.ts packages/cli/src/extensions/subagent*.test.ts packages/cli/src/extensions/remote-footer.test.ts packages/cli/src/extensions/pizzapi-title.test.ts packages/cli/src/tui-glyphs.test.ts`
  - Expected: PASS for every touched surface.

### Task 7: Final verification

**Files:**
- Verify only

- [ ] **Step 1: Run the full targeted verification set**
  - Run:
    - `bun test packages/cli/src/patches.test.ts`
    - `bun test packages/cli/src/tui-glyphs.test.ts`
    - `bun test packages/cli/src/extensions/pizzapi-header.test.ts`
    - `bun test packages/cli/src/extensions/remote-ask-user.test.ts`
    - `bun test packages/cli/src/extensions/remote-plan-mode.test.ts`
    - `bun test packages/cli/src/extensions/subagent*.test.ts`
    - `bun test packages/cli/src/cli-colors.test.ts`
    - plus any tests added for audited adjacent surfaces
  - Ensure this set includes coverage for stale/missing capability globals and mixed `stdout`/`stderr` capability results.

- [ ] **Step 2: Run typecheck for touched code**
  - Run: `bun run typecheck`
  - Expected: PASS.

- [ ] **Step 3: Run build if required by touched package boundaries**
  - Run: `bun run build:cli`
  - Expected: PASS.

- [ ] **Step 4: Manual Windows acceptance checklist**
  - Validate Unicode mode in Windows Terminal.
  - Validate forced fallback with `PIZZAPI_TUI_GLYPHS=ascii`.
  - Validate one degraded/unavailable-console path does not crash and selects ASCII for PizzaPi-owned renderers.
  - Validate at least one non-Windows-Terminal or degraded path where auto mode should pick ASCII (for example legacy conhost / PowerShell / CMD or non-TTY output).
  - Confirm stderr setup/restore does not leave the console in a broken state when stdout/stderr capabilities differ.

- [ ] **Step 5: Commit implementation**
  - Use focused commits per chunk or one final squashed commit if the workflow requires it.

---

## Notes for the implementing agent

- Do not scatter platform checks through every renderer.
- Keep glyph selection centralized in `tui-glyphs.ts`.
- Prefer `stdout` as the authoritative stream for glyph selection.
- Restore console state safely; do not leave the shell in a modified state after exit.
- If the audit uncovers additional affected surfaces, update the audit table immediately instead of relying on memory.
