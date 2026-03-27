# Dish 004: Terminal Title Override

- **Cook Type:** sonnet
- **Complexity:** S
- **Godmother ID:** none — goal-driven
- **Dependencies:** none
- **Files:** packages/cli/src/extensions/pizzapi-header.ts (or new file), packages/cli/src/extensions/factories.ts
- **Verification:** bun run typecheck
- **Status:** served
- **Confidence:** Band A (dispatchPriority=high)

## Task Description

Override pi's default terminal title from `π - sessionName - cwd` to `🍕 PizzaPi — sessionName — cwd`.

### Implementation

Pi sets the terminal title in `InteractiveMode.updateTerminalTitle()` using `this.ui.terminal.setTitle(...)`. PizzaPi can override this by:

1. Using an extension that sets a custom title on `session_start` via the TUI terminal API
2. Or hooking into the session name change event to update the title

The simplest approach: in the header extension (dish 002), also call `tui.terminal.setTitle(...)` on init and whenever the session name changes. This keeps the title and header in the same extension.

If `tui.terminal.setTitle` is not accessible from the extension API, explore alternative approaches (e.g., directly writing the OSC escape sequence via `process.stdout.write`).

### Format

```
🍕 PizzaPi — <sessionName> — <cwdBasename>
```

When no session name: `🍕 PizzaPi — <cwdBasename>`

---

## Health Inspection — 2026-03-25
- **Inspector Model:** claude-sonnet-4-5 (Health Inspector)
- **Verdict:** ✅ CLEAN BILL
- **Findings:** P3 (acknowledged in tests) — `basename("/")` returns `""` on POSIX, producing a dangling `"🍕 PizzaPi — "` title from root. Near-zero real-world impact; test suite explicitly documents it.
- **Critic Missed:** Nothing material. Round-1 LGTM confirmed.
