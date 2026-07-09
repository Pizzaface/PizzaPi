# Audit: customization/subagents.mdx
Verdict: MAJOR ISSUES
Claims checked: 22 | Failed: 7

## Findings

### [P1] "Built-in agents | PizzaPi: None (define your own)" is factually wrong
- Claim (line ~232, Claude Code compatibility differences table): `| **Built-in agents** | \`general-purpose\`, \`Explore\`, \`Plan\` | None (define your own) |`
- Reality: PizzaPi has a real built-in agent: `BUILTIN_AGENTS = [{ name: "task", ... }]`, always available in every scope and overriding-able by user/project (packages/cli/src/extensions/subagent-agents.ts:60-76, :270, :330-373; system prompt confirms it: "A built-in `task` agent is always available" — packages/cli/src/config/system-prompt.precompiled.ts:55). The sibling page agent-definitions.mdx documents this `task` agent.
- Fix: Change the PizzaPi cell to "`task` (general-purpose)".

### [P2] "Built-in agents" section mislabels bundled sample files and omits the real built-in
- Claim (line 101): "PizzaPi ships with three default agents in `packages/cli/agents/`. Copy them to `~/.pizzapi/agents/` to use them:" (heading "Built-in agents")
- Reality: `packages/cli/agents/{researcher,reviewer,refactorer}.md` are sample/template files — they are NOT auto-discovered. `discoverAgents()` only loads `~/.pizzapi/agents/`, `~/.claude/agents/`, project `.pizzapi/agents/`, `.claude/agents/`, and plugin `extraUserDirs`; the bundled `packages/cli/agents/` dir is never scanned (packages/cli/src/extensions/subagent-agents.ts:165-265). The only true built-in is `task` (BUILTIN_AGENTS), which this page never mentions.
- Fix: Rename the section to "Bundled example agents" and add a note that the always-available built-in is `task` (see Agent Definitions).

### [P1] "`inherit` to use parent model" is wrong
- Claim (line 81, frontmatter `model` row): "Model override (e.g., `claude-haiku-3`; `inherit` to use parent model)"
- Reality: `parseModelString("inherit")` returns `undefined` (packages/cli/src/extensions/subagent/engine.ts:46-83). With no explicit model, `runSingleAgent` calls `selectLightweightModel()` — "auto-select the cheapest available model" — NOT the parent's model (engine.ts:285-293). There is no code path that inherits the parent session's model.
- Fix: Write "`inherit` or omit → auto-select the cheapest available model (not the parent's model)".

### [P2] Example model `claude-haiku-3` is stale/likely invalid
- Claim (line 81, 134): examples use `model: claude-haiku-3`
- Reality: The alias map resolves `haiku` → `claude-haiku-4-5`, `sonnet` → `claude-sonnet-4-20250514`, `opus` → `claude-opus-4-5` (engine.ts:25-29). A bare `claude-haiku-3` is looked up via `modelRegistry.find("anthropic", "claude-haiku-3")` and, if absent, fails with "Model not found: anthropic/claude-haiku-3" (engine.ts:286-291). No `claude-haiku-3` model is current.
- Fix: Use `model: claude-haiku-4-5` (or the `haiku` alias) in examples.

### [P1] "Linked child sessions do not trigger push notifications" is false by default
- Claim (lines ~280-282, Push notification suppression): "Linked child sessions (spawned via `spawn_session`) **do not trigger push notifications**. Only top-level sessions — those started by a user or the runner daemon directly — send push notifications."
- Reality: Push suppression is per-subscription opt-in, default OFF. `sendPushToUser` skips a child push only `if (isChildSession && sub.suppressChildNotifications)` and the column defaults to 0 (packages/server/src/push.ts:574, :172 `.defaultTo(0)`). The ntfy/native path explicitly "delivers ALL events regardless of `isChildSession`" (push.ts:383-389). `isChildSession` is computed from `linkedParentId` (push-tracker.ts:99-103), but without the subscription preference it still sends. So by default, linked children DO send push notifications.
- Fix: State that child-session push suppression is opt-in per subscription (`suppressChildNotifications`), defaults to off, and that the ntfy/native path never suppresses.

