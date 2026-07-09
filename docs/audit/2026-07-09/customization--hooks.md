# Audit: customization/hooks.mdx
Verdict: MAJOR ISSUES
Claims checked: 34 | Failed: 9

## Findings

### [P2] Hook Events table omits two fully-implemented events (TurnEnd, SessionStart)
- Claim (line ~38, Hook Events table): The table lists 11 events: PreToolUse, PostToolUse, Input, BeforeAgentStart, UserBash, SessionBeforeSwitch, SessionBeforeFork, SessionShutdown, SessionBeforeCompact, SessionBeforeTree, ModelSelect.
- Reality: `HooksConfig` defines 13 event keys, including `TurnEnd?: HookEntry[]` and `SessionStart?: HookEntry[]`, both fully wired in `createHooksExtension` (`pi.on("turn_end", ...)` and `pi.on("session_start", ...)`). (packages/cli/src/config/types.ts:85, :112; packages/cli/src/extensions/hooks/extension.ts:29, :38, :310-336, :351-378)
- Fix: Add `TurnEnd` ("After each agent turn, fire-and-forget, no block, no matchers") and `SessionStart` ("On session start/reload/new/resume/fork, fire-and-forget, no block, no matchers") rows to the table.

### [P2] Project hooks are not "silently ignored" — a warning is emitted
- Claim (line ~20, table note and Aside): "Project-local hooks (`.pizzapi/config.json`) are **silently ignored** unless you set `allowProjectHooks: true`". Repeated in the "Project Hooks Trust Model" section ("silently ignored by default").
- Reality: When `project.hooks` exists but is untrusted, `loadConfig` calls `warnLoadConfigOnce(projectPath, "project-hooks-untrusted", 'Set "allowProjectHooks": true ...')`, producing a visible config-load warning — not silent. (packages/cli/src/config/io.ts:99-100, :141-150)
- Fix: Replace "silently ignored" with "ignored (a one-time warning is emitted pointing at the trust gate)".

### [P2] Exit-code table overgeneralizes fail-closed behavior
- Claim (line ~70, Exit codes table): "`Other non-zero` → **Error** — treated as a block (fail-closed for safety)."
- Reality: Fail-closed only applies to PreToolUse and cancelable event hooks via `runEventHooks`. PostToolUse explicitly ignores killed/errored hooks ("tool already ran, can't undo"). BeforeAgentStart calls `runEventHooks` but discards `blocked` ("BeforeAgentStart doesn't support blocking — just log"). Fire-and-forget events (SessionShutdown, ModelSelect, TurnEnd, SessionStart) ignore exit codes entirely via `runFireAndForgetHooks`. (packages/cli/src/extensions/hooks/extension.ts:130-135, :196-200; packages/cli/src/extensions/hooks/events.ts:62-77)
- Fix: Add a note that PostToolUse, BeforeAgentStart, and fire-and-forget events (SessionShutdown, ModelSelect, TurnEnd, SessionStart) do not fail-closed; only PreToolUse and the cancelable session/Input/UserBash hooks block on non-zero.

### [P2] BeforeAgentStart "Can block?" cell is misleading
- Claim (line ~38, Hook Events table): BeforeAgentStart's "Can block?" cell reads "Can override system prompt" rather than Yes/No.
- Reality: BeforeAgentStart cannot block. The handler runs `runEventHooks` but explicitly ignores the `blocked` flag ("BeforeAgentStart doesn't support blocking — just log"). (packages/cli/src/extensions/hooks/extension.ts:196-200)
- Fix: Set the cell to "No" and move "Can override system prompt" into the "When it fires" / a notes column.

### [P2] Stdout JSON fields table omits `updatedInput` (PreToolUse rewrite)
- Claim (line ~83, Stdout JSON fields table): Lists additionalContext, permissionDecision, text, action, systemPrompt.
- Reality: `HookOutput` also defines `updatedInput?: Record<string, unknown>`, used by PreToolUse to mutate `event.input` in place (e.g. RTK command rewrite). This is a real, implemented feature the docs never mention. (packages/cli/src/extensions/hooks/types.ts:35-37; packages/cli/src/extensions/hooks/extension.ts:96-104; packages/cli/src/extensions/hooks/runner.ts:155)
- Fix: Add a row: `updatedInput` | PreToolUse | Object replacing tool_input fields (rewrites tool args before execution).

