# Audit: features/plan-mode.mdx
Verdict: MAJOR ISSUES
Claims checked: 34 | Failed: 5

## Findings

### [P1] Execution Tracking described as general, but only happens in the legacy TUI menu path
- Claim (Execution Tracking section): "After a plan is approved, the agent enters execution mode. If the plan had steps, PizzaPi tracks progress: The agent marks steps complete by including [DONE:n] tags ... A checklist of plan steps is displayed ... When all steps are marked done, a Plan Complete! ✓ message appears"
- Reality: `executionMode` is set to `true` and `todoItems` populated ONLY in the `agent_end` legacy TUI menu handler (`packages/cli/src/extensions/plan-mode/extension.ts:439`, `:413`). When a plan is approved via the `plan_mode` tool (the primary web/remote flow), `setPlanModeFromRemote(false)` is called, which runs `setPlanMode(false)` and explicitly sets `executionMode = false` and `todoItems = []` (`extension.ts:117-118`, `remote-plan-mode.ts:548`). The plan's submitted `steps` are never turned into tracked todos in that path. So none of the [DONE:n] tracking / checklist / "Plan Complete!" behavior occurs for `plan_mode`-tool approvals.
- Fix: Restrict the Execution Tracking section to the TUI menu flow, or implement todo tracking for `plan_mode`-tool approvals and then document it.

### [P1] "State persists across resumes" is contradicted by an unconditional reset handler
- Claim (Session Behavior): "State persists across resumes — if you resume a session that was in plan mode, plan mode is restored along with any in-progress execution steps and the sandbox overlay."
- Reality: Two `session_start` handlers are registered. The first restores from persisted entries (`extension.ts:466-510`). The second, registered immediately after, unconditionally resets `planModeEnabled = false`, `executionMode = false`, `todoItems = []`, clears the sandbox overlay, and calls `persistState()` — with no check of `event.reason` (`extension.ts:514-536`). `SessionStartEvent.reason` includes `"resume"` (`packages/cli/src/providers/types.ts:72`), so on a resume the second handler runs after the restore and overwrites it to off. There are no tests covering resume restoration.
- Fix: Either gate the reset handler on `event.reason === "new"`, or correct the doc to state resume does not currently restore plan-mode state.

### [P2] Blocked-tools list omits `subagent` and `spawn_session`
- Claim (What's Blocked / Tool-level blocking): "The following tools are completely blocked while plan mode is active: edit, write, write_file"
- Reality: `WRITE_BLOCKED_TOOL_NAMES = new Set(["edit", "write", "write_file", "subagent", "spawn_session"])` (`packages/cli/src/extensions/plan-mode/patterns.ts:179`). The extension explicitly blocks `subagent`/`spawn_session` with a distinct reason about child contexts having full write access (`extension.ts:238-242`). The web-ui/plan-mode.mdx page mentions "spawning sessions" being blocked; this features page does not.
- Fix: Add `subagent` and `spawn_session` to the blocked-tools list (and note the distinct reason).

### [P2] `respond_to_trigger` call syntax in the multi-agent section is misleading
- Claim (Multi-Agent Plan Review): `respond_to_trigger(triggerId, "approve", { action: "approve" })`, `respond_to_trigger(triggerId, "cancel", { action: "cancel" })`, `respond_to_trigger(triggerId, "Your step 2 should also handle middleware", { action: "edit" })`
- Reality: The tool schema defines `triggerId`, `response`, and `action` as flat sibling parameters, not a nested object (`packages/cli/src/extensions/triggers/extension.ts:271-289`). The built-in system prompt phrases it as "also pass `action`: `"approve"`" (`packages/cli/src/config/templates/system-prompt.hbs:8`). Writing `{ action: "approve" }` as a third positional object is not how the tool is invoked.
- Fix: Show the call as `respond_to_trigger(triggerId, "approve")` or document `action` as a separate parameter, matching the system prompt wording.

### [P3] "any MCP read tools" implies MCP write tools are blocked — they are not
- Claim (What the agent can do): "Use MCP tools that only read data"
- Reality: The `tool_call` handler blocks only `WRITE_BLOCKED_TOOL_NAMES` (`edit`, `write`, `write_file`, `subagent`, `spawn_session`) and destructive `bash` (`extension.ts:227-260`). MCP tools are never inspected for read/write semantics, so MCP write tools are fully allowed in plan mode. The phrasing "MCP read tools" is accurate only in the sense that read MCP tools happen to be safe; it implies a restriction that does not exist.
- Fix: Either state plainly that all MCP tools are allowed regardless of side effects, or note the gap and (ideally) add blocking for non-read MCP tools.

## Redesign notes
- Two pages cover the same feature (`features/plan-mode.mdx` and `web-ui/plan-mode.mdx`) with heavy duplication: activating plan mode, the plan review flow, the four action buttons (table duplicated near-verbatim), parent-child plan reviews + 5-minute timeout, and the "Best practices" section (identical lists). The web-ui page already defers technical details to the features page, but still repeats the action-buttons table, parent-child triggers, and best practices. Consider merging into one page with a "Web UI" subsection, or slimming the web-ui page to only UI-specific details (panel layout, status pills, plan cards) and linking out for everything else.
- "Execution Tracking" is awkwardly split: general-sounding prose that actually only applies to the TUI legacy menu, followed by the TUI menu description. Restructure so it is clearly scoped to the TUI agent_end menu, and explicitly state that `plan_mode`-tool approvals do not currently track step progress.
- The bash restrictions section lists patterns as if always applied, then the sandbox Aside clarifies the OS overlay. It would be clearer to state up front that in sandbox mode only non-filesystem patterns (sudo/kill/systemctl/network mutations) are checked, and the filesystem patterns (rm/mv/redirection/interpreters) are enforced by the OS overlay.
- "Three ways to enter plan mode" lists `/plan` slash and "Web UI remote command: Send /plan" as separate methods, but they are the same mechanism (`slash-commands.ts:850-851` routes `/plan` to `set_plan_mode`). Collapse to two.

## Code UX opportunities
- Unify execution tracking: when a `plan_mode` plan with steps is approved, set `executionMode = true` and seed `todoItems` from the submitted `steps` (currently only the legacy TUI menu does this, in `extension.ts:413,439`). This would make the documented [DONE:n]/checklist/"Plan Complete!" behavior real for the primary web flow.
- Fix the resume handler: the second `session_start` handler should check `event.reason === "new"` before resetting, so resume actually restores plan mode + sandbox overlay as the doc claims (`extension.ts:514`).
- Consider blocking non-read MCP tools in plan mode (or surfacing them as a warning), since the doc implies they are restricted but they are not.
- The `plan_mode` tool returns different result text for the TUI free-text fallback vs. structured actions; the doc could note that typing free text in the TUI is treated as an edit suggestion (`remote-plan-mode.ts:~360-380`), which is a nice UX detail worth documenting precisely.
