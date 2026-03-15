import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import type { PizzaPiConfig } from "../config.js";
import { PizzaPiOAuthProvider, type RelayContext } from "./mcp-oauth.js";
import { getSandboxEnv, isSandboxActive, getResolvedConfig, getSandboxMode, wrapCommand } from "@pizzapi/tools";

/**
 * Minimal MCP client transport + tool bridge.
 *
 * Supports:
 *  - STDIO transport via spawning a command
 *  - HTTP transport via POSTing JSON-RPC-ish MCP messages
 *  - Streamable HTTP transport (MCP spec 2025-03-26)
 *
 * This is intentionally lightweight and only implements what we need:
 *  - initialize (lifecycle handshake — required by the MCP spec)
 *  - listTools
 *  - callTool
 *
 * All transports perform the MCP initialization handshake lazily before
 * the first real request (tools/list or tools/call). The handshake sends
 * an `initialize` request followed by a `notifications/initialized`
 * notification, as required by the MCP specification.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Json;
};

type McpListToolsResult = { tools: McpTool[] };

type McpCallToolResult = {
  content?: unknown;
  isError?: boolean;
  // Some MCP servers return structured content blocks.
  // We'll just forward as-is.
};

type McpClient = {
  name: string;
  /**
   * Perform the MCP initialize handshake (and any OAuth if needed).
   * Separating this from listTools() allows callers to complete auth
   * without being constrained by tool-listing timeouts.
   *
   * An optional AbortSignal can be passed to cancel the in-flight
   * handshake request (e.g. when an init timeout fires).
   */
  initialize(signal?: AbortSignal): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(toolName: string, args: unknown, signal?: AbortSignal): Promise<McpCallToolResult>;
  close(): void;
};

/**
 * Protocol version we advertise during the MCP initialize handshake.
 * Using the 2025-03-26 spec (widely supported); servers may negotiate down.
 */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

/** Versions we accept from the server in its InitializeResult. */
export const MCP_SUPPORTED_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"]);

/** Client info sent during the initialize handshake. */
export const MCP_CLIENT_INFO = { name: "pizzapi", version: "1.0.0" };

const PROVIDER_TOOL_NAME_MAX_LENGTH = 64;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function shortHash(value: string): string {
  let h1 = 0xdeadbeef ^ value.length;
  let h2 = 0x41c6ce57 ^ value.length;

  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

function sanitizeToolNamePart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return sanitized || "tool";
}

function clampToolName(name: string, seed: string): string {
  if (name.length <= PROVIDER_TOOL_NAME_MAX_LENGTH) return name;

  const hash = shortHash(seed).slice(0, 8);
  const keep = Math.max(1, PROVIDER_TOOL_NAME_MAX_LENGTH - hash.length - 1);
  return `${name.slice(0, keep)}_${hash}`;
}

