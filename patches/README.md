# Patches

Patches in this directory are applied automatically by Bun via the
`patchedDependencies` field in the root `package.json`. They are reapplied on
every `bun install` — no postinstall script is needed.

## @earendil-works/pi-agent-core@0.80.6

Adds one PizzaPi-specific runtime fix:

- **Dynamic tool refresh between assistant responses:** when a tool changes the
  active tool set mid-run (for example `search_tools` loading deferred tools),
  the next assistant response now sees the refreshed tools and system prompt
  instead of the stale turn-start snapshot. This fixes same-turn Tool Deferral
  flows where the model successfully loads a tool and then immediately gets
  `Unknown tool` / `tool isn't loaded` errors trying to call it.

**What it changes:**

| File | Change |
|------|--------|
| `dist/agent.js` — `createContextSnapshot()` | Exposes internal callbacks that return the latest tool set and system prompt |
| `dist/agent-loop.js` — `runLoop()` | Refreshes `currentContext.tools` and `currentContext.systemPrompt` before each assistant response |

**Tests:** `packages/cli/src/patches.test.ts` verifies the regression behavior with a live `Agent` instance.

## @earendil-works/pi-coding-agent@0.80.6

PizzaPi integration changes ported forward to the 0.80.x upstream layout.
Upstream provides session-control actions for command contexts; PizzaPi also
exposes those actions on the general extension API so remote event handlers can
trigger `/new` and `/resume`. The retryable-JSON-parse hunk that lived here in
0.79.x moved with upstream into `@earendil-works/pi-ai` (see the pi-ai patch
below).

**What it changes:**

| File | Change |
|------|--------|
| `dist/config.js` | Hardcodes `".pizzapi"`, flattens `getAgentDir()`, and honors `PIZZAPI_CHANGELOG_PATH` |
| `dist/core/agent-session.js` | Extension `sendUserMessage` path accepts an `expandPromptTemplates` opt-in (default `false`) so web UI input can opt into slash-command/template expansion |
| `dist/core/extensions/loader.js` / `dist/core/extensions/runner.js` | Exposes `newSession()`, `switchSession()`, and `fork()` on the general extension API for remote exec handlers |
| `dist/core/extensions/types.d.ts` | Types `newSession`/`switchSession`/`fork` on `ExtensionAPI`, `expandPromptTemplates` on `sendUserMessage`/`SendUserMessageHandler`, and `newSession`/`switchSession`/`fork` on `ExtensionActions` |
| `dist/core/model-resolver.js` | Adds built-in default model selection for `ollama-cloud` (`glm-5.1`) |
| `dist/core/provider-display-names.js` | Exposes `Ollama Cloud` as a built-in provider display name |
| `dist/modes/interactive/interactive-mode.js` | Removes upstream version-notification UI (import, `run()` call, and `showNewVersionNotification()` method) |
| `dist/index.js` / `dist/index.d.ts` | Re-exports `handlePackageCommand` and `handleConfigCommand` so the `pizza` CLI can inherit `install`/`remove`/`update`/`list`/`config` without a subpath import |

## @earendil-works/pi-ai@0.80.6

Same Anthropic web-search and Claude Code credential fallback changes as 0.79.3,
ported to the 0.80.x upstream layout (the Anthropic streaming implementation
moved from `dist/providers/anthropic.js` into `dist/api/anthropic-messages.js`),
plus built-in **Ollama Cloud** provider support and the retryable-JSON-parse
patterns that upstream relocated into `dist/utils/retry.js`.

**What it changes:**

