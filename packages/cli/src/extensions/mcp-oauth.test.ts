import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PizzaPiOAuthProvider, startCallbackServer, encodeRelayState, type RelayContext } from "./mcp-oauth.js";

// Redirect HOME to a temp directory so tests don't write to the real home.
const originalHome = process.env.HOME;
const tempHome = mkdtempSync(join(tmpdir(), "mcp-oauth-test-"));

beforeAll(() => {
    process.env.HOME = tempHome;
});

afterAll(() => {
    process.env.HOME = originalHome;
    try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
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
        const { getPort, close } = startCallbackServer(0, 5000);
        try {
            const port = getPort();
            expect(port).toBeGreaterThan(0);
        } finally {
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
});