function allocateProviderSafeToolName(serverName: string, mcpToolName: string, usedNames: Set<string>): string {
  const source = `${serverName}:${mcpToolName}`;
  const normalizedBase = `mcp_${sanitizeToolNamePart(serverName).toLowerCase()}_${sanitizeToolNamePart(mcpToolName).toLowerCase()}`;

  const preferred = clampToolName(normalizedBase, source);
  if (!usedNames.has(preferred)) {
    usedNames.add(preferred);
    return preferred;
  }

  const hash = shortHash(source).slice(0, 8);
  const withHash = clampToolName(`${normalizedBase}_${hash}`, `${source}:${hash}`);
  if (!usedNames.has(withHash)) {
    usedNames.add(withHash);
    return withHash;
  }

  let counter = 2;
  while (true) {
    const candidate = clampToolName(`${normalizedBase}_${hash}_${counter}`, `${source}:${counter}`);
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    counter++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STDIO client
// ─────────────────────────────────────────────────────────────────────────────

async function createStdioMcpClient(opts: { name: string; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }): Promise<McpClient> {
  // Sandbox: inject proxy env vars so sandboxed MCP servers route traffic
  // through the sandbox network proxy. User-provided env takes precedence.
  const sandboxEnv = isSandboxActive() ? getSandboxEnv() : {};
  // Sandbox env vars (proxy settings) spread LAST so MCP server config cannot
  // override them to bypass network filtering.
  const mergedEnv = { ...process.env, ...(opts.env ?? {}), ...sandboxEnv };

  // Wrap MCP command with OS-level sandbox (filesystem + socket restrictions).
  // wrapCommand applies sandbox-exec (macOS) or bwrap (Linux) around the command.
  let child: ChildProcessWithoutNullStreams;
  if (isSandboxActive()) {
    // Build shell command string from command + args for wrapping
    const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const shellArgs = (opts.args ?? []).map(a => shellQuote(a)).join(" ");
    const quotedCmd = shellQuote(opts.command);
    const shellCmd = shellArgs ? `${quotedCmd} ${shellArgs}` : quotedCmd;
    const wrappedCmd = await wrapCommand(shellCmd);
    child = spawn(wrappedCmd, [], {
      stdio: "pipe",
      shell: true,
      env: mergedEnv,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
  } else {
    child = spawn(opts.command, opts.args ?? [], {
      stdio: "pipe",
      env: mergedEnv,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
  }

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  let buffer = "";

  function send(msg: any) {
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  function request(method: string, params?: any, signal?: AbortSignal): Promise<any> {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send(payload);

      const onAbort = () => {
        pending.delete(id);
        reject(new Error("MCP request aborted"));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;

      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (isRecord(msg) && typeof msg.id === "number") {
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if ("error" in msg) p.reject(new Error(String((msg as any).error?.message ?? "MCP error")));
        else p.resolve((msg as any).result);
      }
    }
  });

  child.on("exit", (code, sig) => {
    const err = new Error(`MCP stdio server exited (code=${code}, signal=${sig ?? ""})`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });

  child.on("error", (e) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  });

  // ── Lazy MCP initialize handshake ──────────────────────────────────────
  let initPromise: Promise<void> | null = null;

  function ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        const result = await request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO,
        }, signal);

        if (result?.protocolVersion && !MCP_SUPPORTED_VERSIONS.has(result.protocolVersion)) {
          throw new Error(`MCP server "${opts.name}" returned unsupported protocol version: ${result.protocolVersion}`);
        }

        // Send the initialized notification (no id → notification, no response expected)
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
      })();
    }
    return initPromise;
  }

  return {
    name: opts.name,
    initialize: (signal?: AbortSignal) => ensureInitialized(signal),
    async listTools() {
      await ensureInitialized();
      const res = (await request("tools/list")) as McpListToolsResult;
      return Array.isArray(res?.tools) ? res.tools : [];
    },
    async callTool(toolName: string, args: unknown, signal?: AbortSignal) {
      await ensureInitialized();
      const res = await request("tools/call", { name: toolName, arguments: args ?? {} }, signal);
      return (res ?? {}) as McpCallToolResult;
    },
    close() {
      try { child.kill(); } catch {}
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP client (plain JSON POST — legacy / simple servers)
// ─────────────────────────────────────────────────────────────────────────────

function createHttpMcpClient(opts: { name: string; url: string; headers?: Record<string, string> }): McpClient {
  let nextId = 1;

  async function request(method: string, params?: any, signal?: AbortSignal): Promise<any> {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };

    const res = await fetch(opts.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(payload),
      signal,
    });

    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    if (!json || typeof json !== "object") throw new Error("Invalid MCP response");
    if (json.error) throw new Error(String(json.error?.message ?? "MCP error"));
    return json.result;
  }

  async function notify(method: string, params?: any): Promise<void> {
    // Notifications have no id and expect no response body.
    const payload: any = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;

    await fetch(opts.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(payload),
    }).catch(() => {}); // best-effort
  }

  // ── Lazy MCP initialize handshake ──────────────────────────────────────
  let initPromise: Promise<void> | null = null;

  function ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        const result = await request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO,
        }, signal);

        if (result?.protocolVersion && !MCP_SUPPORTED_VERSIONS.has(result.protocolVersion)) {
          throw new Error(`MCP server "${opts.name}" returned unsupported protocol version: ${result.protocolVersion}`);
        }

        await notify("notifications/initialized");
      })();
    }
    return initPromise;
  }

  return {
    name: opts.name,
    initialize: (signal?: AbortSignal) => ensureInitialized(signal),
    async listTools() {
      await ensureInitialized();
      const res = (await request("tools/list")) as McpListToolsResult;
      return Array.isArray(res?.tools) ? res.tools : [];
    },
    async callTool(toolName: string, args: unknown, signal?: AbortSignal) {
      await ensureInitialized();
      const res = await request("tools/call", { name: toolName, arguments: args ?? {} }, signal);
      return (res ?? {}) as McpCallToolResult;
    },
    close() {},
  };
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

