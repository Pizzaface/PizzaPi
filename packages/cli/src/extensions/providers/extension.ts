import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProviderBridge } from "../../providers/bridge";
import type { ProviderContext, SessionCloseResult } from "../../providers/types";

let bridge: ProviderBridge | null = null;
/** Provider instances tracked separately for disposal (bridge doesn't own lifecycle). */
let providerInstances: Array<{ id: string; dispose(): Promise<void> | void }> = [];
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
  ctx: { signal?: AbortSignal; cwd: string },
  overrides?: Partial<ProviderContext>,
): ProviderContext {
  return {
    signal: ctx.signal ?? new AbortController().signal,
    timeoutMs: 5000,
    sessionId: "unknown",
    cwd: ctx.cwd,
    ...overrides,
  };
}

/**
 * Called by the daemon when a session is being archived.
 * Returns the close result if any provider handles it, or null.
 */
export async function triggerSessionClose(
  sessionId: string,
  sessionFile: string,
  reason: "close" | "error" | "complete",
  cwd: string,
): Promise<SessionCloseResult | null> {
  if (!bridge) return null;
  return bridge.onSessionClose(
    { reason, sessionFile },
    {
      signal: new AbortController().signal,
      timeoutMs: 5000,
      sessionId,
      sessionFile,
      cwd,
    },
  );
}

export async function providerExtension(pi: ExtensionAPI) {
  // ── Session Start: discover and init providers ────────────────
  pi.on("session_start", async (event, ctx) => {
    const { discoverProviders } = await import("../../providers/loader");

    const result = await discoverProviders({
      cwd: ctx.cwd,
      allowProject: false, // TODO: wire from config.json allowProjectProviders
    });
    for (const err of result.errors) {
      console.error(`[provider-extension] Load error: ${err.path} — ${err.error}`);
    }

    const configs = loadProviderConfig();
    const enabledProviders = result.providers.filter(({ provider }) => {
      const cfg = configs[provider.id];
      if (cfg?.enabled === false) {
        console.log(`[provider-extension] Skipping disabled provider "${provider.id}"`);
        return false;
      }
      return true;
    });

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
        console.log(`[provider-extension] Initialized provider "${provider.id}"`);
      } catch (err) {
        console.error(`[provider-extension] Failed to init "${provider.id}":`, err);
      }
    }

    providerInstances = instances;
    bridge = new ProviderBridge(enabledProviders.map((p) => p.provider));

    // Reset prompt tracking
    currentPromptId = null;
    currentTurnId = 0;

    // Notify lifecycle providers
    await bridge.onSessionStart(
      { reason: event.reason as "startup", previousSessionFile: event.previousSessionFile },
      makeProviderContext(ctx, { sessionFile: ctx.sessionManager?.getSessionFile?.() ?? undefined }),
    );
  });

  // ── Before Agent Start: inject context ────────────────────────
  pi.on("before_agent_start", async (event, ctx) => {
    if (!bridge) return;

    // Start a new prompt boundary
    currentPromptId = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    currentTurnId = 0;

    const result = await bridge.onBeforeAgentStart(
      { prompt: event.prompt, images: event.images as any, systemPrompt: event.systemPrompt },
      makeProviderContext(ctx, { promptId: currentPromptId, turnId: 0, isFirstTurn: true }),
    );

    if (result.prepend.length === 0 && result.append.length === 0) return;

    // Inject prepended text after pi's preamble, appended text before user appendSystemPrompt.
    // We split the system prompt at the first tool listing or guideline marker if present,
    // otherwise we prepend/append to the full prompt.
    const prependBlock = result.prepend.length > 0
      ? `\n${result.prepend.join("\n")}\n`
      : "";
    const appendBlock = result.append.length > 0
      ? `\n${result.append.join("\n")}\n`
      : "";

    return { systemPrompt: prependBlock + event.systemPrompt + appendBlock };
  });

  // ── Turn End: incremental indexing ────────────────────────────
  pi.on("turn_end", async (event, ctx) => {
    if (!bridge) return;

    currentTurnId++;

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
      makeProviderContext(ctx, { promptId: currentPromptId ?? undefined, turnId: currentTurnId }),
    );
  });

  // ── Session Shutdown: dispose providers ───────────────────────
  pi.on("session_shutdown", async (event, ctx) => {
    if (bridge) {
      // SessionClose is called separately by daemon before session_shutdown.
      // Here we only notify shutdown and dispose.
      await bridge.onSessionShutdown(
        { reason: event.reason as "quit", targetSessionFile: event.targetSessionFile },
        makeProviderContext(ctx),
      );
    }

    for (const instance of providerInstances) {
      try {
        await instance.dispose();
      } catch (err) {
        console.error(`[provider-extension] Error disposing ${instance.id}:`, err);
      }
    }

    bridge = null;
    providerInstances = [];
    currentPromptId = null;
    currentTurnId = 0;
  });
}

export default providerExtension;
