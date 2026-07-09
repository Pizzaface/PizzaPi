# Audit: customization/providers.mdx
Verdict: MAJOR ISSUES
Claims checked: 34 | Failed: 11

## Findings

### [P1] `ui-panel` and `metadata` capabilities are validated but never wired to anything
- Claim (line 271-307): "`"ui-panel"` — Web UI Extensions: Add UI panels, sidebar widgets, or session metadata cards to the PizzaPi web interface" and "`"metadata"` — Session Metadata: Contribute structured metadata for the session viewer."
- Reality: `isUIPanelProvider` and `isMetadataProvider` are defined in `packages/cli/src/providers/types.ts:151,158` but are never imported or called by `bridge.ts` or `extensions/providers/extension.ts`. `ProviderBridge` only uses `isContextProvider` and `isLifecycleHook` (`packages/cli/src/providers/bridge.ts:15`). No code in `packages/server` or `packages/ui` references `sidebarWidgets`, `sessionMetadataCards`, `getSessionMetadata`, or `MetadataCardDef` (grep returned no matches). Providers declaring these capabilities load and pass validation but their UI/metadata output is never read or rendered.
- Fix: Either remove the `ui-panel`/`metadata` sections as unimplemented, or wire the bridge to invoke them and surface results to the server/UI.

### [P1] `ProviderInitContext.fireTrigger`, `publishMetadata`, and `socket` are documented as functional but are no-ops
- Claim (line 175-184): `init()` receives a context with `fireTrigger(...)`, `socket: unknown; // Socket.IO connection (if available)`, and `publishMetadata(...)`.
- Reality: `extensions/providers/extension.ts:115-118` passes `fireTrigger: async () => {}`, `socket: null`, `publishMetadata: () => {}` to every provider's `init()`. These are inert stubs; a provider relying on them to push triggers/metadata to the UI will silently do nothing.
- Fix: Mark these as stubs/not-yet-implemented in the doc, or implement them (a real `fireTrigger` exists in `extensions/triggers/extension.ts:15` and could be wired in).

### [P2] "config object (excluding `enabled`) is passed to init" is false
- Claim (line 247): "The entire config object (excluding `enabled`) is passed to the provider's `init()` method as `ctx.config`."
- Reality: `extensions/providers/extension.ts:116` passes `config: configs[provider.id] ?? {}` — the full entry from `loadProviderConfig()` (`extension.ts:23-35`), which includes the `enabled` field. Nothing strips `enabled` before handing it to `init()`.
- Fix: Drop "(excluding `enabled`)" or strip the key before passing.

### [P2] "See Also: ProviderBridge API" link target does not document ProviderBridge
- Claim (line 541): "[ProviderBridge API](/PizzaPi/reference/architecture/) — how providers are orchestrated"
- Reality: `packages/docs/src/content/docs/reference/architecture.mdx` mentions the remote extension and CLI but contains zero occurrences of "ProviderBridge", "Extension Provider", or "provider" orchestration (grep confirmed). The link promises content that isn't there.
- Fix: Point to an actual ProviderBridge reference (e.g. a new page or the source `packages/cli/src/providers/bridge.ts`), or remove the link.

### [P3] Error-isolation hook list and "successful call resets counter" are imprecise
- Claim (line 352-360): "If a provider throws in `onBeforeAgentStart`, `onTurnEnd`, or `onSessionClose`... A successful call resets the error counter."
- Reality: `bridge.ts` also records errors from `onSessionStart` (`bridge.ts:130`), which the doc omits. The counter is reset on success only in `onBeforeAgentStart` (`bridge.ts:91`) and `onTurnEnd` (`bridge.ts:178`); `onSessionStart` and `onSessionClose` never reset it (`bridge.ts:126-133`, `bridge.ts:193-205`). `onSessionShutdown` swallows errors silently without recording (`bridge.ts:166`).
- Fix: State exactly which hooks reset the counter and which record errors, or align the code.

### [P3] `SessionStartEvent` is missing the `model?` field
- Claim (line 232-236): `SessionStartEvent` lists only `reason` and `previousSessionFile?`.
- Reality: `packages/cli/src/providers/types.ts:54-56` also defines `model?: { provider: string; id: string; name: string }`, and `extension.ts:138-140` populates it from `ctx.model`. Providers cannot discover this field from the docs.
- Fix: Add the optional `model` field to the documented interface.

### [P3] Deduplication scope is per-provider, not global
- Claim (line 132): "When two contributions share the same `dedupeKey` within a single user prompt, the second is silently skipped."
- Reality: `bridge.ts:31` keeps `#dedupeState = new Map<string, Map<string, CollectedContribution>>` keyed by provider id first, then dedupeKey (`bridge.ts:73-90`). Two different providers using the same `dedupeKey` are both emitted; only repeats from the same provider are skipped. The parenthetical ("when a provider fires...") softens this, but the lead sentence reads as global.
- Fix: State explicitly that dedupe is per-provider.

