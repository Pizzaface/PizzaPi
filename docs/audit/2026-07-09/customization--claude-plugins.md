# Audit: customization/claude-plugins.mdx
Verdict: MAJOR ISSUES
Claims checked: 45 | Failed: 7

## Findings

### [P1] `~/.claude/plugins/` is not a directly scanned global plugin directory
- Claim (line 18, 264): Quick Start says "# Any of these work: ~/.claude/plugins/my-plugin/"; Discovery table lists `~/.claude/plugins/` as "Claude Code's plugin directory" (auto-trusted global).
- Reality: `globalPluginDirs()` returns only `~/.pizzapi/plugins/` and `~/.agents/plugins/`; `~/.claude/plugins/` is intentionally excluded and a code comment states Claude Code manages it via its marketplace cache (packages/cli/src/plugins/discover.ts:30-43). Plugins under `~/.claude/plugins/` are only discovered via `discoverClaudeInstalledPlugins()`, which reads `~/.claude/plugins/installed_plugins.json` (discover.ts:120-125). A manually-placed `~/.claude/plugins/my-plugin/` directory is never scanned and will silently NOT load.
- Fix: Document that `~/.claude/plugins/` only works for plugins installed via Claude Code's marketplace (`installed_plugins.json`); for manual placement use `~/.pizzapi/plugins/` or `~/.agents/plugins/`.

### [P1] Plugin commands are NOT namespaced to the plugin
- Claim (line 67-70): "Each file becomes a pi slash command namespaced to the plugin: `commands/review.md → /my-plugin:review`".
- Reality: Command names are built from the relative file path only (`name = prefix ? \`${prefix}/${baseName}\` : baseName`), with no plugin prefix (packages/cli/src/plugins/parse.ts:201-203). The extension registers them verbatim via `pi.registerCommand(cmd.name, ...)` (packages/cli/src/extensions/claude-plugins.ts:128). E2E tests confirm e.g. `commands/a/b/c/deep.md` → name `"a/b/c/deep"`, not `<plugin>:a/b/c/deep` (claude-plugins.e2e.test.ts:282). The actual slash command is `/review`, not `/my-plugin:review`. Two plugins shipping `commands/review.md` would collide (second overwrites first).
- Fix: Either drop the namespacing claim and document the flat `/review` form (plus the collision risk), or implement namespacing in `registerPluginCommand`.

### [P1] "Using Official Claude Plugins" symlink workflow is broken
- Claim (line 405-419): `ln -s /tmp/claude-plugins/plugins/code-review ~/.pizzapi/plugins/code-review` (and the `for plugin … ln -s` loop) to install official plugins.
- Reality: `scanPluginsDir()` uses `lstatSync` and explicitly skips symlinked plugin root dirs: `if (s.isSymbolicLink() || !s.isDirectory()) continue;` (packages/cli/src/plugins/discover.ts:295-300). The same symlink rejection applies to `commands/`, `hooks/`, `skills/`, `rules/`, and `agents/` subdirs (parse.ts uses `lstatSync(...).isSymbolicLink()` guards throughout). So every `ln -s`'d plugin in the documented workflow is silently ignored.
- Fix: Replace the symlink instructions with `cp -r`/`git clone` into the plugins dir, or add a config-gated symlink-following path and document the trust implications.

### [P1] Plugin `agents/` ARE adapted (loaded as subagents), not "informational"
- Claim (line 353): "Agents (`agents/`) | ⚠️ Informational | Claude Code–specific agent definitions" under "What's Not Adapted".
- Reality: `parsePluginAgents()` parses every `agents/*.md` (parse.ts:382-418), `hasAgents` is set (parse.ts:514), and `getPluginAgentPaths()` returns trusted plugin `agents/` dirs which are fed into the subagent extension's `discoverAgents(..., { extraUserDirs: pluginAgentDirs })` (packages/cli/src/extensions/claude-plugins.ts:702-738; packages/cli/src/extensions/subagent/index.ts:145). Plugin agents become usable subagent definitions — they are fully active, not informational.
- Fix: Move `agents/` out of "What's Not Adapted" into an adapted-features section (alongside commands/hooks/skills/rules).

### [P1] MCP and LSP detection filenames are wrong
- Claim (line 38, 351, 355): FileTree shows `mcp.json`; "What's Not Adapted" table lists `mcp.json` and `LSP (lsp/)`.
- Reality: `hasMcp` checks for `.mcp.json` (leading dot) and `hasLsp` checks for `.lsp.json` (a file, not a directory): `hasMcp: existsSync(join(rootPath, ".mcp.json"))`, `hasLsp: existsSync(join(rootPath, ".lsp.json"))` (packages/cli/src/plugins/parse.ts:513-515). A plugin shipping `mcp.json` (no dot) or an `lsp/` directory will not be flagged.
- Fix: Correct the filenames to `.mcp.json` and `.lsp.json` in the FileTree and table.

