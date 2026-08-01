# Patches

Patches in this directory are applied automatically by Bun via the
`patchedDependencies` field in the root `package.json`. They are reapplied on
every `bun install` — no postinstall script is needed.

## @earendil-works/pi-agent-core@0.82.1

Refreshes the agent's system prompt and tool list before every assistant
response, not just at loop start. `dist/agent.js` exposes the current
`systemPrompt`/`tools` off the context snapshot (`__getLatestSystemPrompt`,
`__getLatestTools`); `dist/agent-loop.js` calls them right before each
`streamAssistantResponse`. Without this, a tool that loads a deferred tool or
updates the prompt mid-turn (e.g. `search_tools`) wouldn't take effect until
the *next* user turn. See the "pi-agent-core dynamic tool refresh" tests in
`packages/cli/src/patches.test.ts`.

## @earendil-works/pi-tui@0.82.1

Adds a Windows console lifecycle to `dist/terminal.js`:
`createWindowsConsoleLifecycle()` enables VT output processing and switches
the input/output code pages to UTF-8 (via `koffi` calls into
`kernel32.dll`) when `ProcessTerminal.start()` runs, publishes the result as
`globalThis.__PI_WINDOWS_CONSOLE_CAPS__`, and restores the original console
mode/code pages on `stop()`. This fixes garbled Unicode/ANSI rendering in
Windows terminals; it's a no-op (best-effort, swallows failures) on other
platforms. See `packages/cli/src/patches.test.ts`.

## @earendil-works/pi-ai@0.82.1

Same intent as 0.80.6 (Anthropic web-search passthrough, Claude Code
credentials fallback, retryable-JSON-parse patterns), ported to upstream's
restructured 0.82.0 layout:

- The Anthropic OAuth module moved from `dist/utils/oauth/anthropic.js` to
  `dist/auth/oauth/anthropic.js`, and its shape changed: the old
  `anthropicOAuthProvider.refreshToken(credentials)` object is gone, replaced
  by `anthropicOAuth.refresh(credential)` on the same `anthropicOAuth` object
  used for login. The Claude Code Keychain/file fallback now lives inside
  that `refresh()` method.

**Ollama Cloud is no longer part of this patch (Task 0.2, Godmother idea
Uq2WsWiW).** Earlier revisions inlined an `ollamaCloudProvider()` factory
into `dist/providers/all.js`, an `OLLAMA_CLOUD_MODELS` catalog into
`dist/models.generated.js`, an `OLLAMA_API_KEY` mapping into
`dist/env-api-keys.js`, and an `ollama-cloud` `KnownProvider` entry into
`dist/types.d.ts`. All four hunks were fully replaceable by pi's public
`pi.registerProvider()` extension API, so they were dropped from the patch
and replaced with a bundled PizzaPi extension
(`packages/cli/src/extensions/ollama-cloud-provider.ts`) that registers the
same provider (baseUrl, `apiKey: "$OLLAMA_API_KEY"`, `api:
"openai-completions"`) plus a static fallback model catalog
(`packages/cli/src/ollama-cloud-fallback-models.ts`, same data the patch used
to inline) at extension-load time — before pi's `bindCore()` flushes queued
provider registrations, so `--provider ollama-cloud`, `pizza models`, and the
web model selector see the provider and models with zero network. Live
discovery (`packages/cli/src/ollama-cloud-models.ts`, 24h cache) then
refreshes the catalog as before. See `packages/cli/src/ollama-provider.test.ts`
for the functional tests and `packages/cli/src/patches.test.ts` for the
assertions that the pi-ai patch no longer carries any ollama-cloud hunks.

**What it changes:**

| File | Change |
|------|--------|
| `dist/api/anthropic-messages.js` | Same Anthropic web-search patch as 0.80.6 (unchanged file) |
| `dist/auth/oauth/anthropic.js` | Claude Code Keychain/file credentials fallback, now inside `anthropicOAuth.refresh()` |
| `dist/utils/retry.js` | Same retryable-JSON-parse patterns as 0.80.6 (unchanged file) |

## @earendil-works/pi-coding-agent@0.82.1

Same PizzaPi integration changes as 0.80.6, ported forward, with two upstream
removals absorbed elsewhere rather than restored:

- **`dist/core/provider-display-names.js` was deleted upstream.** Provider
  display names now come from each provider's own `name` field (set at
  registration in pi-ai's `builtinProviders()`) via
  `ModelRegistry.getProviderDisplayName()` → `runtime.getProvider(id)?.name`.
  Ollama Cloud's display name now comes from the `name` field on
  `ollamaCloudProviderExtension`'s `pi.registerProvider()` call
  (`packages/cli/src/extensions/ollama-cloud-provider.ts`) instead of any
  pi-ai or pi-coding-agent patch.
