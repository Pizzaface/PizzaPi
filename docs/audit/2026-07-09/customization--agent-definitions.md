# Audit: customization/agent-definitions.mdx
Verdict: MAJOR ISSUES
Claims checked: 37 | Failed: 9

## Findings

### [P1] Invented `provider` frontmatter field
- Claim (line ~33, Frontmatter Fields table): "`provider` | string | — | Provider override (e.g. `anthropic`, `google`)"
- Reality: No `provider` frontmatter field is parsed. `loadAgentsFromDir` only reads `name`, `description`, `tools`, `disallowedTools`, `model`, `maxTurns`, `background`, `permissionMode` (packages/cli/src/extensions/subagent-agents.ts:120-147). Provider is set via the `model` string using `provider/id` slash form, parsed by `parseModelString` (packages/cli/src/extensions/subagent/engine.ts:62-83), or via the `subagent` tool's `model: { provider, id }` parameter (packages/cli/src/extensions/subagent/index.ts:33-41). A `provider:` frontmatter key is silently ignored.
- Fix: Remove the `provider` row; document `model` accepting `anthropic/claude-haiku-4-5` slash form and `haiku`/`sonnet`/`opus`/`inherit` aliases.

### [P1] Missing supported frontmatter fields
- Claim (Frontmatter Fields table): only `name`, `description`, `tools`, `model`, `provider`.
- Reality: The parser supports `disallowedTools`, `maxTurns`, `permissionMode`, and `background` (packages/cli/src/extensions/subagent-agents.ts:134-147, AgentConfig interface lines 33-52). `permissionMode: plan` switches the session to read-only tools (packages/cli/src/extensions/subagent/engine.ts:209-211). The sibling page subagents.mdx documents all of these, and subagents.mdx even links here as the "complete guide" — so the incomplete table is the canonical reference and is wrong.
- Fix: Add `disallowedTools`, `maxTurns`, `permissionMode`, `background` rows (mirror subagents.mdx) and drop `provider`.

