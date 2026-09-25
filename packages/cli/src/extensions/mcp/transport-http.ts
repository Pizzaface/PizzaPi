/**
 * HTTP-based MCP transports:
 *  - Plain HTTP (legacy / simple servers): createHttpMcpClient
 *  - Streamable HTTP (MCP spec 2025-03-26): createStreamableMcpClient
 *
 * Also contains environment-token detection (used as a fallback before
 * starting a full OAuth flow) and the isGitHubHost helper.
 */

import { type PizzaPiOAuthProvider } from "../mcp-oauth.js";
import {
  MCP_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_MODERN_ERROR_CODES,
  MCP_SUPPORTED_VERSIONS,
  MCP_CLIENT_INFO,
  modernRequestMeta,
  MCP_ELICITATION_CAPABILITY,
  isRecord,
  type McpClient,
  type McpListToolsResult,
  type McpCallToolResult,
  type McpElicitationHandler,
} from "./types.js";
import { requestWithMrtr } from "./mrtr.js";

// ─────────────────────────────────────────────────────────────────────────────
// HTTP client (plain JSON POST — legacy / simple servers)
// ─────────────────────────────────────────────────────────────────────────────

function hasHeaderAnnotation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => key === "x-mcp-header" || hasHeaderAnnotation(child));
}

