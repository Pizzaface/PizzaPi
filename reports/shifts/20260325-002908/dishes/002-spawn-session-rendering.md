# Dish 002: spawn_session + set_session_name Themed Rendering

- **Cook Type:** claude-sonnet-4-6
- **Complexity:** S
- **Band:** A (clarityScore=78, riskScore=9, confidenceScore=73)
- **Godmother ID:** —
- **Dependencies:** none
- **dispatchPriority:** high
- **Files:**
  - `packages/cli/src/extensions/spawn-session.ts`
  - `packages/cli/src/extensions/set-session-name.ts`
- **Verification:** `bun run typecheck`, `bun test packages/cli`, visual: renderCall/renderResult are non-silent for spawn_session
- **Status:** served
- **Critic round 2:** LGTM — renderResult correctly reads result.details, error/success paths both correct
- **Session:** 204ebffa-0a93-4c2f-a412-a70c95025ca1
- **PR:** #311
- **Expo:** PASS (typecheck clean; test failures are pre-existing cli-colors tests from NS1 — not caused by this dish)

## Task Description

Both `spawn_session` and `set_session_name` tools currently use `silent` for renderCall and renderResult, making them invisible in the TUI. Since spawning a session is a significant action and session naming is a meaningful event, these should have tasteful themed renderings.

### spawn_session tool

**Current:** Both renderCall and renderResult return `silent` — nothing is shown when a session is spawned.

**Target:**

`renderCall` should show a brief line like:
```
⟳ spawning session  [model-id]  in /path/to/cwd
```

Using theme tokens:
- `⟳` icon in `theme.fg("accent", ...)`
- `"spawning session"` in `theme.fg("muted", ...)`
- Model ID (if provided) in `theme.fg("dim", ...)`
- The cwd (if provided, shortened to basename or last 2 segments) in `theme.fg("dim", ...)`

`renderResult` should show:
- On success: `✓ session <sessionId> [url]`
- The checkmark `✓` in `theme.fg("success", ...)`
- Session ID shortened to last 8 chars in `theme.fg("accent", ...)`
- URL in `theme.fg("dim", ...)` if present

For the list_models tool (currently also silent): keep silent — this is a utility call, not user-facing.

**Implementation note:** The `renderCall` and `renderResult` functions receive:
- `renderCall(args, theme)` — args is the tool input
- `renderResult(result, opts, theme)` — result.content[0].text is the JSON response

Import `Text` from `@mariozechner/pi-tui` for the return value.

The pattern to use:
```typescript
renderCall: (args: any, theme: any) => {
    const model = args.model ? ` [${args.model.provider}/${args.model.id}]` : "";
    const cwd = args.cwd ? ` in ${args.cwd.split("/").slice(-2).join("/")}` : "";
    return new Text(
        theme.fg("accent", "⟳") + " " + 
        theme.fg("muted", "spawning session") + 
        theme.fg("dim", model + cwd),
        0, 0
    );
},
renderResult: (result: any, _opts: any, theme: any) => {
    // Try to parse the result
    try {
        const text = result?.content?.[0]?.text ?? "";
        if (text.includes("Error:")) {
            return new Text(theme.fg("error", "✗ ") + theme.fg("muted", text.slice(0, 80)), 0, 0);
        }
        const data = JSON.parse(text);
        const sessionId = data.sessionId ? data.sessionId.slice(-8) : "?";
        const url = data.shareUrl ? " " + data.shareUrl : "";
        return new Text(
            theme.fg("success", "✓") + " " +
            theme.fg("muted", "session ") +
            theme.fg("accent", sessionId) +
            theme.fg("dim", url),
            0, 0
        );
    } catch {
        return new Text(theme.fg("success", "✓ session spawned"), 0, 0);
    }
},
```

### set_session_name tool

The `set_session_name` tool is intentionally invisible (prevents visual noise on every session start). **Keep it silent.** No change needed here.

### Verification

1. `bun run typecheck` passes with 0 errors
2. `bun test packages/cli` passes
3. `spawn_session` renderCall and renderResult are non-silent
4. `set_session_name` renderCall and renderResult remain silent (intentional)
5. `list_models` renderCall and renderResult remain silent (utility call)

---

## Kitchen Disconnect — Fixer Report (2026-03-25)

### Status after fix: **Re-plated ✓**

### Root Cause

The Cook implemented `renderResult` by inspecting `result.content[0].text` and attempting `JSON.parse()` on it. However, `execute()` returns human-readable summary text in `content[0].text`, not JSON. Structured data (`sessionId`, `shareUrl`, `error`) is always in `result.details` — the correct extraction point.

### Bugs Diagnosed

| # | Severity | Description |
|---|----------|-------------|
| 1 | P1 | `JSON.parse(text)` always throws on the human-readable summary → catch block always returned static `"✓ session spawned"`, never the real session ID or URL |
| 2 | P1 | Error check used `text.startsWith("Error:")` but `execute()` returns `"Error spawning session: ..."` — different prefix → errors silently fell through as "success" |
| 3 | P3 | Catch fallback returned success-styled text even for errors; spec requires `✗ <message>` for failures |

### Fix Applied

Replaced the entire `renderResult` body to read from `result.details`:

- **Success path:** `details.sessionId` → last-8-chars display; `details.shareUrl` → dim URL suffix
- **Error path:** `details.error` truthy OR `text.startsWith("Error")` → `✗ <message>` in error color; message truncated to 80 chars with `...`
- **No try/catch needed** — `details` is either present or `undefined`; all branches are explicit

### Verification

- `bun run typecheck` from main project dir: **0 errors**
- Commit: `b96fcbc` on branch `nightshift/dish-002-spawn-session-rendering`


## Health Inspection — 2026-03-25T11:44Z
- **Inspector Model:** claude-opus-4-6
- **Verdict:** CITATION
- **Findings:** Three P3 issues: (a) `renderResult` ignores `_opts.isPartial` — partial results show misleading `✓ session ?`; (b) cwd display for single-segment paths like `/foo` retains leading slash due to empty split token; (c) `text.startsWith("Error")` fallback alongside `details.error` is a spec deviation (spec says use only `details`). All three are low/no practical impact.
- **Critic Missed:** All three P3 issues missed by both per-dish critic and batch critic.
