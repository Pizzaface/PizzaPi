# Audit: features/providers-and-models.mdx
Verdict: MAJOR ISSUES
Claims checked: 34 | Failed: 9

## Findings

### P1 Wrong config directory path `~/.pi/agent/` used throughout
- Claim (lines 52, 60, 76, 99, 119, 128): auth/settings/models files live at `~/.pi/agent/auth.json`, `~/.pi/agent/settings.json`, `~/.pi/agent/models.json`.
- Reality: PizzaPi patches `CONFIG_DIR_NAME = ".pizzapi"` and flattens the dir (`getAgentDir()` returns `~/.pizzapi`, no `/agent/` segment). `getAuthPath()/getSettingsPath()/getModelsPath()` all return `~/.pizzapi/{auth,settings,models}.json` (config.js:398,416,429,433,437). `defaultAgentDir()` in cli also returns `~/.pizzapi` (packages/cli/src/config/io.ts:385). `~/.pi/agent` is legacy and migrated away (packages/cli/src/migrations.ts:29-58).
- Fix: Replace every `~/.pi/agent/` with `~/.pizzapi/`.

### P1 Google Gemini CLI & Google Antigravity listed as OAuth subscription providers
- Claim (lines 28-31): "Subscription Providers (OAuth) … Google Gemini CLI | Free with Google account | Google Antigravity | Free with Google account", authenticated "with `/login` inside a session".
- Reality: The built-in OAuth registry in pi-ai 0.80.3 contains only `anthropicOAuthProvider`, `githubCopilotOAuthProvider`, `openaiCodexOAuthProvider` (dist/utils/oauth/index.js:25-29). No `google-gemini-cli` or `google-antigravity` OAuth provider, no env api-key mapping, and they are absent from `BUILT_IN_PROVIDER_DISPLAY_NAMES` (core/provider-display-names.js). `google-gemini-cli` appears only in PizzaPi *usage-quota* read code (packages/cli/src/index.ts:190, runner/usage-auth.ts:25) which reads pre-existing `{token,projectId}` credentials — there is no `/login` flow registering it in this version. `google-antigravity` exists only in a stale 0.70.6 patch and a UI usage label (packages/ui/src/components/UsageIndicator.tsx:27). The git log shows the Gemini CLI OAuth provider was added on an unmerged temp branch `temp/adk-go-integration`, not in the shipped 0.80.3.
- Fix: Remove both rows (or mark them clearly as not available in the current build) and document Google Gemini via `GEMINI_API_KEY` instead.

### P1 Key Resolution: bare env-var-name example is wrong
- Claim (lines 66-72): "Environment variable | `MY_ANTHROPIC_KEY` | Reads the named env var" — i.e. a bare all-caps string in the `key` field reads that environment variable.
- Reality: Bare strings are treated as literals. Env-var interpolation requires a `$` prefix: `parseConfigValueTemplate` only pushes `{type:"env"}` parts for `$NAME` / `${NAME}` tokens; a string with no `$` becomes a single literal part (core/resolve-config-value.js:34-79, esp. the `nextChar === "$"` / `${` branches). A user storing `"key": "MY_ANTHROPIC_KEY"` would send the literal text `MY_ANTHROPIC_KEY` as the API key.
- Fix: Change the example to `"$MY_ANTHROPIC_KEY"` (or `"${MY_ANTHROPIC_KEY}"`) and state that `$`/`${}` is required for env interpolation.

### P2 Credential priority order swaps env var and models.json
- Claim (lines 84-89): priority is 1) `--api-key`, 2) `auth.json`, 3) env var, 4) "Custom provider keys from `models.json`".
- Reality: `ModelRegistry.getApiKeyAndHeaders` calls `authStorage.getApiKey(provider, {includeFallback:false})` (which returns runtime override → auth.json api_key → auth.json oauth, but NOT the ambient env var) and only then falls back to `providerConfig.apiKey` from models.json (core/model-registry.js:536-540). The ambient env var is applied last, at stream time, by `withEnvApiKey` (compat.js:78-86) only when no explicit apiKey was resolved. So the real order is: `--api-key` > auth.json > models.json `apiKey` > env var. The doc's #3 and #4 are reversed.
- Fix: Swap items 3 and 4, or note env var is the final fallback.

