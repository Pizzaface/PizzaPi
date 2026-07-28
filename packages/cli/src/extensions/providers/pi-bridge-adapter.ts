import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { ProviderBridge } from "../../providers/bridge.js";
import { isContextProvider, isLifecycleHook } from "../../providers/types.js";
import type { ExtensionProvider, ProviderContext } from "../../providers/types.js";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Provider -> pi extension event mapping (see event-mapping.test.ts for the
 * exhaustive, assertable table):
 *
 *   session_start     -> provider.init() once, then onSessionStart (lifecycle hook)
 *   before_agent_start -> onBeforeAgentStart (context provider), mapped onto pi's
 *                         `{ systemPrompt }` return
 *   turn_end           -> onTurnEnd, mapping pi's `event.toolResults`
 *   session_shutdown   -> onSessionShutdown, then provider.dispose()
 *   (no pi event)      -> onSessionClose is INTENTIONALLY NOT WIRED. pi has no
 *                         event for "produce a close-time artifact before the
 *                         process exits" — that's driven today from the worker's
 *                         own process-shutdown signal handlers
 *                         (runProviderSessionClose in extension.ts), not from an
 *                         `ExtensionAPI.on(...)` event. Wiring it here would be
 *                         speculative; left unimplemented until pi grows an
 *                         equivalent event.
 */
function makeProviderContext(
  ctx: { signal?: AbortSignal; cwd: string },
  sessionId: string,
  timeoutMs: number,
  overrides?: Partial<ProviderContext>,
): ProviderContext {
  return {
    signal: ctx.signal ?? new AbortController().signal,
    timeoutMs,
    sessionId,
    cwd: ctx.cwd,
    ...overrides,
  };
}

/**
 * Wraps a single `ExtensionProvider` as a native pi `ExtensionFactory`.
 *
 * PURELY ADDITIVE / UNWIRED building block: not imported by `providerExtension`
 * or any other production entrypoint. Delegates timeout enforcement,
 * error-count auto-disable (3 consecutive errors), contribution sorting
 * (order, then providerId), and dedupe-state reset to a private
 * single-provider `ProviderBridge` instance so those semantics can never
 * drift from the existing multi-provider bridge — no reimplementation.
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
 */
export function wrapProviderAsExtension(
  provider: ExtensionProvider,
  opts?: { timeoutMs?: number },
): ExtensionFactory {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (pi: ExtensionAPI) => {
    // Recreated fresh on every session_start, cleared on session_shutdown —
    // never reused across sessions (see lifecycle note above).
    let bridge: ProviderBridge | null = null;
    let initialized = false;

    pi.on("session_start", async (event, ctx) => {
      if (!initialized) {
        await provider.init({
          config: {},
          fireTrigger: async () => {},
          socket: null,
          publishMetadata: () => {},
        });
        initialized = true;
      }
      bridge = new ProviderBridge([provider]);
      if (!isLifecycleHook(provider)) return;
      const sessionId = ctx.sessionManager?.getSessionFile?.() ?? "unknown";
      await bridge.onSessionStart(
        { reason: event.reason, previousSessionFile: event.previousSessionFile },
        makeProviderContext(ctx, sessionId, timeoutMs),
      );
    });

    pi.on("before_agent_start", async (event, ctx) => {
      if (!bridge) return;
      if (!isContextProvider(provider)) return;
      bridge.resetDedupeState();
      const sessionId = ctx.sessionManager?.getSessionFile?.() ?? "unknown";
      const result = await bridge.onBeforeAgentStart(
        { prompt: event.prompt, images: event.images as any, systemPrompt: event.systemPrompt },
        makeProviderContext(ctx, sessionId, timeoutMs, {
          promptId: `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          turnId: 0,
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
      if (!isLifecycleHook(provider)) return;
      const sessionId = ctx.sessionManager?.getSessionFile?.() ?? "unknown";
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
        makeProviderContext(ctx, sessionId, timeoutMs),
      );
    });

    pi.on("session_shutdown", async (event, ctx) => {
      if (bridge && isLifecycleHook(provider)) {
        const sessionId = ctx.sessionManager?.getSessionFile?.() ?? "unknown";
        await bridge.onSessionShutdown(
          { reason: event.reason, targetSessionFile: event.targetSessionFile },
          makeProviderContext(ctx, sessionId, timeoutMs),
        );
      }
      // NOTE: onSessionClose is not called here — see module doc comment above.
      await provider.dispose();
      initialized = false;
      // Drop the bridge so a new session_start builds a fresh one — error
      // counters and disabled-provider state must not leak across sessions.
      bridge = null;
    });
  };
}
