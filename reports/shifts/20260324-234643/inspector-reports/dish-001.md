## Inspection: Dish 001 — PizzaPi Dark Theme

### Quality Gates
- **Typecheck:** SKIPPED (all 4 errors are pre-existing known false positives: `bun:sqlite` ×3 and `bun:test` ×1 — worktree environment artifacts, unrelated to the PR)
- **Tests:** SKIPPED (106 fail, 0 pass — all failures are `Cannot find package 'redis'`, a pre-existing worktree infrastructure issue; the PR only adds a JSON file and a package.json key, neither of which can cause test regressions)

### Findings
#### P0 (Critical)
- None

#### P1 (Serious)
- None

#### P2 (Moderate)
- None

#### P3 (Minor)
- None

### Completeness
- All 51 tokens present — ✅ (confirmed against live schema: `theme-schema.json` defines exactly 51 `colors` properties; the file covers all 51 in the correct order)
- $schema correct — ✅ (`https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json` matches the URL used in the upstream `dark.json` reference theme)
- name: pizzapi-dark — ✅
- Required accent/border colors correct — ✅
  - accent: `#e8b4f8` ✅
  - border: `#c4a7e0` ✅
  - borderAccent: `#f0c4ff` ✅
  - borderMuted: `#3d3350` ✅
  - success: `#6ee7b7` ✅
  - error: `#f87171` ✅
  - warning: `#fbbf24` ✅
  - muted: `#9a8aad` ✅
  - dim: `#706080` ✅
- Background colors correct — ✅
  - userMessageBg: `#2a2035` (via var `userMsgBg`) ✅
  - toolPendingBg: `#221a2e` ✅
  - toolSuccessBg: `#1e2e22` ✅
  - toolErrorBg: `#2e1a1e` ✅
  - customMessageBg: `#251e30` (via var `customMsgBg`) ✅
  - selectedBg: `#3a2f48` ✅
- Thinking gradient correct — ✅
  - `thinkingOff` → `borderMuted` → `#3d3350` (darkest anchor) ✅
  - `thinkingMinimal` → `#4e3f62` (intermediate) ✅
  - `thinkingLow` → `#6b5580` (intermediate) ✅
  - `thinkingMedium` → `muted` → `#9a8aad` (mid-range) ✅
  - `thinkingHigh` → `border` → `#c4a7e0` (near-peak) ✅
  - `thinkingXhigh` → `accent` → `#e8b4f8` (brightest anchor) ✅
  - Gradient arc: `#3d3350` → `#c4a7e0` → `#e8b4f8` matches spec exactly
- Export colors correct — ✅
  - pageBg: `#151118` ✅
  - cardBg: `#1e1828` ✅
  - infoBg: `#3c3228` ✅
- Theme registration — ✅ (`packages/cli/package.json` → `"pi": { "themes": ["themes/pizzapi-dark.json"] }`)

### Verdict
**CLEAN_BILL**

### Summary
The `pizzapi-dark` theme is fully compliant: all 51 schema-defined color tokens are present and correctly mapped, every required hex value from the spec matches the file, and the thinking gradient ramps cleanly from `#3d3350` through `#c4a7e0` to `#e8b4f8`. The `$schema` URL, theme name, export block, and `pi.themes` registration in `package.json` are all correct. Quality gates were untestable due to known pre-existing worktree environment issues (missing Redis/bun type declarations), not anything introduced by this PR.
