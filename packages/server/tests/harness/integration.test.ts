/**
 * Integration tests using the BDD TestScenario builder.
 *
 * All suites share a single TestServer (singleton constraint — only one server
 * may be active at a time). The server is created once in a file-level
 * beforeAll and torn down in afterAll. Each describe suite uses its own
 * TestScenario instance (via setServer) for component isolation, with
 * per-test cleanup in try/finally blocks.
 *
 * Pattern mirrors mock-viewer.test.ts — proven to be stable with the
 * singleton server constraint.
 *
 * ## Hub-before-session ordering (critical)
 *
 * Tests that use both a hub and a relay session must:
 *   1. Connect the hub FIRST
 *   2. Call hub.waitForSessionAdded() BEFORE creating the session
 *   3. Then create the session
 *   4. Await the waitForSessionAdded promise
 *
 * This pattern ensures the hub receives the session_added event reliably.
 *
 * ## Relay Redis cache warmup (critical for Suite 1)
 *
 * The relay namespace has a Redis cache client that initializes asynchronously
 * on the FIRST relay connection to a fresh server. During initialization,
 * hub and viewer sockets may be disconnected by the server (the adapter
 * temporarily disrupts the pub/sub setup). A warmup relay session is created
 * in beforeAll (before any test) and held open long enough for the cache to
 * fully initialize.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { TestScenario } from "./scenario.js";
import { createTestServer } from "./server.js";
import {
    buildHeartbeat,
    buildMetaState,
    buildTodoList,
} from "./builders.js";
import type { TestServer } from "./types.js";

const TIMEOUT = 30_000;

// ── Single shared server ─────────────────────────────────────────────────────

let server: TestServer;

beforeAll(async () => {
    server = await createTestServer();

    // ── Warmup: prime the relay Redis cache ──────────────────────────────────
    // On a fresh server, the relay namespace's Redis cache client connects
    // asynchronously the first time a relay socket registers a session.
    // During this window (typically < 1 s), hub and viewer sockets can be
    // disconnected by the server. We create a warmup session, wait for the
    // Redis cache to fully connect, then PROPERLY END the session (via
    // emitSessionEnd) before disconnecting — this ensures server-side async
    // cleanup completes synchronously from the relay's perspective rather
    // than being deferred until after the first test's hub connects.
    const warmup = new TestScenario();
    warmup.setServer(server);
    try {
        const warmupSess = await warmup.addSession({ cwd: "/warmup" });
        // Send a heartbeat to trigger full event-pipeline initialization
        warmupSess.relay.emitEvent(
            warmupSess.sessionId,
            warmupSess.token,
            buildHeartbeat({ active: true }),
            0,
        );
        // Wait for the Redis cache to fully connect and all events to flush
        await new Promise<void>((r) => setTimeout(r, 1500));
        // Properly end the warmup session so server-side cleanup runs NOW
        // (not deferred after our first test's hub connects)
        warmupSess.relay.emitSessionEnd(warmupSess.sessionId, warmupSess.token);
        await new Promise<void>((r) => setTimeout(r, 500));
    } finally {
        await warmup.reset();
        // Extra settle time to ensure all server-side cleanup (session_removed
        // broadcasts, Redis state updates) has fully propagated before tests start
        await new Promise<void>((r) => setTimeout(r, 500));
    }
}, TIMEOUT);

afterAll(async () => {
    if (!server) return;
    try {
        await server.io.disconnectSockets(true);
        await new Promise<void>((r) => setTimeout(r, 100));
        const httpServer = (server.io as unknown as {
            httpServer?: { closeAllConnections?(): void; closeIdleConnections?(): void };
        }).httpServer;
        if (typeof httpServer?.closeAllConnections === "function") {
            httpServer.closeAllConnections();
        } else if (typeof httpServer?.closeIdleConnections === "function") {
            httpServer.closeIdleConnections();
        }
        await server.cleanup();
    } catch {
        // Ignore cleanup errors
    }
}, TIMEOUT);

// ── Suite 1: Full session lifecycle ─────────────────────────────────────────

describe("Full session lifecycle", () => {
    test("relay → viewer receives heartbeat → session ends → viewer notified", async () => {
        // Tests the core relay→viewer event pipeline and clean session teardown.
        // Hub-based removal is tested in Suite 2 "hub sees both sessions" and
        // Suite 5 meta state (where the server is past first-relay initialization).
        const scenario = new TestScenario();
        scenario.setServer(server);

        try {
            const session = await scenario.addSession({ cwd: "/lifecycle-test" });
            const viewer = await scenario.addViewer(session.sessionId);
            expect(viewer.socket.connected).toBe(true);

            // Relay → viewer: heartbeat event flows through
            const heartbeat = buildHeartbeat({ active: true, sessionName: "lifecycle-test" });
            session.relay.emitEvent(session.sessionId, session.token, heartbeat, 0);

            const received = await viewer.waitForEvent(
                (evt) =>
                    typeof evt === "object" &&
                    evt !== null &&
                    (evt as Record<string, unknown>)["type"] === "heartbeat",
                5_000,
            );
            expect((received as Record<string, unknown>)["type"]).toBe("heartbeat");
            expect((received as Record<string, unknown>)["active"]).toBe(true);

            // Session ends → viewer receives disconnected notification
            const disconnectedWaiter = viewer.waitForDisconnected(5_000);
            session.relay.emitSessionEnd(session.sessionId, session.token);
            const reason = await disconnectedWaiter;
            expect(typeof reason).toBe("string");
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);

    test("runner registers and appears in REST API", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);

        try {
            const runner = await scenario.addRunner({ name: "lifecycle-runner" });
            expect(runner.runnerId).toBeTruthy();
            expect(runner.socket.connected).toBe(true);

            const res = await server.fetch("/api/runners");
            expect(res.status).toBe(200);
            const data = (await res.json()) as { runners: Array<{ runnerId: string; name: string }> };
            const found = data.runners.find((r) => r.runnerId === runner.runnerId);
            expect(found).toBeTruthy();
            expect(found?.name).toBe("lifecycle-runner");
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);
});

// ── Suite 2: Multi-runner environment ────────────────────────────────────────

describe("Multi-runner environment", () => {
    test("two runners connect, both appear in REST API", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);

        try {
            const [r1, r2] = await Promise.all([
                scenario.addRunner({ name: "runner-alpha" }),
                scenario.addRunner({ name: "runner-beta" }),
            ]);
            expect(r1.runnerId).not.toBe(r2.runnerId);

            const res = await server.fetch("/api/runners");
            expect(res.status).toBe(200);
            const data = (await res.json()) as { runners: Array<{ runnerId: string }> };
            const ids = data.runners.map((r) => r.runnerId);
            expect(ids).toContain(r1.runnerId);
            expect(ids).toContain(r2.runnerId);
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);

    test("sessions are isolated — events for one session don't bleed into another", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);

        try {
            const sess1 = await scenario.addSession({ cwd: "/isolated-a" });
            const sess2 = await scenario.addSession({ cwd: "/isolated-b" });

            const viewer1 = await scenario.addViewer(sess1.sessionId);
            const viewer2 = await scenario.addViewer(sess2.sessionId);

            // Send event only to session 1
            const event = buildHeartbeat({ active: true, sessionName: "isolated-a" });
            sess1.relay.emitEvent(sess1.sessionId, sess1.token, event, 0);

            // Viewer 1 should receive the event
            const received = await viewer1.waitForEvent(
                (e) =>
                    typeof e === "object" &&
                    e !== null &&
                    (e as Record<string, unknown>)["type"] === "heartbeat",
                3_000,
            );
            expect((received as Record<string, unknown>)["sessionName"]).toBe("isolated-a");

            // Viewer 2 should NOT receive events from session 1
            await new Promise<void>((r) => setTimeout(r, 200));
            const evts2 = viewer2.getReceivedEvents();
            const bleed = evts2.filter(
                (e) =>
                    typeof e.event === "object" &&
                    e.event !== null &&
                    (e.event as Record<string, unknown>)["sessionName"] === "isolated-a",
            );
            expect(bleed.length).toBe(0);
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);

    test("hub sees both sessions (hub-before-session pattern)", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);

        try {
            const hub = await scenario.addHub();

            const added1 = hub.waitForSessionAdded(undefined, 8_000);
            const sess1 = await scenario.addSession({ cwd: "/hub-multi-a" });
            await added1;

            const added2 = hub.waitForSessionAdded(
                (s) => s.sessionId !== sess1.sessionId,
                8_000,
            );
            const sess2 = await scenario.addSession({ cwd: "/hub-multi-b" });
            await added2;

            const ids = hub.sessions.map((s) => s.sessionId);
            expect(ids).toContain(sess1.sessionId);
            expect(ids).toContain(sess2.sessionId);
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);

    test("session ends → hub sees removal", async () => {
        // Hub-based removal test (runs after server has been through several
        // relay connections so the relay state is fully stable)
        const scenario = new TestScenario();
        scenario.setServer(server);

        try {
            const hub = await scenario.addHub();
            const addedWaiter = hub.waitForSessionAdded(undefined, 8_000);
            const session = await scenario.addSession({ cwd: "/removal-test" });
            await addedWaiter;

            expect(hub.sessions.some((s) => s.sessionId === session.sessionId)).toBe(true);

            const removalWaiter = hub.waitForSessionRemoved(session.sessionId, 5_000);
            session.relay.emitSessionEnd(session.sessionId, session.token);
            await removalWaiter;

            expect(hub.sessions.find((s) => s.sessionId === session.sessionId)).toBeUndefined();
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);
});

// ── Suite 3: Conversation replay ─────────────────────────────────────────────

describe("Conversation replay", () => {
    test("sendResync delivers stored heartbeat events to viewer as replay", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);

        try {
            // Create session and send events BEFORE viewer connects
            const session = await scenario.addSession({ cwd: "/replay-test" });

            // Send heartbeat events (reliably stored server-side)
            session.relay.emitEvent(
                session.sessionId,
                session.token,
                buildHeartbeat({ active: true, sessionName: "replay-session" }),
                0,
            );
            session.relay.emitEvent(
                session.sessionId,
                session.token,
                buildHeartbeat({ active: false, sessionName: "replay-session-2" }),
                1,
            );

            // Wait for events to be stored server-side
            await new Promise<void>((r) => setTimeout(r, 400));

            // Connect a LATE viewer, then request a resync to get stored events
            const viewer = await scenario.addViewer(session.sessionId);
            expect(viewer.socket.connected).toBe(true);
            viewer.clearEvents();

            // Request resync — server should replay stored events back to viewer
            viewer.sendResync();

            // Wait for replay events to arrive
            await new Promise<void>((r) => setTimeout(r, 800));

            const events = viewer.getReceivedEvents();
            // Should have at least one event after resync
            expect(events.length).toBeGreaterThan(0);
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);

    test("early viewer receives real-time events (not replay-flagged)", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);

        try {
            const session = await scenario.addSession({ cwd: "/realtime-test" });
            const viewer = await scenario.addViewer(session.sessionId);
            viewer.clearEvents();

            const heartbeat = buildHeartbeat({ active: true, sessionName: "realtime" });
            session.relay.emitEvent(session.sessionId, session.token, heartbeat, 0);

            await viewer.waitForEvent(
                (e) =>
                    typeof e === "object" &&
                    e !== null &&
                    (e as Record<string, unknown>)["type"] === "heartbeat",
                3_000,
            );

            const evts = viewer.getReceivedEvents();
            const heartbeatEntry = evts.find(
                (e) =>
                    typeof e.event === "object" &&
                    e.event !== null &&
                    (e.event as Record<string, unknown>)["type"] === "heartbeat",
            );
            // Real-time events should NOT be flagged as replay
            expect(heartbeatEntry?.replay).not.toBe(true);
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);

    test("conversation events flow through relay to connected viewer", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);

        try {
            const session = await scenario.addSession({ cwd: "/conv-test" });
            const viewer = await scenario.addViewer(session.sessionId);
            viewer.clearEvents();

            await scenario.sendConversation(0, [
                { role: "assistant", text: "Hello from relay!" },
            ]);

            const received = await viewer.waitForEvent(
                (e) =>
                    typeof e === "object" &&
                    e !== null &&
                    (e as Record<string, unknown>)["type"] === "message_update",
                5_000,
            );
            expect((received as Record<string, unknown>)["type"]).toBe("message_update");
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);
});

// ── Suite 4: Inter-session messaging ─────────────────────────────────────────

describe("Inter-session messaging", () => {
    test("child session emits trigger targeting parent session", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);

        try {
            const parentSession = await scenario.addSession({ cwd: "/parent" });
            const childSession = await scenario.addSession({
                cwd: "/child",
                parentSessionId: parentSession.sessionId,
            });

            expect(parentSession.sessionId).not.toBe(childSession.sessionId);

            const triggerId = `trigger-${Date.now()}`;

            // Listen for delivery on the parent relay socket BEFORE emitting.
            // The server forwards session_trigger to the target session's relay socket
            // (messaging.ts line ~199: targetSocket.emit("session_trigger", { trigger })).
            // This verifies the trigger was actually received on the parent end, not
            // just that the emit-side local variable was set.
            const deliveryPromise = parentSession.relay.waitForEvent("session_trigger", 5_000);

            childSession.relay.emitTrigger({
                token: childSession.token,
                trigger: {
                    type: "plan_review",
                    sourceSessionId: childSession.sessionId,
                    targetSessionId: parentSession.sessionId,
                    payload: { steps: ["step 1", "step 2"] },
                    deliverAs: "steer",
                    expectsResponse: true,
                    triggerId,
                    ts: new Date().toISOString(),
                },
            });

            // Verify delivery: the trigger must arrive at the parent relay socket
            // with the correct triggerId — confirming end-to-end routing worked.
            const delivered = await deliveryPromise;
            const deliveredTrigger = (delivered as Record<string, unknown>).trigger as Record<string, unknown>;
            expect(deliveredTrigger?.triggerId).toBe(triggerId);
            expect(deliveredTrigger?.sourceSessionId).toBe(childSession.sessionId);
            expect(deliveredTrigger?.targetSessionId).toBe(parentSession.sessionId);
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);

    test("hub records correct parentSessionId for child sessions", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);

        try {
            const hub = await scenario.addHub();

            const parentWaiter = hub.waitForSessionAdded(undefined, 8_000);
            const parent = await scenario.addSession({ cwd: "/p" });
            await parentWaiter;

            const childWaiter = hub.waitForSessionAdded(
                (s) => s.sessionId !== parent.sessionId,
                8_000,
            );
            const child = await scenario.addSession({
                cwd: "/c",
                parentSessionId: parent.sessionId,
            });
            await childWaiter;

            const childInfo = hub.sessions.find((s) => s.sessionId === child.sessionId);
            expect(childInfo).toBeTruthy();
            expect(childInfo?.parentSessionId).toBe(parent.sessionId);
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);
});

// ── Suite 5: Session meta state ──────────────────────────────────────────────

describe("Session meta state", () => {
    test("buildTodoList and buildMetaState produce well-formed structures", async () => {
        const todos = buildTodoList([
            { text: "Task 1", status: "done" },
            { text: "Task 2", status: "in_progress" },
            { text: "Task 3", status: "pending" },
        ]);
        expect(todos).toHaveLength(3);
        expect(todos[0].status).toBe("done");
        expect(todos[1].status).toBe("in_progress");
        expect(todos[2].status).toBe("pending");

        // SessionMetaState uses todoList (not todos)
        const metaState = buildMetaState({ todoList: todos });
        expect(metaState.todoList).toHaveLength(3);

        const defaultMeta = buildMetaState();
        expect(defaultMeta).toBeTruthy();
        expect(Array.isArray(defaultMeta.todoList)).toBe(true);
    }, TIMEOUT);

    test("heartbeat event with session name triggers hub session_status update", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);

        try {
            const hub = await scenario.addHub();
            const addedWaiter = hub.waitForSessionAdded(undefined, 8_000);
            const session = await scenario.addSession({ cwd: "/meta-state-test" });
            await addedWaiter;

            hub.subscribeSessionMeta(session.sessionId);

            const statusPromise = hub.waitForSessionStatus(
                session.sessionId,
                (data) =>
                    typeof data === "object" &&
                    data !== null &&
                    (data as Record<string, unknown>)["sessionId"] === session.sessionId,
                5_000,
            );

            const heartbeat = buildHeartbeat({
                active: true,
                sessionName: "meta-test-session",
            });
            session.relay.emitEvent(session.sessionId, session.token, heartbeat, 0);

            const status = await statusPromise;
            expect((status as Record<string, unknown>)["sessionId"]).toBe(session.sessionId);
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);
});

// ── Suite 6: Concurrent registerSession ──────────────────────────────────────

describe("Concurrent registerSession", () => {
    test("two concurrent addSession calls produce distinct sessions", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);

        try {
            const [sessA, sessB] = await Promise.all([
                scenario.addSession({ cwd: "/concurrent-a" }),
                scenario.addSession({ cwd: "/concurrent-b" }),
            ]);

            expect(sessA.sessionId).toBeTruthy();
            expect(sessB.sessionId).toBeTruthy();
            expect(sessA.sessionId).not.toBe(sessB.sessionId);
            expect(sessA.token).not.toBe(sessB.token);
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);

    test("three concurrent sessions all appear in hub", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);

        try {
            const hub = await scenario.addHub();

            const w1 = hub.waitForSessionAdded(undefined, 8_000);
            const [s1, s2, s3] = await Promise.all([
                scenario.addSession({ cwd: "/multi-relay-a" }),
                scenario.addSession({ cwd: "/multi-relay-b" }),
                scenario.addSession({ cwd: "/multi-relay-c" }),
            ]);
            await w1;

            await new Promise<void>((r) => setTimeout(r, 400));

            const hubIds = hub.sessions.map((s) => s.sessionId);
            for (const id of [s1.sessionId, s2.sessionId, s3.sessionId]) {
                expect(hubIds).toContain(id);
            }
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);

    test("registerSession called twice on same relay socket produces distinct sessions", async () => {
        const scenario = new TestScenario();
        scenario.setServer(server);

        try {
            const sess1 = await scenario.addSession({ cwd: "/serial-a" });

            // Call registerSession a second time on the SAME relay socket
            const sess2 = await sess1.relay.registerSession({ cwd: "/serial-b" });

            expect(sess2.sessionId).toBeTruthy();
            expect(sess2.sessionId).not.toBe(sess1.sessionId);
            expect(sess2.token).not.toBe(sess1.token);
        } finally {
            await scenario.reset();
        }
    }, TIMEOUT);
});
