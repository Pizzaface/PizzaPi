/**
 * Smoke tests for the test server factory harness.
 *
 * These tests verify that createTestServer():
 *   1. Spins up a real HTTP server that responds to requests
 *   2. Pre-creates a user with a working API key
 *   3. Multiple servers can run simultaneously (created sequentially, then accessed concurrently)
 *   4. Cleans up all resources on shutdown
 *
 * NOTE: Servers must be created sequentially (not with Promise.all) because
 * auth.ts and sio-state.ts use module-level singletons. Once created, multiple
 * servers can coexist and respond simultaneously.
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

    test("multiple test servers can run concurrently", async () => {
        // Create servers sequentially (module singletons require serial creation)
        // then verify they can all respond simultaneously.
        const s1 = await createTestServer();
        const s2 = await createTestServer();
        const s3 = await createTestServer();

        try {
            // All servers should have different ports
            const ports = new Set([s1.port, s2.port, s3.port]);
            expect(ports.size).toBe(3);

            // All servers should respond simultaneously (concurrent reads are fine)
            const responses = await Promise.all([
                fetch(`${s1.baseUrl}/health`),
                fetch(`${s2.baseUrl}/health`),
                fetch(`${s3.baseUrl}/health`),
            ]);

            for (const res of responses) {
                expect([200, 503]).toContain(res.status);
                const data = await res.json();
                expect(["ok", "degraded"]).toContain(data.status);
            }
        } finally {
            // Clean up all servers, ignoring individual errors
            await Promise.allSettled([s1.cleanup(), s2.cleanup(), s3.cleanup()]);
        }
    }, TEST_TIMEOUT_MS * 3);

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
