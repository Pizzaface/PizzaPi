# Audit: features/sessions.mdx
Verdict: MAJOR ISSUES
Claims checked: 42 | Failed: 11

## Findings

### [P1] Session storage path is wrong for PizzaPi
- Claim (line ~16): "Sessions auto-save as JSONL files under `~/.pi/agent/sessions/`, organized by working directory."
- Reality: PizzaPi patches `getAgentDir()` to return `~/.pizzapi/` (flat, no `/agent/`), so the default session dir is `~/.pizzapi/sessions/<encoded-cwd>/`. `getDefaultSessionDirPath` joins `agentDir` (= `~/.pizzapi`) + `sessions` (config.js:416-422, session-manager.js:8,221-228). Patches.test.ts:121-138 asserts CONFIG_DIR_NAME=".pizzapi" and flat structure. migrations.ts:36 even migrates `~/.pi/agent` → `~/.pizzapi`.
- Fix: Replace `~/.pi/agent/sessions/` with `~/.pizzapi/sessions/` everywhere on this page.

### [P1] Custom session directory default path is wrong
- Claim (line ~150): "Priority: `--session-dir` CLI flag → `sessionDir` in settings → default (`~/.pi/agent/sessions/`)."
- Reality: Default is `~/.pizzapi/sessions/<encoded-cwd>/` (see above). Also the precedence omits the `PI_CODING_AGENT_SESSION_DIR` env var (`ENV_SESSION_DIR`, config.js:402-403), which sits between the flag and settings: `parsed.sessionDir ?? envSessionDir ?? settings.sessionDir` (main.js:448-451).
- Fix: Default `~/.pizzapi/sessions/`; add `PI_CODING_AGENT_SESSION_DIR` to the precedence chain.

### [P1] Compaction settings file paths are wrong
- Claim (line ~95): "Configure in `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project)"
- Reality: Global settings live at `~/.pizzapi/settings.json` and project settings at `<cwd>/.pizzapi/settings.json` — `getSettingsPath()` = `agentDir/settings.json` (config.js:438) and `FileSettingsStorage` uses `join(cwd, CONFIG_DIR_NAME, "settings.json")` where CONFIG_DIR_NAME=".pizzapi" (settings-manager.js:49-50). PizzaPi config/io.ts:338 also reads `~/.pizzapi/settings.json`.
- Fix: Use `~/.pizzapi/settings.json` (global) and `.pizzapi/settings.json` (project).

### [P1] Context-file locations are wrong; "both conventions work" is false
- Claim (Context Files table + Aside): AGENTS.md/CLAUDE.md at `~/.pi/agent/`, SYSTEM.md at `.pi/SYSTEM.md` or `~/.pi/agent/SYSTEM.md`; Aside says "pi's context file discovery still checks `~/.pi/agent/` and `.pi/` paths. Both conventions work."
- Reality: Global context files load from `agentDir` = `~/.pizzapi/` (resource-loader.js:51-55, getAgentDir→`~/.pizzapi`). SYSTEM.md/APPEND_SYSTEM.md project path is `cwd/.pizzapi/...` and global is `agentDir/...` = `~/.pizzapi/...` (resource-loader.js:752-767, CONFIG_DIR_NAME=".pizzapi"). `.pi/` is never checked. The Aside is actively false.
- Fix: Replace all `~/.pi/agent/` → `~/.pizzapi/` and `.pi/` → `.pizzapi/`; delete or rewrite the Aside.

### [P2] `retry.maxDelayMs` is a legacy migrated field, not a current setting
- Claim (Retry table): "`retry.maxDelayMs` | `60000` | Max delay before failing (prevents multi-hour waits)"
- Reality: `RetrySettings` has no `maxDelayMs` field; the cap is `retry.provider.maxRetryDelayMs` (default 60000) (settings-manager.d.ts:9-14, settings-manager.js:574-575). `retry.maxDelayMs` is migrated to `retry.provider.maxRetryDelayMs` and then deleted on load (settings-manager.js:223-239). The upstream settings.md documents it under `retry.provider.maxRetryDelayMs`.
- Fix: Document `retry.provider.maxRetryDelayMs` (default 60000); optionally note `retry.maxDelayMs` is accepted only for backward compat.

### [P2] `/resume [query]` does not accept a query argument
- Claim (Starting and Resuming table): "`/resume [query]` | Browse and resume a previous session — fuzzy-search by name, ID, or content"
- Reality: The dispatcher matches only the exact string `text === "/resume"` (interactive-mode.js:2142); `/resume foo` falls through and is sent as a normal message. The picker itself supports fuzzy search, but the `[query]` argument is not parsed. Upstream docs list `/resume` with no argument.
- Fix: Drop `[query]` or document that the search happens inside the picker, not via a command argument.

