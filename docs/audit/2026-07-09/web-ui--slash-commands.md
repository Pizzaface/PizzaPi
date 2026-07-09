# Audit: web-ui/slash-commands.mdx
Verdict: MINOR ISSUES
Claims checked: 34 | Failed: 7

## Findings

### [P2] `/re` filter example is factually wrong
- Claim (line 12): "For example, `/re` filters to `/resume`."
- Reality: `commandSuggestions` uses `name.toLowerCase().includes(query)` over `supportedWebCommands`; query `re` matches both `resume` AND `rewind` (slash-commands.ts:248-252). Typing `/re` shows two entries, not one.
- Fix: Change the example to `/res` (matches only `resume`) or `/mo` (matches only `model`).

### [P2] `/goal` flags omit `--every` (and `--evaluator`/`--keyword`)
- Claim (line 41): "`/goal "{condition}" [flags]` | Set a success condition and optional budget (`--max-turns`, `--max-tokens`, `--max-cost`)."
- Reality: The goal parser supports `--max-turns`, `--max-tokens`, `--max-cost`, `--evaluator`, `--keyword`, and `--every` (packages/cli/src/extensions/goal/parser.ts:13-18, 110-133). The web picker's own goal description string even advertises `[--every N]` (slash-commands.ts supportedWebCommands `goal` entry).
- Fix: List all six flags, or at minimum add `--every N` (LLM evaluator cadence) and `--evaluator keyword|llm` / `--keyword {word}`.

### [P2] `/sandbox` sub-commands undocumented
- Claim (line 48): "`/sandbox` | Show current sandbox status (mode, platform, recent violations) if a runner is connected."
- Reality: The sandbox extension registers subcommands `status` (default), `violations`, and `config` (packages/cli/src/extensions/sandbox-events.ts:15,48-65), and the web picker exposes them via `supportedWebCommands` `sandbox.subCommands` (slash-commands.ts). Typing `/sandbox ` enters sub-command mode showing all three.
- Fix: Document `/sandbox status`, `/sandbox violations`, and `/sandbox config`, mirroring the `/mcp` sub-command table.

### [P2] `/goal status` sub-command undocumented; sub-command mode covers more than `/mcp`
- Claim (line 39-42): Lists `/goal` (show), `/goal "{condition}"`, `/goal clear`, but no `/goal status`.
- Reality: `supportedWebCommands` for `goal` defines subCommands `status` and `clear` (slash-commands.ts), and the CLI parser treats both bare `/goal` and `/goal status` as `statusOnly` (parser.ts:73,82). The "Sub-command mode" section (line 56) only mentions `/mcp`, but `/sandbox` and `/goal` also enter sub-command mode.
- Fix: Add `/goal status` and mention that sub-command mode applies to `/mcp`, `/sandbox`, and `/goal` (plus extension commands with completions).

### [P2] Sub-command mode does NOT apply to skill commands
- Claim (line 60): "This also applies to plugin-provided extension commands and skill commands — any command that defines its own sub-command structure."
- Reality: `subCommandsByName` is built only from `supportedWebCommands` and `extensionCommands` (those with `completions`); `skillCommands` are never added (slash-commands.ts subCommandsByName useMemo). Skill commands never enter sub-command mode.
- Fix: Drop "and skill commands" — sub-command mode applies to built-in commands and extension/plugin commands that declare completions, not skills.

### [P3] `/remote` (a real, web-blocked command) is undocumented
- Claim: The "Core commands" table omits `/remote`; only the notes imply runner-only commands.
- Reality: `/remote` is a registered CLI command with `stop`/`reconnect` subcommands (packages/cli/src/extensions/remote/lifecycle-handlers.ts:565-600). The web UI intentionally blocks it with a "isn't available from the web UI" message (slash-commands.ts `rawCommand === "remote"` branch) and excludes it from extension commands via `webHandledCommands`.
- Fix: Add a short note (e.g. under Notes & limitations) that `/remote` is intentionally blocked in the web UI because it would sever the relay connection.

### [P3] `/agents` with no name only opens the picker via the selection path, not via typing+Enter
- Claim (line 46): "`/agents [name]` | Without a name, opens a picker showing available agents from the runner."
- Reality: Selecting `/agents` from the popover keeps it open (`keepPopoverOpenNames` includes `agents`) and `isAgentMode` renders the agent picker. But typing `/agents` and pressing Enter calls `executeSlashCommand`, which in the no-args branch runs `setCommandOpen(false)` and does nothing — no agent picker appears (slash-commands.ts `rawCommand === "agents"` branch).
- Fix: Document that you must select `/agents` from the picker (or type `/agents ` with a trailing space) to open the agent list; or fix the code to keep the picker open on bare `/agents`.

