/**
 * Smoke tests for the test server factory harness.
 *
 * These tests verify that createTestServer():
 *   1. Spins up a real HTTP server that responds to requests
 *   2. Pre-creates a user with a working API key
 *   3. Enforces the singleton constraint (second call while one is active throws)
 *   4. Cleans up all resources on shutdown (no process hang)
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

    test("singleton guard: creating a second server while one is active throws", async () => {
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
});
