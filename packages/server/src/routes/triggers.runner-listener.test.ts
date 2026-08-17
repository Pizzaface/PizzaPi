/**
 * Tests for point-to-point trigger delivery addressed to a
 * `runner-listener:<listenerId>` pseudo-session — the path the Time service
 * uses to fire time:cron / time:at / time:timer_fired schedules that were
 * created as runner-level auto-spawn listeners.
 *
 * POST /api/sessions/runner-listener:<id>/trigger must spawn a fresh session
 * from the listener's own prompt/cwd/model and deliver the trigger into it
 * (never 404 → "session gone" → degraded generic replacement spawn).
 *
 * DELETE /api/sessions/runner-listener:<id>/trigger-subscriptions/... must
 * retire the durable listener row (one-shot listeners after a fire).
 */

import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const LISTENER_ID = "listener:runner-A:time:cron:1786976720494:z3iChXtR";
const PSEUDO_SESSION = `runner-listener:${LISTENER_ID}`;

const LISTENER = {
    listenerId: LISTENER_ID,
    triggerType: "time:cron",
    prompt: "/skill:watchman-duty",
    cwd: "/tmp/workdir",
    model: { provider: "claude-subscription", id: "claude-opus-5" },
    params: { cron: "*/15 * * * *" },
    autoClose: true,
    createdAt: new Date().toISOString(),
};

// ── Mocks (must precede the dynamic route import) ───────────────────────────

const emittedRunnerEvents: Array<{ event: string; data: any }> = [];
const fakeRunnerSocket = { emit: (event: string, data: any) => { emittedRunnerEvents.push({ event, data }); } };

const emittedSessionEvents: Array<{ event: string; data: any }> = [];
const fakeTuiSocket = {
    connected: true,
    emit: (event: string, data: any) => { emittedSessionEvents.push({ event, data }); },
};

const mockGetLocalRunnerSocket = mock((_runnerId: string) => fakeRunnerSocket as any);
const mockGetLocalTuiSocket = mock((_id: string) => fakeTuiSocket as any);

mock.module("../ws/sio-registry.js", () => ({
    emitToRunner: mock(() => {}),
    getSharedSession: mock(() => Promise.resolve(null)),
    getLocalTuiSocket: mockGetLocalTuiSocket,
    waitForLocalTuiSocket: mock(() => Promise.resolve(true)),
    emitToRelaySessionVerified: mock(() => Promise.resolve(false)),
    broadcastToSessionViewers: mock(() => {}),
    getLocalRunnerSocket: mockGetLocalRunnerSocket,
    recordRunnerSession: mock(() => Promise.resolve()),
    linkSessionToRunner: mock(() => Promise.resolve()),
}));

mock.module("../middleware.js", () => ({
    requireSession: mock(() => Promise.resolve({ userId: "user-1", userName: "TestUser" })),
    validateApiKey: mock(() => Promise.resolve({ userId: "user-1", userName: "TestUser" })),
}));

mock.module("../sessions/trigger-store.js", () => ({
    pushTriggerHistory: mock(() => Promise.resolve()),
    getTriggerHistory: mock(() => Promise.resolve([])),
    clearTriggerHistory: mock(() => Promise.resolve()),
}));

const mockListRunnerTriggerListeners = mock(() => Promise.resolve([LISTENER] as any[]));
const mockRemoveRunnerTriggerListener = mock(() => Promise.resolve(true));
mock.module("../sessions/runner-trigger-listener-store.js", () => ({
    getRunnerListenerTypes: mock(() => Promise.resolve([])),
    getRunnerTriggerListener: mock(() => Promise.resolve(null)),
    listRunnerTriggerListeners: mockListRunnerTriggerListeners,
    updateRunnerTriggerListener: mock(() => Promise.resolve(false)),
    removeRunnerTriggerListener: mockRemoveRunnerTriggerListener,
}));

mock.module("../ws/runner-control.js", () => ({
    waitForSpawnAck: mock(() => Promise.resolve({ ok: true })),
}));

const mockEmitDelta = mock((_runnerId: string, _delta: any) => Promise.resolve());
mock.module("../ws/namespaces/runner.js", () => ({
    emitTriggerSubscriptionDelta: mockEmitDelta,
}));