function encodeHeaderValue(value: string): string {
  return /^[\x20-\x7e\t]*$/.test(value) && value.trim() === value && !(value.startsWith("=?base64?") && value.endsWith("?="))
    ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function createHttpMcpClient(opts: { name: string; url: string; headers?: Record<string, string> }): McpClient {
  // Modern MCP requires both JSON and SSE, even for "http" configurations.
  return createStreamableMcpClient(opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment token detection (used as fallback before full OAuth)
// ─────────────────────────────────────────────────────────────────────────────

type EnvironmentToken = { token: string; source: string };

/** Trusted GitHub hostnames for automatic token detection. */
const GITHUB_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "api.githubcopilot.com",
]);

/**
 * Check whether a URL points to a known GitHub host.
 * Uses exact hostname matching (or `.github.com` suffix) to prevent
 * token exfiltration to attacker-controlled URLs like `github.evil.com`.
 */
export function isGitHubHost(serverUrl: string): boolean {
  try {
    const hostname = new URL(serverUrl).hostname.toLowerCase();
    return GITHUB_HOSTS.has(hostname) || hostname.endsWith(".github.com");
  } catch {
    return false;
  }
}

/**
 * Try to find an existing token that might work for the given MCP server URL.
 * Checks environment variables and CLI tools (e.g. `gh auth token`).
 */
async function detectEnvironmentToken(serverUrl: string): Promise<EnvironmentToken | null> {
  // GitHub-specific: check env vars and `gh` CLI.
  // Use strict hostname matching to prevent token exfiltration to attacker-controlled URLs.
  const isGitHub = isGitHubHost(serverUrl);
  if (isGitHub) {
    // GITHUB_TOKEN is the standard env var
    if (process.env.GITHUB_TOKEN) {
      return { token: process.env.GITHUB_TOKEN, source: "GITHUB_TOKEN env var" };
    }
    // GH_TOKEN is used by the GitHub CLI
    if (process.env.GH_TOKEN) {
      return { token: process.env.GH_TOKEN, source: "GH_TOKEN env var" };
    }
    // Try `gh auth token` as a last resort
    try {
      const proc = Bun.spawn(["gh", "auth", "token"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const text = await new Response(proc.stdout).text();
      const token = text.trim();
      if (token && token.startsWith("gh")) {
        return { token, source: "gh CLI (gh auth token)" };
      }
    } catch {
      // gh not installed or not authenticated — skip
    }
  }

  // Generic: check for MCP_TOKEN or MCP_ACCESS_TOKEN
  if (process.env.MCP_TOKEN) {
    return { token: process.env.MCP_TOKEN, source: "MCP_TOKEN env var" };
  }
  if (process.env.MCP_ACCESS_TOKEN) {
    return { token: process.env.MCP_ACCESS_TOKEN, source: "MCP_ACCESS_TOKEN env var" };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Streamable client (MCP spec 2025-03-26)
//
// Sends JSON-RPC over POST with Accept: application/json, text/event-stream.
// The server may respond with either:
//   - application/json  → single JSON-RPC response (handled like plain HTTP)
//   - text/event-stream → SSE stream; we read until we find the matching id
//
// Session lifecycle:
//   - Server may return mcp-session-id on any response; we attach it to all
//     subsequent requests.
//   - close() sends DELETE to the endpoint so the server can clean up.
// ─────────────────────────────────────────────────────────────────────────────

export function createStreamableMcpClient(opts: {
  name: string;
  url: string;
  headers?: Record<string, string>;
  oauthProvider?: PizzaPiOAuthProvider;
}): McpClient {
  let nextId = 1;
  let sessionId: string | undefined;
  let closed = false;
  let modern = false;
  const lifetime = new AbortController();
  const oauthProvider = opts.oauthProvider;

  function buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(opts.headers),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(extra),
    };

    // Attach stored OAuth access token if available
    if (oauthProvider?.getAccessToken() && !h["Authorization"]) {
      h["Authorization"] = `Bearer ${oauthProvider.getAccessToken()}`;
    }

    return h;
  }

  async function parseSSE(res: Response, targetId: number, signal?: AbortSignal): Promise<any> {
    if (!res.body) throw new Error("MCP streamable: response body is null");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const abortHandler = () => reader.cancel().catch(() => {});
    signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by blank lines (\n\n or \r\n\r\n)
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";

        for (const event of events) {
          // Collect all "data:" lines within this event block
          let data = "";
          for (const line of event.split(/\r?\n/)) {
            if (line.startsWith("data:")) {
              data += line.slice(5).trimStart();
            }
          }
          if (!data) continue;

          let msg: any;
          try {
            msg = JSON.parse(data);
          } catch {
            continue;
          }

          if (!isRecord(msg)) continue;

          // A server request is never a response, even if its id collides.
          if ("id" in msg && typeof msg.method === "string") throw new Error("MCP server-initiated requests are not supported");
          if (!("id" in msg)) continue;

          if (msg.id === targetId || msg.id === String(targetId)) {
            if (msg.error) throw Object.assign(new Error(String((msg.error as any)?.message ?? "MCP error")), msg.error);
            return (msg as any).result;
          }
        }
      }
    } finally {
      signal?.removeEventListener("abort", abortHandler);
      reader.cancel().catch(() => {});
    }

    throw new Error("MCP streamable: SSE stream ended without a matching response");
  }

  async function rawRequest(method: string, params?: any, signal?: AbortSignal, modernRequest = modern) {
    if (method !== "server/discover") return rawRequestImpl(method, params, signal, modernRequest);
    const probe = new AbortController();
    const timer = setTimeout(() => probe.abort(new DOMException("MCP discovery timed out", "TimeoutError")), 1000);
    try {
      return await rawRequestImpl(method, params, signal ? AbortSignal.any([signal, probe.signal]) : probe.signal, modernRequest);
    } catch (err) {
      if (probe.signal.aborted && !signal?.aborted) throw probe.signal.reason;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function rawRequestImpl(method: string, params?: any, signal?: AbortSignal, modernRequest = modern): Promise<{ result: any; status: number; response: Response; rpcError?: any }> {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };

    const res = await fetch(opts.url, {
      method: "POST",
      headers: buildHeaders(modernRequest ? {
        "MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION,
        "Mcp-Method": method,
        ...(typeof params?.name === "string" ? { "Mcp-Name": encodeHeaderValue(params.name) } : {}),
      } : undefined),
      body: JSON.stringify(payload),
      signal,
    });

    // Capture / update session ID.
    // If the client was already closed (e.g. init timeout fired while this
    // request was in flight), don't adopt the session — send DELETE immediately
    // to prevent an orphaned remote session.
    const sid = res.headers.get("mcp-session-id");
    if (sid && !modernRequest) {
      if (closed) {
        fetch(opts.url, {
          method: "DELETE",
          headers: { ...(opts.headers), "mcp-session-id": sid },
        }).catch(() => {});
      } else {
        sessionId = sid;
      }
    }

    if (!res.ok) {
      const json = (await res.clone().json().catch(() => null)) as any;
      return { result: null, status: res.status, response: res, rpcError: json?.error };
    }

    const ct = res.headers.get("content-type") ?? "";

    if (ct.includes("text/event-stream")) {
      const result = await parseSSE(res, id, signal);
      return { result, status: res.status, response: res };
    }

    // Fallback: plain JSON
    const json = (await res.json().catch(() => null)) as any;
    if (!json || typeof json !== "object" || json.method) throw new Error("MCP streamable: invalid response (server requests are not supported)");
    if (json.id !== id && json.id !== String(id)) throw new Error("MCP response id mismatch");
    return { result: json.result, status: res.status, response: res, rpcError: json.error };
  }

  /** Guard to prevent infinite OAuth loops within a single request. */
  let oauthInProgress = false;

  async function request(method: string, params?: any, signal?: AbortSignal, modernRequest = modern): Promise<any> {
    signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    signal.throwIfAborted();
    const { result, status, response, rpcError } = await rawRequest(method, params, signal, modernRequest);
    signal.throwIfAborted();

    // ── OAuth 401 handling ──────────────────────────────────────────────────
    // Use a per-request guard instead of a permanent flag so that token
    // expiry mid-session can trigger re-authentication.
    if (status === 401 && oauthProvider && !oauthInProgress) {
      oauthInProgress = true;

      try {
        // ── Strategy 1: Try environment tokens first ──────────────────────
        // Many servers (e.g. GitHub) accept a PAT. Check common env vars
        // and the `gh` CLI before starting a full OAuth flow.
        const envToken = await detectEnvironmentToken(opts.url);
        if (envToken) {
          oauthProvider.saveTokens({ access_token: envToken.token, token_type: "bearer" });

          const retry = await rawRequest(method, params, signal, modernRequest);
          if (retry.status !== 401) {
            if (!retry.response.ok || retry.rpcError) throw Object.assign(new Error(retry.rpcError?.message ?? `MCP HTTP ${retry.status}`), { status: retry.status, code: retry.rpcError?.code });
            return retry.result;
          }
          // Token didn't work — fall through to OAuth
          oauthProvider.invalidateCredentials("tokens");
          process.stderr.write(`⚠ ${opts.name}: token from ${envToken.source} rejected, trying OAuth…\n`);
        }

        // ── Strategy 2: Full MCP OAuth 2.1 flow ──────────────────────────

        // Wait for relay context to become available before starting OAuth.
        // During startup, MCP init can race ahead of the relay connection.
        // If we start OAuth in local mode, the redirect_uri points to localhost
        // which is unreachable when running remotely. Waiting here gives the
        // relay connection time to establish so OAuth uses the server callback
        // URL instead. Falls back to local mode after the timeout.
        await oauthProvider.waitForRelayContext(15_000, signal);

        // If the signal was aborted while waiting (e.g., session shutdown),
        // bail out instead of falling through to the OAuth flow. Without this
        // check, a stale eager init would open a local OAuth flow and keep
        // eagerLoadPromise alive until the callback timeout.
        if (signal?.aborted) {
          throw new Error("MCP OAuth aborted: session shut down during relay wait");
        }

        const { auth, extractWWWAuthenticateParams } = await import(
          "@modelcontextprotocol/sdk/client/auth.js"
        );

        // Extract hints from the 401 response (scope, resource_metadata URL)
        const wwwAuthParams = extractWWWAuthenticateParams(response);

        // Phase 1: Start the auth flow → opens browser for consent
        let result1: Awaited<ReturnType<typeof auth>>;
        try {
          result1 = await auth(oauthProvider, {
            serverUrl: opts.url,
            scope: wwwAuthParams.scope,
            resourceMetadataUrl: wwwAuthParams.resourceMetadataUrl,
          });
        } catch (regErr) {
          // If registration failed in relay mode (no client info was saved),
          // the server likely rejects non-localhost redirect URIs (e.g. Figma).
          // Retry with localhost-only registration: register with a localhost
          // placeholder, but keep using the relay URL for the actual redirect.
          if (oauthProvider.relayContext && !oauthProvider.clientInformation()) {
            // Silent fallback — no need to surface this implementation detail to the user.
            oauthProvider.enableLocalhostRegistration();
            result1 = await auth(oauthProvider, {
              serverUrl: opts.url,
              scope: wwwAuthParams.scope,
              resourceMetadataUrl: wwwAuthParams.resourceMetadataUrl,
            });
          } else {
            throw regErr;
          }
        }

        if (result1 === "REDIRECT") {
          // Wait for the OAuth callback (browser → local server)
          const { code, state: callbackState } = await oauthProvider.startCallbackAndWait(signal);
          oauthProvider.closeCallback();

          // Validate state to prevent CSRF (defense-in-depth alongside PKCE)
          if (!oauthProvider.validateCallbackState(callbackState)) {
            throw new Error("OAuth state mismatch — possible CSRF attack");
          }

          // Phase 2: Exchange code for token
          const result2 = await auth(oauthProvider, {
            serverUrl: opts.url,
            authorizationCode: code,
            scope: wwwAuthParams.scope,
            resourceMetadataUrl: wwwAuthParams.resourceMetadataUrl,
          });

          if (result2 !== "AUTHORIZED") {
            throw new Error("OAuth token exchange failed");
          }
        }

        // Retry the original request with the new token
        const retry = await rawRequest(method, params, signal, modernRequest);
        if (!retry.response.ok || retry.rpcError) {
          throw Object.assign(new Error(retry.rpcError?.message ?? `MCP streamable HTTP ${retry.status} (after OAuth)`), { status: retry.status, code: retry.rpcError?.code });
        }
        return retry.result;
      } catch (err) {
        // Re-throw abort errors directly so callers can detect cancellation
        // without parsing the wrapped message.
        if ((err instanceof DOMException && err.name === "AbortError") || typeof (err as { status?: number }).status === "number") throw err;
        const errName = err instanceof Error ? err.constructor?.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);
        const errDetail = errMsg || errName || "unknown error";
        throw new Error(
          `OAuth authentication failed for "${opts.name}": ${errDetail}`,
        );
      } finally {
        // Always clean up the callback server — it may have been started
        // eagerly by the redirectUrl getter even if auth() resolved without
        // needing a redirect (e.g. tokens were already valid). Without this,
        // the callback server's 2-minute timeout fires an unhandled rejection
        // that crashes the CLI.
        oauthProvider.closeCallback();
        oauthInProgress = false;
      }
    }

    if (rpcError || (status !== 200 && result === null)) {
      const e = new Error(String(rpcError?.message ?? `MCP streamable HTTP ${status}`)) as Error & { status?: number; code?: number; data?: unknown };
      e.status = status; e.code = rpcError?.code; e.data = rpcError?.data;
      throw e;
    }

    return result;
  }

  async function notify(method: string, params?: any): Promise<void> {
    // Notifications have no id and expect no response body.
    const payload: any = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;

    await fetch(opts.url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(payload),
      signal: lifetime.signal,
    }).catch(() => {}); // best-effort
  }

  const modernParams = (params: Record<string, unknown> = {}, capabilities: Record<string, unknown> = {}) =>
    ({ ...params, _meta: modernRequestMeta(capabilities) });
  let initPromise: Promise<void> | null = null;

  function ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (!initPromise) initPromise = (async () => {
      try {
        const discovered = await request("server/discover", modernParams(), signal, true);
        if (isRecord(discovered) && Array.isArray(discovered.supportedVersions)) {
          if (!discovered.supportedVersions.includes(MCP_MODERN_PROTOCOL_VERSION)) throw new Error(`MCP server "${opts.name}" does not support ${MCP_MODERN_PROTOCOL_VERSION}`);
          modern = true;
          return;
        }
        // Some legacy servers return an empty result for unknown methods.
      } catch (err) {
        const e = err as { status?: number; code?: number };
        const probeTimedOut = err instanceof DOMException && err.name === "TimeoutError";
        if (signal?.aborted || lifetime.signal.aborted || (typeof e.code === "number" && MCP_MODERN_ERROR_CODES.has(e.code)) ||
            (!probeTimedOut && e.code !== -32601 && ![400, 404, 405].includes(e.status ?? 0))) throw err;
      }
      const result = await request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT_INFO }, signal, false);
      if (result?.protocolVersion && !MCP_SUPPORTED_VERSIONS.has(result.protocolVersion)) throw new Error(`MCP server "${opts.name}" returned unsupported protocol version: ${result.protocolVersion}`);
      await notify("notifications/initialized");
    })();
    return initPromise;
  }

  return {
    name: opts.name,
    initialize: ensureInitialized,
    async listTools() {
      await ensureInitialized();
      const res = (await request("tools/list", modern ? modernParams() : undefined)) as McpListToolsResult;
      return (Array.isArray(res?.tools) ? res.tools : []).filter(tool => {
        if (!modern || !hasHeaderAnnotation(tool.inputSchema)) return true;
        // ponytail: header mirroring is outside form elicitation; fail visibly
        // rather than expose tools whose required routing headers we'd omit.
        console.warn(`MCP server "${opts.name}": tool "${tool.name}" unavailable: modern x-mcp-header annotations are not supported`);
        return false;
      });
    },
    async callTool(toolName: string, args: unknown, signal?: AbortSignal, onElicitation?: McpElicitationHandler) {
      signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      await ensureInitialized(signal);
      const base = { name: toolName, arguments: args ?? {} };
      const result = modern
        ? await requestWithMrtr((params, s) => request("tools/call", modernParams(params, onElicitation ? MCP_ELICITATION_CAPABILITY : {}), s), base, onElicitation, signal)
        : await request("tools/call", base, signal);
      return (result ?? {}) as McpCallToolResult;
    },
    close() {
      // Mark as closed so late-arriving responses don't adopt a session ID.
      closed = true;
      lifetime.abort();
      // Best-effort session teardown
      if (sessionId) {
        const sid = sessionId;
        sessionId = undefined;
        fetch(opts.url, {
          method: "DELETE",
          headers: { ...(opts.headers), "mcp-session-id": sid },
        }).catch(() => {});
      }
    },
  };
}