### [P3] Module-formats description doesn't match the loader's `new`-then-`await` fallback
- Claim (line 92-126): Three equally-valid export patterns — object literal, class (`new`), factory function (`await`).
- Reality: `loader.ts:74-93` always tries `new exported()` first for any function export, and only falls back to `await exported()` if the constructor throws. A sync function returning an object is loaded via the `new` path (it returns the object), not the `await` path; an `async function` works only because async functions are non-constructable (so `new` throws). The doc presents them as three independent code paths.
- Fix: Describe the actual heuristic ("if the default export is a function, the loader instantiates it with `new`; if that throws, it awaits it as a factory").

### [P3] Troubleshooting calls error logs "warnings"
- Claim (line 527, 487): "[ProviderBridge] Disabling provider warnings"; duplicate-id and load errors implied as warnings.
- Reality: `bridge.ts:261` uses `console.error` (error level, stderr). Duplicate-id and load errors are emitted via `log.error` (`extensions/providers/extension.ts:82`, `createLogger` → `console.error`, `packages/tools/src/log.ts:38`). Telling users to grep for "warnings" undersells severity.
- Fix: Say "error logs" / "stderr" instead of "warnings".

### [P3] Lifecycle `reason` unions are only exercised as `startup`/`quit`
- Claim (line 228-229, 242): `SessionStartEvent.reason` is `"startup"|"reload"|"new"|"resume"|"fork"`; `SessionShutdownEvent.reason` is `"quit"|"reload"|"new"|"resume"|"fork"`.
- Reality: The unions match `types.ts:53,62`, but `extension.ts:142` casts `event.reason as "startup"` and `extension.ts:213` casts `event.reason as "quit"`, and every test in `extension.test.ts` only ever passes `reason: "startup"` / `reason: "quit"`. Whether pi ever emits `reload/new/resume/fork` for these events is unverified; the casts suggest the author assumed a single value.
- Fix: Confirm which reasons pi actually emits and document only those, or drop the cast in code.

### [P3] Verbosity / completeness of the Complete Example
- Claim (line 387-461): A ~75-line `git-context` example duplicates concepts already shown in Quick Start and Capability sections.
- Reality: The example re-implements `init`/`dispose`/`onSessionStart`/`onBeforeAgentStart`/`onTurnEnd`/`onSessionClose` already covered above; it adds little new beyond `execSync` usage. No factual error, but it inflates the page and duplicates the SKILL.md example (`packages/cli/src/skills/creating-runner-services/SKILL.md:100-160`).
- Fix: Trim the example to the one or two capabilities not already illustrated, or link to the SKILL.md.

## Redesign notes
- The page documents four capabilities but only two (`context`, `lifecycle`) actually do anything. Lead with that distinction; mark `ui-panel`/`metadata` as "planned/validated-only" so users don't build against a no-op surface.
- `ProviderInitContext` is mostly hollow today (`fireTrigger`/`publishMetadata`/`socket` are stubs). Either implement these or document the minimal usable surface (`config` only) to set honest expectations.
- The "Module Formats" section would be clearer as a single sentence describing the `new`-then-`await` heuristic rather than three pattern blocks that imply distinct detection.
- The "See Also" should link to working pages; the architecture page currently has no ProviderBridge content.
- Lifecycle reason semantics need a runtime check against pi; the doc currently mirrors a type union that may over-promise.

## Code UX opportunities
- `extension.ts:115-118` passing inert `fireTrigger`/`publishMetadata`/`socket:null` is a silent footgun — a provider author who calls them gets no error and no effect. Throw or log a "not implemented" warning, or wire `fireTrigger` to the existing trigger client (`extensions/triggers/extension.ts:15`).
- `extension.ts:142,213` casting `event.reason` to a single literal hides whether pi actually emits the other reasons; if it does, the cast is wrong, and if it doesn't, the type union is misleading. Either widen the cast or narrow the type.
- `bridge.ts` resets the error counter only in two of four error-recording hooks; providers that fail in `onSessionStart`/`onSessionClose` can stay one error away from disablement indefinitely. Consider resetting on any successful hook call for consistency.
- `loader.ts:74-93` uses `new`-then-`await` fallback based on constructor throwing; an async arrow/function factory only works because async functions aren't constructable. A comment or explicit `isConstructable` check would make the intent legible.
- Config `enabled` leaking into `ctx.config` (extension.ts:116) is a minor surprise; stripping it would match the doc and avoid providers reading their own enable flag.
