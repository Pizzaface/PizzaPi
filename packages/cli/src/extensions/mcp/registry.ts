/**
 * MCP client factory and tool registration.
 *
 * Responsibilities:
 *  - Parse MCP config (both `mcp.servers[]` and `mcpServers{}` formats)
 *  - Sandbox domain gating for URL-based servers
 *  - OAuth provider lifecycle management
 *  - Parallel init + tool listing with per-server timeouts
 *  - Registering MCP tools with the pi tool provider
 */

import { type PizzaPiConfig } from "../../config.js";
import { PizzaPiOAuthProvider, type RelayContext } from "../mcp-oauth.js";
import { createLogger, isSandboxActive, getResolvedConfig } from "@pizzapi/tools";
import { createStdioMcpClient } from "./transport-stdio.js";
import { createHttpMcpClient, createStreamableMcpClient } from "./transport-http.js";
import { allocateProviderSafeToolName } from "./tool-naming.js";
import { type McpClient, type McpTool } from "./types.js";

const log = createLogger("MCP");
const sandboxLog = createLogger("sandbox/mcp");

// ─────────────────────────────────────────────────────────────────────────────
// Config types
// ─────────────────────────────────────────────────────────────────────────────

export type McpConfig = {
  // Preferred format
  mcp?: {
    servers?: Array<
      | { name: string; transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; deferLoading?: boolean }
      | { name: string; transport: "http"; url: string; headers?: Record<string, string>; oauthClientName?: string; oauthClientId?: string; oauthClientSecret?: string; oauthCallbackPort?: number; deferLoading?: boolean }
      | { name: string; transport: "streamable"; url: string; headers?: Record<string, string>; oauthClientName?: string; oauthClientId?: string; oauthClientSecret?: string; oauthCallbackPort?: number; deferLoading?: boolean }
    >;
  };

  // Compatibility format (commonly used by MCP configs)
  // {
  //   "mcpServers": {
  //     "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
  //     "myserver":   { "url": "http://localhost:3000/mcp", "transport": "streamable" },
  //     "figma":      { "type": "http", "url": "https://mcp.figma.com/mcp", "oauthClientName": "Codex" }
  //   }
  // }
  //
  // Also supports the Claude Code / VS Code format where "type" is used
  // instead of "transport":
  //   "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" }
  //
  // Note: in the standard MCP ecosystem, type "http" means Streamable HTTP.
  mcpServers?: Record<
    string,
    | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string; deferLoading?: boolean }
    | { url: string; transport?: "http" | "streamable"; type?: "http" | "sse"; headers?: Record<string, string>; oauthClientName?: string; oauthClientId?: string; oauthClientSecret?: string; oauthCallbackPort?: number; deferLoading?: boolean }
  >;
};

// ─────────────────────────────────────────────────────────────────────────────
// OAuth provider lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/** Track active OAuth providers so the relay context can be injected later. */
const activeOAuthProviders: PizzaPiOAuthProvider[] = [];

/**
 * Controls whether newly created OAuth providers defer relay wait timeout
 * counting until markOAuthRelayWaitAnchorReady() is called.
 */
let deferOAuthRelayWaitTimeoutUntilAnchor = false;

/** Configure timeout anchoring behavior for subsequently created providers. */
export function setDeferOAuthRelayWaitTimeoutUntilAnchor(enabled: boolean): void {
  deferOAuthRelayWaitTimeoutUntilAnchor = enabled;
}

/**
 * Mark the relay wait timeout anchor as ready on all active OAuth providers.
 * Used by the MCP extension at session_start so timeout counting begins when
 * the relay has had a chance to register.
 */
export function markOAuthRelayWaitAnchorReady(): void {
  for (const provider of activeOAuthProviders) {
    provider.markRelayWaitAnchorReady();
  }
}

