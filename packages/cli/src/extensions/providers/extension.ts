import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProviderBridge } from "../../providers/bridge";
import type { ProviderContext, SessionCloseResult } from "../../providers/types";
import { loadGlobalConfig } from "../../config/io";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("provider-extension");

let bridge: ProviderBridge | null = null;
/** Provider instances tracked separately for disposal (bridge doesn't own lifecycle). */
let providerInstances: Array<{ id: string; dispose(): Promise<void> | void }> = [];
/** Last-known session identity for close-time context (updated on session_start/turn_end). */
let currentSessionInfo: { sessionFile?: string; cwd?: string } | null = null;
/**
 * Cached in-flight/completed close promise so concurrent shutdown paths
 * (signal handler + extension shutdownHandler) share one close instead of
 * racing: the second caller awaits the SAME promise rather than seeing a
 * "completed" flag and returning early while the first close is still
 * running (which let callers proceed to process.exit() mid-close).
 */
let sessionClosePromise: Promise<SessionCloseResult | null> | null = null;
/** Current prompt boundary ID — generated once per user prompt. */
let currentPromptId: string | null = null;
/** Turn counter within the current prompt. Reset on new prompt. */
let currentTurnId = 0;

export function loadProviderConfig(): Record<string, Record<string, unknown>> {
  const configPath = join(process.env.HOME || homedir(), ".pizzapi", "config.json");
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      const providers = raw?.providers;
      if (providers && typeof providers === "object" && !Array.isArray(providers)) {
        return providers;
      }
    }
  } catch {}
  return {};
}

function makeProviderContext(
  ctx: { signal?: AbortSignal; cwd: string; sessionId?: string },
  overrides?: Partial<ProviderContext>,
): ProviderContext {
  return {
    signal: ctx.signal ?? new AbortController().signal,
    timeoutMs: 5000,
    sessionId: ctx.sessionId ?? process.env.PIZZAPI_SESSION_ID ?? process.env.SESSION_ID ?? "unknown",
    cwd: ctx.cwd,
    ...overrides,
  };
}

/**
 * Run provider onSessionClose hooks in-process, from the worker's own
 * shutdown paths (SIGTERM/SIGINT/IPC shutdown and extension-initiated
 * shutdownHandler). This MUST run in the worker process: `bridge` is a
 * module-global initialized by providerExtension's session_start handler,
 * so a daemon-side import of this module sees `null` (that cross-process
 * call was a guaranteed no-op — see idea jg017xa4).
 *
 * Idempotent: only the first invocation runs providers; concurrent/later
 * calls await and share that same invocation's result rather than racing
 * ahead (see sessionClosePromise). Bounded: default 2.5s overall — one
 * deadline for the whole (possibly multi-provider) close, not per provider
 * — so the worker stays inside the daemon's SIGTERM→SIGKILL escalation
 * window.
 */
export async function runProviderSessionClose(
  reason: "close" | "error" | "complete",
  opts?: { timeoutMs?: number },
): Promise<SessionCloseResult | null> {
  if (sessionClosePromise) return sessionClosePromise;
  sessionClosePromise = doRunProviderSessionClose(reason, opts);
  return sessionClosePromise;
}

async function doRunProviderSessionClose(
  reason: "close" | "error" | "complete",
  opts?: { timeoutMs?: number },
): Promise<SessionCloseResult | null> {
  if (!bridge) return null;
  const sessionId = process.env.PIZZAPI_SESSION_ID ?? process.env.SESSION_ID ?? "unknown";
  const sessionFile = currentSessionInfo?.sessionFile ?? sessionId;
  const cwd = currentSessionInfo?.cwd ?? process.cwd();
  const timeoutMs = opts?.timeoutMs ?? 2500;
  const deadline = Date.now() + timeoutMs;
  // Overall deadline is enforced twice: the bridge's own Promise.race stops
  // WAITING on a slow provider, but a well-behaved hook can also watch
  // ctx.signal and cancel its own in-flight work — abort it here so hooks
  // that honor AbortSignal get a chance to clean up rather than being cut off.
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await bridge.onSessionClose(
      { reason, sessionFile },
      {
        signal: controller.signal,
        timeoutMs,
        deadline,
        sessionId,
        sessionFile,
        cwd,
      },
    );
    if (result) {
      log.info(`Provider close: ${result.label}`);
    }
    return result;
  } catch (err) {
    log.error("Provider close failed:", err);
    return null;
  } finally {
    clearTimeout(abortTimer);
    controller.abort();
  }
}

/** Test-only: inject a bridge without running provider discovery. */
export function __setBridgeForTest(b: ProviderBridge | null): void {
  bridge = b;
  sessionClosePromise = null;
}

