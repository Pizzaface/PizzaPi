/**
 * Regression tests for durable-schedule ownership resolution.
 *
 * The relay-session pruner deletes ended relay_session rows, but durable
 * time:* subscriptions outlive them. When both the live record and the
 * persisted row are gone, ownership must fall back to the schedule's runner —
 * otherwise the schedule 404s on every manage attempt and fires forever
 * (the root cause of stacked duplicate Morning Report schedules).
 */

import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const mockEmitDelta = mock((_runnerId: string, _delta: any) => {});
mock.module("../ws/namespaces/runner.js", () => ({
  emitTriggerSubscriptionDelta: mockEmitDelta,
}));

const mockGetSharedSession = mock((_id: string) => Promise.resolve(null as any));
mock.module("../ws/sio-registry.js", () => ({
  emitToRunner: mock(() => {}),
  getSharedSession: mockGetSharedSession,
  getLocalTuiSocket: mock(() => null),
  waitForLocalTuiSocket: mock(() => null),
  emitToRelaySessionVerified: mock(() => Promise.resolve(false)),
  broadcastToSessionViewers: mock(() => {}),
  getLocalRunnerSocket: mock(() => null),
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

mock.module("../sessions/runner-trigger-listener-store.js", () => ({
  getRunnerListenerTypes: mock(() => Promise.resolve([])),
  getRunnerTriggerListener: mock(() => Promise.resolve(null)),
  listRunnerTriggerListeners: mock(() => Promise.resolve([])),
  updateRunnerTriggerListener: mock(() => Promise.resolve(false)),
  removeRunnerTriggerListener: mock(() => Promise.resolve(false)),
}));

mock.module("../ws/runner-control.js", () => ({
  waitForSpawnAck: mock(() => Promise.resolve({ ok: true })),
}));

import * as _runnersModule from "../ws/sio-registry/runners.js";
import * as _triggerSubsModule from "../sessions/trigger-subscription-store.js";
import * as _sessionsStore from "../sessions/store.js";

const mockGetRunnerData = spyOn(_runnersModule, "getRunnerData")
  .mockImplementation(() => Promise.resolve({ userId: "user-1", runnerId: "runner-A" } as any));
const spyPersistedOwner = spyOn(_sessionsStore, "getPersistedRelaySessionOwner")
  .mockImplementation(() => Promise.resolve(null));
const spyDurableRunner = spyOn(_triggerSubsModule, "getDurableSubscriptionRunnerId")
  .mockImplementation(() => Promise.resolve(null));
const spyListSubs = spyOn(_triggerSubsModule, "listSessionSubscriptions")
  .mockImplementation(() => Promise.resolve([]));
const spyUnsubById = spyOn(_triggerSubsModule, "unsubscribeSessionSubscription")
  .mockImplementation(() => Promise.resolve({ removed: 1, triggerType: "time:cron" } as any));

afterAll(() => {
  mockGetRunnerData.mockRestore();
  spyPersistedOwner.mockRestore();
  spyDurableRunner.mockRestore();
  spyListSubs.mockRestore();
  spyUnsubById.mockRestore();
  mock.restore();
});

const { handleTriggersRoute } = await import("./triggers.js");

function makeReq(method: string, path: string): [Request, URL] {
  const url = new URL(`http://localhost${path}`);
  return [new Request(url.toString(), { method, headers: { "content-type": "application/json" } }), url];
}

describe("durable subscription ownership fallback (pruned relay_session)", () => {
  beforeEach(() => {
    mockGetSharedSession.mockReset();
    mockGetSharedSession.mockReturnValue(Promise.resolve(null));
    spyPersistedOwner.mockClear();
    spyDurableRunner.mockClear();
    spyUnsubById.mockClear();
  });

  test("GET falls back to durable subscription runner when session is pruned", async () => {
    spyDurableRunner.mockReturnValueOnce(Promise.resolve("runner-A"));
    const [req, url] = makeReq("GET", "/api/sessions/dead-sess/trigger-subscriptions");
    const res = await handleTriggersRoute(req, url);
    expect(res!.status).toBe(200);
    expect(spyDurableRunner).toHaveBeenCalledWith("dead-sess");
  });

  test("DELETE succeeds for a schedule whose session row was pruned", async () => {
    spyDurableRunner.mockReturnValueOnce(Promise.resolve("runner-A"));
    const [req, url] = makeReq(
      "DELETE",
      "/api/sessions/dead-sess/trigger-subscriptions/time:cron?subscriptionId=sub-1",
    );
    const res = await handleTriggersRoute(req, url);
    expect(res!.status).toBe(200);
    expect(spyUnsubById).toHaveBeenCalledWith("dead-sess", "sub-1");
  });

  test("404 when no durable subscription exists for the pruned session", async () => {
    const [req, url] = makeReq("GET", "/api/sessions/dead-sess/trigger-subscriptions");
    const res = await handleTriggersRoute(req, url);
    expect(res!.status).toBe(404);
  });

  test("404 when the schedule's runner belongs to another user", async () => {
    spyDurableRunner.mockReturnValueOnce(Promise.resolve("runner-A"));
    mockGetRunnerData.mockReturnValueOnce(Promise.resolve({ userId: "someone-else" } as any));
    const [req, url] = makeReq("GET", "/api/sessions/dead-sess/trigger-subscriptions");
    const res = await handleTriggersRoute(req, url);
    expect(res!.status).toBe(404);
  });
});
