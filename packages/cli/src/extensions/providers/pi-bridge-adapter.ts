import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { ProviderBridge, withProviderTimeout } from "../../providers/bridge.js";
import type { BeforeAgentStartEvent, ExtensionProvider, ProviderContext, ProviderInitContext } from "../../providers/types.js";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Provider -> pi extension event mapping (see event-mapping.test.ts for the
 * exhaustive, assertable table):
 *
 *   session_start     -> provider.init() once per provider, then a single
 *                        shared ProviderBridge.onSessionStart (lifecycle hook)
 *   before_agent_start -> shared bridge's onBeforeAgentStart (context provider),
 *                         mapped onto pi's `{ systemPrompt }` return
 *   turn_end           -> onTurnEnd, mapping pi's `event.toolResults`
 *   session_shutdown   -> onSessionShutdown, then provider.dispose() per provider
 *   (no pi event)      -> onSessionClose is INTENTIONALLY NOT WIRED. pi has no
 *                         event for "produce a close-time artifact before the
 *                         process exits" — that's driven today from the worker's
 *                         own process-shutdown signal handlers
 *                         (runProviderSessionClose in extension.ts), not from an
 *                         `ExtensionAPI.on(...)` event. Wiring it here would be
 *                         speculative; left unimplemented until pi grows an
 *                         equivalent event.
 *
 * All provider hook invocations (init, onSessionStart, onBeforeAgentStart,
 * onTurnEnd, onSessionShutdown, dispose) go through `withProviderTimeout`
 * (shared with ProviderBridge — see bridge.ts), so an already-aborted signal
 * or an expired timeout skips the hook rather than running it and discarding
 * the result, and shutdown can never hang indefinitely.
 */
function makeProviderContext(
  ctx: { signal?: AbortSignal; cwd: string },
  sessionFile: string,
  timeoutMs: number,
  overrides?: Partial<ProviderContext>,
): ProviderContext {
  return {
    signal: ctx.signal ?? new AbortController().signal,
    timeoutMs,
    // Matches providerExtension's production semantics (extension.ts):
    // sessionId is the external session identifier (env var), sessionFile is
    // pi's on-disk session file path — the two are never the same value.
    sessionId: process.env.PIZZAPI_SESSION_ID ?? process.env.SESSION_ID ?? "unknown",
    sessionFile,
    cwd: ctx.cwd,
    ...overrides,
  };
}

/** pi's `ImageContent` (`{ type, data, mimeType }`) -> ExtensionProvider's
 * `{ type, source: { type, mediaType, data } }`. Shapes look similar but
 * differ in nesting; a raw cast previously left providers reading
 * `image.source.data`/`.mediaType` as `undefined`. */
function translateImages(images?: ImageContent[]): BeforeAgentStartEvent["images"] {
  return images?.map((img) => ({
    type: "image" as const,
    source: { type: "base64" as const, mediaType: img.mimeType, data: img.data },
  }));
}

/**
 * Wraps one or more `ExtensionProvider`s as a single native pi `ExtensionFactory`.
 *
 * PURELY ADDITIVE / UNWIRED building block: not imported by `providerExtension`
 * or any other production entrypoint. Delegates timeout enforcement,
 * error-count auto-disable (3 consecutive errors), contribution sorting
 * (order, then providerId), and dedupe-state reset to a single shared
 * `ProviderBridge` instance holding *all* wrapped providers — so those
 * semantics can never drift from the existing multi-provider bridge, and
 * `order`-based contribution ordering is correct across all of them. Passing
 * providers to N separate `wrapProviderAsExtension()` calls each gets its own
 * private single-provider bridge, which sorts trivially (nothing to sort
 * against) — always pass every provider that must share ordering to *one*
 * call.
 *
 * Matches production's per-session bridge lifecycle (see providerExtension in
 * extension.ts): a fresh `ProviderBridge` is created on every `session_start`
 * and dropped on `session_shutdown`. This is required because the bridge
 * auto-disables a provider after 3 consecutive errors — if the same bridge
 * instance were reused across sessions, that disabled state (and error
 * counters) would leak into a brand-new session forever.
 *
 * `opts.timeoutMs` defaults to the same 5000ms the existing providerExtension
 * hardcodes; exposed as a param (not a config file) purely so tests can
 * exercise timeout enforcement without a real 5s wait.
 *
 * `opts.initContext` is a wiring point for callers whose providers need real
 * config/services in `init()` — it's merged onto the default no-op
 * `ProviderInitContext` (`config: {}`, `socket: null`, no-op
 * `fireTrigger`/`publishMetadata`). The adapter itself stays unwired to any
 * config source, per the PR description; this just gives callers somewhere
 * to plug one in instead of forcing a fork.
 */
