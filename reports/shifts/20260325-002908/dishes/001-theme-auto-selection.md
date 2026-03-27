# Dish 001: pizzapi-dark Theme Bundling + Auto-Selection

- **Cook Type:** claude-sonnet-4-6
- **Complexity:** M
- **Band:** A (clarityScore=78, riskScore=27, confidenceScore=62)
- **Godmother ID:** svcqeh0w
- **Dependencies:** none
- **dispatchPriority:** high
- **Files:**
  - `packages/cli/themes/pizzapi-dark.json` (create — copy from NS1 design)
  - `packages/cli/package.json` (add `"pi": { "themes": ["themes/pizzapi-dark.json"] }`)
  - `packages/cli/src/setup.ts` (write theme setting after successful setup)
- **Verification:** `bun run typecheck`, theme file exists, package.json has pi field, setup.ts writes theme
- **Status:** served
- **Critic round 3:** LGTM — all 6 edge cases verified (missing file, valid object, invalid JSON, non-object JSON, existing theme key, Object.hasOwn check)
- **Session:** dde9dae1-1b2b-4e2d-90b8-fba48d549164
- **PR:** #312
- **Expo:** PASS (typecheck 0 errors confirmed on changed files; worktree bun:sqlite/bun:test false positive excluded per NS1 policy)

## Task Description

The PizzaPi CLI has a custom warm-plum dark theme (`pizzapi-dark`) designed in Night Shift 1 but not yet in main. The theme needs to be:
1. Bundled in `packages/cli/themes/pizzapi-dark.json`
2. Registered in `packages/cli/package.json` under `"pi": { "themes": [...] }`
3. Auto-selected for new PizzaPi installations

### Sub-task 1: Create the theme file

Create `packages/cli/themes/pizzapi-dark.json` with this exact content:

```json
{
	"$schema": "https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
	"name": "pizzapi-dark",
	"vars": {
		"accent": "#e8b4f8",
		"border": "#c4a7e0",
		"borderAccent": "#f0c4ff",
		"borderMuted": "#3d3350",
		"success": "#6ee7b7",
		"error": "#f87171",
		"warning": "#fbbf24",
		"muted": "#9a8aad",
		"dim": "#706080",
		"selectedBg": "#3a2f48",
		"userMsgBg": "#2a2035",
		"toolPendingBg": "#221a2e",
		"toolSuccessBg": "#1e2e22",
		"toolErrorBg": "#2e1a1e",
		"customMsgBg": "#251e30"
	},
	"colors": {
		"accent": "accent",
		"border": "border",
		"borderAccent": "borderAccent",
		"borderMuted": "borderMuted",
		"success": "success",
		"error": "error",
		"warning": "warning",
		"muted": "muted",
		"dim": "dim",
		"text": "",
		"thinkingText": "muted",
		"selectedBg": "selectedBg",
		"userMessageBg": "userMsgBg",
		"userMessageText": "",
		"customMessageBg": "customMsgBg",
		"customMessageText": "",
		"customMessageLabel": "accent",
		"toolPendingBg": "toolPendingBg",
		"toolSuccessBg": "toolSuccessBg",
		"toolErrorBg": "toolErrorBg",
		"toolTitle": "",
		"toolOutput": "muted",
		"mdHeading": "#f0c674",
		"mdLink": "#81a2be",
		"mdLinkUrl": "dim",
		"mdCode": "accent",
		"mdCodeBlock": "success",
		"mdCodeBlockBorder": "muted",
		"mdQuote": "muted",
		"mdQuoteBorder": "muted",
		"mdHr": "muted",
		"mdListBullet": "accent",
		"toolDiffAdded": "success",
		"toolDiffRemoved": "error",
		"toolDiffContext": "muted",
		"syntaxComment": "#6A9955",
		"syntaxKeyword": "#c792ea",
		"syntaxFunction": "#DCDCAA",
		"syntaxVariable": "#9CDCFE",
		"syntaxString": "#CE9178",
		"syntaxNumber": "#B5CEA8",
		"syntaxType": "#4EC9B0",
		"syntaxOperator": "#D4D4D4",
		"syntaxPunctuation": "#D4D4D4",
		"thinkingOff": "borderMuted",
		"thinkingMinimal": "#4e3f62",
		"thinkingLow": "#6b5580",
		"thinkingMedium": "muted",
		"thinkingHigh": "border",
		"thinkingXhigh": "accent",
		"bashMode": "success"
	},
	"export": {
		"chatBg": "#16101f",
		"inputBg": "#1d1428",
		"editorBg": "#1d1428",
		"editorFg": "#e5e5e7"
	}
}
```

### Sub-task 2: Register theme in package.json

In `packages/cli/package.json`, add a `"pi"` section right after `"piConfig"`:

