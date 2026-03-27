## Inspection: Dish 007 — AskUserQuestion TUI Display

### Quality Gates
- **Typecheck:** SKIPPED — worktree has pervasive pre-existing missing-dependency errors (`bun:test`, `bun:sqlite`, `socket.io-client`, `@zenyr/bun-pty`, etc.) unrelated to this PR. Main branch typechecks cleanly with no errors; the changed file (`remote-ask-user.ts`) introduces no new type errors.
- **Tests:** SKIPPED — same worktree infra failure (0 pass / 106 fail vs. main's 2402 pass / 9 fail); all failures are unrelated to this PR. The branch's test file (`remote-ask-user.test.ts`) only tests pre-existing exported helpers (`sanitizeQuestions`, `sanitizeDisplay`) — the new display code is unexercised.

---

### Findings

#### P0 (Critical)
- None

#### P1 (Serious)
- **Long text silently overflows box borders** — `packages/cli/src/extensions/remote-ask-user.ts` (~lines 185–220): `padTo()` correctly pads short strings to `BOX_W=58` but does nothing when content *exceeds* that width — `Math.max(0, BOX_W - visLen(s))` silently adds 0 padding and the right `│` border shifts right. A question with a 2-char indent already has a working budget of only 56 visible chars; `"What is your preferred deployment strategy for production environments?"` (70 chars) overflows by 14. Numbered option lines have an even tighter budget (~53 chars after the `(N) ` prefix). No wrapping, truncation, or ellipsis is applied. Real-world LLM-generated questions routinely exceed this limit.

#### P2 (Moderate)
- **Zero test coverage for all new display code** — `packages/cli/src/extensions/remote-ask-user.test.ts`: The entire `buildBox` / `typeLabel` / `visLen` / `padTo` / `bRow` implementation is untested. All helpers are defined inside the private `askUserQuestion` function scope and cannot be imported, making unit testing impossible without a refactor or export. AGENTS.md requires all new code to include tests.

- **`visLen` does not account for wide (2-column) Unicode characters** — `packages/cli/src/extensions/remote-ask-user.ts` (~line 177): The ANSI-stripping regex `s.replace(/\x1b\[[0-9;]*m/g, "")` produces the correct *byte/char count*, but emoji and CJK characters occupy 2 terminal columns while `.length` returns 1 (or 2 for surrogate pairs). An option like `"🍕 Neapolitan"` will cause `visLen` to under-count by 1 per wide char, shifting the right border left by the same amount.

#### P3 (Minor)
- **`hdrDashes` magic formula is undocumented** — `packages/cli/src/extensions/remote-ask-user.ts` (~line 197): `BOX_W - 1 - hdr.length` is correct (yields 40 dashes → total top border = 60 chars = content row width) but requires mental arithmetic to verify. A brief inline comment (e.g., `// ╭─ (2) + hdr (17) + dashes (40) + ╮ (1) = 60`) would make it obvious.

- **No regression test for the empty-options layout** — The `if (q.options.length > 0)` guard is correctly present and the box renders without option rows when `options` is empty. However, this path has no test coverage; a one-line `sanitizeQuestions` call already passes an empty-options case through the test suite but never exercises the rendered output.

---

### Completeness
- Box-drawing frame — ✅ Full Unicode box-drawing set (╭ ╮ ╰ ╯ │ ─) correctly applied; borders align at 60 visible chars for average-length content.
- Numbered options — ✅ Options rendered as `(1)`, `(2)`, … in accent-plum color; skipped entirely when `options` is empty.
- Type hints (radio/checkbox/ranked) — ✅ All three enum values mapped; `undefined` type (legacy/radio-default) correctly falls through to `"[select one]"`.
- Step counter (multi-question) — ✅ `Q{i+1} of {N}:` prefix shown only when `questions.length > 1`; omitted for single questions.
- PizzaPi visual style — ✅ Soft-purple border (`#C4A7E0`) and accent-plum numbers (`#E8B4F8`) match the project's established palette; uses targeted SGR resets (`\x1b[22m`, `\x1b[39m`) rather than blanket `\x1b[0m`.
- Integrates with pi AskUserQuestion hook — ✅ Rendered string passed directly to `ctx.ui.input()` which is the correct pi TUI entry point; abort signal wired through unchanged.
- Edge cases (empty options, long text) — ⚠️ Empty-options array handled correctly; long text (question or option text exceeding available box width) is **not** wrapped or truncated — right border misaligns silently.

---

### Verdict
**CITATION**

### Summary
The implementation is functionally correct and visually complete for all *nominal* inputs: the box-drawing frame aligns, all three type hints work, step counters engage on multi-question batches, and PizzaPi's color palette is properly applied. The blocking issue is a silent overflow bug — any question or option text that exceeds the fixed 56-char interior budget pushes the right `│` border out of alignment with no fallback. Additionally, all display logic lives inside a non-exportable function scope, leaving it entirely without test coverage in violation of project standards.
