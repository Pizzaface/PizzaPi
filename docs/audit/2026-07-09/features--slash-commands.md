# Audit: features/slash-commands.mdx

Verdict: BROKEN
Claims checked: 32 | Failed: 11

## Findings

### [P1] `/tree` is documented as a web UI command but does not exist in the web UI
- Claim (line ~52): "`/tree` | Open tree-based session navigator. Browse all branches, jump to any point in the conversation, and optionally summarize the branch you're leaving."
- Reality: `/tree` is not in the web UI's `supportedWebCommands` list (`packages/ui/src/components/session-viewer/slash-commands.ts:145-185`) nor in `webHandledCommands` (`slash-commands.ts:130-141`). `executeSlashCommand` returns `false` for it (`slash-commands.ts:~end of executeSlashCommand`), so `handleSubmit` forwards it as a raw user message via `onSendInput` (`packages/ui/src/components/SessionViewer.tsx:520`). The PizzaPi runner runs pi in RPC mode, where the `prompt` command calls `session.prompt(message)` directly (`node_modules/.../pi-coding-agent/dist/modes/rpc/rpc-mode.js:299`) — there is no interactive input loop to parse `/tree`. The tree navigator is a TUI-only feature. The command is sent to the model as plain text and will not open any navigator.
- Fix: Remove `/tree` from this page (or explicitly mark it TUI-only and unsupported in the web UI).

### [P1] `/rewind` (the actual picker command) is never documented; `/fork` is described as a distinct command
- Claim (line ~58): "`/fork` | Fork the current session into a new session file. Opens a selector to choose a point..."
- Reality: The web UI picker command is `rewind` (`slash-commands.ts:152`, description "Rewind the conversation to a previous message"); `isRewindMode` matches `rewind|fork` as aliases (`slash-commands.ts:~isRewindMode`). The picker heading is "Rewind to message (forks the session)" (`SessionViewer.tsx:1157`). The features page never mentions `/rewind`, so a user seeing `/rewind` in the picker finds no documentation, and the description of `/fork` omits that the composer is pre-filled with the rewound message for editing (`rewindToMessage` in `slash-commands.ts`).
- Fix: Document `/rewind` as the primary command with `/fork` as an alias, matching `web-ui/slash-commands.mdx`.

### [P1] `/export`, `/share`, `/session`, `/login`, `/logout`, `/reload` are documented as working web UI commands but are not handled
- Claim (lines ~40, ~78-84, ~92, ~118): `/session` "Show session info", `/export [file]` "Export the current session to an HTML file", `/share` "Upload as a private GitHub gist", `/login` "Opens an OAuth flow", `/logout` "Clear stored credentials", `/reload` "Reload keybindings, extensions...".
- Reality: None of these names appear in `supportedWebCommands` (`slash-commands.ts:145-185`). They fall through `executeSlashCommand` → `onSendInput` → runner RPC `prompt` → `session.prompt(message)` (`rpc-mode.js:299`), i.e. they are sent to the model as user text, not executed. RPC mode has explicit command types (`export_html`, `switch_session`, etc.) but no text-slash dispatch; `export_html` is even stubbed: `"export_html is not implemented for remote exec yet"` (`packages/cli/src/extensions/remote-exec-handler.ts:513-514`). The sibling page `web-ui/slash-commands.mdx` deliberately omits all of these, confirming they are not web-UI-functional.
- Fix: Remove these six commands from the features page, or clearly state they are TUI-only / not yet available in the web UI.

### [P2] `/goal` flags omit `--every`
- Claim (line ~72): "Flags: `--max-turns`, `--max-tokens`, `--max-cost`, `--evaluator keyword|llm`, `--keyword {word}`."
- Reality: The parser's `KNOWN_FLAGS` also includes `--every` (`packages/cli/src/extensions/goal/parser.ts:14-21`, handled at `parser.ts:~case "--every"`). The goal command's own description string in the web UI even advertises it: `--every N` (`slash-commands.ts` goal entry).
- Fix: Add `--every N` to the flags list (throttle LLM evaluator frequency).

### [P2] Command picker group names are wrong
- Claim (line ~10): groups are "Commands — built-in session and UI commands", "Extensions — commands registered by Claude Code plugins", "Prompts — prompt template shortcuts", "Skills — skill-based commands".
- Reality: The rendered `CommandGroup` headings are "Commands", "Plugin Commands", "Prompt Templates", "Skills" (`packages/ui/src/components/SessionViewer.tsx:1225, 1243, 1266, 1283`). "Extensions" and "Prompts" do not match.
- Fix: Rename to "Plugin Commands" and "Prompt Templates" (or align code headings to the docs).