### [P3] Picker group headings not stated; "grouped by type" is vague
- Claim (line 8): "The picker shows a scrollable list of available commands, grouped by type."
- Reality: The rendered `CommandGroup` headings are exactly `Commands`, `Plugin Commands`, `Prompt Templates`, and `Skills` (SessionViewer.tsx:1230,1243,1265,1282). The features doc calls the second group "Extensions" — a mismatch.
- Fix: Name the four groups explicitly so users can map docs to the UI.

### [P3] Duplication with features/slash-commands.mdx — should merge
- Claim: Both `web-ui/slash-commands.mdx` and `features/slash-commands.mdx` are slash-command references for the web UI (the features page subtitle: "Complete reference for all / commands available in the PizzaPi web UI chat input").
- Reality: They overlap heavily on `/new`, `/resume`, `/stop`, `/restart`, `/model`, `/cycle_model`, `/effort`, `/cycle_effort`, `/compact`, `/plan`, `/name`, `/goal`, `/copy`, `/plugins`, `/skills`, `/sandbox`, `/mcp`, `/agents` but DISAGREE: the features page lists `/session`, `/tree`, `/reload`, `/export`, `/share`, `/login`, `/logout` which are NOT exposed by the runner's `getCommands()` (only extension-registered commands, prompt templates, and skills are sent — pi-coding-agent dist/core/agent-session.js:1748-1764), so they do not appear in the web UI picker. The features page also describes `/fork` as a standalone "fork into a new session file" while the web-ui page treats `/fork` as an alias of `/rewind` — a direct contradiction. Features page goal flags add `--evaluator`/`--keyword` but still omit `--every`.
- Fix: Merge into a single canonical page (keep `web-ui/slash-commands.mdx` as the web UI source of truth); delete or redirect `features/slash-commands.mdx`, or clearly partition TUI-only vs web-UI commands. Reconcile the `/fork` vs `/rewind` contradiction.

### [P3] Overlap with customization/prompt-templates.mdx
- Claim: prompt-templates.mdx has a "Web UI Integration" section re-describing the picker groups and pre-fill behavior.
- Reality: That section (groups "Built-in commands / Extension commands / Prompt Templates / Skills", pre-fill with `/<name> ` trailing space) duplicates the "Prompt template commands" subsection here and the picker-group behavior. The pre-fill claim is accurate (SessionViewer.tsx promptSuggestions onSelect sets `/${cmd.name} ` and focuses).
- Fix: Keep template authoring/format/arguments in prompt-templates.mdx; link to slash-commands.mdx for picker mechanics instead of re-listing groups.

## Redesign notes
- Consolidate the two slash-command pages into one canonical reference; the features page is the less-accurate superset and contradicts the web-ui page on `/fork` vs `/rewind` and on which commands exist in the web UI.
- Replace the single "Core commands" mega-table with grouped subsections (Session / Model & reasoning / Context & planning / Display / Introspection / MCP / Agents) matching the features page structure, so sub-commands (`/mcp`, `/sandbox`, `/goal`) sit naturally under their parent.
- State the exact picker group headings (`Commands`, `Plugin Commands`, `Prompt Templates`, `Skills`) once up front and reference them by name thereafter.
- Add a "Command availability" column or badges (web-UI-handled vs runner-forwarded vs requires-runner vs blocked) so users know which commands need a connected runner and which are intentionally unavailable (`/remote`).
- Document the full `/goal` flag set and all `/sandbox` sub-commands in a shared sub-command table format.

## Code UX opportunities
- `executeSlashCommand` for bare `/agents` (no args) closes the picker instead of opening the agent list; it should keep the popover open / set `isAgentMode` so typing `/agents`+Enter behaves like selecting `/agents` from the picker.
- `/rewind`+Enter with no exact match silently keeps the picker open with no feedback; a hint ("select a message below") would help when `rewindCandidates` is empty.
- `/skills` and `/plugins` show different "runner not connected" messages ("Runner not connected yet. Try again in a moment.") while `/sandbox`/`/agents` have their own variants — unify the disconnected-runner copy across commands.
- `/remote` is blocked with a one-line message but never appears in the picker and isn't documented; consider either surfacing it as a disabled/greyed picker entry with the explanation, or documenting it so users aren't surprised it's missing.
- Skill commands are excluded from sub-command mode (`subCommandsByName`) even though `CmdEntry` supports `completions`; if skills ever declare completions they'd be silently ignored — either wire them in or document the limitation.
