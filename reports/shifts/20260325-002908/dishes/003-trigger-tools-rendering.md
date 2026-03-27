# Dish 003: Trigger Tools Themed Rendering

- **Cook Type:** claude-sonnet-4-6
- **Complexity:** S
- **Band:** B (clarityScore=63, riskScore=9, confidenceScore=58)
- **Godmother ID:** —
- **Dependencies:** none
- **dispatchPriority:** normal
- **Fallback model:** claude-haiku-4-5 (if Sonnet unavailable)
- **Files:**
  - `packages/cli/src/extensions/triggers/extension.ts`
- **Verification:** `bun run typecheck`, `bun test packages/cli`
- **Status:** served
- **Critic round 2:** LGTM — positive-match success in respond_to_trigger, escalate_trigger reads result, all renderResult paths correct
- **PR:** #321
- **Expo:** PASS — triggers/extension.ts correct; PR includes NS1 cli-colors commits from local main (expected, those are separate PRs pending merge)

## Task Description

The trigger tools (`tell_child`, `respond_to_trigger`, `escalate_trigger`) are currently all silent in the TUI. These are important inter-session communication tools — when the agent tells a child something or responds to a trigger, that should be visible.

**Design philosophy:** Tasteful, minimal. Not noisy. These fire frequently during orchestration so the renders should be concise single-liners.

### tell_child tool

`renderCall(args, theme)`:
```
→ child <last-8-of-sessionId>: <first 50 chars of message>
```
- `→` in `theme.fg("accent", ...)`
- `"child"` in `theme.fg("muted", ...)`
- sessionId (last 8 chars) in `theme.fg("dim", ...)`
- `: ` separator
- message preview (first 50 chars, `...` if truncated) in `theme.fg("dim", ...)`

`renderResult(result, opts, theme)`:
- If result text contains "Error:" → `theme.fg("error", "✗ " + result.text.slice(0, 60))`
- Otherwise → `theme.fg("success", "✓ ") + theme.fg("dim", "delivered")`

### respond_to_trigger tool

`renderCall(args, theme)`:
```
↩ trigger <triggerId-last-8>  [action]  <response-preview>
```
- `↩` in `theme.fg("accent", ...)`
- `"trigger"` in `theme.fg("muted", ...)`
- triggerId (last 8 chars) in `theme.fg("dim", ...)`
- action badge `[approve]` / `[cancel]` / `[ack]` / `[followUp]` / `[edit]` in:
  - approve/ack → `theme.fg("success", ...)`
  - cancel → `theme.fg("error", ...)`
  - followUp/edit → `theme.fg("warning", ...)`
  - default → `theme.fg("muted", ...)`
- response preview (first 40 chars) in `theme.fg("dim", ...)`

`renderResult`:
- Success → `theme.fg("success", "✓ ") + theme.fg("dim", "trigger responded")`
- Error → `theme.fg("error", "✗ " + text.slice(0, 60))`

### escalate_trigger tool

`renderCall(args, theme)`:
```
↑ escalating trigger <triggerId-last-8>
```
- `↑` in `theme.fg("warning", ...)`
- `"escalating trigger"` in `theme.fg("muted", ...)`
- triggerId (last 8) in `theme.fg("dim", ...)`

`renderResult`:
- `theme.fg("warning", "↑ ") + theme.fg("dim", "trigger escalated to human")`

### Implementation

Import `Text` from `@mariozechner/pi-tui`. Remove the `const silent = ...` if all tools are rendered (keep if some still need it — the session_complete tool uses it too).

Use this helper pattern to keep code DRY:
```typescript
function shortId(id: string, len = 8): string {
    return id.length > len ? id.slice(-len) : id;
}
function preview(text: string, max = 50): string {
    return text.length > max ? text.slice(0, max) + "..." : text;
}
```

### Verification

1. `bun run typecheck` passes with 0 errors
2. `bun test packages/cli` passes
3. All three trigger tools have non-silent renderCall functions

---

## Kitchen Disconnect — Fixer Report (2026-03-25)

**Sent back by:** Critic (P1 bugs in renderResult)
**Fixed by:** Fixer session (nightshift/dish-003-trigger-tools-rendering)
**Fix commit:** `a9a448a`

### Bug 1 — `respond_to_trigger` renderResult: false positive on `"Failed to clean up..."`

**Root cause:** Negative-match guard (`text.startsWith("Error:")` || `text.includes("error")`) missed the cleanup timeout failure path. The execute() function returns `"Failed to clean up child session <id>: Cleanup ack timed out"` — a genuine failure that starts with `"Failed"`, not `"Error:"`, and contains no lowercase `"error"`. Both conditions evaluated false, so the failure fell through to the success branch and rendered as `✓ trigger responded`.

**Fix:** Replaced negative-match with positive-match. Success is only true when the text starts with a known success prefix (`"Response sent for trigger"` or `"Acknowledged"`). Any other text — including future failure paths — defaults to the error display.

```typescript
// Before (negative-match — misses "Failed to clean up...")
if (text.startsWith("Error:") || text.includes("error")) { /* error */ }
else { /* success */ }

// After (positive-match — future-proof)
const isSuccess = text.startsWith("Response sent for trigger") || text.startsWith("Acknowledged");
if (!isSuccess) { /* error */ }
else { /* success */ }
```

### Bug 2 — `escalate_trigger` renderResult: result entirely ignored

**Root cause:** The `result` parameter was shadowed as `_result` and the function body didn't read it at all — always returning the warning-color escalation message. Error returns from execute() (`"Error: Not connected to relay."`, `"Error: No pending trigger with ID <id>."`) rendered identically to success.

**Fix:** Read `result?.content?.[0]?.text`, check for `"Error:"` prefix, and branch accordingly. Errors display error color + text; success displays the original warning-color escalation message.

```typescript
// Before (unconditional)
renderResult: (_result: any, ...) => {
    return new Text(theme.fg("warning", "↑ ") + ...);
}

// After (error-aware)
renderResult: (result: any, ...) => {
    const text: string = result?.content?.[0]?.text ?? "";
    if (text.startsWith("Error:")) {
        return new Text(theme.fg("error", "✗ ") + theme.fg("muted", preview(text, 60)), 0, 0);
    }
    return new Text(theme.fg("warning", "↑ ") + ...);
}
```

### Verification

- `bun run typecheck` — ✓ 0 errors
- Branch pushed to `origin/nightshift/dish-003-trigger-tools-rendering`
- Only `packages/cli/src/extensions/triggers/extension.ts` modified (renderResult functions only, renderCall untouched)


## Health Inspection — 2026-03-25T11:44Z
- **Inspector Model:** claude-opus-4-6
- **Verdict:** VIOLATION
- **Findings:** P1 — `respond_to_trigger` renderResult missing success prefix. The `isSuccess` guard checks only `"Response sent for trigger"` and `"Acknowledged"` but `execute()` has a third success return: `"Follow-up sent to child ${childId}"`. When `action === "followUp"` succeeds, `isSuccess` is `false` and the UI shows red `✗` for a successful operation. Fix: add `|| text.startsWith("Follow-up sent")` to the isSuccess check.
- **Critic Missed:** Per-dish critic (round 2 post-fixer) gave LGTM without catching this. Batch critic's P3 note referenced the cook's old `text.includes("error")` pattern which the fixer had already removed — batch critic did not identify the new P1 gap in the fixer's positive-match guard.
- **⚠️ MANUAL FIX REQUIRED before merging PR #321** (`--skip-fixers` was set)