### P2 "apiKey is required by the schema" for Ollama is false
- Claim (lines 116-118): "The `apiKey` is required by the schema but Ollama ignores it — any value works."
- Reality: `apiKey` is `Type.Optional(Type.String({minLength:1}))` in `ProviderConfigSchema` (core/model-registry.js:157). `validateConfig` requires only `baseUrl` for non-built-in providers with custom models, explicitly noting "Auth can come from auth.json, --api-key, or provider request config" (core/model-registry.js:404-413). `getApiKeyAndHeaders` returns `{ok:true, apiKey:undefined}` when no key is configured (core/model-registry.js:536-556), so Ollama works with no `apiKey` at all.
- Fix: State `apiKey` is optional; omit it for password-less local servers.

### P2 Supported API Types table is incomplete (4 of 9)
- Claim (lines 137-143): "Supported API Types" lists only `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`.
- Reality: `BUILTIN_APIS` in compat.js registers nine: `anthropic-messages`, `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `google-generative-ai`, `google-vertex`, `mistral-conversations`, `bedrock-converse-stream` (compat.js:101-111). The `api` field on a model def accepts any of these (ModelDefinitionSchema `api: Type.Optional(Type.String())`).
- Fix: Add the five missing API types (or at least `openai-codex-responses`, `azure-openai-responses`, `google-vertex`) with use-cases.

### P2 Google Vertex AI "Uses Application Default Credentials" omits the API-key path
- Claim (line 156): "Google Vertex AI | Uses Application Default Credentials".
- Reality: `vertexAuth.resolve` accepts either an explicit `GOOGLE_CLOUD_API_KEY` (env or stored credential) *or* ADC (`gcloud auth application-default login`) plus `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` (providers/google-vertex.js:9-22; env-api-keys.js `"google-vertex": "GOOGLE_CLOUD_API_KEY"`).
- Fix: Note `GOOGLE_CLOUD_API_KEY` as an alternative to ADC.

### P2 GOOGLE_CLOUD_PROJECT tip is misleading
- Claim (line 33): "Google Gemini CLI and Antigravity are free with any Google account, subject to rate limits. For paid usage, set the `GOOGLE_CLOUD_PROJECT` environment variable."
- Reality: `GOOGLE_CLOUD_PROJECT` is a Vertex AI requirement (paired with ADC + `GOOGLE_CLOUD_LOCATION`), not a toggle for "paid Gemini CLI usage". Setting it alone does nothing (providers/google-vertex.js:13-21). The Gemini CLI/Antigravity free-tier claim itself is unsupported by the current build (see P1 above).
- Fix: Remove the tip or reword to describe Vertex AI prerequisites accurately.

### P2 API Key Providers table undercounts providers (~15 listed vs 34 built-in)
- Claim (lines 38-54): the "API Key Providers" table lists 15 providers; intro says "20+ AI providers out of the box".
- Reality: `BUILT_IN_PROVIDER_DISPLAY_NAMES` defines 34 providers (core/provider-display-names.js:1-35); `getApiKeyEnvVars` (env-api-keys.js:43-79) maps env vars for many not in the table: `deepseek` (`DEEPSEEK_API_KEY`), `nvidia` (`NVIDIA_API_KEY`), `ollama-cloud` (`OLLAMA_API_KEY`), `moonshotai`/`moonshotai-cn` (`MOONSHOT_API_KEY`), `fireworks` (`FIREWORKS_API_KEY`), `together` (`TOGETHER_API_KEY`), `opencode`/`opencode-go` (`OPENCODE_API_KEY`), `cloudflare-workers-ai`/`cloudflare-ai-gateway` (`CLOUDFLARE_API_KEY`), `zai`/`zai-coding-cn`, `ant-ling`, `xiaomi*`, plus `github-copilot` (`COPILOT_GITHUB_TOKEN`) and the `ANTHROPIC_OAUTH_TOKEN` alternative for anthropic.
- Fix: Either expand the table or state it is a representative subset and link to `pizza models` / the registry for the full list.

### P3 Model Fields table omits valid fields
- Claim (lines 161-171): the "Model Fields" table lists id, name, api, reasoning, input, contextWindow, maxTokens, cost.
- Reality: `ModelDefinitionSchema` also accepts `thinkingLevelMap`, `headers`, `compat`, and `baseUrl` (core/model-registry.js:139-152). These matter for advanced local-model setups.
- Fix: Add the missing rows or note "see schema" for advanced fields.

### P3 Azure setup omits AZURE_OPENAI_RESOURCE_NAME alternative
- Claim (lines 180-184): Azure env vars are `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`.
- Reality: All four exist (api/azure-openai-responses.js:78-92), but `AZURE_OPENAI_RESOURCE_NAME` is also supported as a shorthand that builds `https://<name>.openai.azure.com/openai/v1` (api/azure-openai-responses.js:69,86-88). Default api-version is `v1`, not `2024-02-01`.
- Fix: Mention `AZURE_OPENAI_RESOURCE_NAME` and that the default api-version is `v1`.