| File | Change |
|------|--------|
| `dist/api/anthropic-messages.js` | Preserves PizzaPi's Anthropic web-search patch (server-tool-use / web-search-result block handling, `PIZZAPI_WEB_SEARCH` injection, message round-tripping, server-side tool passthrough) |
| `dist/utils/oauth/anthropic.js` | Preserves Claude Code Keychain / credential-file fallback in `anthropicOAuthProvider.refreshToken()` |
| `dist/env-api-keys.js` | Recognizes `OLLAMA_API_KEY` for provider `ollama-cloud` |
| `dist/utils/retry.js` | Adds `json.?parse.?error` / `unexpected.?end.?of.?json` to `RETRYABLE_PROVIDER_ERROR_PATTERN` (moved here from `pi-coding-agent` in 0.80.x) |
| `dist/models.generated.js` | Inlines `createOllamaModel()` helper and `OLLAMA_CLOUD_MODELS` catalog, registers the `ollama-cloud` key in `MODELS` (inlined rather than a separate file to work around [oven-sh/bun#13330](https://github.com/oven-sh/bun/issues/13330) — `bun patch` fails on `new file` in nested dirs) |
| `dist/models.generated.d.ts` / `dist/types.d.ts` | Adds `ollama-cloud` model typing to `MODELS` and `KnownProvider` |

## @mariozechner/pi-coding-agent@0.70.6 (replaced by 0.79.3 patch)

Same PizzaPi integration changes as 0.67.5, ported forward to the 0.70.x
upstream layout, plus one Ollama-first-party addition.

## @mariozechner/pi-coding-agent@0.66.1 (replaced by 0.67.5 patch)

Same changes as 0.63.1 (see below), ported forward to the 0.66.1 refactor.

Notable upstream changes in 0.66.1:
- `ModelRegistry` constructor is now private — use `ModelRegistry.create()`.
- `AgentSession.newSession()`/`switchSession()`/`fork()` moved to a new
  `AgentSessionRuntime` class. `InteractiveMode` now takes
  `AgentSessionRuntime` instead of `AgentSession`.
- The `session_switch` extension event was removed; `session_before_switch`
  and `session_start` remain.
- New `SessionManager.create()` replaces `SessionManager.persistent()`.
- Upstream retryable error regex added `ended without`; our `json.?parse`
  addition is appended on top.

**What it changes:**

| File | Change |
|------|--------|
| `dist/config.js` — `CONFIG_DIR_NAME` | Hardcodes `".pizzapi"` |
| `dist/config.js` — `getAgentDir()` | Returns `~/.pizzapi/` instead of `~/.pizzapi/agent/` — PizzaPi uses a flat directory structure |
| `dist/config.js` — `getChangelogPath()` | Checks `PIZZAPI_CHANGELOG_PATH` env var first |
| `dist/core/agent-session.js` — `_isRetryableError()` | Adds `json.?parse.?error\|unexpected.?end.?of.?json` |
| `dist/core/extensions/loader.js` — `createExtensionRuntime()` | Adds `newSession`/`switchSession` stubs |
| `dist/core/extensions/loader.js` — `createExtensionAPI()` | Adds `newSession`/`switchSession` wrappers |
| `dist/core/extensions/runner.js` — `bindCommandContext()` | Copies real handlers onto the runtime |
| `dist/core/resource-loader.js` | Uses factory `displayName`/`name` for inline extension paths |
| `dist/modes/interactive/interactive-mode.js` — `run()` | Removes `checkForNewVersion()` call |
| `dist/modes/interactive/interactive-mode.js` | Removes `checkForNewVersion()` and `showNewVersionNotification()` methods |
| `dist/modes/interactive/interactive-mode.js` — login flow | Uses `authStorage.storage?.authPath` instead of `getAuthPath()` |
| `dist/modes/interactive/interactive-mode.js` — section headers | Box-drawing themed headers, compact extension table |
| `dist/modes/interactive/interactive-mode.js` — diagnostics | Uses themed section headers for skill/prompt/extension/theme issues |

## @earendil-works/pi-tui@0.80.6

Adds Windows console output lifecycle management so Unicode glyphs render
reliably on Windows terminals.

**What it changes:**

| File | Change |
|------|--------|
| `dist/terminal.js` — `ProcessTerminal.start()` | Calls `setupWindowsConsole()` after VT-input setup to enable VT output and UTF-8 code pages |
| `dist/terminal.js` — `setupWindowsConsole()` | Creates and activates a Windows console lifecycle that configures stdout/stderr for VT processing and UTF-8 |
| `dist/terminal.js` — `ProcessTerminal.stop()` | Restores saved console modes and code pages, then clears the global capability signal |
| `dist/terminal.js` — `createWindowsConsoleLifecycle()` | Exported helper that returns `{ activate, restore }`; publishes `globalThis.__PI_WINDOWS_CONSOLE_CAPS__` with `stdoutMode`/`stderrMode` classification |

**Tests:** `packages/cli/src/patches.test.ts` verifies patch markers, source wiring,
behavioral contract, and cross-platform safety.

## @mariozechner/pi-ai@0.66.1 (replaced by 0.67.5 patch)

Same changes as 0.63.1 (see below), ported forward.

**What it changes:**

| File | Change |
|------|--------|
| `dist/providers/anthropic.js` — `convertTools()` | Pass through server-side tools as-is |
| `dist/providers/anthropic.js` — `buildParams()` | Inject `web_search_20250305` tool when `PIZZAPI_WEB_SEARCH` env var is set |
| `dist/providers/anthropic.js` — stream handler | Handle `server_tool_use` and `web_search_tool_result` blocks |
| `dist/providers/anthropic.js` — `convertMessages()` | Round-trip `_serverToolUse` and `_webSearchResult` blocks |
| `dist/utils/oauth/anthropic.js` — `anthropicOAuthProvider.refreshToken()` | Try Claude Code Keychain (`security find-generic-password`) first, then `~/.claude/.credentials.json`, before API refresh |

## @mariozechner/pi-coding-agent@0.63.1 (replaced by 0.66.1 patch)

Same changes as 0.58.3 (see below), ported forward, plus one new patch:

- **Flat agent directory:** `getAgentDir()` now returns `~/.pizzapi/` instead of
  `~/.pizzapi/agent/`. PizzaPi uses a flat directory structure where sessions,
  auth, models, bin, etc. all live directly under `~/.pizzapi/`. A startup
  migration in the daemon consolidates any data from `~/.pizzapi/agent/`.

## @mariozechner/pi-ai@0.63.1 (replaced by 0.66.1 patch)

Same web search changes as 0.58.3 (see below), ported forward, plus one new
patch:

- **Claude Code credentials fallback (Keychain-first):** When refreshing an
  expired Anthropic OAuth token, the patch first reads the macOS Keychain
  item `Claude Code-credentials` via `security find-generic-password`. If
  the token is valid (and not expiring within 60 seconds), it's returned
  directly — avoiding an API round-trip to `platform.claude.com/v1/oauth/token`.
  If the Keychain entry is unavailable (non-macOS, locked keychain, missing
  entry), the patch falls back to reading `~/.claude/.credentials.json`.

## @mariozechner/pi-coding-agent@0.58.3

**Purpose:** Five changes:

1. **Session control on extension API:** Expose `newSession()` and
   `switchSession()` on the extension runtime so the PizzaPi remote extension
   can trigger `/new` and `/resume` flows from the web UI.

2. **Remove version check:** Disable the npm registry version check and
   "Update Available" notification on startup (not relevant for PizzaPi's
   headless runner mode).

3. **Auth path display:** Show the actual auth path from the model registry
   instead of the hardcoded default, so the login message is accurate when
   PizzaPi overrides the auth file location.

4. **Override configDir to `.pizzapi`:** Hardcode `CONFIG_DIR_NAME` to
   `".pizzapi"` so that all session storage, auth, settings, and agent data
   lives under `~/.pizzapi/` instead of the upstream default `~/.pi/`. The
   upstream code reads `configDir` from its own `package.json` (which has
   `".pi"`), not the consuming CLI's `package.json`.

5. **Retryable JSON parse errors:** Add `json.?parse.?error` and
   `unexpected.?end.?of.?json` to the retryable error regex so transient
   Anthropic SSE stream truncations are automatically retried instead of
   showing an opaque ERROR badge to the user.

**Why this is needed:** Upstream `ExtensionAPI` only exposes session control
methods on `ExtensionCommandContext`, which is only available inside registered
command handlers. Regular event handlers and remote exec handlers only receive
`ExtensionContext`, which lacks session-control methods. This patch adds a thin
forwarding layer so `(pi as any).newSession()` and `(pi as any).switchSession()`
work from anywhere in the extension.

**What it changes:**

| File | Change |
|------|--------|
| `dist/config.js` — `CONFIG_DIR_NAME` | Hardcodes `".pizzapi"` instead of reading `pkg.piConfig?.configDir` (which resolves to `".pi"` from the upstream package.json) |
| `dist/core/extensions/loader.js` — `createExtensionRuntime()` | Adds `newSession` and `switchSession` stubs (reject before init) |
| `dist/core/extensions/loader.js` — `createExtensionAPI()` | Adds `newSession(options)` and `switchSession(sessionPath)` wrappers delegating to the runtime |
| `dist/core/extensions/runner.js` — `bindCommandContext()` | Copies real `newSessionHandler` / `switchSessionHandler` onto the runtime object |
| `dist/modes/interactive/interactive-mode.js` — `run()` | Removes `checkForNewVersion()` call |
| `dist/modes/interactive/interactive-mode.js` | Removes `checkForNewVersion()` and `showNewVersionNotification()` methods |
| `dist/modes/interactive/interactive-mode.js` — login flow | Uses `authStorage.storage?.authPath` instead of `getAuthPath()` |
| `dist/core/agent-session.js` — `_isRetryableError()` | Adds `json.?parse.?error\|unexpected.?end.?of.?json` to the retryable error regex |

**Tests:** `packages/cli/src/patches.test.ts` verifies both patch application
(source inspection) and functional behavior (runtime method stubs, assignment,
rejection before init). Run with `bun test packages/cli/src/patches.test.ts`.

**Removing this patch:** If `newSession` and `switchSession` are added to
`ExtensionContextActions` (or `ExtensionAPI`) upstream, this patch can be
deleted and the `patchedDependencies` entry removed from `package.json`. The
call sites in `packages/cli/src/extensions/remote.ts` should then be updated to
use the typed API.

## @mariozechner/pi-ai@0.58.3

**Purpose:** Add support for Anthropic's native web search tool
(`web_search_20250305`), which is a server-side tool that lets Claude search
the web during conversations without requiring an MCP server or external search
tool.

**Why this is needed:** The upstream `anthropic.js` provider only handles three
content block types: `text`, `thinking`, and `tool_use`. The web search API
returns `server_tool_use` and `web_search_tool_result` content blocks that are
silently dropped. Additionally, `convertTools()` assumes all tools follow the
standard `{name, description, input_schema}` shape, but server-side tools like
web search use a different format with a `type` field.

**What it changes:**

| File | Change |
|------|--------|
| `dist/providers/anthropic.js` — `convertTools()` | Pass through objects that already have a `type` field (server-side tools) instead of converting them |
| `dist/providers/anthropic.js` — `buildParams()` | Inject web search tool definition when `PIZZAPI_WEB_SEARCH` env var is set |
| `dist/providers/anthropic.js` — stream handler | Handle `server_tool_use` blocks (search queries) → emit as text blocks with `_serverToolUse` metadata; accumulate input via `input_json_delta` events and finalize at `content_block_stop` |
| `dist/providers/anthropic.js` — stream handler | Handle `web_search_tool_result` blocks → emit as text blocks with `_webSearchResult` metadata; safely handle both array results and `WebSearchToolResultError` objects |
| `dist/providers/anthropic.js` — `convertMessages()` | Round-trip `_serverToolUse` and `_webSearchResult` blocks back to the API format on subsequent turns |

**Configuration (preferred):**

Add to `~/.pizzapi/config.json`:

```json
{
  "providerSettings": {
    "anthropic": {
      "webSearch": {
        "enabled": true,
        "maxUses": 5,
        "allowedDomains": ["docs.python.org", "stackoverflow.com"],
        "blockedDomains": ["example.com"]
      }
    }
  }
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `enabled` | Enable web search | `false` |
| `maxUses` | Maximum searches per request | `5` |
| `allowedDomains` | Only include results from these domains | (all) |
| `blockedDomains` | Never include results from these domains | (none) |

**Environment variable override:**

Env vars take precedence over config.json if both are set:

| Variable | Description |
|----------|-------------|
| `PIZZAPI_WEB_SEARCH` | Set to any truthy value to enable |
| `PIZZAPI_WEB_SEARCH_MAX_USES` | Max searches per request |
| `PIZZAPI_WEB_SEARCH_ALLOWED_DOMAINS` | Comma-separated domain whitelist |
| `PIZZAPI_WEB_SEARCH_BLOCKED_DOMAINS` | Comma-separated domain blacklist |

**How it works:**

1. When `PIZZAPI_WEB_SEARCH` is set, `buildParams()` appends a `web_search_20250305`
   tool definition to the tools array.
2. Claude decides when to search. The API returns `server_tool_use` (the query)
   and `web_search_tool_result` (the results) content blocks.
3. These blocks are mapped to `text` content blocks with hidden metadata
   (`_serverToolUse`, `_webSearchResult`). The text is left empty — the UI
   renderer is responsible for presenting web-search blocks using the
   structured metadata.
4. For `server_tool_use`, the search query input arrives via `input_json_delta`
   streaming events (just like regular tool calls). The patch accumulates the
   partial JSON and finalizes it at `content_block_stop`.
5. On subsequent turns, `convertMessages()` converts them back to the proper
   API format for context continuity.

**Limitations:**

- The `web_search_tool_result` content blocks may contain encrypted search
  result data; the UI renderer must decide how to present them.

**Tests:** `packages/cli/src/patches.test.ts` verifies patch presence and
syntactic validity. Run with `bun test packages/cli/src/patches.test.ts`.

**Removing this patch:** If upstream pi-ai adds native web search support,
this patch can be deleted.

## Previously patched (no longer needed)

### @earendil-works/*@0.80.5 (replaced by 0.80.6 patches)

The 0.80.5 patch files are retained in this directory for history but are no
longer referenced by `patchedDependencies`. The 0.80.6 patches port the same
intent forward unchanged for `pi-agent-core`, `pi-tui`, and all but one file of
`pi-coding-agent`/`pi-ai` — none of those upstream files changed between 0.80.5
and 0.80.6. The two exceptions (`pi-coding-agent`'s `dist/core/extensions/types.d.ts`
and `pi-ai`'s `dist/models.generated.d.ts`/`dist/api/anthropic-messages.js`) had
unrelated upstream churn (a `Model.cost` type refactor, a new `"max"` thinking
level, request-wide cost tiers) nearby; the PizzaPi hunks in those files applied
cleanly with fuzzy context matching and needed no manual adjustment.

### @earendil-works/*@0.80.3 (replaced by 0.80.5 patches)

The 0.80.3 patch files are retained in this directory for history but are no
longer referenced by `patchedDependencies`. The 0.80.5 patches port the same
intent forward; no patch hunk needed adjustment — the upstream changes between
0.80.3 and 0.80.5 (truncated-tool-call handling in `agent-loop.js`, a new
`cache-stats` module, config-selector refactor) do not overlap with any PizzaPi
patch site. The stale `.bun-tag` marker files that `bun patch` had injected into
the 0.80.3 `pi-coding-agent` patch were dropped in the 0.80.5 regeneration.

### @earendil-works/*@0.79.3 (replaced by 0.80.3 patches)

The 0.79.3 patch files are retained in this directory for history but are no
longer referenced by `patchedDependencies`. The 0.80.3 patches port the same
intent forward; note that the retryable-JSON-parse hunk moved with upstream from
`pi-coding-agent` (`dist/core/agent-session.js`) to `pi-ai` (`dist/utils/retry.js`),
and the Anthropic streaming implementation moved from `pi-ai`
`dist/providers/anthropic.js` to `dist/api/anthropic-messages.js`.

### @mariozechner/pi-coding-agent@0.58.3 (replaced by 0.63.1 patch)

Same purpose as the current patch, just targeting an older version.

### @mariozechner/pi-coding-agent@0.55.4 (replaced by 0.58.3 patch)

Same purpose as the current patch, just targeting an older version.

### @mariozechner/pi-ai@0.58.3 (replaced by 0.63.1 patch)

Same purpose as the current patch, just targeting an older version.

### @mariozechner/pi-ai (removed in 0.55.1 upgrade)

The pi-ai patch normalized image content blocks in `transform-messages.js` to
handle various formats (OpenAI-style `source.type: "base64"`, `image_url` data
URIs, etc.). This normalization now happens inside each provider's message
converter upstream, so the patch is no longer needed.
