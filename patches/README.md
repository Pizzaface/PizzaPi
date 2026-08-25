# Patches

Patches in this directory are applied automatically by Bun via the
`patchedDependencies` field in the root `package.json`. They are reapplied on
every `bun install` — no postinstall script is needed.

## @earendil-works/pi-agent-core@0.84.2

Refreshes the agent's system prompt and tool list before every assistant
response, not just at loop start. `dist/agent.js` exposes the current
`systemPrompt`/`tools` off the context snapshot (`__getLatestSystemPrompt`,
`__getLatestTools`); `dist/agent-loop.js` calls them right before each
`streamAssistantResponse`. Without this, a tool that loads a deferred tool or
updates the prompt mid-turn (e.g. `search_tools`) wouldn't take effect until
the *next* user turn. See the "pi-agent-core dynamic tool refresh" tests in
`packages/cli/src/patches.test.ts`.

## @earendil-works/pi-tui@0.84.2

Adds a Windows console lifecycle to `dist/terminal.js`:
`createWindowsConsoleLifecycle()` enables VT output processing and switches
the input/output code pages to UTF-8 (via `koffi` calls into
`kernel32.dll`) when `ProcessTerminal.start()` runs, publishes the result as
`globalThis.__PI_WINDOWS_CONSOLE_CAPS__`, and restores the original console
mode/code pages on `stop()`. This fixes garbled Unicode/ANSI rendering in
Windows terminals; it's a no-op (best-effort, swallows failures) on other
platforms. See `packages/cli/src/patches.test.ts`.

## @earendil-works/pi-ai@0.84.2

Same intent as 0.80.6 (Anthropic web-search passthrough, Claude Code
credentials fallback, retryable-JSON-parse patterns), ported to upstream's
restructured 0.82.0 layout:

- The Anthropic OAuth module moved from `dist/utils/oauth/anthropic.js` to
  `dist/auth/oauth/anthropic.js`, and its shape changed: the old
  `anthropicOAuthProvider.refreshToken(credentials)` object is gone, replaced
  by `anthropicOAuth.refresh(credential, signal)` on the same `anthropicOAuth`
  object used for login. The Claude Code Keychain/file fallback now lives
  inside that `refresh()` method.

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

## @earendil-works/pi-coding-agent@0.84.2

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

OpenAI's direct API catalog reports a 272K short-context pricing threshold for
some GPT-5.4, GPT-5.5, and GPT-5.6 models instead of their actual capacity.
PizzaPi wraps the built-in `openai` provider in `ModelRuntime` after
remote-catalog discovery but before extension and `models.json` composition,
so direct API consumers see OpenAI's published 1.05M/400K windows while
provider auth, streaming, model discovery, user overrides, and custom native-
provider metadata remain intact. The separate `openai-codex` OAuth backend
keeps its own catalog limits.
Source: https://developers.openai.com/api/docs/models/compare

**What it changes:**

| File | Change |
|------|--------|
| `dist/config.js` | Same `.pizzapi` config-dir / flat-directory / `PIZZAPI_CHANGELOG_PATH` overrides as 0.80.6 |
| `dist/core/agent-session.js` | `_expandSkillCommand` expands **every** `/skill:<name>` token in a message, not just a leading one (leading token keeps trailing-text-as-args semantics; inline tokens expand in place) so multiple skills and `@`-mentions can coexist in one web/TUI message |
| `dist/core/model-runtime.js` | Wraps the built-in OpenAI API provider so GPT-5.4+ defaults match OpenAI's published context capacities |
| `dist/core/model-resolver.js` | Same `ollama-cloud` default model (`glm-5.1`) as 0.80.6 |
| `dist/modes/interactive/interactive-mode.js` | Same version-notification-UI removal as 0.80.6 (upstream shifted a few lines; hunk re-applied manually) |
| `dist/index.js` / `dist/index.d.ts` | Same `handlePackageCommand`/`handleConfigCommand` re-export as 0.80.6 |

**No longer present (see above for why):** `dist/core/provider-display-names.js`. **Also no longer present (Phase 2, below):** `dist/core/agent-session.js`'s `sendUserMessage({ expandPromptTemplates })` opt-in and both `dist/core/extensions/types.d.ts` hunks that typed it.

### Phase 1: control-plane exposure removed (was `loader.js` / `runner.js` / `types.d.ts`)

Earlier revisions copied session-control capabilities onto `ExtensionAPI` so
PizzaPi's remote extension (which runs in event handlers and only sees
`ExtensionAPI`) could reach them: `newSession`/`switchSession`/`fork` and
`getQueuedMessages`/`replaceQueuedMessages`. These were **pure surface-widening**
— the capabilities are already native on `AgentSessionRuntime` (new/switch/fork)
and `AgentSession` (`getSteeringMessages`/`getFollowUpMessages`/`clearQueue`).

They were removed from the patch once PizzaPi's remote extension was rewired to
drive control through a host-owned **SessionHost**
(`packages/cli/src/runner/session-host.ts`), threaded into the relay context via
`packages/cli/src/extensions/remote/session-host-ref.ts`. The worker backs the
host with its existing headless in-place lifecycle actions; the local TUI backs
it with the runtime. `replaceQueuedMessages` has no clean public native path (it
needs pi's private raw-enqueue to avoid double-expanding already-expanded queued
text), so the worker's SessionHost reaches those private methods directly — as
it already does for queue clearing — rather than via a patch. `patches.test.ts`
has regression guards asserting the removed hunks do not silently return on a
version bump.

### Phase 2: `sendUserMessage({ expandPromptTemplates })` hunk removed

The last remaining reason for the patch's `ExtensionAPI.sendUserMessage`
surface — the `expandPromptTemplates` opt-in used by the web UI input path —
was removed once `connection-handlers-factory.ts`'s `ConnectionHandlers.sendUserMessage`
was rewired to call `rctx.sessionHost.sendUserMessage()` directly instead of
`(pi as any).sendUserMessage()`. `SessionHost.sendUserMessage` already called
`session.prompt()` with `expandPromptTemplates` natively supported (unpatched
`PromptOptions` field) — the patched `AgentSession.sendUserMessage()` method
and its `ExtensionAPI`/`SendUserMessageHandler` typings in `types.d.ts` were
never reached anymore. Both hunks (`dist/core/agent-session.js` and the two
`dist/core/extensions/types.d.ts` hunks) were dropped from the patch. As of
0.84.2, upstream provides the same opt-in API natively; `patches.test.ts`
asserts that native behavior remains while PizzaPi's old patch markers stay
absent.

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
