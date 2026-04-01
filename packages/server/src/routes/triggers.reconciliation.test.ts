/**
 * Focused tests for trigger subscription reconciliation behaviour in the triggers route:
 *
 * 1. DELETE (unsubscribe) emits a TriggerSubscriptionDelta with action="unsubscribe"
 * 2. POST (subscribe) always emits a delta, even when no params are provided
 * 3. PUT (update) emits a delta with action="update"
 *
 * These tests mock all external dependencies so they run with no Redis or Socket.IO.
 */

import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// ── Mock emitTriggerSubscriptionDelta ────────────────────────────────────────
// Must be declared before the dynamic import of the route handler so the
// module registry picks up the mock when triggers.ts is first evaluated.
const mockEmitDelta = mock((_runnerId: string, _delta: any) => {});

mock.module("../ws/namespaces/runner.js", () => ({
    emitTriggerSubscriptionDelta: mockEmitDelta,
}));

// ── Mock sio-registry ────────────────────────────────────────────────────────
const mockGetSharedSession = mock((_id: string) => Promise.resolve(null as any));
const mockGetLocalTuiSocket = mock((_id: string) => null as any);
const mockEmitToRelaySessionVerified = mock(() => Promise.resolve(false));
const mockBroadcastToSessionViewers = mock(() => {});
const mockGetLocalRunnerSocket = mock((_runnerId: string) => null as any);
const mockRecordRunnerSession = mock(() => Promise.resolve());
const mockLinkSessionToRunner = mock(() => Promise.resolve());

mock.module("../ws/sio-registry.js", () => ({
    getSharedSession: mockGetSharedSession,
    getLocalTuiSocket: mockGetLocalTuiSocket,
    emitToRelaySessionVerified: mockEmitToRelaySessionVerified,
    broadcastToSessionViewers: mockBroadcastToSessionViewers,
    getLocalRunnerSocket: mockGetLocalRunnerSocket,
    recordRunnerSession: mockRecordRunnerSession,
    linkSessionToRunner: mockLinkSessionToRunner,
}));

// ── Mock middleware ──────────────────────────────────────────────────────────
const mockRequireSession = mock((_req: Request) =>
    Promise.resolve({ userId: "user-1", userName: "TestUser" } as any),
);
const mockValidateApiKey = mock((_req: Request, _key?: string) =>
    Promise.resolve({ userId: "user-1", userName: "TestUser" } as any),
);
mock.module("../middleware.js", () => ({
    requireSession: mockRequireSession,
    validateApiKey: mockValidateApiKey,
}));

// ── Mock trigger stores ──────────────────────────────────────────────────────
const mockSubscribeSessionToTrigger = mock(() => Promise.resolve());
const mockUnsubscribeSessionFromTrigger = mock(() => Promise.resolve());
const mockListSessionSubscriptions = mock(() => Promise.resolve([] as any[]));
const mockGetSubscribersForTrigger = mock(() => Promise.resolve([] as string[]));
const mockGetSubscriptionParams = mock(() => Promise.resolve(undefined as any));
const mockGetSubscriptionFilters = mock(() => Promise.resolve(undefined as any));
const mockUpdateSessionSubscription = mock(() => Promise.resolve({ updated: true, runnerId: "runner-A" } as any));

mock.module("../sessions/trigger-subscription-store.js", () => ({
    subscribeSessionToTrigger: mockSubscribeSessionToTrigger,
    unsubscribeSessionFromTrigger: mockUnsubscribeSessionFromTrigger,
    listSessionSubscriptions: mockListSessionSubscriptions,
    getSubscribersForTrigger: mockGetSubscribersForTrigger,
    getSubscriptionParams: mockGetSubscriptionParams,
    getSubscriptionFilters: mockGetSubscriptionFilters,
    updateSessionSubscription: mockUpdateSessionSubscription,
}));

mock.module("../sessions/trigger-store.js", () => ({
    pushTriggerHistory: mock(() => Promise.resolve()),
    getTriggerHistory: mock(() => Promise.resolve([])),
    clearTriggerHistory: mock(() => Promise.resolve()),
}));

mock.module("../sessions/runner-trigger-listener-store.js", () => ({
    getRunnerListenerTypes: mock(() => Promise.resolve([])),
    getRunnerTriggerListener: mock(() => Promise.resolve(null)),
    updateRunnerTriggerListener: mock(() => Promise.resolve(false)),
}));

mock.module("../ws/runner-control.js", () => ({
    waitForSpawnAck: mock(() => Promise.resolve({ ok: true })),
}));