function createStreamableMcpClient(opts: {
  name: string;
  url: string;
  headers?: Record<string, string>;
  oauthProvider?: PizzaPiOAuthProvider;
}): McpClient {
  let nextId = 1;
  let sessionId: string | undefined;
  let closed = false;
  const oauthProvider = opts.oauthProvider;

  function buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(opts.headers ?? {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(extra ?? {}),
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

          // Ignore notifications / requests that have no id
          if (!("id" in msg)) continue;

          if (msg.id === targetId || msg.id === String(targetId)) {
            if (msg.error) throw new Error(String((msg.error as any)?.message ?? "MCP error"));
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

  async function rawRequest(method: string, params?: any, signal?: AbortSignal): Promise<{ result: any; status: number; response: Response }> {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };

    const res = await fetch(opts.url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(payload),
      signal,
    });

    // Capture / update session ID.
    // If the client was already closed (e.g. init timeout fired while this
    // request was in flight), don't adopt the session — send DELETE immediately
    // to prevent an orphaned remote session.
    const sid = res.headers.get("mcp-session-id");
    if (sid) {
      if (closed) {
        fetch(opts.url, {
          method: "DELETE",
          headers: { ...(opts.headers ?? {}), "mcp-session-id": sid },
        }).catch(() => {});
      } else {
        sessionId = sid;
      }
    }

    if (!res.ok) return { result: null, status: res.status, response: res };

    const ct = res.headers.get("content-type") ?? "";

    if (ct.includes("text/event-stream")) {
      const result = await parseSSE(res, id, signal);
      return { result, status: res.status, response: res };
    }

    // Fallback: plain JSON
    const json = (await res.json().catch(() => null)) as any;
    if (!json || typeof json !== "object") throw new Error("MCP streamable: invalid JSON response");
    if (json.error) throw new Error(String(json.error?.message ?? "MCP error"));
    return { result: json.result, status: res.status, response: res };
  }

  /** Guard to prevent infinite OAuth loops within a single request. */
  let oauthInProgress = false;

  async function request(method: string, params?: any, signal?: AbortSignal): Promise<any> {
    const { result, status, response } = await rawRequest(method, params, signal);

    // ── OAuth 401 handling ──────────────────────────────────────────────────
    // Use a per-request guard instead of a permanent flag so that token
    // expiry mid-session can trigger re-authentication.
    if (status === 401 && oauthProvider && !oauthInProgress) {
      process.stderr.write(`🔐 MCP server "${opts.name}" requires authentication…\n`);
      oauthInProgress = true;

      try {
        // ── Strategy 1: Try environment tokens first ──────────────────────
        // Many servers (e.g. GitHub) accept a PAT. Check common env vars
        // and the `gh` CLI before starting a full OAuth flow.
        const envToken = await detectEnvironmentToken(opts.url);
        if (envToken) {
          process.stderr.write(`🔑 Using token from ${envToken.source}\n`);
          oauthProvider.saveTokens({ access_token: envToken.token, token_type: "bearer" });

          const retry = await rawRequest(method, params, signal);
          if (retry.response.ok) {
            process.stderr.write(`✅ Authenticated with ${opts.name}\n`);
            return retry.result;
          }
          // Token didn't work — fall through to OAuth
          oauthProvider.invalidateCredentials("tokens");
          process.stderr.write(`⚠ Token from ${envToken.source} was rejected, trying OAuth…\n`);
        }

        // ── Strategy 2: Full MCP OAuth 2.1 flow ──────────────────────────

        // Wait for relay context to become available before starting OAuth.
        // During startup, MCP init can race ahead of the relay connection.
        // If we start OAuth in local mode, the redirect_uri points to localhost
        // which is unreachable when running remotely. Waiting here gives the
        // relay connection time to establish so OAuth uses the server callback
        // URL instead. Falls back to local mode after the timeout.
        await oauthProvider.waitForRelayContext();

        const { auth, extractWWWAuthenticateParams } = await import(
          "@modelcontextprotocol/sdk/client/auth.js"
        );

        // Extract hints from the 401 response (scope, resource_metadata URL)
        const wwwAuthParams = extractWWWAuthenticateParams(response);

        // Phase 1: Start the auth flow → opens browser for consent
        const result1 = await auth(oauthProvider, {
          serverUrl: opts.url,
          scope: wwwAuthParams.scope,
          resourceMetadataUrl: wwwAuthParams.resourceMetadataUrl,
        });

        if (result1 === "REDIRECT") {
          // Wait for the OAuth callback (browser → local server)
          const { code, state: callbackState } = await oauthProvider.startCallbackAndWait();
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

        process.stderr.write(`✅ Authenticated with ${opts.name}\n`);

        // Retry the original request with the new token
        const retry = await rawRequest(method, params, signal);
        if (!retry.response.ok) {
          throw new Error(`MCP streamable HTTP ${retry.status} (after OAuth)`);
        }
        return retry.result;
      } catch (err) {
        oauthProvider.closeCallback();
        throw new Error(
          `OAuth authentication failed for "${opts.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        oauthInProgress = false;
      }
    }

    if (status !== 200 && result === null) {
      throw new Error(`MCP streamable HTTP ${status}`);
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
    }).catch(() => {}); // best-effort
  }

  // ── Lazy MCP initialize handshake ──────────────────────────────────────
  let initPromise: Promise<void> | null = null;

  function ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        const result = await request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO,
        }, signal);

        if (result?.protocolVersion && !MCP_SUPPORTED_VERSIONS.has(result.protocolVersion)) {
          throw new Error(`MCP server "${opts.name}" returned unsupported protocol version: ${result.protocolVersion}`);
        }

        await notify("notifications/initialized");
      })();
    }
    return initPromise;
  }

  return {
    name: opts.name,
    initialize: (signal?: AbortSignal) => ensureInitialized(signal),
    async listTools() {
      await ensureInitialized();
      const res = (await request("tools/list")) as McpListToolsResult;
      return Array.isArray(res?.tools) ? res.tools : [];
    },
    async callTool(toolName: string, args: unknown, signal?: AbortSignal) {
      await ensureInitialized();
      const res = await request("tools/call", { name: toolName, arguments: args ?? {} }, signal);
      return (res ?? {}) as McpCallToolResult;
    },
    close() {
      // Mark as closed so late-arriving responses don't adopt a session ID.
      closed = true;
      // Best-effort session teardown
      if (sessionId) {
        const sid = sessionId;
        sessionId = undefined;
        fetch(opts.url, {
          method: "DELETE",
          headers: { ...(opts.headers ?? {}), "mcp-session-id": sid },
        }).catch(() => {});
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export type McpConfig = {
  // Preferred format
  mcp?: {
    servers?: Array<
      | { name: string; transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
      | { name: string; transport: "http"; url: string; headers?: Record<string, string> }
      | { name: string; transport: "streamable"; url: string; headers?: Record<string, string> }
    >;
  };

  // Compatibility format (commonly used by MCP configs)
  // {
  //   "mcpServers": {
  //     "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
  //     "myserver":   { "url": "http://localhost:3000/mcp", "transport": "streamable" }
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
    | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    | { url: string; transport?: "http" | "streamable"; type?: "http" | "sse"; headers?: Record<string, string> }
  >;
};

/** Track active OAuth providers so the relay context can be injected later. */
const activeOAuthProviders: PizzaPiOAuthProvider[] = [];

/** Get all active OAuth providers (used by the MCP extension to inject relay context). */
export function getOAuthProviders(): PizzaPiOAuthProvider[] {
  return activeOAuthProviders;
}

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
    console.warn(
      `[sandbox/mcp] Blocked MCP server "${serverName}": no domains in allowedDomains (full mode). ` +
      `Add the domain to sandbox.network.allowedDomains in config.`,
    );
    return false;
  }

  try {
    const hostname = new URL(url).hostname;

    // Check deniedDomains first — deny takes precedence over allow
    const deniedDomains = sandboxCfg.srtConfig.network.deniedDomains ?? [];
    if (deniedDomains.some(d => hostname === d || hostname.endsWith(`.${d.replace(/^\*\./, "")}`))) {
      console.warn(
        `[sandbox/mcp] Blocked MCP server "${serverName}": domain "${hostname}" ` +
        `is in deniedDomains [${deniedDomains.join(", ")}]`,
      );
      return false;
    }

    if (allowedDomains.some(d => hostname === d || hostname.endsWith(`.${d.replace(/^\*\./, "")}`))) {
      return true;
    }
    console.warn(
      `[sandbox/mcp] Blocked MCP server "${serverName}": domain "${hostname}" ` +
      `not in allowedDomains [${allowedDomains.join(", ")}]`,
    );
    return false;
  } catch {
    console.warn(`[sandbox/mcp] Blocked MCP server "${serverName}": invalid URL "${url}"`);
    return false;
  }
}

export async function createMcpClientsFromConfig(config: PizzaPiConfig & McpConfig): Promise<McpClient[]> {
  // Clear stale OAuth providers from previous loads (e.g. /mcp reload)
  // to prevent unbounded growth and iteration over dead providers.
  activeOAuthProviders.length = 0;

  const disabled = new Set(config.disabledMcpServers ?? []);

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
        console.error(`[MCP] Failed to create stdio client for "${s.name}": ${err}`);
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
      const provider = new PizzaPiOAuthProvider({ serverUrl: s.url, serverName: s.name });
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
        console.error(`[MCP] Failed to create stdio client for "${name}": ${err}`);
      }
      continue;
    }

    if ("url" in def && typeof (def as any).url === "string") {
      const d = def as { url: string; transport?: string; type?: string; headers?: Record<string, string> };

      // Domain gating for URL-based MCP servers
      if (!isMcpDomainAllowed(d.url, name)) continue;

      // Determine transport mode:
      //  - "transport" field (our format): "streamable" → streamable, else plain HTTP
      //  - "type" field (Claude Code / VS Code format): "http" → streamable (per MCP spec)
      const useStreamable =
        d.transport === "streamable" ||
        (d.type === "http" && d.transport === undefined);

      if (useStreamable) {
        const provider = new PizzaPiOAuthProvider({ serverUrl: d.url, serverName: name });
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
async function listToolsWithTimeout(client: McpClient, timeoutMs: number): Promise<{ tools: McpTool[]; error?: string; timedOut: boolean }> {
  if (timeoutMs <= 0) {
    // Timeout disabled — call directly
    const tools = await client.listTools();
    return { tools, timedOut: false };
  }

  // Keep a reference to the listTools promise so we can suppress its rejection
  // if the timeout fires first (the child process will be killed, causing the
  // pending JSON-RPC request to reject with "server exited").
  const listToolsPromise = client.listTools().then(
    (tools) => ({ tools, timedOut: false as const }),
  );

  const timeoutPromise = new Promise<{ tools: McpTool[]; error: string; timedOut: true }>((resolve) =>
    setTimeout(
      () => resolve({ tools: [], error: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for tools/list`, timedOut: true }),
      timeoutMs,
    ),
  );

  const result = await Promise.race([listToolsPromise, timeoutPromise]);

  if (result.timedOut) {
    // Close the client immediately to abort the in-flight request and prevent
    // it from establishing a remote MCP session that would never be cleaned up.
    try { client.close(); } catch {}
    // Suppress the dangling promise rejection that fires when the connection is killed
    listToolsPromise.catch(() => {});
  }

  return result;
}

export async function registerMcpTools(pi: any, config: PizzaPiConfig & McpConfig, relayContext?: RelayContext | null): Promise<McpRegistrationResult> {
  const totalStart = Date.now();
  const clients = await createMcpClientsFromConfig(config);
  const empty: McpRegistrationResult = { clients: [], toolCount: 0, toolNames: [], errors: [], serverTools: {}, serverTimings: [], totalDurationMs: 0 };
  if (clients.length === 0) return { ...empty, totalDurationMs: Date.now() - totalStart };

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

  // ── Phase 1: Initialize + list tools for all servers in parallel ─────────
  //
  // Initialization is performed first (may trigger OAuth which requires user
  // interaction and can take minutes). The tool-listing timeout only applies
  // to the subsequent tools/list call — not the auth flow — so servers that
  // require OAuth are not killed by the 30 s default timeout.
  const initResults = await Promise.all(
    clients.map(async (client): Promise<McpServerInitResult> => {
      const start = Date.now();
      try {
        // Initialize the MCP handshake (+ any OAuth) with a generous timeout.
        // OAuth flows have their own 2-min callback timeout; the init timeout
        // (default 3 min) is a safety net against hung processes / stalled
        // endpoints that would otherwise block forever.
        //
        // When the timeout fires we:
        //  1. Abort the in-flight request via AbortController (cancels fetch /
        //     STDIO pending request so the handshake doesn't complete late).
        //  2. Close the client immediately (kills child process / marks
        //     streamable client as closed so a late response can't set
        //     sessionId and leak a remote MCP session).
        //  3. Suppress the dangling initPromise rejection to prevent
        //     unhandled-rejection crashes.
        if (initTimeoutMs > 0) {
          const ac = new AbortController();
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
            // Abort in-flight requests and close the client to prevent
            // orphaned remote MCP sessions from late-arriving responses.
            ac.abort();
            try { client.close(); } catch {}
            // Suppress the dangling init promise to avoid unhandled rejection
            initPromise.catch(() => {});
            throw err;
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        } else {
          await client.initialize();
        }

        // Now list tools with the configurable timeout.  Since initialize()
        // already resolved, ensureInitialized() inside listTools() returns
        // immediately — the timeout only covers the tools/list request.
        const { tools, error, timedOut } = await listToolsWithTimeout(client, timeoutMs);
        const durationMs = Date.now() - start;
        if (error) {
          return { name: client.name, tools: [], error, durationMs, timedOut };
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
    }),
  );

  // ── Phase 2: Register tools sequentially (name allocation needs Set) ─────
  let toolCount = 0;
  const toolNames: string[] = [];
  const errors: Array<{ server: string; error: string }> = [];
  const usedToolNames = new Set<string>();
  const serverTools: Record<string, string[]> = {};
  const liveClients: McpClient[] = [];

  for (let i = 0; i < clients.length; i++) {
    const client = clients[i];
    const result = initResults[i];

    if (result.error) {
      errors.push({ server: client.name, error: result.error });
      // Close errored clients so child processes don't leak
      try { client.close(); } catch {}
      continue;
    }

    liveClients.push(client);
    const serverToolList: string[] = [];
    serverTools[client.name] = serverToolList;

    for (const tool of result.tools) {
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
  }

  // Best-effort shutdown.
  pi.on?.("session_shutdown", () => {
    for (const c of liveClients) c.close();
  });

  const totalDurationMs = Date.now() - totalStart;
  return { clients: liveClients, toolCount, toolNames, errors, serverTools, serverTimings: initResults, totalDurationMs };
}