- **`AuthStorage` (and its associated types) is no longer exported from the
  package root**, and the class itself was rewritten to a plain
  `CredentialStore` (read/list/modify/delete) with all OAuth-refresh/env-
  fallback/runtime-override orchestration moved into `ModelRuntime`. Only
  `readStoredCredential(providerId, authPath)` (a stateless raw JSON read,
  unchanged in shape) remains exported. This patch does **not** try to
  restore the old export — the class it pointed to doesn't exist in the old
  shape anymore. Instead, `packages/cli` callers were migrated to
  `ModelRuntime`/`ModelRegistry`/`readStoredCredential` (see below).

**What it changes:**

| File | Change |
|------|--------|
| `dist/config.js` | Same `.pizzapi` config-dir / flat-directory / `PIZZAPI_CHANGELOG_PATH` overrides as 0.80.6 |
| `dist/core/agent-session.js` | Same `expandPromptTemplates` opt-in as 0.80.6 |
| `dist/core/extensions/loader.js` / `dist/core/extensions/runner.js` | Same `newSession()`/`switchSession()`/`fork()` general-API exposure as 0.80.6 |
| `dist/core/extensions/types.d.ts` | Same `ExtensionAPI`/`ExtensionActions` typings as 0.80.6 |
| `dist/core/model-resolver.js` | Same `ollama-cloud` default model (`glm-5.1`) as 0.80.6 |
| `dist/modes/interactive/interactive-mode.js` | Same version-notification-UI removal as 0.80.6 (upstream shifted a few lines; hunk re-applied manually) |
| `dist/index.js` / `dist/index.d.ts` | Same `handlePackageCommand`/`handleConfigCommand` re-export as 0.80.6 |

**No longer present (see above for why):** `dist/core/provider-display-names.js`.

### packages/cli auth call-site migration (not a patch — our own source)

Because `AuthStorage` and `ModelRegistry.create()`/`.authStorage` are gone,
every `packages/cli` call site that constructed or read through them was
updated to the new API:

| Old | New |
|-----|-----|
| `AuthStorage.create(authPath)` + `ModelRegistry.create(authStorage, modelsPath)` | `await ModelRuntime.create({ authPath, modelsPath })` + `new ModelRegistry(runtime)` |
| `authStorage.get(provider)` (raw credential read) | `readStoredCredential(provider, authPath)` (same shape, now a plain exported function) |
| `authStorage.hasAuth(provider)` | `modelRegistry.getProviderAuthStatus(provider).configured` (or `runtime.hasConfiguredAuth(provider)` where only the runtime is in scope) |
| `ctx.modelRegistry.authStorage.get(provider)` (extension auth-source detection) | `ctx.modelRegistry.isUsingOAuth(ctx.model)` + `ctx.modelRegistry.getProviderAuthStatus(provider)` |
| `authStorage.getApiKey("google-gemini-cli")` (a synthetic, non-model-registry credential slot used only for usage reporting) | `readStoredCredential("google-gemini-cli", authPath)` — this slot is api_key-only in practice (no real OAuth provider registered for it), so the raw `.key` read is behavior-preserving |
| `worker.ts`'s `createAuthStorageWithRetry()` (lock-contention retry wrapper around `AuthStorage.create()`, feeding `createAgentSession({ authStorage })`) | `createModelRuntimeWithRetry()`, same retry/backoff/lockless-fallback structure around `ModelRuntime.create()` + `runtime.listCredentials()`, feeding `createAgentSession({ modelRuntime })`. The last-resort in-memory snapshot tier uses a small local class structurally matching pi-ai's (unexported) `CredentialStore` interface, since there's no public in-memory credential store constructor anymore. |

Affected files: `models-command.ts`, `index.ts`, `runner/daemon.ts`,
`runner/runner-ollama-models-cache.ts`, `runner/runner-usage-cache.ts`,
`runner/worker.ts`, `extensions/ollama-web-tools.ts`,
`extensions/remote-auth-source.ts`, `extensions/remote-provider-usage.ts`,
`extensions/spawn-session.ts`, plus their tests.

## Historical patches (older versions & the retired `@mariozechner/*` scope)

Patch files and docs for superseded versions (pre-0.82.1 `@earendil-works/*`
and the old `@mariozechner/*` scope) were removed once they stopped being
referenced by `patchedDependencies`. Their lineage — including the recurring
"same as 0.80.6" notes above — lives in git history if you need to diff a
port forward:

```bash
git log --oneline -- 'patches/*.patch'
```