// ── Mock runners registry ──────────────────────────────────────────────────
// Use spyOn instead of mock.module so this file cannot poison the module cache
// for later test files that import runners.js in the same Bun worker.
import * as _runnersModule from "../ws/sio-registry/runners.js";

// Default: no runner services. Individual tests override as needed.
const mockGetRunnerServices = spyOn(_runnersModule, "getRunnerServices")
    .mockImplementation((_rid: string) => Promise.resolve(null as any));
const mockGetRunnerData = spyOn(_runnersModule, "getRunnerData")
    .mockImplementation(() => Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));

// ── Import route handler (after mocks) ──────────────────────────────────────
afterAll(() => {
    mockGetRunnerServices.mockRestore();
    mockGetRunnerData.mockRestore();
    mock.restore();
});

const { handleTriggersRoute } = await import("./triggers.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(method: string, path: string, body?: object): [Request, URL] {
    const url = new URL(`http://localhost${path}`);
    const init: RequestInit = {
        method,
        headers: { "content-type": "application/json" },
    };
    if (body) init.body = JSON.stringify(body);
    return [new Request(url.toString(), init), url];
}

const SESSION_WITH_RUNNER = {
    userId: "user-1",
    sessionId: "sess-1",
    runnerId: "runner-A",
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("trigger subscription reconciliation — delta emission", () => {
    beforeEach(() => {
        mockEmitDelta.mockClear();
        mockGetSharedSession.mockReset();
        mockRequireSession.mockReturnValue(
            Promise.resolve({ userId: "user-1", userName: "TestUser" }),
        );
        mockGetRunnerServices.mockReturnValue(Promise.resolve(null));
    });

    // ── DELETE (unsubscribe) ──────────────────────────────────────────────

    describe("DELETE /api/sessions/:id/trigger-subscriptions/:triggerType", () => {
        test("emits an unsubscribe delta to the runner", async () => {
            mockGetSharedSession.mockReturnValue(
                Promise.resolve({ ...SESSION_WITH_RUNNER } as any),
            );

            const [req, url] = makeReq(
                "DELETE",
                "/api/sessions/sess-1/trigger-subscriptions/time:timer_fired",
            );
            const res = await handleTriggersRoute(req, url);
            expect(res!.status).toBe(200);

            // emitTriggerSubscriptionDelta must have been called once
            expect(mockEmitDelta).toHaveBeenCalledTimes(1);

            const [runnerId, delta] = mockEmitDelta.mock.calls[0] as [string, any];
            expect(runnerId).toBe("runner-A");
            expect(delta.action).toBe("unsubscribe");
            expect(delta.subscription.sessionId).toBe("sess-1");
            expect(delta.subscription.triggerType).toBe("time:timer_fired");
            expect(delta.subscription.runnerId).toBe("runner-A");
        });

        test("does NOT emit a delta when session has no runner", async () => {
            mockGetSharedSession.mockReturnValue(
                Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: null } as any),
            );

            const [req, url] = makeReq(
                "DELETE",
                "/api/sessions/sess-1/trigger-subscriptions/time:timer_fired",
            );
            await handleTriggersRoute(req, url);

            expect(mockEmitDelta).not.toHaveBeenCalled();
        });
    });

    // ── POST (subscribe) ──────────────────────────────────────────────────

    describe("POST /api/sessions/:id/trigger-subscriptions", () => {
        beforeEach(() => {
            // Provide a valid trigger catalog so the POST route proceeds past validation
            mockGetRunnerServices.mockReturnValue(Promise.resolve({
                serviceIds: ["time"],
                triggerDefs: [
                    {
                        type: "time:timer_fired",
                        label: "Timer Fired",
                        params: [{ name: "duration", type: "string", required: true }],
                    },
                    {
                        type: "godmother:idea_moved",
                        label: "Idea Moved",
                        // no required params
                    },
                ],
            }));
        });

        test("emits a subscribe delta even when no params are supplied", async () => {
            mockGetSharedSession.mockReturnValue(
                Promise.resolve({ ...SESSION_WITH_RUNNER } as any),
            );

            // godmother:idea_moved has no required params — subscribe with bare triggerType
            const [req, url] = makeReq(
                "POST",
                "/api/sessions/sess-1/trigger-subscriptions",
                { triggerType: "godmother:idea_moved" },
            );
            const res = await handleTriggersRoute(req, url);
            expect(res!.status).toBe(200);

            expect(mockEmitDelta).toHaveBeenCalledTimes(1);
            const [runnerId, delta] = mockEmitDelta.mock.calls[0] as [string, any];
            expect(runnerId).toBe("runner-A");
            expect(delta.action).toBe("subscribe");
            expect(delta.subscription.sessionId).toBe("sess-1");
            expect(delta.subscription.triggerType).toBe("godmother:idea_moved");
            expect(delta.subscription.runnerId).toBe("runner-A");
            // No params in the delta when none were supplied
            expect(delta.subscription.params).toBeUndefined();
        });

        test("emits a subscribe delta with params when params are supplied", async () => {
            mockGetSharedSession.mockReturnValue(
                Promise.resolve({ ...SESSION_WITH_RUNNER } as any),
            );

            const [req, url] = makeReq(
                "POST",
                "/api/sessions/sess-1/trigger-subscriptions",
                { triggerType: "time:timer_fired", params: { duration: "10m" } },
            );
            const res = await handleTriggersRoute(req, url);
            expect(res!.status).toBe(200);

            expect(mockEmitDelta).toHaveBeenCalledTimes(1);
            const [, delta] = mockEmitDelta.mock.calls[0] as [string, any];
            expect(delta.action).toBe("subscribe");
            expect(delta.subscription.params?.duration).toBe("10m");
        });

        test("emits a subscribe delta with filters when filters are supplied", async () => {
            mockGetSharedSession.mockReturnValue(
                Promise.resolve({ ...SESSION_WITH_RUNNER } as any),
            );

            const [req, url] = makeReq(
                "POST",
                "/api/sessions/sess-1/trigger-subscriptions",
                {
                    triggerType: "godmother:idea_moved",
                    filters: [{ field: "status", value: "shipped" }],
                    filterMode: "and",
                },
            );
            const res = await handleTriggersRoute(req, url);
            expect(res!.status).toBe(200);

            const [, delta] = mockEmitDelta.mock.calls[0] as [string, any];
            expect(delta.action).toBe("subscribe");
            expect(delta.subscription.filters?.[0].field).toBe("status");
            expect(delta.subscription.filterMode).toBe("and");
        });

        test("does NOT emit a delta when session has no runner", async () => {
            mockGetSharedSession.mockReturnValue(
                // No runnerId → session has no runner
                Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: null } as any),
            );

            const [req, url] = makeReq(
                "POST",
                "/api/sessions/sess-1/trigger-subscriptions",
                { triggerType: "godmother:idea_moved" },
            );
            // Route returns 422 "no associated runner" before reaching the delta emit
            const res = await handleTriggersRoute(req, url);
            expect(res!.status).toBe(422);
            expect(mockEmitDelta).not.toHaveBeenCalled();
        });
    });

    // ── PUT (update) ──────────────────────────────────────────────────────

    describe("PUT /api/sessions/:id/trigger-subscriptions/:triggerType", () => {
        test("emits an update delta to the runner", async () => {
            mockGetSharedSession.mockReturnValue(
                Promise.resolve({ ...SESSION_WITH_RUNNER } as any),
            );
            // updateSessionSubscription returns updated=true
            mockUpdateSessionSubscription.mockReturnValue(
                Promise.resolve({ updated: true, runnerId: "runner-A" }),
            );

            const [req, url] = makeReq(
                "PUT",
                "/api/sessions/sess-1/trigger-subscriptions/time:cron",
                { params: { cron: "0 * * * *" } },
            );
            const res = await handleTriggersRoute(req, url);
            expect(res!.status).toBe(200);

            expect(mockEmitDelta).toHaveBeenCalledTimes(1);
            const [runnerId, delta] = mockEmitDelta.mock.calls[0] as [string, any];
            expect(runnerId).toBe("runner-A");
            expect(delta.action).toBe("update");
            expect(delta.subscription.sessionId).toBe("sess-1");
            expect(delta.subscription.triggerType).toBe("time:cron");
        });

        test("does NOT emit a delta when subscription not found", async () => {
            mockGetSharedSession.mockReturnValue(
                Promise.resolve({ ...SESSION_WITH_RUNNER } as any),
            );
            mockUpdateSessionSubscription.mockReturnValue(
                Promise.resolve({ updated: false }),
            );

            const [req, url] = makeReq(
                "PUT",
                "/api/sessions/sess-1/trigger-subscriptions/time:cron",
                {},
            );
            const res = await handleTriggersRoute(req, url);
            // Returns 404 when subscription not found
            expect(res!.status).toBe(404);
            expect(mockEmitDelta).not.toHaveBeenCalled();
        });
    });
});
