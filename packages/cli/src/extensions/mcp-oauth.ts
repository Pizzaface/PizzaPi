/**
 * MCP OAuth 2.1 provider for PizzaPi.
 *
 * Handles the full MCP OAuth flow:
 *  1. Detect 401 from MCP server
 *  2. Discover resource metadata & authorization server
 *  3. Dynamic client registration
 *  4. PKCE authorization flow (opens browser)
 *  5. Local callback server to receive auth code
 *  6. Token exchange & persistence
 *
 * Tokens and client registrations are persisted to ~/.pizzapi/mcp-auth/
 * so subsequent sessions reuse existing credentials.
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { exec } from "child_process";
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
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      // If we can't open a browser, print the URL to stderr for manual use
      process.stderr.write(`\n🔐 Open this URL to authenticate:\n${url}\n\n`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Local callback server (receives OAuth redirect)
// ─────────────────────────────────────────────────────────────────────────────

export type OAuthCallbackResult = {
  code: string;
  state?: string;
};

/**
 * Start a temporary local HTTP server to receive the OAuth callback.
 * Returns a promise that resolves when the auth code is received.
 * The server auto-closes after receiving the callback or on timeout.
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

      // Ignore favicon requests
      if (url.pathname === "/favicon.ico") {
        return new Response(null, { status: 404 });
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state") ?? undefined;

      if (code) {
        clearTimeout(timer);
        resolvePromise({ code, state });
        // Auto-close after a short delay to let the response finish
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
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuthClientProvider implementation
// ─────────────────────────────────────────────────────────────────────────────

/** Default callback port — uses port 0 to let the OS pick a free port. */
const DEFAULT_CALLBACK_PORT = 0;

export type McpOAuthOptions = {
  /** MCP server URL (used as key for persisted tokens). */
  serverUrl: string;
  /** Human-readable server name for log messages. */
  serverName: string;
  /** Callback port override. 0 = auto. */
  callbackPort?: number;
  /** Callback when auth starts (for TUI/web notifications). */
  onAuthStart?: (authUrl: string) => void;
  /** Callback when auth completes. */
  onAuthComplete?: () => void;
};

/**
 * PizzaPi OAuth provider for MCP servers.
 *
 * Implements the MCP SDK's `OAuthClientProvider` interface with:
 * - Persistent token storage in ~/.pizzapi/mcp-auth/
 * - Browser-based authorization flow
 * - Local callback server for receiving auth codes
 */
export class PizzaPiOAuthProvider implements OAuthClientProvider {
  private _serverUrl: string;
  private _serverName: string;
  private _persisted: PersistedAuth;
  private _callbackPort: number;
  private _callbackServer: ReturnType<typeof startCallbackServer> | null = null;
  private _onAuthStart?: (authUrl: string) => void;
  private _onAuthComplete?: () => void;

  constructor(opts: McpOAuthOptions) {
    this._serverUrl = opts.serverUrl;
    this._serverName = opts.serverName;
    this._callbackPort = opts.callbackPort ?? DEFAULT_CALLBACK_PORT;
    this._onAuthStart = opts.onAuthStart;
    this._onAuthComplete = opts.onAuthComplete;
    this._persisted = loadPersistedAuth(this._serverUrl);
  }

  get redirectUrl(): string {
    // If we already have a callback server running, use its port
    if (this._callbackServer) {
      return `http://localhost:${this._callbackServer.getPort()}/callback`;
    }
    // Before the server starts, use the configured port (0 means we'll update later)
    return `http://localhost:${this._callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `PizzaPi (${this._serverName})`,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
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
    process.stderr.write(`\n🔐 Opening browser for ${this._serverName} MCP authentication…\n`);
    openBrowser(url);
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
    if (scope === "all" || scope === "tokens") {
      delete this._persisted.tokens;
    }
    if (scope === "all" || scope === "client") {
      delete this._persisted.clientInfo;
    }
    if (scope === "all" || scope === "verifier") {
      delete this._persisted.codeVerifier;
    }
    savePersistedAuth(this._serverUrl, this._persisted);
  }

  // ── Callback server management ──────────────────────────────────────────

  /**
   * Start the callback server and wait for the OAuth code.
   * Called externally by the transport when `auth()` returns REDIRECT.
   */
  startCallbackAndWait(): Promise<OAuthCallbackResult> {
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
