# Audit: customization/mcp-servers.mdx
Verdict: MAJOR ISSUES
Claims checked: 34 | Failed: 8

## Findings

### [P1] `transport: "sse"` is not a valid transport value
- Claim (line ~70): The HTTP transport table lists `transport` as `"sse" | "streamable"`, and the HTTP example uses `"transport": "sse"`.
- Reality: The `mcpServers` entry type only accepts `transport?: "http" | "streamable"`; the `mcp.servers[]` array accepts `transport: "stdio" | "http" | "streamable"`. There is no `"sse"` transport anywhere (packages/cli/src/extensions/mcp/registry.ts:54, registry.ts:30-33). The selection logic is `useStreamable = d.transport === "streamable" || (d.type === "http" && d.transport === undefined)` (registry.ts:262-264), so `"transport": "sse"` falls through to `createHttpMcpClient` — plain JSON POST, not Server-Sent Events.
- Fix: Replace `"sse" | "streamable"` with `"http" | "streamable"` and drop the `"transport": "sse"` example.

### [P1] "sse uses Server-Sent Events" is false
- Claim (line ~70): `transport` `"sse"` "uses Server-Sent Events".
- Reality: There is no SSE/EventSource client. `createHttpMcpClient` does plain JSON `POST` requests (packages/cli/src/extensions/mcp/transport-http.ts:18-46). SSE (`text/event-stream`) parsing exists only inside `createStreamableMcpClient` (transport-http.ts:108-159), i.e. the `"streamable"` transport. A `"sse"` transport value routes to plain HTTP, which would fail against a real SSE endpoint.
- Fix: Remove the SSE row; document that `streamable` is the transport that handles `text/event-stream` responses.

### [P1] "PizzaPi infers the transport from the URL path" is false
- Claim (line ~70): "If omitted, PizzaPi infers the transport from the URL path."
- Reality: No URL-path inference exists. When both `transport` and `type` are omitted, `useStreamable` is `false` and `createHttpMcpClient` (plain HTTP POST) is used unconditionally (registry.ts:262-279). There is no inspection of the URL path.
- Fix: Replace with "If omitted, plain HTTP (JSON POST) is used. Set `transport: "streamable"` or `type: "http"` for the Streamable HTTP protocol."

### [P2] Project-local MCP trust gate (`allowProjectMcp`) is undocumented
- Claim (line ~18): Project-local `.pizzapi/config.json` servers are simply scoped to the project and deep-merged.
- Reality: Project-local MCP servers trigger a security warning by default and are loaded "warn-and-load" unless `allowProjectMcp: true` is set in the global config or `PIZZAPI_ALLOW_PROJECT_MCP=1` is exported (packages/cli/src/config/io.ts:103-110, 243-253; types documented at packages/cli/src/config/types.ts:374-385). The warning text explicitly cites the self-authorization-bypass risk. The docs page never mentions this gate, so users following the guide will hit an unexpected warning and have no documented way to silence it.
- Fix: Add a note that project-local MCP servers emit a trust warning by default and require `allowProjectMcp` (global) or `PIZZAPI_ALLOW_PROJECT_MCP=1` to silence.

### [P2] `mcpTimeout` does not bound server startup
- Claim (line ~150): "Server timeout on startup — MCP servers must respond within `mcpTimeout` milliseconds (default: `30000`, i.e. 30 seconds)."
- Reality: `mcpTimeout` (default 30000) only bounds the `tools/list` call. Server initialization (handshake + OAuth) uses a separate `mcpInitTimeout` defaulting to `180_000` ms (3 minutes) (packages/cli/src/extensions/mcp/registry.ts:128-131, 466-468; types at packages/cli/src/config/types.ts:424-431). A server needing 60s to initialize will NOT time out at 30s. The doc also omits the `mcpInitTimeout` config key and that `mcpTimeout: 0` disables the timeout.
- Fix: Clarify that 30s bounds `tools/list` only; document `mcpInitTimeout` (default 180s) for init/OAuth and `mcpTimeout: 0` to disable.

### [P2] Paste-fallback activation described incorrectly
- Claim (line ~110): "This flow activates automatically when the runner detects it can't open a local browser."
- Reality: Paste mode activates only in relay mode AND after OAuth dynamic client registration fails (server rejects non-localhost redirect URIs, e.g. Figma). The code calls `enableLocalhostRegistration()` solely inside the registration-failure fallback in `transport-http.ts:374-381`; `_useLocalhostForRegistration` gates paste mode (packages/cli/src/extensions/mcp-oauth.ts:325, 482-499, 614-621, 749-751). Browser-open detection is not part of the trigger — in local mode the browser is opened directly regardless.
- Fix: Rephrase: paste mode triggers when, in relay mode, a server's OAuth registration rejects non-localhost redirect URIs.

### [P2] "mcpServers (preferred)" tab label contradicts code terminology
- Claim (line ~24): The first tab is labeled "mcpServers (preferred)".
- Reality: The code consistently names `mcp.servers[]` the "Preferred format" and `mcpServers{}` the "Compatibility format" (registry.ts:6, 28, 48; mcp-extension.ts `effectivePreferredSource` ↔ `hasMcpKey`, `effectiveCompatibilitySource` ↔ `hasMcpServersKey` at lines 354-366). The `/mcp` status output prints "Effective config sources … mcp.servers … mcpServers" using that same preferred/compatibility split (mcp-extension.ts:571-573). The doc label inverts the code's own wording, which will confuse users reading `/mcp` output. (Note: project AGENTS.md asserts the opposite — that `mcpServers{}` is preferred — so the repo is internally inconsistent; the doc should pick one and align the code comments.)
- Fix: Either relabel the tab to match the code ("mcpServers (Claude Code / compatibility)") or update the code comments/AGENTS.md to match the doc; do not leave them contradictory.

