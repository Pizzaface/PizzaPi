import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PizzaPiOAuthProvider, startCallbackServer, encodeRelayState, type RelayContext } from "./mcp-oauth.js";

// Redirect MCP auth dir to a temp directory so tests don't write to the real home.
// Note: Bun caches os.homedir() at process start, so mutating HOME has no effect.
// We use PIZZAPI_MCP_AUTH_DIR instead, which getMcpAuthDir() checks first.
const originalAuthDir = process.env.PIZZAPI_MCP_AUTH_DIR;
const tempAuthDir = mkdtempSync(join(tmpdir(), "mcp-oauth-test-"));

beforeAll(() => {
    process.env.PIZZAPI_MCP_AUTH_DIR = tempAuthDir;
});

afterAll(() => {
    if (originalAuthDir !== undefined) {
        process.env.PIZZAPI_MCP_AUTH_DIR = originalAuthDir;
    } else {
        delete process.env.PIZZAPI_MCP_AUTH_DIR;
    }
    try { rmSync(tempAuthDir, { recursive: true, force: true }); } catch {}
});

describe("PizzaPiOAuthProvider", () => {
    function createProvider() {
        return new PizzaPiOAuthProvider({
            serverUrl: "https://example.com/mcp",
            serverName: "test-server",
        });
    }

    function createMockRelayContext(overrides?: Partial<RelayContext>): RelayContext {
        return {
            serverBaseUrl: "https://pizza.example.com",
            sessionId: "test-session-123",
            emitEvent: () => {},
            waitForCallback: () => Promise.resolve({ code: "mock-code" }),
            ...overrides,
        };
    }

    describe("relayContext getter/setter", () => {
        test("starts as null", () => {
            const provider = createProvider();
            expect(provider.relayContext).toBeNull();
        });

        test("can be set and read back", () => {
            const provider = createProvider();
            const ctx = createMockRelayContext();
            provider.relayContext = ctx;
            expect(provider.relayContext).toBe(ctx);
        });

        test("can be set back to null", () => {
            const provider = createProvider();
            provider.relayContext = createMockRelayContext();
            provider.relayContext = null;
            expect(provider.relayContext).toBeNull();
        });
    });

    describe("waitForRelayContext", () => {
        test("resolves immediately when relay context is already set", async () => {
            const provider = createProvider();
            provider.relayContext = createMockRelayContext();

            const start = Date.now();
            await provider.waitForRelayContext(5000);
            const elapsed = Date.now() - start;

            expect(elapsed).toBeLessThan(50); // should be near-instant
        });

        test("resolves when relay context is set after waiting", async () => {
            const provider = createProvider();

            // Set relay context after a short delay
            setTimeout(() => {
                provider.relayContext = createMockRelayContext();
            }, 50);

            const start = Date.now();
            await provider.waitForRelayContext(5000);
            const elapsed = Date.now() - start;

            expect(elapsed).toBeGreaterThanOrEqual(40); // waited for the setTimeout
            expect(elapsed).toBeLessThan(1000); // but didn't wait for timeout
            expect(provider.relayContext).not.toBeNull();
        });

        test("resolves after timeout when relay context is never set", async () => {
            const provider = createProvider();

            const start = Date.now();
            await provider.waitForRelayContext(100); // 100ms timeout
            const elapsed = Date.now() - start;

            expect(elapsed).toBeGreaterThanOrEqual(90);
            expect(elapsed).toBeLessThan(500);
            expect(provider.relayContext).toBeNull(); // still null
        });

        test("deferred timeout starts only after relay wait anchor is ready", async () => {
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://defer-timeout-${Date.now()}.example.com/mcp`,
                serverName: "defer-timeout",
                deferRelayWaitTimeoutUntilAnchor: true,
            });

            const start = Date.now();
            const waitPromise = provider.waitForRelayContext(100);

            // Before anchor is ready, timeout should not fire.
            await new Promise((r) => setTimeout(r, 150));
            let settled = false;
            waitPromise.then(() => {
                settled = true;
            });
            await new Promise((r) => setTimeout(r, 20));
            expect(settled).toBe(false);

            provider.markRelayWaitAnchorReady();
            await waitPromise;
            const elapsed = Date.now() - start;

            // ~150ms pre-anchor + ~100ms timeout after anchor.
            expect(elapsed).toBeGreaterThanOrEqual(220);
            expect(elapsed).toBeLessThan(700);
        });

        test("deferred wait resolves immediately if relay arrives before anchor", async () => {
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://defer-relay-${Date.now()}.example.com/mcp`,
                serverName: "defer-relay",
                deferRelayWaitTimeoutUntilAnchor: true,
            });

            const waitPromise = provider.waitForRelayContext(200);
            setTimeout(() => {
                provider.relayContext = createMockRelayContext();
            }, 40);

            await waitPromise;
            expect(provider.relayContext).not.toBeNull();
        });

        test("deferred wait with timeout 0 falls back immediately", async () => {
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://defer-zero-${Date.now()}.example.com/mcp`,
                serverName: "defer-zero",
                deferRelayWaitTimeoutUntilAnchor: true,
            });

            const start = Date.now();
            await provider.waitForRelayContext(0);
            const elapsed = Date.now() - start;

            expect(elapsed).toBeLessThan(50);
            expect(provider.relayContext).toBeNull();
        });

        test("multiple waiters are all resolved when context is set", async () => {
            const provider = createProvider();

            const results: number[] = [];

            const p1 = provider.waitForRelayContext(5000).then(() => results.push(1));
            const p2 = provider.waitForRelayContext(5000).then(() => results.push(2));
            const p3 = provider.waitForRelayContext(5000).then(() => results.push(3));

            // Set context after a short delay
            setTimeout(() => {
                provider.relayContext = createMockRelayContext();
            }, 50);

            await Promise.all([p1, p2, p3]);

            expect(results).toHaveLength(3);
            expect(results).toContain(1);
            expect(results).toContain(2);
            expect(results).toContain(3);
        });

        test("rejects immediately when signal is already aborted", async () => {
            const provider = createProvider();
            const ac = new AbortController();
            ac.abort();

            const start = Date.now();
            await expect(provider.waitForRelayContext(5000, ac.signal)).rejects.toThrow("Aborted");
            expect(Date.now() - start).toBeLessThan(100);
        });

        test("rejects when signal is aborted while waiting", async () => {
            const provider = createProvider();
            const ac = new AbortController();

            const waitPromise = provider.waitForRelayContext(5000, ac.signal);

            // Not resolved yet — no context, no abort, no timeout
            await new Promise((r) => setTimeout(r, 50));

            // Abort should reject immediately
            ac.abort();
            await expect(waitPromise).rejects.toThrow("Aborted");
        });

        test("abort cleans up relay ready resolvers", async () => {
            const provider = createProvider();
            const ac = new AbortController();

            const waitPromise = provider.waitForRelayContext(5000, ac.signal);
            ac.abort();
            await expect(waitPromise).rejects.toThrow("Aborted");

            // Setting context after abort should not cause issues
            provider.relayContext = createMockRelayContext();
        });

        test("setting context to null does not resolve waiters", async () => {
            const provider = createProvider();
            let resolved = false;

            const waitPromise = provider.waitForRelayContext(200).then(() => {
                resolved = true;
            });

            // Setting to null should NOT resolve
            provider.relayContext = null;
            await new Promise((r) => setTimeout(r, 50));
            expect(resolved).toBe(false);

            // Setting to a real context SHOULD resolve
            provider.relayContext = createMockRelayContext();
            await waitPromise;
            expect(resolved).toBe(true);
        });
    });

    describe("relay context transition cleanup", () => {
        test("redirectUrl returns relay URL when relay context is set", () => {
            const provider = createProvider();
            provider.relayContext = createMockRelayContext({
                serverBaseUrl: "https://pizza.test.com",
            });

            const url = provider.redirectUrl.toString();
            expect(url).toBe("https://pizza.test.com/api/mcp-oauth-callback");
        });

        test("redirectUrl returns localhost when no relay context", () => {
            const provider = createProvider();
            const url = provider.redirectUrl.toString();
            expect(url).toMatch(/^http:\/\/localhost:\d+\/callback$/);
        });

        test("clientMetadata includes correct redirect_uri for relay mode", () => {
            const provider = createProvider();
            provider.relayContext = createMockRelayContext({
                serverBaseUrl: "https://relay.example.com",
            });

            const meta = provider.clientMetadata;
            expect(meta.redirect_uris).toHaveLength(1);
            expect(meta.redirect_uris[0]).toBe("https://relay.example.com/api/mcp-oauth-callback");
        });

        test("relay transition after eager callback start does not cause unhandled rejection", async () => {
            const provider = createProvider();

            // Eagerly create callback server by reading redirectUrl in local mode
            // (this is what happens when the MCP SDK calls clientMetadata before
            // startCallbackAndWait — the promise has no consumer yet).
            const localUrl = provider.redirectUrl.toString();
            expect(localUrl).toMatch(/^http:\/\/localhost:\d+\/callback$/);

            // Transition to relay mode — this closes the callback server.
            // Before the fix, this rejected an unobserved promise → fatal in Bun.
            provider.relayContext = createMockRelayContext();

            // If we get here without an unhandled rejection, the fix works.
            // Give the microtask queue a tick so any unhandled rejection would fire.
            await new Promise((r) => setTimeout(r, 50));

            // Verify we're now in relay mode
            expect(provider.redirectUrl.toString()).toBe(
                "https://pizza.example.com/api/mcp-oauth-callback",
            );
        });

        test("closeCallback after eager start does not cause unhandled rejection", async () => {
            const provider = createProvider();

            // Eagerly create callback server
            const localUrl = provider.redirectUrl.toString();
            expect(localUrl).toMatch(/^http:\/\/localhost:\d+\/callback$/);

            // Close without anyone awaiting the promise
            provider.closeCallback();

            // Give the microtask queue a tick
            await new Promise((r) => setTimeout(r, 50));

            // Should be cleanly closed — accessing redirectUrl starts a fresh server
            const newUrl = provider.redirectUrl.toString();
            expect(newUrl).toMatch(/^http:\/\/localhost:\d+\/callback$/);
        });

        test("reconnect (null→ctx after disconnect) preserves client credentials", () => {
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://reconnect-${Date.now()}.example.com/mcp`,
                serverName: "reconnect-server",
            });

            // First transition: local → relay (should invalidate localhost client info)
            const ctx = createMockRelayContext();
            provider.relayContext = ctx;

            // Save client credentials in relay mode
            provider.saveClientInformation({
                client_id: "test-client",
                client_secret: "test-secret",
                redirect_uris: ["https://pizza.example.com/api/mcp-oauth-callback"],
            } as any);
            expect(provider.clientInformation()?.client_id).toBe("test-client");

            // Simulate disconnect → reconnect cycle
            provider.relayContext = null;
            provider.relayContext = createMockRelayContext();

            // Client credentials should survive the reconnect
            expect(provider.clientInformation()?.client_id).toBe("test-client");
        });
    });

    describe("clientName override", () => {
        test("default client_name uses PizzaPi with server suffix", () => {
            const provider = createProvider();
            const meta = provider.clientMetadata;
            expect(meta.client_name).toBe("PizzaPi (test-server)");
        });

        test("custom clientName is sent verbatim (no suffix)", () => {
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://custom-name-${Date.now()}.example.com/mcp`,
                serverName: "figma",
                clientName: "Codex",
            });
            const meta = provider.clientMetadata;
            // Must be exactly "Codex" — no "(figma)" suffix — so it matches
            // exact allowlists like Figma's registration endpoint.
            expect(meta.client_name).toBe("Codex");
        });

        test("clientName of empty string falls back to PizzaPi with suffix", () => {
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://empty-name-${Date.now()}.example.com/mcp`,
                serverName: "test",
                clientName: "",
            });
            const meta = provider.clientMetadata;
            expect(meta.client_name).toBe("PizzaPi (test)");
        });
    });

    describe("localhost registration + paste mode", () => {
        test("enableLocalhostRegistration makes clientMetadata use localhost redirect_uri in relay mode", () => {
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://localhost-reg-${Date.now()}.example.com/mcp`,
                serverName: "figma",
            });
            provider.relayContext = createMockRelayContext();
            provider.enableLocalhostRegistration();

            const meta = provider.clientMetadata;
            expect(meta.redirect_uris).toHaveLength(1);
            expect(meta.redirect_uris[0]).toBe("http://localhost:1/callback");
        });

        test("redirectUrl returns localhost when localhostRegistration is enabled in relay mode", () => {
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://localhost-redirect-${Date.now()}.example.com/mcp`,
                serverName: "figma",
            });
            provider.relayContext = createMockRelayContext();
            provider.enableLocalhostRegistration();

            const url = provider.redirectUrl.toString();
            expect(url).toBe("http://localhost:1/callback");
        });

        test("redirectToAuthorization emits mcp:auth_paste_required in paste mode", () => {
            const emittedEvents: Array<{ name: string; data: unknown }> = [];
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://paste-event-${Date.now()}.example.com/mcp`,
                serverName: "figma",
            });
            provider.relayContext = createMockRelayContext({
                emitEvent: (name, data) => emittedEvents.push({ name, data }),
            });
            provider.enableLocalhostRegistration();

            provider.redirectToAuthorization(new URL("https://figma.com/oauth/authorize?foo=bar"));

            expect(emittedEvents).toHaveLength(1);
            expect(emittedEvents[0].name).toBe("mcp:auth_paste_required");
            const payload = emittedEvents[0].data as Record<string, unknown>;
            expect(payload.type).toBe("mcp_auth_paste_required");
            expect(payload.serverName).toBe("figma");
            expect(payload.authUrl).toBe("https://figma.com/oauth/authorize?foo=bar");
        });

        test("redirectToAuthorization emits mcp:auth_required in normal relay mode", () => {
            const emittedEvents: Array<{ name: string; data: unknown }> = [];
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://normal-relay-${Date.now()}.example.com/mcp`,
                serverName: "test-server",
            });
            provider.relayContext = createMockRelayContext({
                emitEvent: (name, data) => emittedEvents.push({ name, data }),
            });

            provider.redirectToAuthorization(new URL("https://example.com/oauth/authorize"));

            expect(emittedEvents).toHaveLength(1);
            expect(emittedEvents[0].name).toBe("mcp:auth_required");
        });

        test("startCallbackAndWait uses relay waitForCallback in paste mode", async () => {
            let capturedNonce: string | null = null;
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://paste-wait-${Date.now()}.example.com/mcp`,
                serverName: "figma",
            });
            provider.relayContext = createMockRelayContext({
                waitForCallback: (nonce) => {
                    capturedNonce = nonce;
                    return Promise.resolve({ code: "pasted-auth-code", state: "test-state" });
                },
            });
            provider.enableLocalhostRegistration();

            // Generate a nonce by calling state()
            await provider.state();

            const result = await provider.startCallbackAndWait();
            expect(result.code).toBe("pasted-auth-code");
            expect(capturedNonce).not.toBeNull();
        });
    });

    describe("pre-registered client credentials (oauthClientId / oauthClientSecret)", () => {
        test("clientInformation returns static credentials when clientId is set", () => {
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://static-creds-${Date.now()}.example.com/mcp`,
                serverName: "static-server",
                clientId: "my-app-id",
                clientSecret: "my-app-secret",
            });
            const info = provider.clientInformation();
            expect(info).toBeDefined();
            expect(info!.client_id).toBe("my-app-id");
            expect((info as any).client_secret).toBe("my-app-secret");
        });

        test("clientInformation returns static credentials without secret for public clients", () => {
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://public-client-${Date.now()}.example.com/mcp`,
                serverName: "public-server",
                clientId: "public-app-id",
            });
            const info = provider.clientInformation();
            expect(info).toBeDefined();
            expect(info!.client_id).toBe("public-app-id");
            expect((info as any).client_secret).toBeUndefined();
        });

        test("saveClientInformation is a no-op when static clientId is set", () => {
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://no-save-${Date.now()}.example.com/mcp`,
                serverName: "no-save-server",
                clientId: "my-static-id",
                clientSecret: "my-static-secret",
            });

            // Attempt to overwrite with different credentials
            provider.saveClientInformation({
                client_id: "dynamic-id",
                client_secret: "dynamic-secret",
            } as any);

            // Should still return the static credentials
            const info = provider.clientInformation();
            expect(info!.client_id).toBe("my-static-id");
            expect((info as any).client_secret).toBe("my-static-secret");
        });

        test("per-server public client does not inherit global secret", () => {
            // Simulates: global config has oauthClientSecret, per-server entry
            // has oauthClientId but no secret (public PKCE client).
            // The provider should NOT receive the global secret.
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://public-no-leak-${Date.now()}.example.com/mcp`,
                serverName: "public-server",
                clientId: "per-server-public-id",
                // clientSecret intentionally omitted — should NOT inherit global
            });
            const info = provider.clientInformation();
            expect(info).toBeDefined();
            expect(info!.client_id).toBe("per-server-public-id");
            expect((info as any).client_secret).toBeUndefined();
        });

        test("invalidates persisted tokens when static clientId changes", () => {
            const serverUrl = `https://client-change-${Date.now()}.example.com/mcp`;

            // First: create a provider with client A and save tokens
            const providerA = new PizzaPiOAuthProvider({
                serverUrl,
                serverName: "changing-server",
                clientId: "client-a",
            });
            providerA.saveTokens({
                access_token: "token-for-client-a",
                token_type: "bearer",
            });
            expect(providerA.hasTokens()).toBe(true);

            // Second: create a new provider with client B for the same server URL
            const providerB = new PizzaPiOAuthProvider({
                serverUrl,
                serverName: "changing-server",
                clientId: "client-b",
            });
            // Tokens from client A should be invalidated
            expect(providerB.hasTokens()).toBe(false);
            expect(providerB.tokens()).toBeUndefined();
            // Client info should be the new static credentials
            expect(providerB.clientInformation()!.client_id).toBe("client-b");
        });

        test("preserves persisted tokens when static clientId is unchanged", () => {
            const serverUrl = `https://same-client-${Date.now()}.example.com/mcp`;

            // Create a provider and save tokens
            const provider1 = new PizzaPiOAuthProvider({
                serverUrl,
                serverName: "same-server",
                clientId: "stable-client",
            });
            provider1.saveTokens({
                access_token: "my-token",
                token_type: "bearer",
            });

            // Re-create with the same clientId — tokens should survive
            const provider2 = new PizzaPiOAuthProvider({
                serverUrl,
                serverName: "same-server",
                clientId: "stable-client",
            });
            expect(provider2.hasTokens()).toBe(true);
            expect(provider2.tokens()!.access_token).toBe("my-token");
        });

        test("falls back to persisted DCR data when no static clientId", () => {
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://dcr-fallback-${Date.now()}.example.com/mcp`,
                serverName: "dcr-server",
            });

            // No static credentials — should return undefined initially
            expect(provider.clientInformation()).toBeUndefined();

            // Save DCR credentials — should be returned
            provider.saveClientInformation({
                client_id: "dcr-id",
                client_secret: "dcr-secret",
            } as any);

            const info = provider.clientInformation();
            expect(info!.client_id).toBe("dcr-id");
        });
    });

    describe("callbackPort", () => {
        test("callback server uses specified port", () => {
            const { promise, getPort, close } = startCallbackServer(19876, 5000);
            try {
                expect(getPort()).toBe(19876);
            } finally {
                promise.catch(() => {});
                close();
            }
        });

        test("callback server uses random port when 0", () => {
            const { promise, getPort, close } = startCallbackServer(0, 5000);
            try {
                expect(getPort()).toBeGreaterThan(0);
            } finally {
                promise.catch(() => {});
                close();
            }
        });
    });

    describe("hasTokens", () => {
        test("returns false when no tokens are saved", () => {
            // Use a unique URL so persisted state from other tests doesn't interfere
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://no-tokens-${Date.now()}.example.com/mcp`,
                serverName: "no-tokens-server",
            });
            expect(provider.hasTokens()).toBe(false);
        });

        test("returns true after saving tokens", () => {
            const provider = new PizzaPiOAuthProvider({
                serverUrl: `https://has-tokens-${Date.now()}.example.com/mcp`,
                serverName: "has-tokens-server",
            });
            provider.saveTokens({
                access_token: "test-token",
                token_type: "bearer",
            });
            expect(provider.hasTokens()).toBe(true);
        });
    });
});

