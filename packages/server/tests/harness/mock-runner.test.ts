/**
 * Tests for the MockRunner test harness.
 *
 * Each test creates and cleans up its OWN server (following the pattern from
 * server.test.ts).  Do NOT use beforeAll/afterAll with a shared server —
 * module-level singletons (auth, sio-state) mean servers must be created
 * sequentially, and HTTP keep-alive connections prevent io.close() from
 * completing within hook timeouts.
 *
 * IMPORTANT: createTestServer() uses module-level singletons. Servers MUST be
 * created sequentially — do not use Promise.all for server creation.
 */

import { describe, test, expect } from "bun:test";
import type { IncomingMessage } from "node:http";
import { createTestServer } from "./server.js";
import { createMockRunner } from "./mock-runner.js";
import type { TestServer } from "./types.js";

const TEST_TIMEOUT = 30_000;

/**
 * Helper to shut down a TestServer cleanly.
 *
 * Two problems with a naive `server.cleanup()` call:
 *
 * 1. HTTP keep-alive: `createTestServer()` makes fetch() calls that leave open
 *    keep-alive connections.  `io.close()` → `httpServer.close(cb)` won't fire
 *    `cb` until all connections close, so it hangs indefinitely.
 *
 * 2. Race with disconnect handlers: if we force-close WebSocket connections
 *    (via closeAllConnections) BEFORE the Redis pub/sub adapter is shut down,
 *    the async socket disconnect handlers try to broadcast on already-closed
 *    Redis clients, producing unhandled errors that Bun attributes to the next
 *    test.
 *
 * Fix:
 *   a) First, gracefully disconnect all Socket.IO clients and wait for their
 *      async disconnect handlers to flush (small delay).
 *   b) Then close only idle HTTP connections (keep-alive, not WebSocket).
 *   c) Finally call server.cleanup() normally.
 */
async function cleanupServer(server: TestServer): Promise<void> {
    // a) Gracefully disconnect all socket.io clients so their async disconnect
    //    handlers run while the Redis adapter is still open.
    await server.io.disconnectSockets(true);
    // Allow async disconnect handlers to flush (they do Redis writes).
    await new Promise<void>((r) => setTimeout(r, 100));

    // b) Close idle HTTP connections (keep-alives from fetch() calls) so
    //    httpServer.close() fires its callback promptly.
    const httpServer = (server.io as unknown as { httpServer?: { closeIdleConnections?(): void } }).httpServer;
    if (typeof httpServer?.closeIdleConnections === "function") {
        httpServer.closeIdleConnections();
    }

    // c) Normal cleanup path.
    await server.cleanup();
}

// ---------------------------------------------------------------------------
// 1. Basic connection and registration
// ---------------------------------------------------------------------------

