# Dish 001: PizzaPi Dark Theme

- **Cook Type:** sonnet
- **Complexity:** S
- **Godmother ID:** none — goal-driven
- **Dependencies:** none
- **Files:** packages/cli/themes/pizzapi-dark.json (new)
- **Verification:** Theme JSON validates against schema, all 51 color tokens present, bun run typecheck
- **Status:** served
- **Confidence:** Band A (dispatchPriority=high)

## Task Description

Create a PizzaPi-branded dark theme JSON file at `packages/cli/themes/pizzapi-dark.json`.

### Color Direction: "Warm Confidence" (plum/purple palette)

**Vars:**
- accent: `#e8b4f8` (light plum — logo, selected items, cursor)
- border: `#c4a7e0` (soft purple — normal borders)
- borderAccent: `#f0c4ff` (bright lavender — highlighted borders)
- borderMuted: `#3d3350` (dark purple — editor border)
- success: `#6ee7b7` (mint green)
- error: `#f87171` (soft red)
- warning: `#fbbf24` (warm amber)
- muted: `#9a8aad` (dusty lavender — secondary text)
- dim: `#706080` (muted purple-gray — tertiary text)
- text: `""` (terminal default)

**Backgrounds:**
- userMessageBg: `#2a2035` (deep plum)
- toolPendingBg: `#221a2e` (darker plum)
- toolSuccessBg: `#1e2e22` (dark green tint)
- toolErrorBg: `#2e1a1e` (dark red tint)
- customMessageBg: `#251e30` (purple tint)
- selectedBg: `#3a2f48` (highlighted plum)

**Markdown:** Headings in warm amber `#f0c674`, links in soft blue `#81a2be`, inline code in accent.

**Syntax:** Follow VS Code Dark+ palette but with plum-tinted variables.

**Thinking levels:** Gradient from muted (`#3d3350`) through purple (`#c4a7e0`) to bright plum (`#e8b4f8`).

**Export:** pageBg `#151118`, cardBg `#1e1828`, infoBg `#3c3228`.

Must include `$schema` pointing to the pi theme schema. Must include `name: "pizzapi-dark"`. All 51 tokens required.

### Registration

The theme file should be placed in `packages/cli/themes/` and the CLI should register it so it auto-discovers. Check how pi discovers themes via the `DefaultResourceLoader` — themes in packages can be registered via `package.json` `pi.themes` entry or `themes/` directory.

---

## Health Inspection — 2026-03-25
- **Inspector Model:** claude-sonnet-4-5 (Health Inspector)
- **Verdict:** ✅ CLEAN BILL
- **Findings:** None. All 51 schema tokens present and correctly mapped. $schema URL, theme name, thinking gradient, export block, and pi.themes registration confirmed correct.
- **Critic Missed:** Nothing. Critic override was correct — worktree env failures were pre-existing and unrelated to a JSON theme file.
