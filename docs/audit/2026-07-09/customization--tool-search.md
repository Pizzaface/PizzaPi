# Audit: customization/tool-search.mdx
Verdict: MINOR ISSUES
Claims checked: 22 | Failed: 5

## Findings

### [P2] `search_tools` may be visible even when Tool Search is inactive
- Claim (line ~52, 88): "When Tool Search is active, agents see a single `search_tools` tool" / step 3 implies `search_tools` is given only when active.
- Reality: `pi.registerTool({ name: "search_tools", ... })` runs unconditionally at extension construction, outside any enabled check. When disabled, `evaluateAndDeferImpl` returns early via `clearState({ restoreActiveTools: true })` and never removes `search_tools` from the active set (packages/cli/src/extensions/tool-search.ts:340-358, 196-202). Registered tools are active by default, so the agent can see/call `search_tools` even with `enabled: false` or no MCP tools — calling it then returns "Tool search is not active" (tool-search.ts:380-388). The doc's framing ("when active, agents see...") implies it is hidden otherwise.
- Fix: Either hide `search_tools` when inactive (code: only register/activate when enabled) or note in docs that the tool is always present but reports inactive when disabled.

### [P3] "How it works" step 2 overstates that *all* MCP tools are removed
- Claim (line ~18): "If the total exceeds `tokenThreshold`, all MCP tools are removed from the agent's active tool set."
- Reality: Tools from servers with `deferLoading: false` are exempted even when the threshold is exceeded (packages/cli/src/extensions/tool-search.ts:316-319, 9-11). The exemption is documented later under "Per-server `deferLoading` override" but the "How it works" summary states "all MCP tools" unconditionally.
- Fix: Add "(unless a server is marked `deferLoading: false`)" to step 2, or cross-link to the override section.

### [P3] `/tool-search reset` does not fully reset the loaded state
- Claim (line ~118): "`/tool-search reset` — re-evaluates all tools against the threshold and resets the deferred/loaded state."
- Reality: `reset` calls `evaluateAndDefer()` → `evaluateAndDeferImpl()`, which captures `previousLoadedTools` and re-adds any still-active on-demand tools, then removes them from the deferred set (packages/cli/src/extensions/tool-search.ts:262-306). So previously `search_tools`-loaded tools stay loaded and active; only the deferred set is re-derived. The doc's "resets the ... loaded state" overstates this.
- Fix: Reword to "re-evaluates deferral against the threshold (previously loaded on-demand tools remain loaded)."

### [P3] `/tool-search status` does not show servers for loaded-on-demand tools
- Claim (line ~116): "`/tool-search status` — shows how many tools are deferred, which are loaded on-demand, and which servers they belong to."
- Reality: The status handler lists deferred tools with their `serverName` but lists loaded-on-demand tools by name only, with no server (packages/cli/src/extensions/tool-search.ts:467-481). The claim that status reports "which servers they belong to" applies only to deferred tools.
- Fix: Clarify that server attribution is shown for deferred tools, or add server names to the loaded-on-demand listing (code UX).

### [P3] "Not active" return condition is broader than "all tools already loaded"
- Claim (line ~96): "Not active: if all tools are already loaded, it reports that tool search is inactive."
- Reality: The not-active branch fires when `!state.active || state.deferredTools.size === 0` (packages/cli/src/extensions/tool-search.ts:380-388). This also triggers when tool search is disabled entirely (e.g., `enabled: false`), not only when "all tools are already loaded."
- Fix: Reword to "if tool search is disabled or no tools are deferred, it reports that tool search is inactive."

## Redesign notes
- The page is well-structured and accurate on defaults/thresholds; no duplication with `customization/mcp-servers.mdx` (which does not mention `deferLoading` or Tool Search). No verbosity concerns.
- The config-options table, scoring section, and `--no-mcp` comparison table are all verified correct against `tool-search.ts` and `index.ts`.
- Consider adding a one-line note that `search_tools` is registered unconditionally (see P2 finding) so users aren't surprised to see it when `enabled: false`.
- The daemon enforces `maxResults >= 1` and `tokenThreshold >= 0` (packages/cli/src/runner/daemon.ts:2070-2082); the doc table doesn't mention these constraints. Optional addition.

## Code UX opportunities
- Only register/activate the `search_tools` tool when `toolSearch.enabled` is true so it doesn't clutter the tool set (and confuse the agent) when the feature is off (packages/cli/src/extensions/tool-search.ts:340-358).
- `/tool-search status` should report the server name for loaded-on-demand tools too, matching the deferred-tools listing, since `ToolInfo.serverName` is already captured (packages/cli/src/extensions/tool-search.ts:467-481).
- `/tool-search reset` preserving on-demand loaded tools is reasonable, but the command name implies a fuller reset; consider a `--hard` variant or clearer naming to set expectations (packages/cli/src/extensions/tool-search.ts:451-466).
