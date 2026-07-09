# Audit: customization/skills.mdx
Verdict: MAJOR ISSUES
Claims checked: 18 | Failed: 9

## Findings

### [P1] Discovery locations table omits most real skill paths
- Claim (line ~13): "PizzaPi searches for skills in these locations (all merged): `~/.pizzapi/skills/`, `<cwd>/.pizzapi/skills/`, Paths in the `skills` config array"
- Reality: `buildSkillPaths` returns 7 default paths before config: built-in CLI skills, `~/.pizzapi/skills/`, `<cwd>/.pizzapi/skills/`, `~/.pizzapi/agents/`, `<cwd>/.pizzapi/agents/`, `<cwd>/.agents/skills/`, `<cwd>/.agents/agents/`, plus `config.skills` (packages/cli/src/skills.ts:319-328). The docs list only 3 of 8 and never mention `agents/` dirs or `.agents/skills|agents`.
- Fix: Replace the 3-row table with the full `buildSkillPaths` list incl. built-in and `agents/` directories.

### [P1] `tools` frontmatter field does not exist
- Claim (frontmatter table): "`tools` | string | Comma-separated list of tools this skill needs (informational)"
- Reality: The Agent Skills standard and pi's frontmatter use `allowed-tools` (space-delimited), not `tools` (pi docs/skills.md frontmatter table). PizzaPi's `parseSkillFrontmatterFromString` only parses `description` — it never reads `tools` (packages/cli/src/skills.ts:60-72). The field is inert.
- Fix: Remove the `tools` row, or rename to `allowed-tools` and drop "informational" (it is a real standard field).

### [P1] "All frontmatter fields are optional / no-frontmatter skill still loaded" is wrong
- Claim: "All frontmatter fields are optional. If no frontmatter is provided, the skill is still loaded — the agent uses the file content to decide relevance."
- Reality: pi marks `name` and `description` as **Required** and states "Skills with missing description are not loaded" (pi docs/skills.md Frontmatter + Validation). PizzaPi's scanner still lists such files as metadata (skills.ts:104-116), but pi's `DefaultResourceLoader` (fed via `additionalSkillPaths`) will not load them into the agent.
- Fix: State that `name` and `description` are required by the Agent Skills standard; a skill without a description is discovered but not loaded.

### [P1] Skill name validation rule is wrong on both sides
- Claim (Aside): "Skill names are validated to prevent path traversal — only alphanumeric characters, hyphens, and underscores are allowed."
- Reality: Two different validators apply. The HTTP layer `isValidSkillName` allows uppercase, hyphens, underscores, **and dots** (packages/server/src/validation.ts:17 `/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/`). The runner's `create_skill`/`update_skill` handlers — the ones that actually write — use `^[a-z0-9][a-z0-9-]*[a-z0-9]$`: **lowercase letters, numbers, hyphens only; no underscores, no dots, no uppercase** (packages/cli/src/runner/daemon.ts:1439-1444, 1472-1477). Underscores are explicitly rejected by the runner.
- Fix: "Skill names must be lowercase letters, numbers, and hyphens (1–64 chars); the runner rejects underscores, dots, and uppercase."

### [P2] API only manages the global skills directory, not all discovery dirs
- Claim: "The API writes directly to the same directories used by file-based discovery (`~/.pizzapi/skills/`, etc.)." and Web UI can "Browse all skills discovered from the runner's skill directories"
- Reality: Runner handlers call `writeSkill(name, content)` / `deleteSkill(name)` / `readSkillContent(name)` with no `dir` arg → defaults to `globalSkillsDir()` = `~/.pizzapi/skills/` only (packages/cli/src/skills.ts:137,159,170; daemon.ts:1453,1486,1508,1522). `list_skills` calls `scanGlobalSkills()` which scans **only** `~/.pizzapi/skills/` (skills.ts:124-126). Project-local, `agents/`, `.agents/`, config, and plugin skills are never listed or writable via the API/refresh.
- Fix: State that the API and Refresh operate only on `~/.pizzapi/skills/`; project-local/plugin/config skills are not visible or editable through the API.

### [P2] `~/.claude/plugins/` is not flat-scanned as a global plugin dir
- Claim: "Skills from global plugins (`~/.pizzapi/plugins/`, `~/.agents/plugins/`, `~/.claude/plugins/`) are automatically discovered"
- Reality: `globalPluginDirs()` returns only `~/.pizzapi/plugins/` and `~/.agents/plugins/`; the code comment states "`~/.claude/plugins/` is intentionally excluded here" — it is discovered only via `~/.claude/plugins/installed_plugins.json` marketplace manifest (packages/cli/src/plugins/discover.ts:18-26, 95-180). A plugin folder dropped directly into `~/.claude/plugins/` without a manifest entry is not discovered.
- Fix: Note that `~/.claude/plugins/` plugins are loaded only through Claude Code's `installed_plugins.json` manifest, not by scanning the directory.