describe("encodeRelayState", () => {
    test("encodes session ID and nonce", () => {
        const state = encodeRelayState("session-123", "nonce-abc");
        const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf-8"));
        expect(decoded.sessionId).toBe("session-123");
        expect(decoded.nonce).toBe("nonce-abc");
    });

    test("includes optional oauthState", () => {
        const state = encodeRelayState("session-123", "nonce-abc", "oauth-state-xyz");
        const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf-8"));
        expect(decoded.oauthState).toBe("oauth-state-xyz");
    });
});

describe("startCallbackServer", () => {
    test("returns a server with getPort and close", () => {
        const { promise, getPort, close } = startCallbackServer(0, 5000);
        try {
            const port = getPort();
            expect(port).toBeGreaterThan(0);
        } finally {
            // close() now rejects the pending promise — catch it to avoid unhandled rejection.
            promise.catch(() => {});
            close();
        }
    });

    test("resolves with auth code when callback is received", async () => {
        const { promise, getPort, close } = startCallbackServer(0, 5000);
        const port = getPort();

        try {
            // Simulate OAuth callback
            const res = await fetch(`http://localhost:${port}/callback?code=test-code-123&state=test-state`);
            expect(res.status).toBe(200);

            const result = await promise;
            expect(result.code).toBe("test-code-123");
            expect(result.state).toBe("test-state");
        } finally {
            close();
        }
    });

    test("rejects on error response", async () => {
        const { promise, getPort, close } = startCallbackServer(0, 5000);
        const port = getPort();

        try {
            // Kick off the error callback (don't await the promise yet)
            const fetchPromise = fetch(`http://localhost:${port}/callback?error=access_denied`);
            // The server promise should reject with the error
            await expect(promise).rejects.toThrow("access_denied");
            // Clean up the fetch
            await fetchPromise.catch(() => {});
        } finally {
            close();
        }
    });

    test("close() rejects pending promise so callers don't hang", async () => {
        const { promise, close } = startCallbackServer(0, 30_000);
        // Close the server before any callback arrives
        close();
        // The pending promise should reject (not hang forever)
        await expect(promise).rejects.toThrow("closed");
    });
});