### [P2] `/fork` forks from a user message, not "any point"
- Claim (Forking with /fork): "/fork creates an entirely new session from any point in the current one."
- Reality: `/fork` opens `showUserMessageSelector()` populated from `session.getUserMessagesForForking()` (interactive-mode.js:2081-2082, 3594-3600); only user messages are selectable. Upstream docs describe it as a "User-message selector."
- Fix: Say "from any previous user message," not "any point."

### [P3] `/export` can also export JSONL; `/import`, `/clone` omitted
- Claim (Exporting and Sharing): `/export [file]` "Export the current session to an HTML file"; table lists only /export, /share, /copy.
- Reality: If the path ends with `.jsonl`, `/export` writes JSONL via `exportToJsonl`; otherwise HTML (interactive-mode.js:4219-4230). `/import <path.jsonl>` and `/clone` also exist (interactive-mode.js:2051, 2086) but are undocumented here.
- Fix: Note the `.jsonl` branch of `/export`; consider mentioning `/import` and `/clone` for completeness.

### [P3] Page documents TUI slash commands but PizzaPi is web-first
- Claim (whole page): Commands like `/tree`, `/fork`, `/compact`, `/share`, `/copy`, `/name`, `/session`, `/resume` presented as typed commands.
- Reality: PizzaPi runs pi in RPC mode; the web UI invokes these via dedicated RPC commands / buttons (e.g. `fork`, `compact`, `get_fork_messages` in App.tsx:2186-2202, 3783, 3984), not by users typing slashes. Typing `/tree` in the web composer would send it as a user message to the model. The page never clarifies the web-UI equivalents.
- Fix: Add a short note explaining which session actions are available from the web UI and that TUI slash commands apply to the embedded pi engine, not the composer.

### [P3] "How Context Files Load" ordering/path imprecise
- Claim (How Context Files Load): "1. Global AGENTS.md from ~/.pi/agent/ (or ~/.pizzapi/) 2. Walk up ... 3. Project-level AGENTS.md in the current directory"
- Reality: Step 1 loads only from `agentDir` (~/.pizzapi). Steps 2-3 are a single upward walk that already includes the current directory (resource-loader.js:51-75); there is no separate "project-level" pass. The "or ~/.pizzapi/" parenthetical implies both are checked, which they are not.
- Fix: Describe it as "global AGENTS.md from ~/.pizzapi/, then walk up from cwd collecting AGENTS.md/CLAUDE.md (cwd included)."

### [P3] Branch-summary "stored as separate entries, additive" is correct but undersells the type
- Claim (Aside): "Branch summaries are stored as separate entries in the session file. The full original messages are always preserved — summaries are additive, never destructive."
- Reality: Accurate — `BranchSummaryEntry` (type "branch_summary") is appended at the navigation point; `CompactionEntry` likewise (compaction.md, messages.js:42,97). No fix required; flagging only because the page never names the entry types a user would see in `/tree` or exported JSON.
- Fix: Optionally name `branch_summary`/`compaction` entry types for users inspecting JSONL.

## Redesign notes
- The dominant defect is systematic: every `~/.pi/agent/` and `.pi/` path is wrong for PizzaPi (patched to `~/.pizzapi/`). A single global find-and-replace plus deleting the false "both conventions work" Aside would resolve most P1s at once.
- The page is largely a lightly-edited copy of upstream pi's sessions/compaction docs. It should be re-grounded in PizzaPi's actual directory layout and web-UI interaction model, or clearly scoped as "underlying pi engine behavior."
- Settings tables are accurate on defaults but the surrounding file-path prose contradicts them. Keep the tables, fix the prose.
- `/resume [query]` and `/fork ... from any point` are inherited inaccuracies vs upstream; align phrasing with upstream docs.
- Consider a short "Web UI equivalents" sidebar mapping `/tree`→tree view, `/fork`→fork button, `/compact`→compact action, `/name`→session name field, since that is how PizzaPi users actually invoke them.

## Code UX opportunities
- `retry.maxDelayMs` silently migrating to `retry.provider.maxRetryDelayMs` (and being deleted) is a footgun for users copying old config examples; a settings-load warning when the legacy field is present would help (settings-manager.js:223-239 currently migrates silently).
- `/resume` ignoring any argument is surprising given the documented `/resume [query]`; either accept a pre-filter query or remove the brackets from help.
- `/export` switching format on a `.jsonl` suffix is undiscoverable; a `/export --jsonl` or separate `/export-jsonl` would be clearer, and the docs should mention both formats.
- Context-file discovery no longer reading `~/.pi/` means users migrating from upstream pi must move files; migrations.ts handles sessions but not AGENTS.md/SYSTEM.md — a migration helper or a clearer docs note would reduce confusion.