### [P2] `${CLAUDE_PLUGIN_ROOT}` is not substituted in skill content
- Claim: "Plugin skills can use `${CLAUDE_PLUGIN_ROOT}` to reference files relative to the plugin root"
- Reality: `resolvePluginRoot` is applied to hook **commands** (packages/cli/src/plugins/parse.ts:83-85) and command **templates** (claude-plugins.ts:126), and `CLAUDE_PLUGIN_ROOT` is exported as an env var only when hook commands execute (claude-plugins.ts:63). Plugin skills are loaded by pi's normal skill loader from `<plugin>/skills/`, which uses **relative paths from the skill directory** (pi docs/skills.md). No `${CLAUDE_PLUGIN_ROOT}` substitution is performed on SKILL.md content, and the env var is not set during ordinary agent turns.
- Fix: Drop the `${CLAUDE_PLUGIN_ROOT}` claim for skills; say plugin skills use relative paths from their `SKILL.md` directory like any other skill.

### [P2] "Built-in PizzaPi Extensions … always active" is inaccurate and incomplete
- Claim: "PizzaPi ships with several built-in extensions that are always active" (table of 7)
- Reality: `remote`, `mcp`, and `claude-plugins` are gated by `skipRelay`/`skipMcp`/`skipPlugins` (safe mode) and are NOT always active (packages/cli/src/extensions/factories.ts:62-77, 105-110). The list also omits ~17 other always-on factories (triggers, tunnel-tools, tool-search, goal, subagent, plan-mode, sandbox, providers, session-analysis, hooks, etc.).
- Fix: Either remove this tangential table from the skills page or correct "always active" to "active by default (disabled in safe mode)" and link to the full extension list.

### [P3] Direct root `.md` skill files are supported but undocumented
- Claim: "A skill is a directory containing a `SKILL.md` file" (FileTree shows only subdirectory layout)
- Reality: `scanSkillsDir` also discovers direct `.md` files in the skills root (`name = basename without .md`), and tests assert this (packages/cli/src/skills.ts:104-111; skills.test.ts "discovers direct .md files in root"). The docs only describe the `<name>/SKILL.md` layout.
- Fix: Add a note that a bare `<name>.md` file in a skills directory is also discovered as a skill.

### [P3] Skill matching description overstates "content" matching
- Claim: "The agent compares the user's task against each skill's `description` field (or content) and loads relevant skills automatically."
- Reality: pi puts only skill **descriptions** in the system prompt XML; the full SKILL.md is loaded on-demand via the `read` tool (pi docs/skills.md "How Skills Work"). Content is not used for matching.
- Fix: Drop "(or content)"; matching is against the `description` only.

### [P3] Missing standard frontmatter fields and constraints
- Claim: frontmatter table lists only `name`, `description`, `tools`
- Reality: pi/standard also support `license`, `compatibility`, `metadata`, `allowed-tools`, `disable-model-invocation` (pi docs/skills.md Frontmatter). `name` must be ≤64 chars, lowercase a-z/0-9/hyphens; `description` max 1024 chars. None of these constraints are mentioned.
- Fix: Add the standard fields and the name/description length+charset limits.

## Redesign notes
- The "Skill Discovery" table is the single most important claim on the page and is materially incomplete; make it a faithful mirror of `buildSkillPaths` output.
- The frontmatter table should be replaced with the Agent Skills standard frontmatter (link to the spec) rather than a PizzaPi-invented subset.
- The "Managing Skills via the API" section should disclose the real scope (global dir only) up front, not bury it in "Relationship to File-Based Discovery" with an "etc." that over-promises.
- The "Built-in PizzaPi Extensions" table is off-topic for a skills page and is wrong about "always active"; consider removing it and linking to an extensions/reference page.
- Two examples (Project-Local Skill, TDD Skill) repeat the same "rules + structure" pattern; one would suffice.

## Code UX opportunities
- The server (`isValidSkillName`) and runner (`create_skill`/`update_skill` regex) enforce **different** skill-name rules, so a name can pass the HTTP layer (e.g. `my_skill`, `Org.Tool`) and then fail at the runner with a different error message. Unify the validator (export one `isValidSkillName` from protocol/shared) and have the runner reuse it.
- `scanGlobalSkills()` powers both `list_skills` and refresh but only sees `~/.pizzapi/skills/`, so the web UI "Skills" tab silently hides project-local/plugin/config skills the agent actually loads. Either widen the runner scan to all `buildSkillPaths` dirs or label the UI tab "Global skills" to set correct expectations.
- `parseSkillFrontmatterFromString` only extracts `description`; `name` and other standard fields are ignored, so the API metadata can't surface `disable-model-invocation` or `allowed-tools`. Parsing the full frontmatter would let the UI show accurate skill metadata.