import * as _runnersModule from "../ws/sio-registry/runners.js";
const mockGetRunnerData = spyOn(_runnersModule, "getRunnerData")
    .mockImplementation(() => Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
const mockGetRunnerServices = spyOn(_runnersModule, "getRunnerServices")
    .mockImplementation(() => Promise.resolve(null as any));

afterAll(() => {
    mockGetRunnerData.mockRestore();
    mockGetRunnerServices.mockRestore();
});

const { handleTriggersRoute } = await import("./triggers.js");

function post(path: string, body: unknown): Promise<Response | undefined> {
    const url = new URL(`http://localhost${path}`);
    return handleTriggersRoute(
        new Request(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": "k" },
            body: JSON.stringify(body),
        }),
        url,
    ) as Promise<Response | undefined>;
}

beforeEach(() => {
    emittedRunnerEvents.length = 0;
    emittedSessionEvents.length = 0;
    mockListRunnerTriggerListeners.mockClear();
    mockRemoveRunnerTriggerListener.mockClear();
    mockEmitDelta.mockClear();
});

describe("POST /api/sessions/runner-listener:<id>/trigger", () => {
    test("spawns a session from the listener and delivers the trigger", async () => {
        const res = await post(`/api/sessions/${encodeURIComponent(PSEUDO_SESSION)}/trigger`, {
            type: "time:cron",
            payload: { cron: "*/15 * * * *", firedAt: new Date().toISOString(), iteration: 1 },
            source: "time",
            deliverAs: "followUp",
            wakeSession: true,
        });
        expect(res?.status).toBe(200);
        const json = await res!.json();
        expect(json.ok).toBe(true);
        expect(json.spawnedSessionId).toBeDefined();

        // Spawned with the listener's own cwd/model/autoClose
        const newSession = emittedRunnerEvents.find((e) => e.event === "new_session");
        expect(newSession).toBeDefined();
        expect(newSession!.data.cwd).toBe("/tmp/workdir");
        expect(newSession!.data.model).toEqual({ provider: "claude-subscription", id: "claude-opus-5" });
        expect(newSession!.data.autoClose).toBe(true);

        // Trigger delivered into the spawned session with the listener prompt merged
        const delivered = emittedSessionEvents.find((e) => e.event === "session_trigger");
        expect(delivered).toBeDefined();
        expect(delivered!.data.trigger.payload.prompt).toBe("/skill:watchman-duty");
        expect(delivered!.data.trigger.type).toBe("time:cron");
    });

    test("404s when the listener row no longer exists (schedule was deleted)", async () => {
        mockListRunnerTriggerListeners.mockImplementationOnce(() => Promise.resolve([]));
        const res = await post(`/api/sessions/${encodeURIComponent(PSEUDO_SESSION)}/trigger`, {
            type: "time:cron",
            payload: { cron: "*/15 * * * *" },
        });
        expect(res?.status).toBe(404);
    });

    test("404s when the runner belongs to another user", async () => {
        mockGetRunnerData.mockImplementationOnce(() => Promise.resolve({ userId: "someone-else", runnerId: "runner-A" } as any));
        const res = await post(`/api/sessions/${encodeURIComponent(PSEUDO_SESSION)}/trigger`, {
            type: "time:cron",
            payload: {},
        });
        expect(res?.status).toBe(404);
    });
});

describe("DELETE /api/sessions/runner-listener:<id>/trigger-subscriptions", () => {
    test("removes the durable listener row and notifies the runner", async () => {
        const url = new URL(`http://localhost/api/sessions/${encodeURIComponent(PSEUDO_SESSION)}/trigger-subscriptions/time:at?subscriptionId=${encodeURIComponent(LISTENER_ID)}`);
        const res = await handleTriggersRoute(
            new Request(url, { method: "DELETE", headers: { "x-api-key": "k" } }),
            url,
        ) as Response;
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.ok).toBe(true);
        expect(mockRemoveRunnerTriggerListener).toHaveBeenCalledWith("runner-A", LISTENER_ID);
        expect(mockEmitDelta).toHaveBeenCalled();
    });
});