```json
"pi": {
  "themes": ["themes/pizzapi-dark.json"]
},
```

This registers the theme with pi's theme discovery system so it's available by name as `"pizzapi-dark"`.

### Sub-task 3: Auto-select on new installations

In `packages/cli/src/setup.ts`, modify `runSetup()`:
- After the successful relay setup completes (after the `✓ API key saved` log), write the pizzapi-dark theme preference to the pi settings file (`~/.pizzapi/settings.json`).
- The settings file is at `join(homedir(), ".pizzapi", "settings.json")`.  
- Use a safe merge: read existing JSON (if any), set `theme: "pizzapi-dark"`, write back.
- Only do this if there's no existing theme setting (don't override user's explicit choice).
- Use a try/catch — if writing settings fails, log a warning but don't fail setup.

Example logic:
```typescript
// After saving API key
try {
    const settingsPath = join(homedir(), ".pizzapi", "settings.json");
    let settings: Record<string, unknown> = {};
    try {
        const existing = readFileSync(settingsPath, "utf-8");
        settings = JSON.parse(existing);
    } catch {}
    if (!settings.theme) {
        settings.theme = "pizzapi-dark";
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        console.log("✓ Theme set to pizzapi-dark");
    }
} catch (err) {
    console.warn("Note: Could not set default theme:", err instanceof Error ? err.message : String(err));
}
```

You'll need to import `readFileSync`, `writeFileSync`, `mkdirSync`, `dirname` (node:fs/node:path).

### Required imports in setup.ts

- `readFileSync`, `writeFileSync`, `mkdirSync` from `"node:fs"`
- `dirname` from `"node:path"` (already imported `join` and `homedir`)

### Verification

1. `bun run typecheck` must pass with 0 errors
2. `packages/cli/themes/pizzapi-dark.json` exists with correct structure
3. `packages/cli/package.json` has `"pi": { "themes": ["themes/pizzapi-dark.json"] }`
4. `packages/cli/src/setup.ts` imports the needed fs/path functions and writes theme on successful setup
5. No existing tests should break — run `bun test packages/cli` to verify

---

## Kitchen Disconnect — Fixer Report

**Fixer:** claude-sonnet-4-5 (Haiku proxy)
**Sent-back reason:** Two P1 bugs in `packages/cli/src/setup.ts` theme auto-selection block
**Fix commit:** d047afe
**Fix status:** ✅ Patched and pushed

### Bug 1 — Falsiness check instead of key-presence check

**Root cause:** The Cook used `if (!piSettings.theme)` to guard the theme write. This checks JavaScript truthiness, not property existence. A settings file containing `"theme": ""`, `"theme": null`, `"theme": false`, or `"theme": 0` would pass the guard and silently overwrite the user's explicit (if falsy) theme value.

**Fix:** Replaced with `!Object.hasOwn(piSettings, "theme")`. This only skips the write when the key is genuinely absent, preserving any explicitly set value regardless of its truthiness.

### Bug 2 — Parse-failure path discards existing settings

**Root cause:** The inner `try/catch {}` for JSON parsing caught both "file not found" errors and "invalid JSON" errors identically — leaving `piSettings = {}` in both cases. When the file exists but contains invalid JSON (e.g., partial write, trailing comma), `piSettings` silently reset to empty and the code proceeded to write a new settings file containing only `{"theme":"pizzapi-dark"}`, destroying all other user preferences.

**Fix:** Added an `existsSync` guard before the read. When the file exists, a JSON parse failure now sets `skipThemeWrite = true` and logs a warning, then skips the theme write entirely. When the file doesn't exist, `piSettings = {}` is the correct starting state and setup proceeds normally.

### Changes

- Added `existsSync` to `node:fs` import
- Replaced inner `try/catch {}` with `existsSync`-guarded conditional + `skipThemeWrite` flag
- Replaced `!piSettings.theme` with `!skipThemeWrite && !Object.hasOwn(piSettings, "theme")`

### Verification

- `bun run typecheck` from main project: **0 errors**
- Manual diff confirmed only `setup.ts` was modified


## Health Inspection — 2026-03-25T11:44Z
- **Inspector Model:** claude-opus-4-6
- **Verdict:** CITATION
- **Findings:** P3 — `console.log("✓ Theme set to pizzapi-dark\n")` uses raw uncolored checkmark; the three lines above use `c.success("✓")`. Visual inconsistency — flat checkmark vs styled. No logic or correctness issues found; all edge cases (existsSync guard, JSON parse failure, Object.hasOwn check, unexpected format, outer try/catch) verified correct.
- **Critic Missed:** P3 style inconsistency (batch critic *did* note this in ratings.md; per-dish Codex critic missed it)