### [P2] `.claude-plugin/plugin.json` (Claude Code's standard manifest location) is undocumented
- Claim (line 33-34, 50-58): Plugin Structure FileTree shows only root `plugin.json`; the `plugin.json` section implies root is the location.
- Reality: `parseManifest()` checks `.claude-plugin/plugin.json` FIRST, then root `plugin.json` (packages/cli/src/plugins/parse.ts:74-86), and tests confirm `.claude-plugin/plugin.json` is preferred over a root one (plugins.test.ts:375-390). Claude Code's own plugin spec uses `.claude-plugin/plugin.json`, so users following Claude's docs will place it there — and it works — but PizzaPi's docs never mention it.
- Fix: Add `.claude-plugin/plugin.json` to the FileTree and note it takes precedence over root `plugin.json`.

### [P2] Plugin Discovery table omits the Claude marketplace install-cache discovery path
- Claim (line 262-272): Global auto-trusted table lists three dirs as if all are scanned the same way.
- Reality: Only `~/.pizzapi/plugins/` and `~/.agents/plugins/` are directory-scanned (discover.ts:30-37); `~/.claude/plugins/` is consumed exclusively through `installed_plugins.json` + `enabledPlugins` from `~/.claude/settings.json` (discover.ts:107-185). The doc presents them as equivalent "directories" with no mention of the marketplace/installed-plugins mechanism or the enable/disable filtering.
- Fix: Add a row/footnote explaining the `installed_plugins.json` + `enabledPlugins` discovery model for `~/.claude/plugins/`.

### [P3] `plugin.json` field list is incomplete; `hooks/` parsing undersold
- Claim (line 33, 87): FileTree annotates `plugin.json *(optional — name, description, version)*`; hooks Aside says "Plugins can bundle hooks in `hooks/hooks.json`".
- Reality: `parseManifest` also reads `author` (string or `{name}`), `homepage`, `repository`, `license`, `keywords` (parse.ts:91-101; info.ts:43-45). `parseHooks` merges ALL `*.json` files in `hooks/`, not just `hooks.json` (parse.ts:230-285). The doc's narrower claims aren't wrong, just incomplete.
- Fix: Mention the additional manifest fields and that any `hooks/*.json` is merged.

### [P3] Web UI capability badge list omits the "rules" badge already documented below
- Claim (line 388): "Plugin names with capability badges (commands, hooks, skills, MCP)".
- Reality: The UI renders a `rule(s)` badge too (packages/ui/src/components/PluginsManager.tsx:115), which the doc itself describes two sections later (line 256-258). The Web UI bullet should list "rules" for consistency.
- Fix: Add "rules" to the badge list in the Web UI section.

### [P3] Web UI trust banner button label is "Trust & Load", not "Trust"
- Claim (line 327): "amber trust banner with Trust / Skip buttons".
- Reality: Buttons are labeled `Trust & Load` and `Skip` (packages/ui/src/components/SessionViewer.tsx:1022-1023). Minor wording mismatch.
- Fix: Say "Trust & Load / Skip" or keep "Trust / Skip" as a summary but it's a small inaccuracy.

## Redesign notes
- The "What's Not Adapted" table mixes truly-skipped features (prompt/agent hook types) with actively-adapted ones (agents) and wrongly-named files (mcp/lsp). Split it: "Adapted" (commands, hooks, skills, rules, agents) vs "Not adapted" (MCP servers, LSP, prompt/agent hook types) with correct filenames.
- "Plugin Discovery" should distinguish three discovery mechanisms: directory scan (`~/.pizzapi`, `~/.agents`), Claude marketplace cache (`~/.claude/plugins/installed_plugins.json`), and project-local trust-gated scan. Conflating them produces the Quick Start error.
- The Quick Start "Any of these work" block is the single most misleading part — it should only list the two truly-scanned global dirs and cross-link to the Claude-marketplace section for `~/.claude/`.
- Command namespacing is presented as a feature that doesn't exist; either implement it (best — prevents cross-plugin collisions) or clearly document the flat namespace and collision risk.
- The official-plugins install recipe should be tested end-to-end (it currently can't work due to symlink rejection) before being published.

## Code UX opportunities
- `scanPluginsDir` rejects ALL symlinked plugin roots (discover.ts:295-300). This blocks the natural `ln -s` install workflow users expect from Claude-ecosystem docs. Consider allowing symlinks that resolve to a path still inside a trusted parent (or under the same scan root) rather than rejecting unconditionally — or at least emit a visible warning so `pizza plugins` shows "skipped symlink: X" instead of silently disappearing.
- Command name collisions across plugins are silently last-wins (claude-plugins.ts:128 registers flat names). A startup warning when two plugins register the same command name would surface the problem the docs imply is solved by namespacing.
- `pizza plugins` (listPlugins) only shows project-local plugins from a direct `scanPluginsDir` and never calls `discoverClaudeInstalledPlugins` for the project view, yet the help text (plugins-cli.ts:200-201) advertises `~/.claude/plugins/` as "always auto-trusted" — the help text and the docs share the same inaccuracy. Fix the help string too.
- `hasLsp` detects a `.lsp.json` file but the feature is described as an `lsp/` directory; either align the doc to the file or add directory detection so the doc's mental model matches.
