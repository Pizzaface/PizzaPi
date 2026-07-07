# UX Audit & Improvement Sweep — Summary

Delivered on `main` (~30 commits, +764/−229 across 48 files). Method: Kimi
(`kimi-k2.7-code`) researcher sessions driving the sandbox harness
(`packages/server/tests/harness/sandbox.ts`) via `playwright-cli`, findings
verified against source and re-verified live before each commit. Raw reports:
`/tmp/ux-findings-*.md`, verification reports `/tmp/ux-verify-*.md`.
Certified: `tsc` clean, `vite build` passes, 992 UI tests pass (11 pre-existing
`@/`-alias isolated-run failures unrelated), independent 12/12 end-to-end pass.

## Later rounds (beyond the initial sweep)

- New-session wizard: single-runner auto-advance + hide orphaned Back, focus ring, "Configure session on" copy, folder-browser disable-on-error
- Plugin/Hooks/MCP/Trusted-Paths error states: Retry + friendly copy + aria-labels; plugin Rescan toast; MCP transport/deferred-loading helper text
- Webhooks: HMAC-secret label, stable named delete dialog, collapsed-row Copy fire URL, dismissible (not auto-hidden) errors, Source helper
- Services: open-in-new-tab disabled when service off
- Triggers: empty-state guidance + error Retry
- Usage dashboard: rich empty state, chart `role=img` + axis units, focusable info tooltips, session-table model title, loading skeletons
- Session analyzer: metric explanation tooltips
- Sidebar: Escape-exits-select-mode, concise row aria-label, arrow-key row navigation, enlarged expand-chevron tap target
- Global a11y: `prefers-reduced-motion` for sidebar animations, toast live region (WCAG 4.1.3), settings-panel "taking longer" hint, Appearance "Reset all"

## Coverage (17 researcher sessions, A–Q + verification)

Auth · header/chrome · sidebar/nav · session view · composer (+@/slash) ·
runner managers (skills, agents, plugins, hooks, mcp, webhooks, services,
triggers, sandbox, usage) · work panels (terminal, files, git, triggers,
context analyzer) · mobile (390×844 / 344×882) · accessibility/keyboard ·
new-session wizard.

## Highest-impact fixes

| Area | Fix | Commit |
|------|-----|--------|
| **Connection** | First-load `/hub` socket connected pre-auth, was rejected, never retried → stuck sidebar skeletons + permanent "Connecting…" until reload. Gated the socket on auth. | `bfc81af5` |
| **Crash** | Usage tab crashed on unexpected payloads (`undefined.length`) → validate shape + zero-state. | `4d7f9dd9` |
| **Data loss UX** | Failed send left composer disabled with text trapped → dismissible error, "draft preserved", stuck-hydration explainer. | `18feac3b` |
| **Composer** | `@`-mention Enter with no selection sent the raw `@query` (failed send) → swallow Enter, close picker. | `c0dfd859` |
| **A11y** | State-controlled dialogs dropped focus to `<body>` on close (2.4.3) → restore to trigger. No `<h1>` (1.3.1) → added. Tab focus rings, aria-labels on icon buttons, chart `role=img`. | `ac1f0fed`, `cd39636d` |
| **Dialog bug** | `CommandDialog` rendered its sr-only title into the page while closed. | `aa00c681` |

## Representative smaller fixes

Empty-state CTAs (session view, usage, runner sessions, triggers) · mobile
tap targets 28→36px · panel layout 40vw floor (chat can't be squeezed away) ·
theme contrast for selected sidebar row · sub-agent card theming · tool-card
collapsed summaries · history-palette dead-runner fallback + clear-search ·
sidebar splitter arrow-key resize · mobile notification/haptics menu items ·
manager error states (Trusted Paths Retry, friendly Hooks/MCP copy) · form
submit-disabled + validation-clear · success toasts on skill/agent create ·
webhook HMAC-secret label + stable delete dialog · New-session wizard
single-runner auto-advance · runner tab-bar mobile scroll cue.

## Verification discipline

~15 researcher false positives were caught and rejected before wasting fix
effort (Escape-close claims ×several, sign-in loading state, password input
type, tab overflow, wizard Escape). Two dead-ends were investigated,
root-caused, and reverted rather than shipped as speculative half-fixes
(harness transcript rendering — see GM `inguHsTN`). Every commit: `tsc`
clean, UI suite 992 pass, live-verified in the sandbox.

## Tracked follow-ups (Godmother)

- `6jWuoyzK` — a11y polish (search combobox label done; dialog focus done)
- `v765qbaW` — wizard: silent spawn-failure feedback, step indicator, model pick
- `KBGsLkvQ` — plugin lifecycle controls, service descriptions, MCP jargon
- `5vqCzey4` — first-load WS race (fixed) — verify against a real runner
- `inguHsTN` — harness `/chat` transcript rendering (test-infra, root-caused)