### [P2] `permissionDecision: "ask"` is documented but has no behavioral effect
- Claim (line ~83, Stdout JSON fields table): `permissionDecision` accepts `"allow"`, `"deny"`, or `"ask"`.
- Reality: The PreToolUse handler only branches on `output?.permissionDecision === "deny"`; `"ask"` and `"allow"` fall through identically (no prompt/escalation). (packages/cli/src/extensions/hooks/extension.ts:90-94)
- Fix: Either document that only `"deny"` currently has effect (with `"ask"` reserved/future), or remove `"ask"` from the documented set.

### [P2] Example 1 misrepresents what the hook does and fabricates the RTK acronym
- Claim (line ~159): "### 1. RTK Token Optimization (PreToolUse) — Rewrites Bash commands through an RTK (Read-Transform-Keep) compressor to reduce token usage in tool responses".
- Reality: The shown hook only emits `additionalContext` (an advisory suggestion) and never rewrites the command; actual rewriting would require `updatedInput`. The "Read-Transform-Keep" expansion of RTK is unsupported — the project's own AGENTS.md describes RTK only as a globally-installed token-reduction tool with no acronym expansion. (packages/cli/src/extensions/hooks/extension.ts:96-110; project AGENTS.md `rtk-token-optimization` rule)
- Fix: Reword the example as "Advisory RTK suggestion" (not "Rewrites"), and drop the fabricated "Read-Transform-Keep" expansion; or show a real `updatedInput`-based rewrite.

### [P3] Plugin hook discovery is broader than "hooks/hooks.json"
- Claim (line ~151): "Claude Code plugins can bundle hooks in a `hooks/hooks.json` file. PizzaPi's plugin adapter automatically discovers these..."
- Reality: `parseHooks` reads the entire `hooks/` directory and merges every `*.json` file inside it (not just `hooks.json`); symlinks and non-regular files are skipped. (packages/cli/src/plugins/parse.ts:238-289)
- Fix: Say "one or more `*.json` files in a `hooks/` directory (e.g. `hooks/hooks.json`)".

### [P3] PostToolUse example payload shows an implausible `command` field for Write
- Claim (line ~108): PostToolUse example shows `"tool_name": "Write", "tool_input": { "command": "...", "file_path": "src/index.ts" }`.
- Reality: The Write tool's input has no `command` field; `normalizeToolInput` only aliases `path`↔`file_path`. Showing `command` for a Write call is misleading. (packages/cli/src/extensions/hooks/matcher.ts:62-75)
- Fix: Drop the `"command": "..."` key from the Write example, or use a Bash example for PostToolUse.

## Redesign notes
- The Hook Events table is the single most valuable reference on the page; it must be exhaustive. Two whole events (TurnEnd, SessionStart) are missing, and the "Can block?" column mixes Yes/No with a free-text override note for BeforeAgentStart — split blocking and side-effects into separate columns.
- The exit-code semantics are event-dependent; a single global table is inherently lossy. Consider per-event exit-code semantics, or annotate the table with which events honor fail-closed.
- The "Stdout JSON fields" table should be generated from `HookOutput` (types.ts) so it stays in sync; `updatedInput` and `decision` are currently undocumented.
- "silently ignored" is stated three times; reconcile with the actual warning behavior, and consolidate the trust-model explanation (currently split across the table Aside, a dedicated section, and a closing Aside) into one place to reduce duplication.
- Example 1 is the first thing users copy; it should illustrate a real, working mechanism (`updatedInput` rewrite or a true block), not an advisory that the prose claims "rewrites".

## Code UX opportunities
- BeforeAgentStart runs `runEventHooks` (which returns `blocked`) and then discards `blocked` — this is confusing and wasteful; either support blocking or use a fire-and-forget runner to signal intent. (extension.ts:182-220)
- `permissionDecision: "ask"` is parsed and typed but does nothing, inviting user confusion; either implement an "ask" path (escalate to viewer) or remove it from the type. (types.ts:18, extension.ts:90-94)
- PostToolUse / fire-and-forget hooks swallow all errors silently; a debug log (gated behind a verbose flag) would help users diagnose why their hook "didn't run". (extension.ts:130-135, events.ts:62-77)
- The fail-closed vs. fire-and-forget distinction is encoded only in which runner function is called; surfacing it in the `HooksConfig` type (e.g. a doc comment per event noting "exit code ignored") would keep the docs honest without code changes. (types.ts:27-114)
