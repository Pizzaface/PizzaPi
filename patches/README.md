# Patches

Patches in this directory are applied by Bun through the root
`patchedDependencies` field in `package.json`. They are reapplied on every
`bun install`; there is no postinstall patch script.

## Current patch inventory (Pi 1.0.0)

### `@earendil-works/pi-agent-core@1.0.0`

Keeps PizzaPi's dynamic tool/prompt refresh behavior.

Pi 1.0.0 added transcript-level tool declarations (`toolsAdded` /
`toolsRemoved`), so the patch now refreshes the live tool list before
`declareToolChanges()` as well as immediately before `streamAssistantResponse()`.
Without the earlier refresh, tools loaded by a tool call can be executable in
PizzaPi state but absent from the next provider request's transcript. The patch
also keeps `llmContext.tools = context.tools` for compatibility with custom
stream functions that still inspect `context.tools` directly.

### `@earendil-works/pi-ai@1.0.0`

Preserves PizzaPi's provider-runtime behavior not present upstream:

- Anthropic hosted web search: passes server-side tool definitions through,
  injects `web_search_20250305` when `PIZZAPI_WEB_SEARCH` is truthy, renders
  `server_tool_use` / `web_search_tool_result` blocks into PizzaPi's assistant
  message shape, and round-trips those blocks on replay.
- OpenAI Responses hosted web search: surfaces `web_search_call` items as the
  same UI-only server-tool/result blocks and skips those blocks when replaying
  prior assistant messages.
- Anthropic OAuth refresh first tries Claude Code credentials from macOS
  Keychain and `~/.claude/.credentials.json`, then falls back to Pi's stored
  Anthropic refresh token.
- Retry classification treats transient JSON parse / unexpected-end errors as
  retryable stream truncation failures.

Upstream 1.0.0 still does not include these PizzaPi hooks.

### `@earendil-works/pi-coding-agent@1.0.0`

Preserves PizzaPi integration behavior:

| File | Change |
| --- | --- |
| `dist/config.js` | Uses `.pizzapi` as the config namespace; uses a flat `~/.pizzapi` agent dir instead of `~/.pi/agent`; lets `PIZZAPI_CHANGELOG_PATH` override only the changelog path. |
| `dist/core/agent-session.js` | Expands every `/skill:<name>` token in a message. A leading skill still treats trailing text as args; inline skill tokens expand in place. |
| `dist/core/model-resolver.js` | Adds the bundled `ollama-cloud` default model (`glm-5.1`). |
| `dist/core/model-runtime.js` | Wraps built-in `openai` and `openai-codex` providers so GPT-5.4+ / GPT-6 / Daybreak context windows use PizzaPi's published-capacity table. Pi 1.0.0 added `getAllModels()` / `filterAllModels()` paths, so the wrapper now maps `getModels`, `getAllModels`, `filterModels`, and `filterAllModels`. |
| `dist/core/settings-manager.js` | Defaults `quietStartup` to on while preserving explicit `quietStartup: false` and `"header"`. |
| `dist/index.js` / `dist/index.d.ts` | Re-export `handlePackageCommand` and `handleConfigCommand`. |
| `dist/modes/interactive/interactive-mode.js` | Removes upstream Pi version nags, changes package-update guidance to `pizza update --extensions`, and re-attaches live bash cards after pending-message container clears. |

OpenAI context override note: the actual patch applies to both `openai` and
`openai-codex`. Do not regress this to direct OpenAI only.

### `@earendil-works/pi-tui@1.0.0`

Adds a best-effort Windows console lifecycle in `dist/terminal.js`:
`createWindowsConsoleLifecycle()`, `ProcessTerminal.setupWindowsConsole()`,
`globalThis.__PI_WINDOWS_CONSOLE_CAPS__`, and restore-on-stop wiring. This keeps
PizzaPi's downstream Windows rendering capability signal stable. The 1.0.0 port
currently preserves the existing no-op off-Windows implementation.

### `pptx-browser@4.1.5`

Fixes paragraph default run properties lookup order in `src/render.js` by
loading `defRPr` before bullet parsing.

## Retired historical patches

Superseded pre-1.0.0 `@earendil-works/*` patch files were removed once they
stopped being referenced by `patchedDependencies`. Use git history for lineage:

```bash
git log --oneline -- 'patches/*.patch'
```