### [P2] `/reload` description mentions "context files" instead of "themes"
- Claim (line ~66): "`/reload` | Reload keybindings, extensions, skills, prompt templates, and context files without restarting."
- Reality: Upstream builtin says "Reload keybindings, extensions, skills, prompts, and themes" (`node_modules/.../pi-coding-agent/dist/core/slash-commands.js:23`). "context files" is not part of the reload scope; "themes" is omitted. (Additionally `/reload` is not handled by the web UI — see P1 above.)
- Fix: Align the description with the upstream wording (and remove if not web-UI-functional).

### [P2] Three overlapping slash-command pages with inconsistent command lists
- Claim: This page, `web-ui/slash-commands.mdx`, and `customization/prompt-templates.mdx` all describe the slash command picker.
- Reality: `web-ui/slash-commands.mdx` lists `/rewind` (alias `/fork`) and omits `/tree`, `/export`, `/share`, `/login`, `/logout`, `/reload`, `/session`; this `features/` page does the opposite. The two pages also disagree on `/goal` flags (`web-ui` lists only the three `--max-*`; this page adds `--evaluator`/`--keyword`). `customization/prompt-templates.mdx` re-describes the picker groups ("Built-in commands / Extension commands / Prompt Templates / Skills") with yet another group naming.
- Fix: Merge into a single canonical slash-commands reference (likely keep `web-ui/slash-commands.mdx`, which is the accurate one) and have the others cross-link.

### [P3] `/mo` example is inaccurate
- Claim (line ~15): "For example, typing `/mo` narrows the list to `/model`."
- Reality: Filtering is a substring `includes` match on the command name (`slash-commands.ts` `commandSuggestions`). "mo" matches both `model` and `cycle_model`.
- Fix: Use an example that uniquely matches (e.g. `/res` → `/resume`) or state it narrows to `/model` and `/cycle_model`.

### [P3] `/sandbox` sub-commands are undocumented
- Claim (line ~110): "`/sandbox` | Show the current sandbox status — mode (none/basic/full), platform, and recent violations."
- Reality: `supportedWebCommands` defines `/sandbox` with sub-commands `status`, `violations`, `config` (`slash-commands.ts` sandbox entry), and sub-command mode displays them (`SessionViewer.tsx:1197`). Only the default `status` behavior is described.
- Fix: Document `/sandbox violations` and `/sandbox config` (or note sub-commands exist), consistent with how `/mcp` is documented.

### [P3] "Complete reference" overstates scope
- Claim (description frontmatter): "Complete reference for all / commands available in the PizzaPi web UI chat input."
- Reality: The page omits the actual `/rewind` command and includes several non-functional commands (see P1 findings), so it is neither complete nor accurate.
- Fix: Drop "Complete" or make the page actually complete and accurate.

## Redesign notes
- Collapse `features/slash-commands.mdx`, `web-ui/slash-commands.mdx`, and the picker section of `customization/prompt-templates.mdx` into one source of truth; have the others link to it. The `web-ui/` page is currently the most accurate and should be the base.
- Drive the documented command list from `supportedWebCommands` in `slash-commands.ts` so docs and code cannot drift (consider a generated table).
- Clearly separate "web-UI-native" commands (handled in `executeSlashCommand`) from "forwarded to runner" commands, and only document the former as web UI commands.
- Reconcile `/goal` flag lists across pages with `parser.ts` `KNOWN_FLAGS`.

## Code UX opportunities
- `executeSlashCommand` silently returns `false` for unhandled `/`-prefixed text, causing `handleSubmit` to send commands like `/export` or `/tree` to the model as user messages (`SessionViewer.tsx:520`). Surfacing a "unknown command" hint (or warning that the text will be sent to the model) would prevent user confusion.
- `export_html` is stubbed as "not implemented for remote exec yet" (`remote-exec-handler.ts:513-514`); either implement it or remove `/export` from discoverability so the docs/code gap closes from the code side.
- The picker shows `/rewind` but the code comment calls it "the TUI name for the same rewind flow" (`slash-commands.ts:~isRewindMode`) — consider also accepting `/fork` prominently or aligning the displayed name to reduce doc/picker mismatch.
