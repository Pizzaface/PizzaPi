/**
 * Smoke tests for the test server factory harness.
 *
 * These tests verify that createTestServer():
 *   1. Spins up a real HTTP server that responds to requests
 *   2. Pre-creates a user with a working API key
 *   3. Enforces the singleton constraint (second call while one is active throws)
 *   4. Cleans up all resources on shutdown (no process hang)
 */

import { createConnection } from "node:net";
import { createClient } from "redis";
import { describe, test, expect } from "bun:test";
import { createTestServer } from "./server.js";

// Tests spin up real servers + Redis + Socket.IO, so we need a generous timeout.
const TEST_TIMEOUT_MS = 30_000;

// ── Redis availability + mock detection ──────────────────────────────────────
// Two-stage check before any tests are defined:
//
//   Stage 1 (TCP probe): Uses node:net — completely immune to mock.module("redis", ...).
//                        Checks if the Redis port is open at all.
//
//   Stage 2 (module check): If the TCP port is open, verify the redis module is real
//                            (not mocked by another test file in the same worker).
//                            Real clients have .ping(); mocks typically omit it.
//
// If either check fails, all tests use test.skip for clear CI output instead of
// failing with a cryptic TypeError.
const REDIS_URL_FOR_PROBE = process.env.PIZZAPI_REDIS_URL ?? "redis://localhost:6379";

function probeRedisViaTcp(url: string, timeoutMs = 3000): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (ok: boolean) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch { /* ignore */ }
            resolve(ok);
        };
        const { hostname, port } = new URL(url);
        const socket = createConnection({ host: hostname, port: parseInt(port, 10) || 6379 });
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => settle(true));
        socket.once("error", () => settle(false));
        socket.once("timeout", () => settle(false));
    });
}

// Stage 1: TCP probe
const redisPortOpen = await probeRedisViaTcp(REDIS_URL_FOR_PROBE);

// Stage 2: Module mock detection — createClient() in a mocked environment returns
// an object without .ping(); real clients always have it.
let redisModuleIsReal = false;
if (redisPortOpen) {
    // Intentionally uses the (potentially mocked) redis module: if it IS mocked,
    // the returned object lacks .ping() and we skip rather than fail.
    const probeClient = createClient({ url: REDIS_URL_FOR_PROBE }) as { ping?: unknown };
    redisModuleIsReal = typeof probeClient.ping === "function";
}

if (!redisPortOpen) {
    console.log(
        `[harness] Redis not reachable at ${REDIS_URL_FOR_PROBE} — ` +
        `all harness tests will be skipped.`,
    );
} else if (!redisModuleIsReal) {
    console.log(
        `[harness] Redis module is mocked (mock.module("redis", ...) is active in this worker) — ` +
        `all harness tests will be skipped. Run harness tests in isolation to avoid this.`,
    );
}

const testFn: typeof test = redisPortOpen && redisModuleIsReal ? test : test.skip;

describe("createTestServer", () => {
    testFn("creates server and responds to health check", async () => {
        const server = await createTestServer();
        try {
            const res = await fetch(`${server.baseUrl}/health`);
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

    testFn("pre-created user can authenticate via API key", async () => {
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

    testFn("singleton guard: creating a second server while one is active throws", async () => {
        // This test verifies the documented singleton constraint:
        // auth.ts and sio-state.ts use module-level singletons that cannot
        // be safely reinitialised while a prior server is still active.
        const server = await createTestServer();
        try {
            let threw = false;
            let errorMessage = "";
            try {
                await createTestServer();
            } catch (err) {
                threw = true;
                errorMessage = err instanceof Error ? err.message : String(err);
            }
            expect(threw).toBe(true);
            expect(errorMessage).toContain("already active");
        } finally {
            await server.cleanup();
        }

        // After cleanup the guard is released — a new server should succeed
        const server2 = await createTestServer();
        try {
            const res = await fetch(`${server2.baseUrl}/health`);
            expect([200, 503]).toContain(res.status);
        } finally {
            await server2.cleanup();
        }
    }, TEST_TIMEOUT_MS * 2);

    testFn("cleanup shuts down cleanly", async () => {
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
});
