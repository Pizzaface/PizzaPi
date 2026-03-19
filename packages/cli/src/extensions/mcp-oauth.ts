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
import { randomBytes } from "crypto";
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

/**
 * Resolve the MCP auth directory.
 * Uses PIZZAPI_MCP_AUTH_DIR env var if set (for testing), otherwise ~/.pizzapi/mcp-auth.
 * Note: Bun caches os.homedir() at process start, so mutating HOME at runtime
 * does not work — the env var override is necessary for test isolation.
 */
function getMcpAuthDir(): string {
  return process.env.PIZZAPI_MCP_AUTH_DIR || join(homedir(), ".pizzapi", "mcp-auth");
}

/** Derive a short, filesystem-safe key from a server URL. */
function serverKey(serverUrl: string): string {
  // Use SHA-256 hash to avoid prefix-truncation collisions between similar URLs.
  const hash = new Bun.CryptoHasher("sha256").update(serverUrl).digest("hex");
  return hash.slice(0, 32);
}

interface PersistedAuth {
  clientInfo?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

function loadPersistedAuth(serverUrl: string): PersistedAuth {
  const path = join(getMcpAuthDir(), `${serverKey(serverUrl)}.json`);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function savePersistedAuth(serverUrl: string, auth: PersistedAuth): void {
  const dir = getMcpAuthDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${serverKey(serverUrl)}.json`);
  writeFileSync(path, JSON.stringify(auth, null, 2), { mode: 0o600 });
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

/** Check if client registration has localhost-based redirect URIs. */
function hasLocalhostRedirects(clientInfo: OAuthClientInformationMixed): boolean {
  // OAuthClientInformationMixed is a union — redirect_uris may not be on all branches.
  const info = clientInfo as Record<string, unknown>;
  const uris = Array.isArray(info.redirect_uris) ? info.redirect_uris : [];
  return uris.some((uri: unknown) => {
    try {
      const hostname = new URL(String(uri)).hostname;
      return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch {
      return false;
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
    close: () => {
      clearTimeout(timer);
      server?.stop(true);
      // Reject the pending promise so callers awaiting callback don't hang
      // forever (e.g., when relay context arrives and we switch to relay mode).
      rejectPromise(new Error("OAuth callback server closed"));
    },
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
  /**
   * When true, waitForRelayContext() defers its fallback timeout until
   * markRelayWaitAnchorReady() is called.
   */
  deferRelayWaitTimeoutUntilAnchor?: boolean;
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

  /** Internal relay context storage. Use the getter/setter. */
  private _relayContext: RelayContext | null = null;

  /**
   * Whether we have ever entered relay mode. Used to distinguish the initial
   * local→relay transition (where we must invalidate localhost-bound client
   * credentials) from subsequent reconnects (null→ctx after a transient
   * disconnect) where credentials should be preserved.
   */
  private _hasBeenInRelayMode = false;

  /** Callbacks waiting for relay context to become available. */
  private _relayReadyResolvers: Array<() => void> = [];

  /** Whether waitForRelayContext timeout is deferred until anchor is marked ready. */
  private _deferRelayWaitTimeoutUntilAnchor: boolean;

  /** Whether the timeout anchor has been opened (session_start reached). */
  private _relayWaitAnchorReady: boolean;

  /** Waiters to notify when the timeout anchor is opened. */
  private _relayWaitAnchorResolvers: Array<() => void> = [];

  /** Nonce for the current auth flow (relay mode). */
  private _currentNonce: string | null = null;

  /** Expected OAuth state from the most recent authorization request (for CSRF validation). */
  private _pendingState: string | null = null;

  constructor(opts: McpOAuthOptions) {
    this._serverUrl = opts.serverUrl;
    this._serverName = opts.serverName;
    this._callbackPort = opts.callbackPort ?? 0;
    this._onAuthStart = opts.onAuthStart;
    this._onAuthComplete = opts.onAuthComplete;
    this._deferRelayWaitTimeoutUntilAnchor = opts.deferRelayWaitTimeoutUntilAnchor === true;
    this._relayWaitAnchorReady = !this._deferRelayWaitTimeoutUntilAnchor;
    this._persisted = loadPersistedAuth(this._serverUrl);
  }

  /** Relay context — set by the remote extension when relay is connected. */
  get relayContext(): RelayContext | null {
    return this._relayContext;
  }

  set relayContext(ctx: RelayContext | null) {
    this._relayContext = ctx;
    if (ctx) {
      // First time entering relay mode: clean up any local callback server that
      // was eagerly started (e.g., if redirectUrl was accessed before relay
      // connected) and invalidate cached client info whose redirect_uris
      // pointed to localhost.
      //
      // On reconnects (transient null→ctx after a disconnect), skip invalidation
      // so persisted client credentials survive network blips.
      if (!this._hasBeenInRelayMode) {
        this._hasBeenInRelayMode = true;
        if (this._callbackServer) {
          // Swallow the rejection from close() — the promise may have no
          // consumer yet (eager creation from the redirectUrl getter before
          // startCallbackAndWait() is called), so the rejection would be
          // unhandled and Bun would treat it as a fatal error.
          this._callbackServer.promise.catch(() => {});
          this._callbackServer.close();
          this._callbackServer = null;
        }
        // Only invalidate client info if its redirect_uris point to localhost
        // (registered in local mode). Relay-registered clients are still valid.
        if (this._persisted.clientInfo && hasLocalhostRedirects(this._persisted.clientInfo)) {
          this.invalidateCredentials("client");
        }
      }
      // Notify anyone waiting for relay context
      const resolvers = this._relayReadyResolvers.splice(0);
      for (const resolve of resolvers) resolve();
    }
  }

  /**
   * Open the timeout anchor for waitForRelayContext().
   *
   * When deferRelayWaitTimeoutUntilAnchor is enabled, this starts the
   * fallback timeout window for all currently waiting callers.
   */
  markRelayWaitAnchorReady(): void {
    if (this._relayWaitAnchorReady) return;
    this._relayWaitAnchorReady = true;
    const resolvers = this._relayWaitAnchorResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }

  /**
   * Wait for relay context to become available (e.g. during startup when
   * MCP init races ahead of the relay connection).
   *
   * Returns immediately if relay context is already set, otherwise waits
   * up to `timeoutMs` before resolving (caller falls back to local mode).
   *
   * If deferRelayWaitTimeoutUntilAnchor is enabled, timeout counting begins
   * only after markRelayWaitAnchorReady() is called.
   */
  waitForRelayContext(timeoutMs: number = 15_000): Promise<void> {
    if (this._relayContext) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        const idx = this._relayReadyResolvers.indexOf(wrappedResolve);
        if (idx >= 0) this._relayReadyResolvers.splice(idx, 1);
        const anchorIdx = this._relayWaitAnchorResolvers.indexOf(startTimeout);
        if (anchorIdx >= 0) this._relayWaitAnchorResolvers.splice(anchorIdx, 1);
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const finish = () => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve();
      };

      const wrappedResolve = () => {
        finish();
      };

      const startTimeout = () => {
        if (finished || timer || timeoutMs <= 0) return;
        timer = setTimeout(() => {
          finish();
        }, timeoutMs);
      };

      this._relayReadyResolvers.push(wrappedResolve);

      if (timeoutMs <= 0) {
        finish();
        return;
      }

      if (!this._deferRelayWaitTimeoutUntilAnchor || this._relayWaitAnchorReady) {
        startTimeout();
      } else {
        this._relayWaitAnchorResolvers.push(startTimeout);
      }
    });
  }

  private get _useRelay(): boolean {
    return this._relayContext !== null;
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
      // Attach a default catch so the 2-minute timeout doesn't cause an
      // unhandled rejection if nobody ever awaits startCallbackAndWait()
      // (e.g. auth() returns "AUTHORIZED" without redirecting).
      this._callbackServer.promise.catch(() => {});
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
      const s = encodeRelayState(
        this.relayContext!.sessionId,
        this._currentNonce,
      );
      this._pendingState = s;
      return s;
    }
    // Local mode: simple random state for CSRF protection
    const s = randomBytes(16).toString("hex");
    this._pendingState = s;
    return s;
  }

  /**
   * Validate that a callback state matches the one we generated.
   * Returns true if state matches (or if no state was expected).
   */
  validateCallbackState(returnedState?: string): boolean {
    if (!this._pendingState) return true; // No state to validate
    if (!returnedState) return false; // Expected state but none returned
    return this._pendingState === returnedState;
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

    // Notify web UI that authentication completed
    if (this._useRelay) {
      this.relayContext!.emitEvent("mcp:auth_complete", {
        type: "mcp_auth_complete",
        serverName: this._serverName,
        ts: Date.now(),
      });
    }
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
      // Inform the user in case no web viewer is currently attached.
      process.stderr.write(`🔐 ${this._serverName} requires authentication — check web UI\n`);
    } else {
      // Local mode: open browser directly
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
      // Relay mode: wait for code from server via WebSocket.
      // The relay state (which is the OAuth `state` param) was generated by
      // our `state()` method and stored in `_pendingState`. Return it here
      // so the caller can pass it to `validateCallbackState()`.
      const relayState = this._pendingState ?? undefined;
      return this.relayContext!.waitForCallback(this._currentNonce).then((code) => ({
        code,
        state: relayState,
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
    if (this._callbackServer) {
      // Suppress unhandled rejection — same rationale as in the relayContext
      // setter: the promise may have been created eagerly with no consumer.
      this._callbackServer.promise.catch(() => {});
      this._callbackServer.close();
      this._callbackServer = null;
    }
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
