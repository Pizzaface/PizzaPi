/**
 * MCP OAuth 2.1 provider for PizzaPi.
 *
 * Handles the full MCP OAuth flow with two callback modes:
 *
 *  **Local mode** (CLI only, no relay connected):
 *    - Opens browser on the local machine
 *    - Callback server runs on localhost
 *
 *  **Relay mode** (web UI connected):
 *    - Emits `mcp:auth_required` event → web UI shows clickable link
 *    - Callback URL points to the PizzaPi server's `/api/mcp-oauth-callback`
 *    - Server forwards the auth code back to the runner via WebSocket
 *
 * Tokens and client registrations are persisted to ~/.pizzapi/mcp-auth/
 * so subsequent sessions reuse existing credentials.
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { createHash, randomBytes } from "crypto";
import { execFile } from "child_process";
import type {
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// Token / client info persistence
// ─────────────────────────────────────────────────────────────────────────────

const MCP_AUTH_DIR = join(homedir(), ".pizzapi", "mcp-auth");

function serverKey(serverUrl: string): string {
  return createHash("sha256").update(serverUrl).digest("hex").slice(0, 16);
}

interface PersistedAuth {
  clientInfo?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

function loadPersistedAuth(serverUrl: string): PersistedAuth {
  const path = join(MCP_AUTH_DIR, `${serverKey(serverUrl)}.json`);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function savePersistedAuth(serverUrl: string, auth: PersistedAuth): void {
  mkdirSync(MCP_AUTH_DIR, { recursive: true });
  const path = join(MCP_AUTH_DIR, `${serverKey(serverUrl)}.json`);
  writeFileSync(path, JSON.stringify(auth, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser helper
// ─────────────────────────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(cmd, args, (err) => {
    if (err) {
      process.stderr.write(`\n🔐 Open this URL to authenticate:\n${url}\n\n`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Local callback server (CLI mode — receives OAuth redirect on localhost)
// ─────────────────────────────────────────────────────────────────────────────

export type OAuthCallbackResult = {
  code: string;
  state?: string;
};

/**
 * Start a temporary local HTTP server to receive the OAuth callback.
 * Returns a promise that resolves when the auth code is received.
 */
