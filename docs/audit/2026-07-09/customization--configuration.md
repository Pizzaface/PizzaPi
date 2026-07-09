# Audit: customization/configuration.mdx
Verdict: MAJOR ISSUES
Claims checked: 58 | Failed: 14

## Findings

### [P1] Pi Agent Settings path is wrong — PizzaPi migrated away from ~/.pi/agent
- Claim (Pi Agent Settings section): "Global pi settings" live at `~/.pi/agent/settings.json` and project-local at `.pi/settings.json`.
- Reality: PizzaPi migrated `~/.pi/agent` → `~/.pizzapi/` and points pi at it via `PI_CODING_AGENT_DIR`/`agentDir`. The code reads `defaultProvider` from `join(globalConfigDir(), "settings.json")` = `~/.pizzapi/settings.json` (packages/cli/src/config/io.ts:338), the daemon reads `~/.pizzapi/settings.json` (packages/cli/src/runner/daemon.ts:1877), and ollama-web-tools reads `~/.pizzapi/settings.json` (packages/cli/src/extensions/ollama-web-tools.ts:227). Migration logic confirms the move (packages/cli/src/migrations.ts:29-36). The Per-Provider Overrides section of this very page contradicts the Pi Agent Settings section by correctly citing `~/.pizzapi/settings.json`.
- Fix: Replace `~/.pi/agent/settings.json` with `~/.pizzapi/settings.json` (and `.pizzapi/settings.json` for project-local, after verifying pi's project-local path).

### [P1] Missing security key: allowProjectMcp
- Claim (All Options table): lists `allowProjectHooks` and `trustedPlugins` as the trust-gate keys.
- Reality: A third trust-gate key exists, `allowProjectMcp` (boolean, default false), controlling whether project-local MCP server definitions emit a security warning. It is read in `isProjectMcpTrusted()` and honored via `PIZZAPI_ALLOW_PROJECT_MCP=1` (packages/cli/src/config/io.ts:109, 241-249; types.ts:374-386). This is security-relevant and absent from the docs.
- Fix: Add an `allowProjectMcp` row to the All Options table and the JSONC example, noting it is global-only and that project MCP servers load with a warning when unset.

### [P2] goal.evaluatorModel default described incorrectly
- Claim (All Options + JSONC comment): `goal.evaluatorModel` "Defaults to the cheapest available Anthropic Haiku or OpenAI mini model."
- Reality: `resolveEvaluatorModel` searches "the cheapest available text model that has configured auth" across ALL providers, not just Anthropic/OpenAI (packages/cli/src/extensions/goal/evaluator.ts:211-255). The test "falls back to the cheapest authenticated text model" picks a Groq llama model over Haiku/mini (packages/cli/src/extensions/goal/goal.test.ts:490-498). The evaluator.ts docstring itself says "default Anthropic Haiku" but the implementation is provider-agnostic.
- Fix: Change default to "cheapest available authenticated text model from any provider."

### [P2] Missing config key: goal.evaluateEveryNTurns
- Claim (All Options table): only `goal.evaluatorModel` and `goal.evaluatorMaxTokens` are documented under `goal`.
- Reality: `goal.evaluateEveryNTurns` exists with default `3` (packages/cli/src/extensions/goal/evaluator.ts:34 `DEFAULT_EVALUATE_EVERY_N_TURNS = 3`; types.ts:goal.evaluateEveryNTurns). It controls LLM evaluator cadence and is read at packages/cli/src/extensions/goal/index.ts:188.
- Fix: Add a `goal.evaluateEveryNTurns` row (number, default 3, "1 = every turn; ignored by keyword evaluator").

### [P2] Missing config key: toolSearch (dynamic MCP tool discovery)
- Claim: No mention of tool search anywhere on the page.
- Reality: `toolSearch` config exists with `enabled` (default false), `tokenThreshold` (default 10000), `maxResults` (default 5), `keepLoadedTools` (default true) (packages/cli/src/config/types.ts:ToolSearchConfig). It is a user-facing feature for reducing context bloat.
- Fix: Add a `toolSearch` subsection or All Options rows.

### [P2] Missing OAuth config keys
- Claim (All Options): only `oauthClientName` is documented.
- Reality: `oauthClientId`, `oauthClientSecret`, and `oauthCallbackPort` (default 0) also exist as global defaults with per-server overrides (packages/cli/src/config/types.ts:oauthClientId/oauthClientSecret/oauthCallbackPort).
- Fix: Add rows for the three missing OAuth keys, or note them in the MCP Servers cross-link.

### [P2] Missing config key: disabledMcpServers in All Options
- Claim (All Options table): no `disabledMcpServers` row (it only appears under Per-Provider Overrides as `disabledMcpServers`).
- Reality: `disabledMcpServers` is a top-level config key merged as a union of global+project (packages/cli/src/config/io.ts:268-282; types.ts:disabledMcpServers).
- Fix: Add a `disabledMcpServers` row to All Options.

### [P2] Missing env vars: PIZZAPI_ALLOW_PROJECT_HOOKS / PIZZAPI_ALLOW_PROJECT_MCP
- Claim (Environment Variables table): lists PIZZAPI_NO_* and PIZZAPI_SANDBOX but not the project-trust env vars.
- Reality: `PIZZAPI_ALLOW_PROJECT_HOOKS=1` and `PIZZAPI_ALLOW_PROJECT_MCP=1` are honored env vars (packages/cli/src/config/io.ts:99, 109).
- Fix: Add both rows to the Environment Variables table.

### [P2] Web-search env-var precedence phrasing is backwards
- Claim (Web Search → Environment Variables): "these take precedence if the config values are not already set."
- Reality: `applyProviderSettingsEnv` writes the env var only `if (!process.env.PIZZAPI_WEB_SEARCH)` — i.e., an externally-set env var wins over config regardless of whether config is set (packages/cli/src/config/io.ts:380-410). The determining factor is whether the env var is already set, not whether config is set.
- Fix: Reword to "Environment variables take precedence over config values when set; otherwise the config value is used."

### [P2] Merge Order omits apiKey/relayUrl exception
- Claim (Merge Order + intro table): "Project-local — overrides global for this project" and step 3 project wins.
- Reality: For `apiKey` and `relayUrl` specifically, when BOTH global and project set them, GLOBAL wins (project value is discarded with a warning) (packages/cli/src/config/io.ts:170-219). The general `{ ...global, ...project }` spread does not apply to these two transport/auth fields.
- Fix: Add a note to Merge Order: "apiKey and relayUrl are exceptions — global always wins when both scopes set them."

### [P2] Skills Search Paths list is incomplete
- Claim (Skills Search Paths): three locations — `~/.pizzapi/skills/`, `<cwd>/.pizzapi/skills/`, and `skills` config array.
- Reality: `buildSkillPaths` also includes built-in CLI skills, `~/.pizzapi/agents/`, `<cwd>/.pizzapi/agents/`, `<cwd>/.agents/skills/`, and `<cwd>/.agents/agents/` (packages/cli/src/skills.ts:308-322).
- Fix: List all seven sources or link to the Skills guide for the full set.

### [P3] Misleading "See Safe Mode" links for non-sandbox keys
- Claim (All Options): `mcpTimeout` and `slowStartupWarning` rows link to Safe Mode (/PizzaPi/security/sandbox/).
- Reality: Neither key is sandbox-related; `mcpTimeout` is an MCP tools/list timeout (types.ts:mcpTimeout) and `slowStartupWarning` is a startup-latency notification (types.ts:slowStartupWarning). The sandbox page is the wrong target.
- Fix: Drop the Safe Mode cross-links or point mcpTimeout to the MCP Servers guide.

### [P3] Environment Variables section wording conflicts with Merge Order
- Claim (Environment Variables intro): "Environment variables ... do **not** override saved config values in JSON files — the JSON is loaded first, then env vars for the relay connection are applied on top."
- Reality: Functionally env vars DO win (`process.env.PIZZAPI_API_KEY ?? config.apiKey`, packages/cli/src/index.ts:407-408), which the Merge Order section states correctly (step 4 wins). The "do not override" phrasing refers only to file persistence and reads as a contradiction.
- Fix: Clarify "env vars do not rewrite the JSON file, but they do take precedence at runtime."

### [P3] Missing keys: allowProjectProviders, envOverrides, providers, hooks
- Claim (All Options): purports to be the complete option list.
- Reality: `allowProjectProviders` (default false), `envOverrides`, `providers`, and `hooks` are all valid PizzaPiConfig keys (packages/cli/src/config/types.ts:allowProjectProviders/envOverrides/providers; HooksConfig). `hooks` is covered by a dedicated page but not even cross-referenced in the table; the others are entirely absent.
- Fix: Add rows or explicit "see X guide" cross-references for each.

## Redesign notes
- The page mixes a JSONC example, an "All Options" table, and several feature subsections, leading to duplication (e.g., web-search keys appear in both a table and prose). Consolidate into one authoritative table plus feature narratives.
- "All Options" is presented as exhaustive but is missing at least 10 keys; either rename it "Common Options" or generate it from the PizzaPiConfig type to stay accurate.
- The Pi Agent Settings section duplicates model/compaction content that belongs in the Providers & Models / Sessions pages; consider reducing it to a cross-link plus the single critical fact (the settings file path).
- Two different settings-file paths appear on the same page (`~/.pi/agent/settings.json` vs `~/.pizzapi/settings.json`); a single source-of-truth path would prevent this.
- Sandbox defaults are spread across the JSONC example, the All Options table, and a cross-link to the Sandbox page — pick one location.

## Code UX opportunities
- `loadConfig` silently overrides project `apiKey`/`relayUrl` with global values and only `log.warn`s once; surfacing this in the `pizza setup`/config-show output would help users notice misconfigured project files.
- The `allowProjectMcp` warn-and-load behavior (loads with warning unless trusted) differs from `allowProjectHooks` (blocks unless trusted) — this asymmetry is surprising and worth either aligning the semantics or adding a clearer log prefix.
- Several config keys (`oauthClientId`, `toolSearch`, `envOverrides`) have no web-UI surface despite the AGENTS.md "UI + TUI for every feature" rule; the Runner Settings page could expose them.
- `resolveEvaluatorModel` docstring says "default Anthropic Haiku" while the implementation is provider-agnostic — fixing the code comment would keep generated docs honest.
