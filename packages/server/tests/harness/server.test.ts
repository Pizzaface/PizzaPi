/**
 * Smoke tests for the test server factory harness.
 *
 * These tests verify that createTestServer():
 *   1. Spins up a real HTTP server that responds to requests
 *   2. Pre-creates a user with a working API key
 *   3. Enforces one-active-server constraint (module singletons)
 *   4. Cleans up all resources on shutdown
 */

import { describe, test, expect } from "bun:test";
import { io as clientIo } from "socket.io-client";
import { createTestServer } from "./server.js";
import type { TestServer } from "./types.js";

// Tests spin up real servers + Redis + Socket.IO, so we need a generous timeout.
const TEST_TIMEOUT_MS = 30_000;

function redisConnectUrls(): string[] {
    const globals = globalThis as unknown as { __harnessRedisConnectUrls?: string[] };
    globals.__harnessRedisConnectUrls ??= [];
    return globals.__harnessRedisConnectUrls;
}

function isDefaultDevRedisUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        const usesDefaultDb = parsed.pathname === "" || parsed.pathname === "/" || parsed.pathname === "/0";
        return parsed.protocol === "redis:" && (parsed.port || "6379") === "6379" && usesDefaultDb &&
            (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    } catch {
        return false;
    }
}

async function registerTestSession(server: TestServer): Promise<{ sessionId: string; relay: ReturnType<typeof clientIo> }> {
    const relay = clientIo(`${server.baseUrl}/relay`, {
        auth: { apiKey: server.apiKey },
        transports: ["websocket"],
        forceNew: true,
        reconnection: false,
    });

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            relay.disconnect();
            reject(new Error("registerTestSession: timeout waiting for registered event"));
        }, 8_000);

        relay.once("registered", (data: { sessionId: string }) => {
            clearTimeout(timer);
            resolve({ sessionId: data.sessionId, relay });
        });

        relay.once("connect_error", (err: Error) => {
            clearTimeout(timer);
            relay.disconnect();
            reject(new Error(`registerTestSession: connect_error: ${err.message}`));
        });

        relay.emit("register", { cwd: "/tmp/test", ephemeral: true });
    });
}

async function connectViewerWithOrigin(
    server: TestServer,
    sessionId: string,
    origin: string,
): Promise<{ socket: ReturnType<typeof clientIo>; error?: string }> {
    const socket = clientIo(`${server.baseUrl}/viewer`, {
        extraHeaders: {
            cookie: server.sessionCookie,
            origin,
        },
        query: { sessionId },
        transports: ["websocket"],
        autoConnect: false,
        forceNew: true,
        reconnection: false,
    });

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            socket.disconnect();
            resolve({ socket, error: "timeout" });
        }, 8_000);

        socket.once("connect_error", (err: Error) => {
            clearTimeout(timer);
            socket.disconnect();
            resolve({ socket, error: err.message });
        });

        socket.once("connected", () => {
            clearTimeout(timer);
            resolve({ socket });
        });

        socket.connect();
        socket.once("connect", () => {
            socket.emit("connected", {});
        });
    });
}

