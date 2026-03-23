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
            waitForCallback: () => Promise.resolve("mock-code"),
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