### [P1] MCP tool names rejected, not supported in `tools:`
- Claim (line ~89): "MCP tools are referenced by their prefixed name (e.g. `mcp__tavily__tavily_search`)"
- Reality: When `tools:` is set, `resolveTools` is fail-closed and only accepts names in `BUILTIN_TOOLS` (`bash, read, edit, write, grep, find, ls`); any unknown name returns `Unknown tool(s): ...` (packages/cli/src/extensions/subagent/engine.ts:21-46, 218-232). MCP/extension tools cannot be selected by name. (When `tools:` is omitted, the session uses `createCodingTools` with `noExtensions: true`, so MCP tools aren't available by default either — engine.ts:236-244, loader config lines 248-256.)
- Fix: Remove the MCP-tools-by-name claim; state that only the seven built-in tools can be listed and MCP tools are not selectable for subagents.

### [P2] Project discovery described as `<cwd>/...` instead of walk-up
- Claim (Discovery Paths table, lines 48-51): `<cwd>/.pizzapi/agents/` and `<cwd>/.claude/agents/` for project-local.
- Reality: Project agents use a walk-up search from cwd, stopping at the first ancestor level that has either `.pizzapi/agents/` or `.claude/agents/` (`findNearestProjectAgentsDirs`, packages/cli/src/extensions/subagent-agents.ts:155-173). The sibling subagents.mdx correctly says "walk-up search from cwd". Using only `<cwd>` understates behavior and can mislead users with monorepo layouts.
- Fix: Say "walk-up from cwd" and note the search stops at the nearest level containing an agents dir.

### [P2] `agentScope` section omits precedence and the headless fail-closed rule
- Claim (lines 69-73): `user`/`project`/`both` simply control "which directories are searched"; no precedence or security behavior stated.
- Reality: Within a scope `.pizzapi` is checked before `.claude` (first-name-wins); in `both`, project agents override user agents by name; built-in `task` is lowest priority (packages/cli/src/extensions/subagent-agents.ts:249-271). Additionally, when `agentScope` is `project`/`both` and `confirmProjectAgents` is true (default), headless/runner contexts with no UI **refuse to run** project agents (`Refused: project-local agents ... require confirmation but no UI is available` — packages/cli/src/extensions/subagent/index.ts:178-200). This is a critical operational detail for runner users.
- Fix: Add a precedence bullet (`.pizzapi` before `.claude`; project overrides user; built-in lowest) and document the headless fail-closed behavior + `confirmProjectAgents: false` escape hatch.

### [P2] `spawn_session` framed as a way to "invoke agent definitions"
- Claim (lines ~107-118, "Using Agents — spawn_session (background, async)"): listed under "There are two ways to invoke agent definitions" with example `{ "prompt": "..." }`.
- Reality: `spawn_session` has no `agent` parameter and does not load agent definition files; it takes only `prompt`, `model`, `cwd`, `runnerId` (packages/cli/src/extensions/spawn-session.ts:72-118). The sibling subagents.mdx comparison table correctly marks `spawn_session` as "Prompt-based (inline in spawn call)" vs subagent's "File-based". Framing it as an agent-definition invocation path is misleading.
- Fix: Move `spawn_session` out of the "invoke agent definitions" framing, or explicitly note it does not use agent definition files (prompt-only).

### [P2] Agent-name validation omits dots and length cap
- Claim (line ~243): "only alphanumeric characters, hyphens, and underscores are allowed."
- Reality: `isValidSkillName` regex is `/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/` — dots are allowed (e.g. `my.agent`), and length is capped at 64 characters (packages/server/src/validation.ts:10-21). The statement is a partial truth.
- Fix: "alphanumeric, hyphens, underscores, and dot-separated segments; max 64 chars."

### [P3] "Omitting `tools:` gives the agent access to ALL tools" is loose
- Claim (line ~86): "Omitting `tools:` gives the agent access to ALL tools"
- Reality: Omitting `tools:` yields `createCodingTools(sessionCwd)` with `noExtensions: true, noSkills: true` (packages/cli/src/extensions/subagent/engine.ts:236-256) — i.e. the built-in coding toolset, not MCP/extension/skill tools. "ALL tools" overstates this.
- Fix: "Omitting `tools:` gives the agent the default coding toolset (bash, read, write, edit, grep, find, ls). MCP/extension tools are not available to subagents."

### [P3] Duplication and drift with subagents.mdx
- Claim: Frontmatter table, discovery paths, scope, and examples are duplicated across agent-definitions.mdx and subagents.mdx.
- Reality: subagents.mdx links here as the "complete guide" yet carries the *correct*, fuller frontmatter table (with `disallowedTools`/`maxTurns`/`permissionMode`/`background`) and the correct walk-up/precedence/security notes. agent-definitions.mdx is the drifted, inaccurate copy. Two sources of truth guarantee future drift.
- Fix: Make agent-definitions.mdx the single canonical source for frontmatter + discovery, and have subagents.mdx link (not restate). Or vice versa — but pick one.

## Redesign notes
- The page mixes "definition file format" (canonical here) with "using agents" / "spawn_session" / "API" which all belong elsewhere or are covered by subagents.mdx and api.mdx. Consider trimming to: File Format, Frontmatter Fields (full), Discovery Paths (with walk-up + precedence), Tool Restrictions, Built-in `task`, and a single "See also" block. Move the API CRUD section to reference/api.mdx (where other runner endpoints live) to avoid a third source of truth.
- The Frontmatter table is the most important content and is the part that's wrong; lead with it and keep it in sync with `AgentConfig` (subagent-agents.ts:33-52).
- Replace the example model IDs (`claude-sonnet-4-20250514`) which are stale; show alias + slash forms (`sonnet`, `anthropic/claude-haiku-4-5`, `inherit`) since those are what `parseModelString` actually documents.

## Code UX opportunities
- `provider` frontmatter is silently ignored — either support it (set model.provider from frontmatter) or warn on unknown frontmatter keys so users discover the mistake instead of debugging silently. (packages/cli/src/extensions/subagent-agents.ts:120-147)
- `resolveTools` is fail-closed with no path to use MCP tools; if MCP support is intentionally absent for subagents, surface that in the tool's own description so agents don't attempt `mcp__...` names. (packages/cli/src/extensions/subagent/engine.ts:21-46)
- Headless fail-closed for project agents returns a hard refusal; the error text could point at the exact config key (`confirmProjectAgents: false`) and the agent dir it found, so users can resolve without reading source. (packages/cli/src/extensions/subagent/index.ts:189-199)
- `isValidSkillName` allows dots but the API error just says "Invalid agent name"; returning the actual allowed-character rule would help. (packages/server/src/routes/runners.ts:838,858,875,889)