describe("createTestServer", () => {
    test("cleans up env and active guard when auto Redis provisioning fails", async () => {
        const previousRedisUrl = process.env.PIZZAPI_REDIS_URL;
        const previousTrustProxy = process.env.PIZZAPI_TRUST_PROXY;
        delete process.env.PIZZAPI_REDIS_URL;
        process.env.PIZZAPI_TEST_FORCE_REDIS_PROVISION_FAILURE = "1";

        try {
            await expect(createTestServer()).rejects.toThrow("forced RedisMemoryServer provisioning failure");
            expect(process.env.PIZZAPI_TRUST_PROXY).toBe(previousTrustProxy);
        } finally {
            delete process.env.PIZZAPI_TEST_FORCE_REDIS_PROVISION_FAILURE;
            if (previousRedisUrl === undefined) delete process.env.PIZZAPI_REDIS_URL;
            else process.env.PIZZAPI_REDIS_URL = previousRedisUrl;
            if (previousTrustProxy === undefined) delete process.env.PIZZAPI_TRUST_PROXY;
            else process.env.PIZZAPI_TRUST_PROXY = previousTrustProxy;
        }

        const server = await createTestServer();
        await server.cleanup();
    }, TEST_TIMEOUT_MS);

    test("creates server and responds to health check", async () => {
        const server = await createTestServer();
        try {
            const res = await fetch(`${server.baseUrl}/health`);
            // Health may be degraded if Redis singletons were overwritten, but
            // the server must respond with the expected shape.
            expect([200, 503]).toContain(res.status);
            const data = await res.json();
            expect(["ok", "degraded"]).toContain(data.status);
            expect(typeof data.redis).toBe("boolean");
            expect(typeof data.socketio).toBe("boolean");
            expect(typeof data.uptime).toBe("number");
        } finally {
            await server.cleanup();
        }
    }, TEST_TIMEOUT_MS);

    test("pre-created user can authenticate via API key", async () => {
        const server = await createTestServer();
        try {
            // Verify basic properties are populated
            expect(server.port).toBeGreaterThan(0);
            expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
            expect(server.apiKey).toHaveLength(64); // 32 random bytes → 64 hex chars
            expect(server.userId).toBeTruthy();
            expect(server.userName).toBe("Test User");
            expect(server.userEmail).toBe("testuser@pizzapi-harness.test");
            expect(server.sessionCookie).toBeTruthy();

            // The built-in fetch helper includes auth headers
            const res = await server.fetch("/api/signup-status");
            expect(res.status).toBe(200);
            const data = await res.json();
            // After first user created with disableSignupAfterFirstUser: true (default),
            // signup should be disabled
            expect(data.signupEnabled).toBe(false);
        } finally {
            await server.cleanup();
        }
    }, TEST_TIMEOUT_MS);

    test("rejects concurrent server creation", async () => {
        // Module-level singletons (auth, sio-state) mean only one active
        // test server is supported. The guard should throw on a second call.
        const s1 = await createTestServer();
        try {
            await expect(createTestServer()).rejects.toThrow(
                "Another test server is already active",
            );
        } finally {
            await s1.cleanup();
        }
    }, TEST_TIMEOUT_MS);

    test("allows dynamic trusted origins to be added after server startup", async () => {
        const server = await createTestServer();
        const trustedOrigin = "http://127.0.0.1:4175";
        const { sessionId, relay } = await registerTestSession(server);

        try {
            const before = await connectViewerWithOrigin(server, sessionId, trustedOrigin);
            expect(before.error).toBe("forbidden: untrusted origin");

            server.addTrustedOrigin(trustedOrigin);

            const after = await connectViewerWithOrigin(server, sessionId, trustedOrigin);
            expect(after.error).toBeUndefined();
            expect(after.socket.connected).toBe(true);
            await after.socket.disconnect();
        } finally {
            relay.disconnect();
            await server.cleanup();
        }
    }, TEST_TIMEOUT_MS);

    test("allows sequential server creation after cleanup", async () => {
        // First server — create, verify, cleanup
        const s1 = await createTestServer();
        expect(s1.port).toBeGreaterThan(0);
        await s1.cleanup();

        // Second server — should succeed after cleanup released the guard
        const s2 = await createTestServer();
        try {
            expect(s2.port).toBeGreaterThan(0);
            const res = await fetch(`${s2.baseUrl}/health`);
            expect([200, 503]).toContain(res.status);
        } finally {
            await s2.cleanup();
        }
    }, TEST_TIMEOUT_MS * 2);

    test("cleanup shuts down cleanly", async () => {
        const server = await createTestServer();
        const baseUrl = server.baseUrl;

        // Server is up before cleanup
        const before = await fetch(`${baseUrl}/health`);
        expect([200, 503]).toContain(before.status);

        // Cleanup
        await server.cleanup();

        // Server should no longer be reachable after cleanup
        let threw = false;
        try {
            await fetch(`${baseUrl}/health`);
        } catch {
            threw = true;
        }
        expect(threw).toBe(true);
    }, TEST_TIMEOUT_MS);

    test("test preload refuses direct connections to the default dev Redis port", async () => {
        const { createClient } = await import("redis");
        const client = createClient({ url: "redis://127.0.0.1:6379" });
        await expect(client.connect()).rejects.toThrow("Refusing to connect to live dev Redis");
    });

    test("never connects to the default dev Redis port when PIZZAPI_REDIS_URL is unset", async () => {
        // The harness must provision its own disposable Redis when the caller
        // hasn't opted into an explicit PIZZAPI_REDIS_URL -- it must never
        // silently fall through to redis://127.0.0.1:6379 (a real dev/prod
        // Redis a developer or CI service container may have listening).
        const previousUrl = process.env.PIZZAPI_REDIS_URL;
        delete process.env.PIZZAPI_REDIS_URL;

        try {
            redisConnectUrls().length = 0;
            const server = await createTestServer();
            try {
                // PIZZAPI_REDIS_URL must now be set to an isolated instance,
                // not the hardcoded default port.
                const urlDuringLifetime = process.env.PIZZAPI_REDIS_URL;
                expect(urlDuringLifetime).toBeDefined();
                expect(urlDuringLifetime).not.toBe("redis://localhost:6379");
                expect(urlDuringLifetime).not.toContain(":6379");
            } finally {
                await server.cleanup();
            }

            // The env var must be restored (here: deleted again) once the
            // isolated server is torn down, so it doesn't leak into later tests.
            expect(process.env.PIZZAPI_REDIS_URL).toBeUndefined();
            expect(redisConnectUrls().some(isDefaultDevRedisUrl)).toBe(false);
        } finally {
            if (previousUrl === undefined) {
                delete process.env.PIZZAPI_REDIS_URL;
            } else {
                process.env.PIZZAPI_REDIS_URL = previousUrl;
            }
        }
    }, TEST_TIMEOUT_MS);

    test("respects an explicitly-set PIZZAPI_REDIS_URL instead of auto-provisioning", async () => {
        // Callers that already manage their own isolated Redis (e.g. via
        // RedisMemoryServer, matching trigger-snapshot-offline.test.ts) must
        // not have it silently swapped out from under them.
        const { RedisMemoryServer } = await import("redis-memory-server");
        const ownRedis = await RedisMemoryServer.create({
            instance: { ip: "127.0.0.1", port: 0 },
            autoStart: true,
        } as any);
        const ownUrl = `redis://${await ownRedis.getHost()}:${await ownRedis.getPort()}`;

        const previousUrl = process.env.PIZZAPI_REDIS_URL;
        process.env.PIZZAPI_REDIS_URL = ownUrl;

        try {
            const server = await createTestServer();
            try {
                // The caller's own URL must be left untouched (not overwritten
                // by an auto-provisioned isolated instance).
                expect(process.env.PIZZAPI_REDIS_URL).toBe(ownUrl);
            } finally {
                await server.cleanup();
            }
            // Cleanup must not stop/clear a Redis instance it didn't provision.
            expect(process.env.PIZZAPI_REDIS_URL).toBe(ownUrl);
        } finally {
            if (previousUrl === undefined) {
                delete process.env.PIZZAPI_REDIS_URL;
            } else {
                process.env.PIZZAPI_REDIS_URL = previousUrl;
            }
            await ownRedis.stop();
        }
    }, TEST_TIMEOUT_MS);
});