describe("createMockRunner — basic connection", () => {
    test("runner connects and registers without error", async () => {
        const server = await createTestServer();
        try {
            const runner = await createMockRunner(server, { name: "basic-runner" });
            expect(runner.runnerId).toBeTruthy();
            expect(runner.socket.connected).toBe(true);
            await runner.disconnect();
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);

    test("runnerId reflects the server-assigned id (server generates new id without secret)", async () => {
        // The server ignores the client-supplied runnerId unless runnerSecret is also provided.
        // createMockRunner captures the actual id from the runner_registered event.
        const server = await createTestServer();
        try {
            const runner = await createMockRunner(server, { name: "id-test-runner" });
            // The server assigns a UUID — it should be a valid UUID v4 shape
            expect(runner.runnerId).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
            );
            await runner.disconnect();
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);

    test("auto-generates runnerId when not provided", async () => {
        const server = await createTestServer();
        try {
            const runner = await createMockRunner(server);
            // Server assigns a UUID — valid UUID shape
            expect(runner.runnerId).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
            );
            await runner.disconnect();
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 2. Runner appears in server's runner list (REST API)
// ---------------------------------------------------------------------------

describe("createMockRunner — REST visibility", () => {
    test("registered runner appears in GET /api/runners", async () => {
        const server = await createTestServer();
        try {
            const runner = await createMockRunner(server, { name: "visible-runner" });
            try {
                const res = await server.fetch("/api/runners");
                expect(res.status).toBe(200);
                const data = (await res.json()) as {
                    runners: Array<{ runnerId: string; name: string }>;
                };
                const found = data.runners.find((r) => r.runnerId === runner.runnerId);
                expect(found).toBeTruthy();
                expect(found?.name).toBe("visible-runner");
            } finally {
                await runner.disconnect();
            }
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);

    test("runner metadata is stored correctly", async () => {
        const server = await createTestServer();
        try {
            const runner = await createMockRunner(server, {
                name: "metadata-runner",
                roots: ["/tmp/meta-test"],
                version: "2.0.0-test",
                platform: "darwin",
            });
            try {
                const res = await server.fetch("/api/runners");
                const data = (await res.json()) as {
                    runners: Array<{
                        runnerId: string;
                        name: string;
                        roots: string[];
                        version: string | null;
                        platform: string | null;
                    }>;
                };
                const found = data.runners.find((r) => r.runnerId === runner.runnerId);
                expect(found).toBeTruthy();
                expect(found?.roots).toEqual(["/tmp/meta-test"]);
                expect(found?.version).toBe("2.0.0-test");
                expect(found?.platform).toBe("darwin");
            } finally {
                await runner.disconnect();
            }
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 3. emitSessionReady — session_ready propagates
// ---------------------------------------------------------------------------

describe("createMockRunner — emitSessionReady", () => {
    test("emitSessionReady sends session_ready to the server", async () => {
        const server = await createTestServer();
        try {
            const sessionId = "test-session-ready-" + Date.now();
            const receivedSessionIds: string[] = [];

            // Set up server-side capture BEFORE the runner connects so the
            // connection handler fires and attaches to the real socket (not a RemoteSocket proxy).
            server.io.of("/runner").on("connection", (socket) => {
                socket.on("session_ready", (data: { sessionId: string }) => {
                    receivedSessionIds.push(data.sessionId);
                });
            });

            const runner = await createMockRunner(server);
            try {
                runner.emitSessionReady(sessionId);

                // Wait for the event to propagate to the server
                await new Promise<void>((r) => setTimeout(r, 200));

                // P2 fix: actually assert the event was received server-side
                expect(receivedSessionIds).toContain(sessionId);
            } finally {
                await runner.disconnect();
            }
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 4. Multiple runners on the same server
// ---------------------------------------------------------------------------

describe("createMockRunner — multiple runners", () => {
    test("two runners can register simultaneously", async () => {
        const server = await createTestServer();
        try {
            const [r1, r2] = await Promise.all([
                createMockRunner(server, { name: "runner-alpha" }),
                createMockRunner(server, { name: "runner-beta" }),
            ]);
            try {
                expect(r1.runnerId).not.toBe(r2.runnerId);
                expect(r1.socket.connected).toBe(true);
                expect(r2.socket.connected).toBe(true);

                const res = await server.fetch("/api/runners");
                const data = (await res.json()) as {
                    runners: Array<{ runnerId: string; name: string }>;
                };
                const ids = data.runners.map((r) => r.runnerId);
                expect(ids).toContain(r1.runnerId);
                expect(ids).toContain(r2.runnerId);
            } finally {
                await Promise.allSettled([r1.disconnect(), r2.disconnect()]);
            }
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);

    test("three runners all appear in the list", async () => {
        const server = await createTestServer();
        try {
            const [rA, rB, rC] = await Promise.all([
                createMockRunner(server, { name: "runner-A" }),
                createMockRunner(server, { name: "runner-B" }),
                createMockRunner(server, { name: "runner-C" }),
            ]);
            try {
                const res = await server.fetch("/api/runners");
                const data = (await res.json()) as { runners: Array<{ runnerId: string }> };
                const ids = data.runners.map((r) => r.runnerId);
                expect(ids).toContain(rA.runnerId);
                expect(ids).toContain(rB.runnerId);
                expect(ids).toContain(rC.runnerId);
            } finally {
                await Promise.allSettled([rA.disconnect(), rB.disconnect(), rC.disconnect()]);
            }
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 5. Clean disconnect — runner is removed after disconnect
// ---------------------------------------------------------------------------

describe("createMockRunner — clean disconnect", () => {
    test("runner is removed from the list after disconnect", async () => {
        const server = await createTestServer();
        try {
            const runner = await createMockRunner(server, { name: "temp-runner" });
            const { runnerId } = runner;

            // Verify it's there before disconnect
            const before = await server.fetch("/api/runners");
            const beforeData = (await before.json()) as { runners: Array<{ runnerId: string }> };
            expect(beforeData.runners.map((r) => r.runnerId)).toContain(runnerId);

            // Disconnect
            await runner.disconnect();

            // Give the server a moment to process the disconnect event
            await new Promise<void>((r) => setTimeout(r, 300));

            // Verify it's gone
            const after = await server.fetch("/api/runners");
            const afterData = (await after.json()) as { runners: Array<{ runnerId: string }> };
            expect(afterData.runners.map((r) => r.runnerId)).not.toContain(runnerId);
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);

    test("disconnect() is idempotent (calling twice does not throw)", async () => {
        const server = await createTestServer();
        try {
            const runner = await createMockRunner(server);
            await runner.disconnect();
            await expect(runner.disconnect()).resolves.toBeUndefined();
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 6. waitForEvent utility
// ---------------------------------------------------------------------------

describe("createMockRunner — waitForEvent", () => {
    test("waitForEvent resolves when the server emits the named event", async () => {
        const server = await createTestServer();
        try {
            const runner = await createMockRunner(server);
            try {
                // waitForEvent listens for server→client events on the runner's socket.
                // Use the server's io instance to emit directly to this runner's socket.
                const waitPromise = runner.waitForEvent("ping", 2_000);

                // Find the server-side socket for this runner and emit to it
                const runnerNs = server.io.of("/runner");
                const sockets = await runnerNs.fetchSockets();
                const serverSocket = sockets.find((s) => s.data.runnerId === runner.runnerId);
                expect(serverSocket).toBeTruthy();

                // Emit a ping (a valid server→runner event per protocol)
                serverSocket!.emit("ping", {});

                const result = await waitPromise;
                expect(result).toEqual({});
            } finally {
                await runner.disconnect();
            }
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);

    test("waitForEvent rejects on timeout", async () => {
        const server = await createTestServer();
        try {
            const runner = await createMockRunner(server);
            try {
                await expect(
                    runner.waitForEvent("event_that_never_fires", 100),
                ).rejects.toThrow(/Timed out/);
            } finally {
                await runner.disconnect();
            }
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 7. Emission helpers — emitSessionError, emitSessionEvent, emitSessionEnded
// ---------------------------------------------------------------------------

describe("createMockRunner — emission helpers", () => {
    test("emitSessionError sends session_error to the server", async () => {
        const server = await createTestServer();
        try {
            const received: Array<{ sessionId: string; message: string }> = [];

            // Attach server-side listener BEFORE runner connects
            server.io.of("/runner").on("connection", (socket) => {
                socket.on("session_error", (data: { sessionId: string; message: string }) => {
                    received.push(data);
                });
            });

            const runner = await createMockRunner(server);
            try {
                runner.emitSessionError("sess-err-1", "spawn failed");
                await new Promise<void>((r) => setTimeout(r, 200));

                expect(received.length).toBeGreaterThan(0);
                expect(received[0].sessionId).toBe("sess-err-1");
                expect(received[0].message).toBe("spawn failed");
            } finally {
                await runner.disconnect();
            }
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);

    test("emitSessionEvent sends runner_session_event to the server", async () => {
        const server = await createTestServer();
        try {
            const received: Array<{ sessionId: string; event: unknown }> = [];

            server.io.of("/runner").on("connection", (socket) => {
                socket.on(
                    "runner_session_event",
                    (data: { sessionId: string; event: unknown }) => {
                        received.push(data);
                    },
                );
            });

            const runner = await createMockRunner(server);
            try {
                runner.emitSessionEvent("sess-evt-1", { type: "output", text: "hello" });
                await new Promise<void>((r) => setTimeout(r, 200));

                expect(received.length).toBeGreaterThan(0);
                expect(received[0].sessionId).toBe("sess-evt-1");
                expect(received[0].event).toEqual({ type: "output", text: "hello" });
            } finally {
                await runner.disconnect();
            }
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);

    test("emitSessionEnded sends session_killed to the server", async () => {
        const server = await createTestServer();
        try {
            const received: Array<{ sessionId: string }> = [];

            server.io.of("/runner").on("connection", (socket) => {
                socket.on("session_killed", (data: { sessionId: string }) => {
                    received.push(data);
                });
            });

            const runner = await createMockRunner(server);
            try {
                runner.emitSessionEnded("sess-ended-1");
                await new Promise<void>((r) => setTimeout(r, 200));

                expect(received.length).toBeGreaterThan(0);
                expect(received[0].sessionId).toBe("sess-ended-1");
            } finally {
                await runner.disconnect();
            }
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);
});

// ---------------------------------------------------------------------------
// 8. Auth failure — bad API key is rejected
// ---------------------------------------------------------------------------

describe("createMockRunner — auth failure", () => {
    test("rejects with a bad API key", async () => {
        const server = await createTestServer();
        try {
            await expect(
                createMockRunner(server, { apiKey: "invalid-bad-key-xyz" }),
            ).rejects.toThrow();
        } finally {
            await cleanupServer(server);
        }
    }, TEST_TIMEOUT);
});
