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
import { createTestServer } from "./server.js";

// Tests spin up real servers + Redis + Socket.IO, so we need a generous timeout.
const TEST_TIMEOUT_MS = 30_000;

describe("createTestServer", () => {
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

    test("restart() brings server back up on the same port (graceful)", async () => {
        const server = await createTestServer();
        const port = server.port;
        const baseUrl = server.baseUrl;

        // Verify server is up
        const before = await fetch(`${baseUrl}/health`);
        expect([200, 503]).toContain(before.status);

        try {
            await server.restart({ graceful: true });

            // Port must be unchanged
            expect(server.port).toBe(port);

            // Server must respond after restart
            const after = await fetch(`${baseUrl}/health`);
            expect([200, 503]).toContain(after.status);

            // Auth still works (DB was preserved)
            const me = await server.fetch("/api/auth/get-session");
            expect(me.status).toBe(200);
        } finally {
            await server.cleanup();
        }
    }, TEST_TIMEOUT_MS * 2);

    test("restart() with graceful:false also restores the server", async () => {
        const server = await createTestServer();
        const baseUrl = server.baseUrl;

        try {
            await server.restart({ graceful: false });

            const res = await fetch(`${baseUrl}/health`);
            expect([200, 503]).toContain(res.status);
        } finally {
            await server.cleanup();
        }
    }, TEST_TIMEOUT_MS * 2);

    test("server.io getter reflects new Socket.IO instance after restart", async () => {
        const server = await createTestServer();

        try {
            const ioBefore = server.io;
            await server.restart({ graceful: true });
            const ioAfter = server.io;

            // The io instance must have been replaced.
            expect(ioAfter).not.toBe(ioBefore);
        } finally {
            await server.cleanup();
        }
    }, TEST_TIMEOUT_MS * 2);
});