export function wrapProviderAsExtension(
  providers: ExtensionProvider | ExtensionProvider[],
  opts?: { timeoutMs?: number; initContext?: Partial<ProviderInitContext> },
): ExtensionFactory {
  const providerList = Array.isArray(providers) ? providers : [providers];
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (pi: ExtensionAPI) => {
    // Recreated fresh on every session_start, cleared on session_shutdown —
    // never reused across sessions (see lifecycle note above).
    let bridge: ProviderBridge | null = null;
    let initialized = false;
    // Prompt/turn boundary tracking, mirrored from providerExtension
    // (extension.ts) so onTurnEnd sees the same promptId/turnId the prompt's
    // onBeforeAgentStart call generated, instead of always undefined/0.
    let currentPromptId: string | null = null;
    let currentTurnId = 0;

    pi.on("session_start", async (event, ctx) => {
      const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? "unknown";
      const initCtx = makeProviderContext(ctx, sessionFile, timeoutMs);
      if (!initialized) {
        for (const provider of providerList) {
          await withProviderTimeout(
            () => Promise.resolve(provider.init({
              config: {},
              fireTrigger: async () => {},
              socket: null,
              publishMetadata: () => {},
              ...opts?.initContext,
            })),
            initCtx,
            provider.id,
          );
        }
        initialized = true;
      }
      bridge = new ProviderBridge(providerList);
      const model = ctx.model
        ? { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name }
        : undefined;
      await bridge.onSessionStart(
        { reason: event.reason, previousSessionFile: event.previousSessionFile, model },
        initCtx,
      );
    });

    pi.on("before_agent_start", async (event, ctx) => {
      if (!bridge) return;
      currentPromptId = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      currentTurnId = 0;
      bridge.resetDedupeState();
      const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? "unknown";
      const result = await bridge.onBeforeAgentStart(
        { prompt: event.prompt, images: translateImages(event.images), systemPrompt: event.systemPrompt },
        makeProviderContext(ctx, sessionFile, timeoutMs, {
          promptId: currentPromptId,
          turnId: currentTurnId,
          isFirstTurn: true,
        }),
      );

      if (result.prepend.length === 0 && result.append.length === 0) return;

      const prependBlock = result.prepend.length > 0 ? result.prepend.join("\n") + "\n" : "";
      const appendBlock = result.append.length > 0 ? "\n" + result.append.join("\n") : "";
      return { systemPrompt: prependBlock + event.systemPrompt + appendBlock };
    });

    pi.on("turn_end", async (event, ctx) => {
      if (!bridge) return;
      currentTurnId++;
      const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? "unknown";
      await bridge.onTurnEnd(
        {
          turnIndex: event.turnIndex,
          message: {
            role: "assistant",
            content: typeof (event.message as any)?.content === "string"
              ? (event.message as any).content
              : JSON.stringify((event.message as any)?.content ?? ""),
          },
          toolResults: event.toolResults?.map((tr: any) => ({
            name: tr.toolName ?? "unknown",
            output: JSON.stringify(tr.content ?? tr.details ?? ""),
            isError: tr.isError ?? false,
          })),
        },
        makeProviderContext(ctx, sessionFile, timeoutMs, {
          promptId: currentPromptId ?? undefined,
          turnId: currentTurnId,
        }),
      );
    });

    pi.on("session_shutdown", async (event, ctx) => {
      // Guard on active state: a shutdown before any session_start, or two
      // shutdowns in a row, must be a no-op — nothing to notify or dispose.
      const activeBridge = bridge;
      const wasInitialized = initialized;
      if (!wasInitialized && !activeBridge) return;
      // Claim the lifecycle state synchronously, before the first await.
      // Two overlapping session_shutdown invocations both pass the guard
      // above before either reaches an await — resetting state only in a
      // `finally` (the old approach) left a TOCTOU window where the second
      // invocation would see stale `initialized`/`bridge` and re-run
      // onSessionShutdown()/dispose(). Resetting here means a concurrent
      // shutdown captures null/false locals and no-ops instead.
      initialized = false;
      bridge = null;
      const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? "unknown";
      // ProviderBridge.onSessionShutdown is bounded by ctx.timeoutMs/signal
      // (see bridge.ts) — a hung onSessionShutdown can no longer hang
      // dispose/reload/new/resume/quit indefinitely.
      const shutdownCtx = makeProviderContext(ctx, sessionFile, timeoutMs);
      if (activeBridge) {
        await activeBridge.onSessionShutdown(
          { reason: event.reason, targetSessionFile: event.targetSessionFile },
          shutdownCtx,
        );
      }
      // NOTE: onSessionClose is not called here — see module doc comment above.
      if (wasInitialized) {
        // Bounded per provider (withProviderTimeout) so one hung dispose()
        // can't hang shutdown forever. Promise.allSettled so one provider's
        // failing/timing-out dispose() doesn't block the rest from being
        // attempted — then the first failure (if any) re-throws, preserving
        // the previous single-provider behavior of surfacing dispose errors
        // to the caller unchanged.
        const results = await Promise.allSettled(
          providerList.map((provider) =>
            withProviderTimeout(() => Promise.resolve(provider.dispose()), shutdownCtx, provider.id),
          ),
        );
        const firstFailure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
        if (firstFailure) throw firstFailure.reason;
      }
    });
  };
}