export function startCallbackServer(
  port: number = 0,
  timeoutMs: number = 120_000,
): { promise: Promise<OAuthCallbackResult>; getPort: () => number; close: () => void } {
  let resolvePromise: (result: OAuthCallbackResult) => void;
  let rejectPromise: (err: Error) => void;
  let server: ReturnType<typeof Bun.serve> | null = null;

  const promise = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const timer = setTimeout(() => {
    server?.stop(true);
    rejectPromise(new Error("OAuth callback timed out (2 minutes)"));
  }, timeoutMs);

  server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 404 });

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state") ?? undefined;

      if (code) {
        clearTimeout(timer);
        resolvePromise({ code, state });
        setTimeout(() => server?.stop(true), 1000);
        return new Response(
          `<html><body>
            <h2>✅ Authentication successful!</h2>
            <p>You can close this tab and return to your terminal.</p>
            <script>setTimeout(() => window.close(), 2000);</script>
          </body></html>`,
          { headers: { "Content-Type": "text/html" } },
        );
      }

      if (error) {
        clearTimeout(timer);
        rejectPromise(new Error(`OAuth error: ${error}`));
        setTimeout(() => server?.stop(true), 1000);
        return new Response(
          `<html><body><h2>❌ Authentication failed</h2><p>${error}</p></body></html>`,
          { headers: { "Content-Type": "text/html" }, status: 400 },
        );
      }

      return new Response("Waiting for OAuth callback…", { status: 200 });
    },
  });

  return {
    promise,
    getPort: () => server?.port ?? port,
    close: () => { clearTimeout(timer); server?.stop(true); },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Relay callback (web UI mode — receives OAuth code from server via event)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode the OAuth state parameter for relay mode.
 * This gets URL-safe base64-encoded and passed as the `state` query param.
 */
export function encodeRelayState(sessionId: string, nonce: string, oauthState?: string): string {
  return Buffer.from(JSON.stringify({ sessionId, nonce, oauthState })).toString("base64url");
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuthClientProvider implementation
// ─────────────────────────────────────────────────────────────────────────────

export type McpOAuthOptions = {
  /** MCP server URL (used as key for persisted tokens). */
  serverUrl: string;
  /** Human-readable server name for log messages. */
  serverName: string;
  /** Callback port override for local mode. 0 = auto. */
  callbackPort?: number;
  /** Callback when auth starts (for TUI/web notifications). */
  onAuthStart?: (authUrl: string) => void;
  /** Callback when auth completes. */
  onAuthComplete?: () => void;
};

/**
 * Relay context — set when a web UI is connected.
 * Enables the OAuth callback to go through the PizzaPi server.
 */
export type RelayContext = {
  /** HTTP base URL of the PizzaPi server (e.g. "https://pizza.example.com"). */
  serverBaseUrl: string;
  /** Current session ID on the relay. */
  sessionId: string;
  /** Emit a pi.events event (forwarded to web UI via the remote extension). */
  emitEvent: (eventName: string, data: unknown) => void;
  /** Wait for a relay callback (code delivered from server → runner). */
  waitForCallback: (nonce: string, timeoutMs?: number) => Promise<string>;
};

/**
 * PizzaPi OAuth provider for MCP servers.
 *
 * Supports two modes:
 * - **Local** (default): opens browser + localhost callback server
 * - **Relay**: callback goes through PizzaPi server, auth URL sent to web UI
 */
export class PizzaPiOAuthProvider implements OAuthClientProvider {
  private _serverUrl: string;
  private _serverName: string;
  private _persisted: PersistedAuth;
  private _callbackPort: number;
  private _callbackServer: ReturnType<typeof startCallbackServer> | null = null;
  private _onAuthStart?: (authUrl: string) => void;
  private _onAuthComplete?: () => void;

  /** Set externally by the remote extension when relay is connected. */
  relayContext: RelayContext | null = null;

  /** Nonce for the current auth flow (relay mode). */
  private _currentNonce: string | null = null;

  constructor(opts: McpOAuthOptions) {
    this._serverUrl = opts.serverUrl;
    this._serverName = opts.serverName;
    this._callbackPort = opts.callbackPort ?? 0;
    this._onAuthStart = opts.onAuthStart;
    this._onAuthComplete = opts.onAuthComplete;
    this._persisted = loadPersistedAuth(this._serverUrl);
  }

  private get _useRelay(): boolean {
    return this.relayContext !== null;
  }

  get redirectUrl(): string | URL {
    if (this._useRelay) {
      // Relay mode: callback goes to the PizzaPi server
      return `${this.relayContext!.serverBaseUrl}/api/mcp-oauth-callback`;
    }
    // Local mode: ensure the callback server is started so we have a real port.
    // The MCP SDK calls redirectUrl (via clientMetadata) before startCallbackAndWait(),
    // so we must eagerly start the server to avoid registering localhost:0.
    if (!this._callbackServer) {
      this._callbackServer = startCallbackServer(this._callbackPort);
    }
    return `http://localhost:${this._callbackServer.getPort()}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `PizzaPi (${this._serverName})`,
      redirect_uris: [typeof this.redirectUrl === "string" ? this.redirectUrl : this.redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
  }

  /**
   * Generate the OAuth state parameter.
   * In relay mode, encodes session ID and nonce so the server can route
   * the callback back to the correct runner.
   */
  async state(): Promise<string> {
    if (this._useRelay) {
      this._currentNonce = randomBytes(16).toString("hex");
      return encodeRelayState(
        this.relayContext!.sessionId,
        this._currentNonce,
      );
    }
    // Local mode: simple random state for CSRF protection
    return randomBytes(16).toString("hex");
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this._persisted.clientInfo;
  }

  saveClientInformation(clientInfo: OAuthClientInformationMixed): void {
    this._persisted.clientInfo = clientInfo;
    savePersistedAuth(this._serverUrl, this._persisted);
  }

  tokens(): OAuthTokens | undefined {
    return this._persisted.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this._persisted.tokens = tokens;
    savePersistedAuth(this._serverUrl, this._persisted);
    this._onAuthComplete?.();
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    const url = authorizationUrl.toString();
    this._onAuthStart?.(url);

    if (this._useRelay) {
      // Relay mode: emit event for web UI to show clickable link
      this.relayContext!.emitEvent("mcp:auth_required", {
        type: "mcp_auth_required",
        serverName: this._serverName,
        authUrl: url,
        ts: Date.now(),
      });
      process.stderr.write(`🔐 Authentication required for ${this._serverName} — check web UI\n`);
    } else {
      // Local mode: open browser directly
      process.stderr.write(`\n🔐 Opening browser for ${this._serverName} MCP authentication…\n`);
      openBrowser(url);
    }
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._persisted.codeVerifier = codeVerifier;
    savePersistedAuth(this._serverUrl, this._persisted);
  }

  codeVerifier(): string {
    if (!this._persisted.codeVerifier) {
      throw new Error("No PKCE code verifier saved");
    }
    return this._persisted.codeVerifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): void {
    if (scope === "all" || scope === "tokens") delete this._persisted.tokens;
    if (scope === "all" || scope === "client") delete this._persisted.clientInfo;
    if (scope === "all" || scope === "verifier") delete this._persisted.codeVerifier;
    savePersistedAuth(this._serverUrl, this._persisted);
  }

  // ── Callback server management ──────────────────────────────────────────

  /**
   * Start waiting for the OAuth callback.
   * In relay mode, waits for the code via WebSocket.
   * In local mode, starts a localhost callback server.
   */
  startCallbackAndWait(): Promise<OAuthCallbackResult> {
    if (this._useRelay && this._currentNonce) {
      // Relay mode: wait for code from server via WebSocket
      return this.relayContext!.waitForCallback(this._currentNonce).then((code) => ({
        code,
      }));
    }

    // Local mode: localhost callback server
    if (this._callbackServer) {
      return this._callbackServer.promise;
    }
    this._callbackServer = startCallbackServer(this._callbackPort);
    return this._callbackServer.promise;
  }

  /** Clean up the callback server. */
  closeCallback(): void {
    this._callbackServer?.close();
    this._callbackServer = null;
    this._currentNonce = null;
  }

  /** Whether we have existing tokens that might still be valid. */
  hasTokens(): boolean {
    return !!this._persisted.tokens?.access_token;
  }

  /** Get the stored access token (for adding to request headers). */
  getAccessToken(): string | undefined {
    return this._persisted.tokens?.access_token;
  }
}