/** Get all active OAuth providers (used by the MCP extension to inject relay context). */
export function getOAuthProviders(): PizzaPiOAuthProvider[] {
  return activeOAuthProviders;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox domain gating
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether an MCP server URL is allowed by the sandbox MCP domain policy.
 * Returns true if the sandbox is inactive, the MCP policy has no allowedDomains,
 * or the URL's hostname is in the allowlist.
 *
 * Network-level domain filtering for MCP is enforced by srt's proxy when sandbox
 * is active in "full" mode (allowedDomains in the srt config). This function
 * provides an early application-level check using the same network.allowedDomains
 * list, so blocked connections fail fast with a helpful error rather than a
 * generic proxy timeout.
 */
function isMcpDomainAllowed(url: string, serverName: string): boolean {
  if (!isSandboxActive()) return true;
  const sandboxCfg = getResolvedConfig();
  if (!sandboxCfg || !sandboxCfg.srtConfig?.network) return true;

  const allowedDomains = sandboxCfg.srtConfig.network.allowedDomains;
  // Empty allowedDomains in full mode means deny-all network
  if (allowedDomains.length === 0) {
    sandboxLog.warn(`Blocked MCP server "${serverName}": no domains in allowedDomains (full mode). ` +
      `Add the domain to sandbox.network.allowedDomains in config.`,
    );
    return false;
  }

  try {
    const hostname = new URL(url).hostname.toLowerCase();

    // Check deniedDomains first — deny takes precedence over allow
    // Normalize to lowercase for case-insensitive DNS matching
    const deniedDomains = (sandboxCfg.srtConfig.network.deniedDomains ?? []).map(d => d.toLowerCase());
    if (deniedDomains.some(d => hostname === d || hostname.endsWith(`.${d.replace(/^\*\./, "")}`))) {
      sandboxLog.warn(`Blocked MCP server "${serverName}": domain "${hostname}" ` +
        `is in deniedDomains [${deniedDomains.join(", ")}]`,
      );
      return false;
    }

    const normalizedAllowed = allowedDomains.map(d => d.toLowerCase());
    if (normalizedAllowed.some(d => hostname === d || hostname.endsWith(`.${d.replace(/^\*\./, "")}`))) {
      return true;
    }
    sandboxLog.warn(`Blocked MCP server "${serverName}": domain "${hostname}" ` +
      `not in allowedDomains [${allowedDomains.join(", ")}]`,
    );
    return false;
  } catch {
    sandboxLog.warn(`Blocked MCP server "${serverName}": invalid URL "${url}"`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Client factory
// ─────────────────────────────────────────────────────────────────────────────

export async function createMcpClientsFromConfig(config: PizzaPiConfig & McpConfig): Promise<McpClient[]> {
  // Clean up stale OAuth providers from previous loads (e.g. /mcp reload).
  // This stops any active re-emit timers and prevents unbounded growth.
  for (const provider of activeOAuthProviders) {
    provider.closeCallback();
  }
  activeOAuthProviders.length = 0;

  const disabled = new Set(config.disabledMcpServers ?? []);
  const oauthClientName = config.oauthClientName;
  const oauthClientId = config.oauthClientId;
  const oauthClientSecret = config.oauthClientSecret;
  const oauthCallbackPort = config.oauthCallbackPort;

  const clients: McpClient[] = [];

  // Preferred format
  for (const s of config.mcp?.servers ?? []) {
    if (!s || typeof s !== "object") continue;
    if (disabled.has(s.name)) continue; // skip disabled servers
    if (s.transport === "stdio") {
      try {
        clients.push(
          await createStdioMcpClient({
            name: s.name,
            command: s.command,
            args: s.args,
            env: s.env,
            cwd: s.cwd,
          }),
        );
      } catch (err) {
        log.error(`Failed to create stdio client for "${s.name}": ${err}`);
      }
    } else if (s.transport === "http") {
      if (!isMcpDomainAllowed(s.url, s.name)) continue;
      clients.push(
        createHttpMcpClient({
          name: s.name,
          url: s.url,
          headers: s.headers,
        }),
      );
    } else if (s.transport === "streamable") {
      if (!isMcpDomainAllowed(s.url, s.name)) continue;
      // Per-server clientId/clientSecret are a pair: if per-server clientId is set,
      // use its paired secret (even if undefined) — don't leak the global secret
      // to a server with a different client identity.
      const sClientId = s.oauthClientId ?? oauthClientId;
      const sClientSecret = s.oauthClientId !== undefined ? s.oauthClientSecret : oauthClientSecret;
      const provider = new PizzaPiOAuthProvider({
        serverUrl: s.url,
        serverName: s.name,
        clientName: s.oauthClientName || oauthClientName,
        clientId: sClientId,
        clientSecret: sClientSecret,
        callbackPort: s.oauthCallbackPort ?? oauthCallbackPort,
        deferRelayWaitTimeoutUntilAnchor: deferOAuthRelayWaitTimeoutUntilAnchor,
      });
      activeOAuthProviders.push(provider);
      clients.push(
        createStreamableMcpClient({
          name: s.name,
          url: s.url,
          headers: s.headers,
          oauthProvider: provider,
        }),
      );
    }
  }

  // Compatibility format: mcpServers map
  const mcpServers = config.mcpServers ?? {};
  for (const [name, def] of Object.entries(mcpServers)) {
    if (!def || typeof def !== "object") continue;
    if (disabled.has(name)) continue; // skip disabled servers

    if ("command" in def && typeof (def as any).command === "string") {
      const d = def as { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
      try {
        clients.push(
          await createStdioMcpClient({
            name,
            command: d.command,
            args: d.args,
            env: d.env,
            cwd: d.cwd,
          }),
        );
      } catch (err) {
        log.error(`Failed to create stdio client for "${name}": ${err}`);
      }
      continue;
    }

    if ("url" in def && typeof (def as any).url === "string") {
      const d = def as { url: string; transport?: string; type?: string; headers?: Record<string, string>; oauthClientName?: string; oauthClientId?: string; oauthClientSecret?: string; oauthCallbackPort?: number };

      // Domain gating for URL-based MCP servers
      if (!isMcpDomainAllowed(d.url, name)) continue;

      // Determine transport mode:
      //  - "transport" field (our format): "streamable" → streamable, else plain HTTP
      //  - "type" field (Claude Code / VS Code format): "http" → streamable (per MCP spec)
      const useStreamable =
        d.transport === "streamable" ||
        (d.type === "http" && d.transport === undefined);

      if (useStreamable) {
        // Per-server clientId/clientSecret are a pair (see comment above)
        const dClientId = d.oauthClientId ?? oauthClientId;
        const dClientSecret = d.oauthClientId !== undefined ? d.oauthClientSecret : oauthClientSecret;
        const provider = new PizzaPiOAuthProvider({
          serverUrl: d.url,
          serverName: name,
          clientName: d.oauthClientName || oauthClientName,
          clientId: dClientId,
          clientSecret: dClientSecret,
          callbackPort: d.oauthCallbackPort ?? oauthCallbackPort,
          deferRelayWaitTimeoutUntilAnchor: deferOAuthRelayWaitTimeoutUntilAnchor,
        });
        activeOAuthProviders.push(provider);
        clients.push(createStreamableMcpClient({
          name,
          url: d.url,
          headers: d.headers,
          oauthProvider: provider,
        }));
      } else {
        clients.push(createHttpMcpClient({ name, url: d.url, headers: d.headers }));
      }
    }
  }

  return clients;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool registration
// ─────────────────────────────────────────────────────────────────────────────

/** Default timeout for MCP server tools/list calls: 30 seconds. */
const DEFAULT_MCP_TIMEOUT = 30_000;

/**
 * Default timeout for MCP server initialization (handshake + possible OAuth): 3 minutes.
 * This is intentionally much longer than the tool-listing timeout because
 * OAuth flows require user interaction (opening a browser, clicking through
 * consent screens). The OAuth callback server itself has a 2-minute timeout,
 * so 3 minutes gives enough headroom. For non-OAuth servers, the init
 * handshake completes in milliseconds — the timeout is just a safety net
 * against hung processes or stalled network endpoints.
 */
const DEFAULT_MCP_INIT_TIMEOUT = 180_000;

/** Per-server initialization result collected during parallel init. */
export type McpServerInitResult = {
  name: string;
  tools: McpTool[];
  error?: string;
  /** Time in milliseconds the server took to respond to tools/list */
  durationMs: number;
  timedOut: boolean;
};

/** Overall result of registerMcpTools() including per-server timing. */
export type McpRegistrationResult = {
  clients: McpClient[];
  toolCount: number;
  toolNames: string[];
  errors: Array<{ server: string; error: string }>;
  serverTools: Record<string, string[]>;
  /** Per-server timing breakdown. */
  serverTimings: McpServerInitResult[];
  /** Total wall-clock time for MCP initialization (ms). */
  totalDurationMs: number;
};

/**
 * List tools from a single MCP client with a timeout.
 * Returns the collected tools or an error if the server doesn't respond in time.
 *
 * When the timeout fires, the dangling listTools() promise is caught silently
 * to prevent unhandled rejection crashes (the child process will be killed by
 * the caller, which causes the pending request to reject).
 */
async function listToolsWithTimeout(
  client: McpClient,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ tools: McpTool[]; error?: string; timedOut: boolean }> {
  if (signal?.aborted) {
    try { client.close(); } catch {}
    return { tools: [], error: "MCP registration aborted", timedOut: false };
  }

  if (timeoutMs <= 0) {
    // Timeout disabled — but still honor the abort signal so session
    // shutdown can cancel an in-flight tools/list request.
    if (signal) {
      const listToolsPromise = client.listTools().then(
        (tools) => ({ tools, error: undefined as string | undefined, timedOut: false as const }),
        (err) => ({ tools: [] as McpTool[], error: err instanceof Error ? err.message : String(err), timedOut: false as const }),
      );
      const abortPromise = new Promise<{ tools: McpTool[]; error: string; timedOut: false }>((resolve) => {
        const onAbort = () => resolve({ tools: [], error: "MCP registration aborted", timedOut: false as const });
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      const result = await Promise.race([listToolsPromise, abortPromise]);
      if (result.error === "MCP registration aborted") {
        try { client.close(); } catch {}
        listToolsPromise.catch(() => {});
      }
      return result;
    }
    // No signal and no timeout — call directly
    try {
      const tools = await client.listTools();
      return { tools, timedOut: false };
    } catch (err) {
      return {
        tools: [],
        error: err instanceof Error ? err.message : String(err),
        timedOut: false,
      };
    }
  }

  // Keep a reference to the listTools promise so we can suppress its rejection
  // if the timeout/abort fires first (the child process will be killed,
  // causing the pending JSON-RPC request to reject with "server exited").
  const listToolsPromise = client.listTools().then(
    (tools) => ({ tools, error: undefined as string | undefined, timedOut: false as const }),
  );

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ tools: McpTool[]; error: string; timedOut: true }>((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve({ tools: [], error: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for tools/list`, timedOut: true }),
      timeoutMs,
    );
  });

  let onAbort: (() => void) | null = null;
  const abortPromise = signal
    ? new Promise<{ tools: McpTool[]; error: string; timedOut: false }>((resolve) => {
      onAbort = () => resolve({ tools: [], error: "MCP registration aborted", timedOut: false as const });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    })
    : null;

  const result = await (abortPromise
    ? Promise.race([listToolsPromise, timeoutPromise, abortPromise])
    : Promise.race([listToolsPromise, timeoutPromise]));

  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  if (signal && onAbort) signal.removeEventListener("abort", onAbort);

  if (result.timedOut || result.error === "MCP registration aborted") {
    // Close the client immediately to abort the in-flight request and prevent
    // it from establishing a remote MCP session that would never be cleaned up.
    try { client.close(); } catch {}
    // Suppress the dangling promise rejection that fires when the connection is killed
    listToolsPromise.catch(() => {});
  }

  return result;
}

export async function registerMcpTools(
  pi: any,
  config: PizzaPiConfig & McpConfig,
  relayContext?: RelayContext | null,
  signal?: AbortSignal,
): Promise<McpRegistrationResult> {
  const totalStart = Date.now();
  const clients = await createMcpClientsFromConfig(config);
  const empty: McpRegistrationResult = { clients: [], toolCount: 0, toolNames: [], errors: [], serverTools: {}, serverTimings: [], totalDurationMs: 0 };
  if (clients.length === 0) return { ...empty, totalDurationMs: Date.now() - totalStart };

  if (signal?.aborted) {
    for (const c of clients) {
      try { c.close(); } catch {}
    }
    return { ...empty, totalDurationMs: Date.now() - totalStart };
  }

  const closeAllClients = () => {
    for (const c of clients) {
      try { c.close(); } catch {}
    }
  };
  signal?.addEventListener("abort", closeAllClients);

  // Apply relay context to newly created OAuth providers before initialization.
  // During /mcp reload the relay is already connected, so providers need the
  // context immediately — otherwise waitForRelayContext() falls through to
  // local mode and OAuth opens in a local browser instead of the web UI.
  if (relayContext) {
    for (const provider of getOAuthProviders()) {
      provider.relayContext = relayContext;
    }
  }

  // Determine per-server timeouts from config (0 = disabled)
  const timeoutMs = typeof (config as any).mcpTimeout === "number" ? (config as any).mcpTimeout : DEFAULT_MCP_TIMEOUT;
  const initTimeoutMs = typeof (config as any).mcpInitTimeout === "number" ? (config as any).mcpInitTimeout : DEFAULT_MCP_INIT_TIMEOUT;

  // ── Initialize, list tools, and register — progressively per server ─────
  //
  // Each server initializes (may trigger OAuth which requires user interaction
  // and can take minutes), lists its tools, and registers them with pi
  // immediately — without waiting for slower servers. This prevents a single
  // slow/hung server (e.g. Figma OAuth waiting for user paste) from blocking
  // all other MCP tools from being available.
  //
  // Shared state (usedToolNames, toolCount, etc.) is safe without a mutex
  // because tool registration is synchronous (`pi.registerTool` is sync) and
  // the only contended resource is `usedToolNames` which is only written to
  // in the synchronous registration loop after each server's async phase.
  // JavaScript's single-threaded event loop guarantees these sync sections
  // don't interleave.
  let toolCount = 0;
  const toolNames: string[] = [];
  const errors: Array<{ server: string; error: string }> = [];
  const usedToolNames = new Set<string>();
  const serverTools: Record<string, string[]> = {};
  const liveClients: McpClient[] = [];

  // Helper: run a single server through init → listTools → registerTool.
  function initAndRegisterServer(client: McpClient): Promise<McpServerInitResult> {
    const start = Date.now();
    return (async (): Promise<McpServerInitResult> => {
      try {
        if (signal?.aborted) {
          try { client.close(); } catch {}
          return { name: client.name, tools: [], error: "MCP registration aborted", durationMs: Date.now() - start, timedOut: false };
        }
        // Initialize the MCP handshake (+ any OAuth) with a generous timeout.
        // OAuth flows have their own 2-min callback timeout; the init timeout
        // (default 3 min) is a safety net against hung processes / stalled
        // endpoints that would otherwise block forever.
        if (initTimeoutMs > 0) {
          const ac = new AbortController();
          const onOuterAbort = () => ac.abort();
          signal?.addEventListener("abort", onOuterAbort, { once: true });
          let timer: ReturnType<typeof setTimeout> | undefined;
          const initPromise = client.initialize(ac.signal);
          try {
            const initTimer = new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(
                `Timed out after ${Math.round(initTimeoutMs / 1000)}s waiting for MCP initialize handshake`,
              )), initTimeoutMs);
            });
            await Promise.race([initPromise, initTimer]);
          } catch (err) {
            ac.abort();
            try { client.close(); } catch {}
            initPromise.catch(() => {});
            throw err;
          } finally {
            signal?.removeEventListener("abort", onOuterAbort);
            if (timer !== undefined) clearTimeout(timer);
          }
        } else {
          if (signal?.aborted) throw new Error("MCP registration aborted");
          const ac = new AbortController();
          const onOuterAbort = () => ac.abort();
          signal?.addEventListener("abort", onOuterAbort, { once: true });
          try {
            await client.initialize(ac.signal);
          } catch (err) {
            ac.abort();
            try { client.close(); } catch {}
            throw err;
          } finally {
            signal?.removeEventListener("abort", onOuterAbort);
          }
        }

        // List tools (separate timeout from init).
        const { tools, error, timedOut } = await listToolsWithTimeout(client, timeoutMs, signal);
        const durationMs = Date.now() - start;
        if (error) {
          return { name: client.name, tools: [], error, durationMs, timedOut };
        }

        // Register this server's tools immediately so the agent can use them.
        if (!signal?.aborted) {
          liveClients.push(client);
          const serverToolList: string[] = [];
          serverTools[client.name] = serverToolList;

          for (const tool of tools) {
            if (!tool?.name) continue;

            const sourceName = `mcp:${client.name}:${tool.name}`;
            const toolName = allocateProviderSafeToolName(client.name, tool.name, usedToolNames);

            toolCount++;
            toolNames.push(toolName);
            serverToolList.push(toolName);

            const parameters = (tool.inputSchema ?? { type: "object", additionalProperties: true }) as any;
            if (parameters && typeof parameters === "object" && "$schema" in parameters) {
              delete parameters.$schema;
            }

            pi.registerTool({
              name: toolName,
              label: `${client.name}:${tool.name}`,
              description: tool.description
                ? `${tool.description} (source: ${sourceName})`
                : `MCP tool from ${client.name} (source: ${sourceName})`,
              parameters,
              async execute(_toolCallId: string, rawParams: unknown, signal: AbortSignal | undefined) {
                const result = await client.callTool(tool.name, rawParams ?? {}, signal);
                if (result && typeof result === "object" && "content" in result) {
                  return (result as any);
                }
                return { content: result };
              },
            });
          }

          // Notify extensions that the registry snapshot changed so they can
          // resync against late or background MCP completion.
          pi.events?.emit?.("mcp:registry_updated", {
            server: client.name,
            toolCount: serverToolList.length,
            totalToolCount: toolCount,
          });
        }

        return { name: client.name, tools, durationMs, timedOut };
      } catch (err) {
        const durationMs = Date.now() - start;
        return {
          name: client.name,
          tools: [],
          error: err instanceof Error ? err.message : String(err),
          durationMs,
          timedOut: false,
        };
      }
    })();
  }

  // ── Launch all servers in parallel ───────────────────────────────────────
  //
  // Each server independently inits → lists tools → registers tools with pi.
  // Fast servers (stdio, non-OAuth) finish in seconds. Slow servers (OAuth
  // waiting for user interaction) may take minutes.
  //
  // We return as soon as ALL servers have either completed OR been deferred
  // to the background. The grace period gives fast servers time to finish
  // so their results appear in the startup report. Slow servers continue
  // in the background — their tools appear when they eventually resolve.
  const serverPromises = clients.map((client) => initAndRegisterServer(client));

  // Track which servers are still pending.
  const settled = new Array<McpServerInitResult | null>(clients.length).fill(null);
  const wrappedPromises = serverPromises.map(async (p, i) => {
    const result = await p;
    settled[i] = result;
    return result;
  });

  // Wait up to a short grace period for all servers. If some are still
  // pending (e.g. OAuth waiting for paste), return immediately with what
  // we have. The slow servers continue in the background.
  const GRACE_MS = 10_000; // 10s — enough for stdio + non-OAuth HTTP servers
  const graceTimer = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), GRACE_MS),
  );

  const allDone = Promise.all(wrappedPromises).then(() => "done" as const);
  const raceResult = await Promise.race([allDone, graceTimer]);

  // If all servers finished within the grace period, we have all results.
  // Otherwise, collect what's settled and let the rest continue in background.
  let initResults: McpServerInitResult[];

  if (raceResult === "done") {
    initResults = settled as McpServerInitResult[];
  } else {
    // Grace period expired — collect settled results, mark pending as deferred.
    initResults = settled.map((result, i) => {
      if (result) return result;
      // This server is still pending — mark it as deferred in the report.
      return {
        name: clients[i].name,
        tools: [],
        error: undefined,
        durationMs: Date.now() - totalStart,
        timedOut: false,
        deferred: true,
      } as McpServerInitResult & { deferred?: boolean };
    });

    // Let slow servers continue in the background. When they finish, their
    // tools are already registered (inside initAndRegisterServer). We just
    // need to handle errors/cleanup for ones that eventually fail.
    //
    // Keep the abort listener alive so that load() aborting the signal
    // (e.g. on /mcp disable) kills the background clients and cancels
    // their in-flight OAuth flows.
    Promise.all(wrappedPromises).then((finalResults) => {
      signal?.removeEventListener("abort", closeAllClients);
      for (let i = 0; i < finalResults.length; i++) {
        if (settled[i] !== null && !finalResults[i].error) continue; // already handled
        const result = finalResults[i];
        if (result.error) {
          const client = clients[i];
          if (client && !liveClients.includes(client)) {
            try { client.close(); } catch {}
          }
          // Log non-auth background failures. OAuth/auth errors are already surfaced
          // to the user via web UI events (mcp:auth_required / mcp:auth_paste_required),
          // so there's no need to repeat them as noisy console output.
          const errStr = String(result.error);
          const isAuthError = /oauth|authentication|auth callback/i.test(errStr);
          if (!isAuthError) {
            log.warn(`pizzapi: MCP server "${result.name}" failed in background: ${result.error}`);
          }
        }
      }
    }).catch(() => {
      signal?.removeEventListener("abort", closeAllClients);
    });
  }

  if (signal?.aborted) {
    closeAllClients();
    signal.removeEventListener("abort", closeAllClients);
    return { ...empty, totalDurationMs: Date.now() - totalStart, serverTimings: initResults };
  }

  // Collect errors from servers that failed init/listing (tools were not registered).
  for (const result of initResults) {
    if (result.error) {
      errors.push({ server: result.name, error: result.error });
      const client = clients.find((c) => c.name === result.name);
      if (client && !liveClients.includes(client)) {
        try { client.close(); } catch {}
      }
    }
  }

  // Best-effort shutdown — includes background servers that resolve later.
  pi.on?.("session_shutdown", () => {
    for (const c of liveClients) c.close();
  });

  const totalDurationMs = Date.now() - totalStart;
  // NOTE: don't removeEventListener("abort", closeAllClients) here — background
  // tasks may still be running. The listener is cleaned up when they finish.
  // For the "all done within grace" path, clean up now since no background work exists.
  if (raceResult === "done") {
    signal?.removeEventListener("abort", closeAllClients);
  }
  return { clients: liveClients, toolCount, toolNames, errors, serverTools, serverTimings: initResults, totalDurationMs };
}
