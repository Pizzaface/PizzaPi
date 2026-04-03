/**
 * Focused tests for subscriptionId-targeted trigger subscription operations.
 *
 * Verifies the route honors ?subscriptionId=... for PUT/DELETE so one
 * subscription can be updated/removed without affecting siblings of the same
 * trigger type.
 */

import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const mockEmitDelta = mock((_runnerId: string, _delta: any) => {});
mock.module("../ws/namespaces/runner.js", () => ({
  emitTriggerSubscriptionDelta: mockEmitDelta,
}));

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

const mockSubscribeSessionToTrigger = mock(() => Promise.resolve("sub-default"));
const mockUnsubscribeSessionFromTrigger = mock(() => Promise.resolve({ removed: 0, triggerType: "svc:event" }));
const mockListSessionSubscriptions = mock(() => Promise.resolve([] as any[]));
const mockGetSubscribersForTrigger = mock(() => Promise.resolve([] as string[]));
const mockGetSubscriptionParams = mock(() => Promise.resolve(undefined as any));
const mockGetSubscriptionFilters = mock(() => Promise.resolve(undefined as any));
const mockUpdateSessionSubscription = mock(() => Promise.resolve({ updated: false } as any));
const mockUnsubscribeSessionSubscription = mock(() => Promise.resolve());

mock.module("../sessions/trigger-subscription-store.js", () => ({
  subscribeSessionToTrigger: mockSubscribeSessionToTrigger,
  unsubscribeSessionFromTrigger: mockUnsubscribeSessionFromTrigger,
  unsubscribeSessionSubscription: mockUnsubscribeSessionSubscription,
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

import * as _runnersModule from "../ws/sio-registry/runners.js";
const mockGetRunnerServices = spyOn(_runnersModule, "getRunnerServices")
  .mockImplementation((_rid: string) => Promise.resolve({ serviceIds: [], triggerDefs: [{ type: "svc:event", label: "Event" }] } as any));
const mockGetRunnerData = spyOn(_runnersModule, "getRunnerData")
  .mockImplementation(() => Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));

afterAll(() => {
  mockGetRunnerServices.mockRestore();
  mockGetRunnerData.mockRestore();
  mock.restore();
});

const { handleTriggersRoute } = await import("./triggers.js");

function makeReq(method: string, path: string, body?: object): [Request, URL] {
  const url = new URL(`http://localhost${path}`);
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json" },
  };
  if (body) init.body = JSON.stringify(body);
  return [new Request(url.toString(), init), url];
}

describe("trigger subscription routes honor subscriptionId query param", () => {
  beforeEach(() => {
    mockGetSharedSession.mockReset();
    mockBroadcastToSessionViewers.mockReset();
    mockEmitDelta.mockReset();
    mockUnsubscribeSessionFromTrigger.mockReset();
    mockUnsubscribeSessionSubscription.mockReset();
    mockUpdateSessionSubscription.mockReset();
    mockGetSharedSession.mockReturnValue(Promise.resolve({ userId: "user-1", sessionId: "sess-1", runnerId: "runner-A" } as any));
  });

  test("DELETE uses subscriptionId query param for targeted unsubscribe", async () => {
    const [req, url] = makeReq("DELETE", "/api/sessions/sess-1/trigger-subscriptions/svc:event?subscriptionId=sub-123");
    const res = await handleTriggersRoute(req, url);

    expect(res!.status).toBe(200);
    expect(mockUnsubscribeSessionSubscription).toHaveBeenCalledTimes(1);
    expect(mockUnsubscribeSessionSubscription).toHaveBeenCalledWith("sess-1", "sub-123");
    expect(mockUnsubscribeSessionFromTrigger).not.toHaveBeenCalled();

    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.subscriptionId).toBe("sub-123");
    expect(body.triggerType).toBe("svc:event");

    expect(mockEmitDelta).toHaveBeenCalledTimes(1);
    const [, delta] = mockEmitDelta.mock.calls[0] as [string, any];
    expect(delta.action).toBe("unsubscribe");
    expect(delta.subscription.subscriptionId).toBe("sub-123");
    expect(delta.subscription.triggerType).toBe("svc:event");
  });

  test("PUT forwards subscriptionId query param to targeted update", async () => {
    mockUpdateSessionSubscription.mockReturnValue(
      Promise.resolve({ updated: true, subscriptionId: "sub-123", triggerType: "svc:event", runnerId: "runner-A" }),
    );

    const [req, url] = makeReq(
      "PUT",
      "/api/sessions/sess-1/trigger-subscriptions/svc:event?subscriptionId=sub-123",
      { params: { repo: "PizzaPi" } },
    );
    const res = await handleTriggersRoute(req, url);

    expect(res!.status).toBe(200);
    expect(mockUpdateSessionSubscription).toHaveBeenCalledTimes(1);
    expect(mockUpdateSessionSubscription).toHaveBeenCalledWith(
      "sess-1",
      "sub-123",
      expect.objectContaining({ params: { repo: "PizzaPi" } }),
    );

    const body = await res!.json();
    expect(body.ok).toBe(true);
    expect(body.subscriptionId).toBe("sub-123");
    expect(body.triggerType).toBe("svc:event");

    expect(mockEmitDelta).toHaveBeenCalledTimes(1);
    const [, delta] = mockEmitDelta.mock.calls[0] as [string, any];
    expect(delta.action).toBe("update");
    expect(delta.subscription.subscriptionId).toBe("sub-123");
    expect(delta.subscription.triggerType).toBe("svc:event");
  });
});
