# Dish 008: Protocol Types Audit & Completion

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** L6JsYlCl (heartbeat casts), IBj63TgN (session casts)
- **Dependencies:** none
- **Files:**
  - packages/protocol/ (if exists, or inline types)
  - packages/server/src/ws/namespaces/relay.ts (type casts)
  - packages/server/src/ws/namespaces/viewer.ts (type casts)
  - packages/ui/src/App.tsx (as any casts)
- **Verification:** bun run typecheck (zero `as any` in protocol-related code)
- **Status:** queued

## Task Description

The codebase has extensive `(hb as any)`, `(session as any)` type casts in protocol-adjacent code. This hides type errors at compile time and causes subtle runtime bugs.

### Audit Scope

1. **Count all `as any` casts** in relay.ts, viewer.ts, runner.ts, App.tsx related to protocol types
2. **Identify missing protocol type fields** — planModeEnabled, providerUsage, authSource, todoList, mcpStartupReport, pendingPluginTrust, retryState
3. **Add missing fields to protocol types** — ensure all runtime data flows have compile-time type coverage
4. **Remove `as any` casts** — replace with properly typed access

### Expected Impact

- Compile-time safety for the entire event pipeline
- Protocol changes caught at typecheck, not runtime
- Foundation for the new delta event types (Dish 005 design)

## Health Inspection — 2026-03-23
- **Inspector Model:** gpt-5.3-codex (gemini-3.1-pro 429'd — skipped)
- **Verdict:** CLEAN_BILL
- **Findings:** None. All `as any` removals verified as semantically equivalent. 4137 tests pass.
- **Critic Missed:** Nothing — critic was right.