### P3 /cycle_model and /effort are web-UI commands, not upstream TUI builtins
- Claim (line 95): "You can also cycle through a subset of models using the `/cycle_model` command, or change reasoning effort with `/effort`."
- Reality: Upstream `BUILTIN_SLASH_COMMANDS` only contains `/model`, `/scoped-models`, `/login`, `/logout`, etc. — no `/cycle_model` or `/effort` (core/slash-commands.js:3-26). `/cycle_model` and `/effort`/`/cycle_effort` are web-UI aliases handled in packages/ui/src/components/session-viewer/slash-commands.ts:144,170-172,781-793 (mapping to `cycle_model`/`cycle_thinking_level` exec requests). The doc presents them as generally available.
- Fix: Note these are available in the PizzaPi web UI.

## Redesign notes
- This page is essentially upstream-pi provider documentation with paths rewritten. Because PizzaPi patches the config namespace to `.pizzapi`, every path must be re-derived; a single "PizzaPi paths differ from upstream pi" callout up top would prevent the systemic `~/.pi/agent/` drift seen here.
- The "Subscription Providers (OAuth)" table should be generated from the live OAuth registry rather than hand-maintained, since two of five rows are not actually registerable in the shipped build.
- The "Supported API Types" and "API Key Providers" tables should be sourced from `BUILTIN_APIS` / `getApiKeyEnvVars` to stay in sync as providers are added.
- No merge needed with `customization/providers.mdx`: that page covers Extension Providers (lifecycle plugins), a distinct concept. The cross-linking Aside on lines 6-10 is appropriate and sufficient.
- The "Key Resolution" and "Credential Priority" sections overlap conceptually and both are partially wrong; consolidate into one authoritative "How auth is resolved" section backed by `resolveProviderAuth` + `getApiKeyAndHeaders`.

## Code UX opportunities
- `resolveConfigValue` silently treats a bare `MY_ANTHROPIC_KEY` as a literal; users expecting env-var behavior get a cryptic 401. Consider auto-detecting an all-caps bare token as an env-var reference, or emitting a warning when a stored `key` matches `/^[A-Z_][A-Z0-9_]*$/` and no `$` is present.
- `models.json` `apiKey` taking precedence over the ambient env var is surprising (the opposite of most tools). Either surface this in a startup auth-summary log line, or flip the precedence so env vars win over `models.json` keys.
- The provider/auth surface is large (34 providers, 9 API types) yet `pizza models` only prints a flat list. A `pizza providers` command listing provider id, env var, auth source, and configured status would let users (and docs) self-verify instead of relying on hand-maintained tables.
- `google-gemini-cli`/`google-antigravity` strings linger in usage/UI code but have no backing provider in 0.80.3, which is itself a code-debt signal: either land the OAuth providers from the temp branch or remove the dead usage-key mappings so docs can't reference vaporware.
