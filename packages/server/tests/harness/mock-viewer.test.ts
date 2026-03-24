/**
 * Integration tests for MockViewer and MockHubClient harness helpers.
 *
 * These tests spin up a real test server (HTTP + Redis + Socket.IO) and
 * exercise the /viewer and /hub namespaces through the mock clients.
 *
 * NOTE: Servers are created sequentially (module singletons require serial
 * creation). All tests in this file share a single server instance to keep
 * the suite fast.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { io as clientIo } from "socket.io-client";
import { createTestServer } from "./server.js";
import { createMockViewer } from "./mock-viewer.js";
import { createMockHubClient } from "./mock-hub.js";
import type { TestServer } from "./types.js";

// Give real network + Redis plenty of time
const TEST_TIMEOUT_MS = 30_000;

// ── Inline relay helper ──────────────────────────────────────────────────────

interface TestSession {
    sessionId: string;
    token: string;
    relaySocket: ReturnType<typeof clientIo>;
}

async function createTestSession(server: TestServer): Promise<TestSession> {
    const relay = clientIo(`${server.baseUrl}/relay`, {
        auth: { apiKey: server.apiKey },
        transports: ["websocket"],
    });

    return new Promise<TestSession>((resolve, reject) => {
        const timer = setTimeout(() => {
            relay.disconnect();
            reject(new Error("createTestSession: timeout waiting for registered event"));
        }, 8000);

        relay.on("registered", (data: { sessionId: string; token: string }) => {
            clearTimeout(timer);
            resolve({ sessionId: data.sessionId, token: data.token, relaySocket: relay });
        });

        relay.on("connect_error", (err: Error) => {
            clearTimeout(timer);
            relay.disconnect();
            reject(new Error(`createTestSession: connect_error: ${err.message}`));
        });

        relay.emit("register", { cwd: "/tmp/test", ephemeral: true });
    });
}

// Emit an event through the relay and wait for the ack
async function emitRelayEvent(
    session: TestSession,
    event: unknown,
    seq: number,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("emitRelayEvent: timeout")), 5000);
        session.relaySocket.once("event_ack", () => {
            clearTimeout(timer);
            resolve();
        });
        session.relaySocket.emit("event", {
            sessionId: session.sessionId,
            token: session.token,
            event,
            seq,
        });
    });
}

// ── Shared server ────────────────────────────────────────────────────────────

let server: TestServer;

beforeAll(async () => {
    server = await createTestServer();
}, TEST_TIMEOUT_MS);

afterAll(async () => {
    // Force-close all lingering HTTP keep-alive connections before cleanup.
    // Without this, io.close() → httpServer.close() can wait indefinitely for
    // connections from the relay Redis cache client or Fetch API keep-alive pool.
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (server.io as any).httpServer?.closeAllConnections?.();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (server.io as any).httpServer?.closeIdleConnections?.();
    } catch {
        // closeAllConnections is Node 18.2+; ignore if unavailable
    }
    await server.cleanup();
}, TEST_TIMEOUT_MS);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("MockViewer", () => {
    test(
        "connects to a session and receives connected event",
        async () => {
            const session = await createTestSession(server);
            try {
                const viewer = await createMockViewer(server, session.sessionId);
                expect(viewer.sessionId).toBe(session.sessionId);
                expect(viewer.socket.connected).toBe(true);
                await viewer.disconnect();
            } finally {
                session.relaySocket.disconnect();
            }
        },
        TEST_TIMEOUT_MS,
    );

    test(
        "collects events emitted through relay in getReceivedEvents()",
        async () => {
            const session = await createTestSession(server);
            const viewer = await createMockViewer(server, session.sessionId);

            try {
                const testEvent = { type: "text_delta", text: "hello from relay" };

                // Emit event through relay and wait for viewer to receive it
                const waitPromise = viewer.waitForEvent(
                    (e) => (e as { type?: string }).type === "text_delta",
                    8000,
                );
                await emitRelayEvent(session, testEvent, 1);
                const received = await waitPromise;

                expect((received as { type?: string }).type).toBe("text_delta");
                expect((received as { text?: string }).text).toBe("hello from relay");

                const events = viewer.getReceivedEvents();
                expect(events.length).toBeGreaterThanOrEqual(1);
                const found = events.find(
                    (e) => (e.event as { type?: string }).type === "text_delta",
                );
                expect(found).toBeDefined();
            } finally {
                await viewer.disconnect();
                session.relaySocket.disconnect();
            }
        },
        TEST_TIMEOUT_MS,
    );

    test(
        "receives disconnected event when relay ends session",
        async () => {
            const session = await createTestSession(server);
            const viewer = await createMockViewer(server, session.sessionId);

            try {
                const disconnectPromise = viewer.waitForDisconnected(8000);

                // End session via relay
                session.relaySocket.emit("session_end", {
                    sessionId: session.sessionId,
                    token: session.token,
                });

                const reason = await disconnectPromise;
                expect(typeof reason).toBe("string");
            } finally {
                await viewer.disconnect();
                session.relaySocket.disconnect();
            }
        },
        TEST_TIMEOUT_MS,
    );

    test(
        "clearEvents resets the collected events array",
        async () => {
            const session = await createTestSession(server);
            const viewer = await createMockViewer(server, session.sessionId);

            try {
                // Emit one event
                await emitRelayEvent(session, { type: "ping" }, 1);
                await viewer.waitForEvent(undefined, 5000);
                expect(viewer.getReceivedEvents().length).toBeGreaterThan(0);

                viewer.clearEvents();
                expect(viewer.getReceivedEvents().length).toBe(0);
            } finally {
                await viewer.disconnect();
                session.relaySocket.disconnect();
            }
        },
        TEST_TIMEOUT_MS,
    );

    test(
        "multiple viewers on the same session both receive events",
        async () => {
            const session = await createTestSession(server);
            const viewer1 = await createMockViewer(server, session.sessionId);
            const viewer2 = await createMockViewer(server, session.sessionId);

            try {
                const testEvent = { type: "broadcast_test", value: 42 };

                const p1 = viewer1.waitForEvent(
                    (e) => (e as { type?: string }).type === "broadcast_test",
                    8000,
                );
                const p2 = viewer2.waitForEvent(
                    (e) => (e as { type?: string }).type === "broadcast_test",
                    8000,
                );

                await emitRelayEvent(session, testEvent, 1);

                const [e1, e2] = await Promise.all([p1, p2]);
                expect((e1 as { value?: number }).value).toBe(42);
                expect((e2 as { value?: number }).value).toBe(42);
            } finally {
                await viewer1.disconnect();
                await viewer2.disconnect();
                session.relaySocket.disconnect();
            }
        },
        TEST_TIMEOUT_MS,
    );
});

describe("MockHubClient", () => {
    test(
        "connects and receives initial sessions snapshot",
        async () => {
            const hub = await createMockHubClient(server);
            try {
                // sessions is an array (may be empty at start)
                expect(Array.isArray(hub.sessions)).toBe(true);
            } finally {
                await hub.disconnect();
            }
        },
        TEST_TIMEOUT_MS,
    );

    test(
        "receives session_added when a new relay session is created",
        async () => {
            const hub = await createMockHubClient(server);

            try {
                // Start waiting BEFORE creating session
                const addedPromise = hub.waitForSessionAdded(undefined, 10000);

                const session = await createTestSession(server);

                const added = await addedPromise;
                expect(added.sessionId).toBe(session.sessionId);
                expect(hub.sessions.some((s) => s.sessionId === session.sessionId)).toBe(true);

                session.relaySocket.disconnect();
            } finally {
                await hub.disconnect();
            }
        },
        TEST_TIMEOUT_MS,
    );

    test(
        "hub disconnect cleans up socket",
        async () => {
            const hub = await createMockHubClient(server);
            expect(hub.socket.connected).toBe(true);
            await hub.disconnect();
            expect(hub.socket.connected).toBe(false);
        },
        TEST_TIMEOUT_MS,
    );
});
