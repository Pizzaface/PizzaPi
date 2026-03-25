/**
 * Integration tests for MockRunner.reconnect() — verifies that a mock runner
 * can reconnect to the server after a simulated restart.
 *
 * These tests spin up a real TestServer + Redis (via the sandbox preload),
 * so they require the harness preload and are relatively slow.
 */

import { describe, test, expect } from "bun:test";
import { createTestServer } from "./server.js";
import { createMockRunner } from "./mock-runner.js";

const TEST_TIMEOUT_MS = 30_000;

describe("MockRunner.reconnect()", () => {
    test("reconnects after graceful restart and re-registers with server", async () => {
        const server = await createTestServer();
        try {
            const runner = await createMockRunner(server, {
                name: "reconnect-test-runner",
                roots: ["/tmp/test"],
                serviceIds: ["terminal", "file-explorer"],
            });

            const runnerIdBefore = runner.runnerId;
            expect(runner.socket.connected).toBe(true);

            // Restart the server (graceful — shutdown flag set)
            await server.restart({ graceful: true });

            // Runner should be disconnected now
            expect(runner.socket.connected).toBe(false);

            // Reconnect — should re-register and restore state
            await runner.reconnect();
            expect(runner.socket.connected).toBe(true);

            // Runner ID must be preserved across reconnect
            expect(runner.runnerId).toBe(runnerIdBefore);

            await runner.disconnect();
        } finally {
            await server.cleanup();
        }
    }, TEST_TIMEOUT_MS * 2);

    test("reconnects after crash restart (graceful:false)", async () => {
        const server = await createTestServer();
        try {
            const runner = await createMockRunner(server, {
                name: "crash-reconnect-runner",
                roots: ["/tmp/test"],
            });

            expect(runner.socket.connected).toBe(true);

            await server.restart({ graceful: false });

            expect(runner.socket.connected).toBe(false);

            await runner.reconnect();
            expect(runner.socket.connected).toBe(true);

            await runner.disconnect();
        } finally {
            await server.cleanup();
        }
    }, TEST_TIMEOUT_MS * 2);

    test("reconnect() is a no-op when already connected", async () => {
        const server = await createTestServer();
        try {
            const runner = await createMockRunner(server, {
                name: "noop-reconnect-runner",
                roots: ["/tmp/test"],
            });

            expect(runner.socket.connected).toBe(true);

            // Should resolve immediately without error
            await runner.reconnect();
            expect(runner.socket.connected).toBe(true);

            await runner.disconnect();
        } finally {
            await server.cleanup();
        }
    }, TEST_TIMEOUT_MS);

    test("multiple runners reconnect independently after restart", async () => {
        const server = await createTestServer();
        try {
            const r1 = await createMockRunner(server, { name: "r1", roots: ["/tmp/r1"] });
            const r2 = await createMockRunner(server, { name: "r2", roots: ["/tmp/r2"] });

            expect(r1.socket.connected).toBe(true);
            expect(r2.socket.connected).toBe(true);

            await server.restart({ graceful: true });

            expect(r1.socket.connected).toBe(false);
            expect(r2.socket.connected).toBe(false);

            // Reconnect both in parallel
            await Promise.all([r1.reconnect(), r2.reconnect()]);

            expect(r1.socket.connected).toBe(true);
            expect(r2.socket.connected).toBe(true);

            await r1.disconnect();
            await r2.disconnect();
        } finally {
            await server.cleanup();
        }
    }, TEST_TIMEOUT_MS * 2);
});