### [P3] `/mcp` status shows scope, not per-server config file path
- Claim (line ~94): `/mcp` shows "which config file each server came from."
- Reality: Per-server lines render `from ${server.scope}` (the literal "global"/"project"), not the file path (mcp-extension.ts:510). `sourcePath` is stored on each entry but is not printed per server; the two file paths are only listed separately in a "Config files:" section (mcp-extension.ts:555-557).
- Fix: Say "which scope (global vs project) each server came from" or actually surface `sourcePath` per server.

### [P3] STDIO `cwd` default overstated
- Claim (line ~57): `cwd` "Defaults to the current project root."
- Reality: When `cwd` is unset, `spawn` inherits the parent process's cwd (`opts.cwd ? { cwd } : {}`), which is `process.cwd()` of the runner — not guaranteed to be the project root, especially under the runner daemon (packages/cli/src/extensions/mcp/transport-stdio.ts:40-44).
- Fix: "Defaults to the runner's working directory (typically the project root)."

### [P3] Figma client-name allowlist is an unsupported external claim
- Claim (line ~90): "Figma's remote MCP server currently accepts `"Claude Code"` and `"Codex"` as client names."
- Reality: No code defines or verifies this; it's a claim about Figma's external service that can change without notice. The code only documents the override mechanism (types.ts:456-461).
- Fix: Mark as "at time of writing" and advise checking Figma's docs, or drop the specific values.

### [P3] Missing cross-references and undocumented advanced keys
- Claim (whole page): The page documents `command/args/env/cwd/url/transport/headers/type/oauthClientName/mcpTimeout` only.
- Reality: The code also supports `deferLoading` (per-server, both formats — registry.ts:30-33, 51-54; types.ts:525-530), `oauthClientId`/`oauthClientSecret`/`oauthCallbackPort` (registry.ts:30-33, 209, 252; types.ts:463-496), and `mcpInitTimeout` (registry.ts:468). `deferLoading` is the bridge to the Tool Search page but is never linked here. The `npx` 30s-download caution (line ~162) is reasonable but the parallel-init example "~15 seconds" ignores the 10s grace cap (registry.ts:635 `GRACE_MS = 10_000`) after which slow servers continue in the background.
- Fix: Add a "See Tool Search for `deferLoading`" cross-link; mention `mcpInitTimeout` and the 10s grace cap; optionally document the OAuth pre-registration keys.

### [P3] OAuth troubleshooting step is vague
- Claim (line ~82): "try disconnecting and re-authenticating by removing the stored token and reloading the server with `/mcp reload`."
- Reality: `/mcp reload` re-initializes clients but does not clear persisted OAuth tokens (saved via `savePersistedAuth` in mcp-oauth.ts). The doc never says where tokens are stored or how to remove them, so the instruction is not actionable.
- Fix: Specify the token storage location and the exact removal step, or add a `/mcp` subcommand to clear a server's auth.

### [P3] `--safe-mode` not mentioned as an MCP-skip alternative
- Claim (line ~155): Only `PIZZAPI_NO_MCP=1` and `pizza --no-mcp` skip MCP.
- Reality: `--safe-mode` also skips MCP (plus plugins, hooks, relay) — packages/cli/src/index.ts:363-364. Useful for debugging and worth a one-liner here.
- Fix: Add `pizza --safe-mode` as a broader-scope alternative.

## Redesign notes
- The HTTP transport table is the page's weakest section: it invents an `sse` transport and URL-path inference that don't exist. Rebuild it around the two real modes — plain HTTP (JSON POST) and Streamable HTTP (`text/event-stream`) — driven by `transport: "streamable"` or `type: "http"`.
- Split "timeout" into two clearly labeled knobs (`mcpTimeout` for `tools/list`, `mcpInitTimeout` for init/OAuth) instead of implying one 30s startup budget.
- State the project-local trust gate up front in the Configuration section, since it's a security-relevant behavior users will hit immediately.
- Align "preferred" terminology with the code (or fix the code) so docs and `/mcp` output agree.
- Cross-link Tool Search / `deferLoading` so readers learn about on-demand loading without leaving the MCP page.

## Code UX opportunities
- `transport: "sse"` silently falls back to plain HTTP with no warning — a config-validation step could reject unknown transport values (or warn) at load time instead of failing opaquely at runtime.
- There's no way to clear a server's stored OAuth token via `/mcp`; a `/mcp auth <name> clear` subcommand would make the documented troubleshooting step actionable.
- The `/mcp` status prints `from ${server.scope}` but already has `sourcePath` on the entry — printing the path (or `~`-abbreviated path) would fulfill the doc's "which config file" claim without code changes to data.
- The "preferred" vs "compatibility" naming clash between code comments and AGENTS.md suggests renaming the code fields/comments to match the user-facing `mcpServers`-first convention, removing the contradiction at the source.