export async function providerExtension(pi: ExtensionAPI) {
  // ── Session Start: discover and init providers ────────────────
  pi.on("session_start", async (event, ctx) => {
    const { discoverProviders } = await import("../../providers/loader");

    const result = await discoverProviders({
      cwd: ctx.cwd,
      allowProject: loadGlobalConfig().allowProjectProviders === true,
    });
    for (const err of result.errors) {
      log.error(`Load error: ${err.path} — ${err.error}`);
    }

    // Dispose any providers from a prior session (defensive — session_shutdown
    // normally handles this, but ensure cleanup if session_start fires twice).
    for (const instance of providerInstances) {
      try {
        await instance.dispose();
      } catch (err) {
        log.error(`Error disposing ${instance.id} on re-init:`, err);
      }
    }
    providerInstances = [];

    const configs = loadProviderConfig();
    const enabledProviders = result.providers.filter(({ provider }) => {
      const cfg = configs[provider.id];
      if (cfg?.enabled === false) {
        log.info(`Skipping disabled provider "${provider.id}"`);
        return false;
      }
      return true;
    });

    currentSessionInfo = {
      sessionFile: ctx.sessionManager?.getSessionFile?.() ?? undefined,
      cwd: ctx.cwd,
    };
    sessionClosePromise = null;

    if (enabledProviders.length === 0) {
      bridge = null;
      providerInstances = [];
      return;
    }

    const instances: Array<{ id: string; dispose(): Promise<void> | void }> = [];

    for (const { provider } of enabledProviders) {
      try {
        await provider.init({
          config: configs[provider.id] ?? {},
          fireTrigger: async () => {},
          socket: null,
          publishMetadata: () => {},
        });
        instances.push(provider);
        log.info(`Initialized provider "${provider.id}"`);
      } catch (err) {
        log.error(`Failed to init "${provider.id}":`, err);
      }
    }

    providerInstances = instances;
    const successfulProviders = instances.map((i) => i.id);
    const bridgeProviders = enabledProviders
      .map((p) => p.provider)
      .filter((p) => successfulProviders.includes(p.id));
    bridge = new ProviderBridge(bridgeProviders);

    // Reset prompt tracking
    currentPromptId = null;
    currentTurnId = 0;

    // Notify lifecycle providers
    const modelInfo = ctx.model
      ? { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name }
      : undefined;
    await bridge.onSessionStart(
      { reason: event.reason as "startup", previousSessionFile: event.previousSessionFile, model: modelInfo },
      makeProviderContext(ctx, { sessionFile: ctx.sessionManager?.getSessionFile?.() ?? undefined }),
    );
  });

  // ── Before Agent Start: inject context ────────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    if (!bridge) return;

    // Start a new prompt boundary
    currentPromptId = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    currentTurnId = 0;
    bridge.resetDedupeState();

    const result = await bridge.onBeforeAgentStart(
      { prompt: event.prompt, images: event.images as any, systemPrompt: event.systemPrompt },
      makeProviderContext(ctx, { promptId: currentPromptId, turnId: 0, isFirstTurn: true }),
    );

    if (result.prepend.length === 0 && result.append.length === 0) return;

    const prependBlock = result.prepend.length > 0
      ? "\n<!-- Provider Context -->\n" + result.prepend.join("\n") + "\n<!-- End Provider Context -->\n"
      : "";
    const appendBlock = result.append.length > 0
      ? `\n${result.append.join("\n")}\n`
      : "";

    // Insert prepended text after the leading preamble. Pi's prompt structure is
    // not formally parseable here, so use a conservative preamble window.
    const lines = event.systemPrompt.split("\n");
    const preambleEnd = Math.min(3, Math.floor(lines.length / 4));
    const before = lines.slice(0, preambleEnd).join("\n");
    const after = lines.slice(preambleEnd).join("\n");

    const newPrompt = before + "\n" + prependBlock + after + appendBlock;
    return { systemPrompt: newPrompt };
  });

  // ── Turn End: incremental indexing ────────────────────────────
  pi.on("turn_end", async (event, ctx) => {
    if (!bridge) return;

    currentTurnId++;

    // Keep close-time context fresh — headless switchSession/newSession may
    // swap the session file without a session_start in this process.
    currentSessionInfo = {
      sessionFile: ctx.sessionManager?.getSessionFile?.() ?? currentSessionInfo?.sessionFile,
      cwd: ctx.cwd ?? currentSessionInfo?.cwd,
    };

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
      makeProviderContext(ctx, { promptId: currentPromptId ?? undefined, turnId: currentTurnId, sessionFile: ctx.sessionManager?.getSessionFile?.() ?? undefined }),
    );
  });

  // ── Session Shutdown: dispose providers ───────────────────────
  pi.on("session_shutdown", async (event, ctx) => {
    // Claim the lifecycle state synchronously, before the first await, so
    // repeated/overlapping session_shutdown events can't both see the same
    // bridge/instances and double-dispose (mirrors pi-bridge-adapter.ts).
    // Reset unconditionally up front — a later onSessionShutdown/dispose
    // rejection must never leave stale module-global state behind for the
    // next session_start to trip over.
    const activeBridge = bridge;
    const instances = providerInstances;
    bridge = null;
    providerInstances = [];
    currentPromptId = null;
    currentTurnId = 0;
    sessionClosePromise = null;

    try {
      if (activeBridge) {
        // SessionClose runs from the worker's process shutdown paths (see
        // runProviderSessionClose). Here we only notify shutdown and dispose.
        await activeBridge.onSessionShutdown(
          { reason: event.reason as "quit", targetSessionFile: event.targetSessionFile },
          makeProviderContext(ctx),
        );
      }
    } catch (err) {
      log.error("Error in provider onSessionShutdown:", err);
    }

    // Dispose every claimed instance regardless of shutdown-hook or sibling
    // dispose failures — a stuck/errored provider must not block cleanup of
    // the rest.
    for (const instance of instances) {
      try {
        await instance.dispose();
      } catch (err) {
        log.error(`Error disposing ${instance.id}:`, err);
      }
    }
  });
}

export default providerExtension;