### [P2] Project-agent confirmation omits the headless fail-closed behavior
- Claim (lines ~112-114, Project agent security): "PizzaPi prompts for confirmation before running them (in TUI mode). Set `confirmProjectAgents: false` to skip the prompt."
- Reality: When `confirmProjectAgents` is true and project agents are requested but `!ctx.hasUI` (headless/runner), the tool **fails closed**: "Refused: project-local agents ... require confirmation but no UI is available. Set confirmProjectAgents: false to allow in headless mode." (packages/cli/src/extensions/subagent/index.ts:189-205). The confirmation runs via `ctx.ui.confirm` whenever `ctx.hasUI` (which includes the remote/web UI), not only "TUI mode". The doc never warns runners/headless sessions will refuse project agents.
- Fix: Note the headless fail-closed refusal, and say "whenever a UI is available (TUI or Web)", not just "TUI mode".

### [P3] Heavy duplication with customization/agent-definitions.mdx
- Claim (lines 53-98 vs agent-definitions.mdx): Frontmatter fields table, Agent discovery paths, agentScope/confirmProjectAgents, tool restrictions, and the researcher/reviewer/refactorer examples are restated despite an `<Aside>` pointing readers to Agent Definitions for the "complete guide".
- Reality: agent-definitions.mdx already owns frontmatter fields (incl. the `provider` field, which this page omits), discovery paths, scope table, and the three example agents (agent-definitions.mdx:23-260). Keeping both copies in sync is fragile — the two already disagree (this page lists `disallowedTools`/`maxTurns`/`permissionMode`/`background`; agent-definitions lists `provider`).
- Fix: Replace the duplicated frontmatter/discovery/scope/examples with a one-paragraph summary + link to Agent Definitions; keep only subagent-specific content (modes, streaming, spawn_session comparison).

## Redesign notes
- The page mixes two unrelated topics — the `subagent` tool (its actual subject) and `spawn_session` linking/triggers/push behavior. "Comparison with spawn_session", "Linked Session Triggers", and "Push notification suppression" belong in the cli-reference / multi-agent pages; they bloat this page and duplicate running/runner-daemon.mdx (see prior audit running--runner-daemon.md:38-40). Move spawn_session details out and leave a one-line cross-reference.
- "Built-in agents" should be re-sourced from `BUILTIN_AGENTS` in code (currently only `task`); the bundled `packages/cli/agents/*.md` files are samples and should be documented under "Examples" or "Bundled templates", not "Built-in".
- Document the tool-level `model: { provider, id }` parameter (Comparison table references "model ... via parameter" but the parameter shape is never shown) and the per-task/per-step `model` override, plus the `cwd` parameter — all exist in `SubagentParams` (packages/cli/src/extensions/subagent/index.ts:39-110).
- Note that `maxParallelTasks` (8) and `maxConcurrency` (4) are configurable via `subagent.*` in the global config and that project-local config cannot raise them (subagent/index.ts:131-132, subagent.test.ts:322-344); the doc states them as fixed constants.
- Reconcile the frontmatter field list with agent-definitions.mdx (which adds `provider`); either both list the same fields or this page defers entirely.

## Code UX opportunities
- The misleading "built-in vs sample" split is itself a UX smell: bundled agent files in `packages/cli/agents/` that users must manually copy could instead be shipped as auto-available built-ins (or surfaced via `pizza` init/scaffold), removing the docs confusion entirely.
- `parseModelString` silently treats an unknown bare model id (e.g. `claude-haiku-3`) as `{ provider: "anthropic", id }` and only fails later at registry lookup with a generic "Model not found" — a clearer upfront error naming the registered models would prevent stale-id footguns that produce stale docs.
- `confirmProjectAgents: true` failing closed in headless mode (no UI) with no auto-allow for the runner daemon means orchestrated/headless workflows silently refuse project agents; consider allowing a runner-level trusted-repo allowlist so the runner can use project agents without per-call `confirmProjectAgents: false`.
- Child push suppression being a per-subscription opt-in (default off) while docs imply it is automatic suggests either flipping the default for linked-child sessions or making the toggle prominent in the Web UI — the current behavior surprises users orchestrating many children.
