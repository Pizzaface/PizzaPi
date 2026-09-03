import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";

const memDb = new Kysely<any>({
  dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

const delivered: string[] = [];
const responses: Array<{ sessionId: string; event: string; data: any }> = [];
const recordedResponses: Array<{ sessionId: string; triggerId: string; response: any }> = [];
const viewerBroadcasts: Array<{ sessionId: string; event: string; data: any }> = [];
const mirrored: Array<{ action: string; routeId: string; triggerType?: string; runnerId: string; sessionId: string }> = [];

// Dead-runner markers (runnerId → lastSeenAt) for the GET /api/routes flag.
const deadRunners = new Map<string, string>();

const modsPromise = (async () => {
  // transport.ts named-imports these; ack-settle only runs on the acked
  // emit path, which these route tests never exercise.
  mock.module("../auth.js", () => ({
    getKysely: () => memDb,
    getAuthContext: () => ({ userId: "u1" }),
    runWithAuthContext: <T,>(_ctx: unknown, fn: () => T) => fn(),
  }));
  mock.module("../events/runner-liveness.js", () => ({
    runnerDeadSince: async (runnerId: string) => deadRunners.get(runnerId) ?? null,
    sweepDeadRunners: async () => 0,
  }));
  mock.module("../middleware.js", () => ({
    requireSession: async () => ({ userId: "u1", userName: "tester" }),
    validateApiKey: async () => ({ userId: "u1", userName: "api-tester" }),
  }));
  mock.module("../ws/sio-registry.js", () => ({
    emitToRunner: () => {},
    getIo: () => undefined,
    runnerRoom: (id: string) => `runner:${id}`,
    countSocketsInRoomCluster: async () => ({ kind: "unknown" }),
    getSharedSession: async (id: string) => {
      // offline-src is an OWNED session whose worker is not connected — the
      // response relay must fail while publish-time source validation passes.
      if (id === "offline-src") return { userId: "u1", runnerId: "runner-1" };
      if (id === "owned" || id === "child") return { userId: "u1", runnerId: "runner-1" };
      if (id === "owned-2") return { userId: "u1", runnerId: "runner-2" };
      if (id === "runnerless") return { userId: "u1" };
      return null;
    },
    getLocalTuiSocket: (sessionId: string) => {
      if (sessionId.startsWith("offline-")) return undefined;
      return {
        connected: true,
        emit: (event: string, data: any) => {
          responses.push({ sessionId, event, data });
          if (data?.trigger?.targetSessionId) delivered.push(data.trigger.targetSessionId);
        },
      };
    },
    emitToRelaySessionVerified: async () => false,
    emitToRelaySessionAcked: async () => false,
    broadcastToSessionViewers: (sessionId: string, event: string, data: any) => {
      viewerBroadcasts.push({ sessionId, event, data });
    },
    getLocalRunnerSocket: () => null,
    linkSessionToRunner: async () => {},
    recordRunnerSession: async () => {},
    waitForLocalTuiSocket: async () => true,
  }));
  mock.module("../ws/runner-control.js", () => ({ waitForSpawnAck: async () => ({ ok: true }) }));
  mock.module("../ws/sio-registry/runners.js", () => ({
    getRunnerData: async (id: string) =>
      id === "runner-1" || id === "runner-2" ? { userId: "u1" } : id === "runner-other" ? { userId: "u2" } : null,
  }));
  mock.module("../sessions/trigger-store.js", () => ({
    pushTriggerHistory: async () => {},
    recordTriggerResponse: async (sessionId: string, triggerId: string, response: any) => {
      recordedResponses.push({ sessionId, triggerId, response });
    },
  }));
  mock.module("../push.js", () => ({ sendPushToUser: async () => {} }));
  mock.module("../ws/namespaces/runner.js", () => ({
    emitTriggerSubscriptionDelta: async (runnerId: string, delta: any) => {
      mirrored.push({
        action: delta.action,
        routeId: delta.subscription.subscriptionId,
        triggerType: delta.subscription.triggerType,
        runnerId,
        sessionId: delta.subscription.sessionId,
      });
      return undefined;
    },
  }));
  const store = await import("../events/store.js");
  const routes = await import("./events.js");
  const runnerOwner = await import("../runner-owner.js");
  return { store, routes, runnerOwner };
})();

afterAll(() => mock.restore());

/** Mirrors are fire-and-forget — flush their async chain before asserting. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function call(routes: Awaited<typeof modsPromise>["routes"], method: string, path: string, body?: unknown) {
  const url = new URL(`http://x${path}`);
  const req = new Request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return routes.handleEventsRoute(req, url);
}

describe("events HTTP surface", () => {
  let store: Awaited<typeof modsPromise>["store"];
  let routes: Awaited<typeof modsPromise>["routes"];

  beforeAll(async () => {
    ({ store, routes } = await modsPromise);
    await store.ensureEventTables();
    await (await modsPromise).runnerOwner.ensureRunnerOwnerTable();
  });

  afterEach(async () => {
    delivered.length = 0;
    responses.length = 0;
    recordedResponses.length = 0;
    viewerBroadcasts.length = 0;
    mirrored.length = 0;
    deadRunners.clear();
    await memDb.deleteFrom("trigger_delivery").execute();
    await memDb.deleteFrom("trigger_route").execute();
    await memDb.deleteFrom("trigger_event").execute();
  });

  it("publishes an event and delivers to a direct target", async () => {
    const res = await call(routes, "POST", "/api/events", {
      type: "test:fired",
      payload: { n: 1 },
      target: { sessionId: "owned" },
    });
    expect(res!.status).toBe(200);
    const json = (await res!.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.deliveries).toHaveLength(1);
    expect(json.deliveries[0].status).toBe("delivered");
    expect(delivered).toEqual(["owned"]);
  });

  it("rejects direct targets the caller does not own (404 shape)", async () => {
    const res = await call(routes, "POST", "/api/events", {
      type: "test:fired",
      target: { sessionId: "stranger" },
    });
    expect(res!.status).toBe(404);
  });

  it("rejects invalid event types", async () => {
    const res = await call(routes, "POST", "/api/events", { type: "notNamespaced" });
    expect(res!.status).toBe(400);
  });

  it("validates event fields before publishing or consuming a fireId", async () => {
    const invalidBodies: unknown[] = [
      null,
      [],
      { type: "test:event", payload: [] },
      { type: "test:event", payload: "nope" },
      { type: "test:event", summary: 1 },
      { type: "test:event", fireId: "" },
      { type: "test:event", responseContract: [] },
      { type: "test:event", responseContract: { ttlMs: 0 } },
      { type: "test:event", responseContract: { ttlMs: -1 } },
      { type: "test:event", responseContract: { ttlMs: null } },
      { type: "test:event", responseContract: { actions: "approve" } },
      { type: "test:event", responseContract: { actions: ["approve", 1] } },
      { type: "test:event", responseContract: { escalate: "yes" } },
      { type: "test:event", target: { deliverAs: "later" } },
      { type: "test:event", source: { kind: "webhook" } },
      { type: "test:event", source: { kind: "api", id: 1 } },
      { type: "test:event", source: { kind: "api", name: 1 } },
      { type: "test:event", source: { kind: "session" } },
    ];
    for (const body of invalidBodies) {
      const res = await call(routes, "POST", "/api/events", body);
      expect(res!.status).toBe(400);
    }

    const rejected = await call(routes, "POST", "/api/events", {
      type: "test:event",
      fireId: "retry-after-invalid-contract",
      responseContract: { ttlMs: null },
      target: { sessionId: "owned" },
    });
    expect(rejected!.status).toBe(400);
    const retried = await call(routes, "POST", "/api/events", {
      type: "test:event",
      fireId: "retry-after-invalid-contract",
      responseContract: { ttlMs: 1000, actions: ["ok"], escalate: false },
      target: { sessionId: "owned", deliverAs: "followUp" },
    });
    expect(retried!.status).toBe(200);
    expect(((await retried!.json()) as any).created).toBe(true);
  });

  it("feed lists published events", async () => {
    await call(routes, "POST", "/api/events", { type: "feed:one" });
    const res = await call(routes, "GET", "/api/events?type=feed:one");
    const json = (await res!.json()) as any;
    expect(json.events).toHaveLength(1);
    expect(json.events[0].source.auth).toBe("cookie");
  });

  it("clamps event feed limits to positive integers", async () => {
    for (let i = 0; i < 3; i++) {
      await call(routes, "POST", "/api/events", { type: "feed:limited", payload: { i } });
    }

    const negative = await call(routes, "GET", "/api/events?type=feed:limited&limit=-1");
    expect(((await negative!.json()) as any).events).toHaveLength(1);

    const fractional = await call(routes, "GET", "/api/events?type=feed:limited&limit=1.9");
    expect(((await fractional!.json()) as any).events).toHaveLength(1);

    const oversized = await call(routes, "GET", "/api/events?type=feed:limited&limit=999");
    expect(((await oversized!.json()) as any).events).toHaveLength(3);
  });

  it("route CRUD with ownership check and config read-only", async () => {
    const created = await call(routes, "POST", "/api/routes", {
      eventType: "t:x",
      target: { kind: "session", sessionId: "owned" },
      deliverAs: "followUp",
      origin: "ui",
    });
    expect(created!.status).toBe(200);
    const { route } = (await created!.json()) as any;

    const updated = await call(routes, "PUT", `/api/routes/${route.routeId}`, { deliverAs: "steer" });
    expect(((await updated!.json()) as any).route.deliverAs).toBe("steer");

    await store.syncConfigRoutes([
      { eventType: "cfg:x", target: { kind: "session", sessionId: "owned" }, deliverAs: "steer", origin: "config" },
    ]);
    const [cfg] = await store.listRoutes({ eventType: "cfg:x" });
    const denied = await call(routes, "DELETE", `/api/routes/${cfg.routeId}`);
    expect(denied!.status).toBe(403);

    const deleted = await call(routes, "DELETE", `/api/routes/${route.routeId}`);
    expect(deleted!.status).toBe(200);
  });

  it("rejects malformed route fields on create and update", async () => {
    const valid = {
      eventType: "test:route",
      target: { kind: "session", sessionId: "owned" },
      deliverAs: "followUp",
      origin: "ui",
    };
    const invalidPatches: Array<Record<string, unknown>> = [
      { eventType: "not-namespaced" },
      { deliverAs: "later" },
      { filters: {} },
      { filters: [{ field: "", value: "x" }] },
      { filters: [{ field: "repo", value: null }] },
      { filters: [{ field: "repo", value: ["ok", {}] }] },
      { filters: [{ field: "repo", value: "x", op: "startsWith" }] },
      { filterMode: "some" },
      { params: [] },
      { promptTemplate: 1 },
      { disabled: "false" },
    ];

    for (const patch of invalidPatches) {
      const res = await call(routes, "POST", "/api/routes", { ...valid, ...patch });
      expect(res!.status).toBe(400);
    }

    const created = await call(routes, "POST", "/api/routes", {
      ...valid,
      filters: [{ field: "repo", value: ["one", 2, true], op: "contains" }],
      filterMode: "or",
      params: { source: "test" },
      promptTemplate: "{{repo}}",
      disabled: false,
    });
    expect(created!.status).toBe(200);
    const { route } = (await created!.json()) as any;

    for (const patch of invalidPatches) {
      const res = await call(routes, "PUT", `/api/routes/${route.routeId}`, patch);
      expect(res!.status).toBe(400);
    }
    const unchanged = await store.getRoute(route.routeId);
    expect(unchanged?.eventType).toBe("test:route");
    expect(unchanged?.deliverAs).toBe("followUp");
  });

  it("derives session target runnerIds and rejects mismatches", async () => {
    const mismatch = await call(routes, "POST", "/api/routes", {
      eventType: "test:mismatch",
      target: { kind: "session", sessionId: "owned", runnerId: "runner-other" },
      deliverAs: "followUp",
      origin: "ui",
    });
    expect(mismatch!.status).toBe(400);
    expect((await mismatch!.json()) as any).toEqual({ error: "runnerId does not match session" });

    // Session without a resolvable runner: a client runnerId is honored only
    // when the caller owns that runner.
    const foreign = await call(routes, "POST", "/api/routes", {
      eventType: "test:runnerless",
      target: { kind: "session", sessionId: "runnerless", runnerId: "runner-other" },
      deliverAs: "followUp",
      origin: "ui",
    });
    expect(foreign!.status).toBe(404);
    const unknown = await call(routes, "POST", "/api/routes", {
      eventType: "test:runnerless",
      target: { kind: "session", sessionId: "runnerless", runnerId: "client-value" },
      deliverAs: "followUp",
      origin: "ui",
    });
    expect(unknown!.status).toBe(404);
    const owned = await call(routes, "POST", "/api/routes", {
      eventType: "test:runnerless",
      target: { kind: "session", sessionId: "runnerless", runnerId: "runner-2" },
      deliverAs: "followUp",
      origin: "ui",
    });
    expect(owned!.status).toBe(200);
    const ownedRoute = ((await owned!.json()) as any).route;
    expect(ownedRoute.target.runnerId).toBe("runner-2");
    expect(ownedRoute.ownerUserId).toBe("u1");
  });

  it("stamps ownerUserId from the principal and ignores a client-supplied value", async () => {
    const res = await call(routes, "POST", "/api/routes", {
      eventType: "test:owner",
      target: { kind: "session", sessionId: "owned" },
      deliverAs: "followUp",
      origin: "ui",
      ownerUserId: "someone-else",
    });
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).route.ownerUserId).toBe("u1");
  });

  it("session-target route CRUD notifies the target runner with reconcile deltas (routeId = subscriptionId)", async () => {
    const created = await call(routes, "POST", "/api/routes", {
      eventType: "time:timer_fired",
      target: { kind: "session", sessionId: "owned" },
      deliverAs: "followUp",
      origin: "agent",
      params: { duration: "10m", message: "check the build" },
    });
    const { route } = (await created!.json()) as any;
    await flush();
    expect(mirrored).toEqual([{
      action: "subscribe",
      routeId: route.routeId,
      triggerType: "time:timer_fired",
      runnerId: "runner-1",
      sessionId: "owned",
    }]);

    mirrored.length = 0;
    await call(routes, "PUT", `/api/routes/${route.routeId}`, { params: { duration: "20m" } });
    await flush();
    expect(mirrored).toEqual([{
      action: "update",
      routeId: route.routeId,
      triggerType: "time:timer_fired",
      runnerId: "runner-1",
      sessionId: "owned",
    }]);

    mirrored.length = 0;
    await call(routes, "DELETE", `/api/routes/${route.routeId}`);
    await flush();
    expect(mirrored).toEqual([{
      action: "unsubscribe",
      routeId: route.routeId,
      triggerType: "time:timer_fired",
      runnerId: "runner-1",
      sessionId: "owned",
    }]);

    // Spawn-target routes never mirror
    mirrored.length = 0;
    const spawn = await call(routes, "POST", "/api/routes", {
      eventType: "t:spawn",
      target: { kind: "spawn", spec: { runnerId: "runner-1" } },
      deliverAs: "steer",
      origin: "ui",
    });
    expect(spawn!.status).toBe(200);
    await flush();
    expect(mirrored).toEqual([]);
  });

  it("reconciles route target moves and disabled transitions", async () => {
    const created = await call(routes, "POST", "/api/routes", {
      eventType: "test:reconcile",
      target: { kind: "session", sessionId: "owned" },
      deliverAs: "followUp",
      origin: "ui",
    });
    const { route } = (await created!.json()) as any;

    mirrored.length = 0;
    await call(routes, "PUT", `/api/routes/${route.routeId}`, {
      target: { kind: "session", sessionId: "owned-2" },
    });
    expect(mirrored.map(({ action, runnerId, sessionId }) => ({ action, runnerId, sessionId }))).toEqual([
      { action: "unsubscribe", runnerId: "runner-1", sessionId: "owned" },
      { action: "update", runnerId: "runner-2", sessionId: "owned-2" },
    ]);

    mirrored.length = 0;
    await call(routes, "PUT", `/api/routes/${route.routeId}`, { disabled: true });
    expect(mirrored.map((delta) => delta.action)).toEqual(["unsubscribe"]);

    mirrored.length = 0;
    await call(routes, "PUT", `/api/routes/${route.routeId}`, { disabled: false });
    expect(mirrored.map((delta) => delta.action)).toEqual(["subscribe"]);

    mirrored.length = 0;
    await call(routes, "PUT", `/api/routes/${route.routeId}`, {
      target: { kind: "spawn", spec: { runnerId: "runner-1" } },
    });
    expect(mirrored.map(({ action, runnerId, sessionId }) => ({ action, runnerId, sessionId }))).toEqual([
      { action: "unsubscribe", runnerId: "runner-2", sessionId: "owned-2" },
    ]);
  });

  it("per-session deliveries view is ownership-gated", async () => {
    await call(routes, "POST", "/api/events", { type: "t:x", target: { sessionId: "owned" } });
    const ok = await call(routes, "GET", "/api/sessions/owned/deliveries");
    expect(((await ok!.json()) as any).deliveries).toHaveLength(1);
    const denied = await call(routes, "GET", "/api/sessions/stranger/deliveries");
    expect(denied!.status).toBe(404);
  });

  it("delivery views stamp respondable/actions from the event's responseContract", async () => {
    const pub = await call(routes, "POST", "/api/events", {
      type: "lifecycle:plan_review",
      responseContract: { actions: ["approve", "cancel"] },
      target: { sessionId: "owned" },
    });
    const { eventId, deliveries } = (await pub!.json()) as any;

    const sessionView = (await (await call(routes, "GET", "/api/sessions/owned/deliveries"))!.json()) as any;
    expect(sessionView.deliveries).toHaveLength(1);
    expect(sessionView.deliveries[0].respondable).toBe(true);
    expect(sessionView.deliveries[0].actions).toEqual(["approve", "cancel"]);

    const eventView = (await (await call(routes, "GET", `/api/events/${eventId}/deliveries`))!.json()) as any;
    expect(eventView.deliveries[0].respondable).toBe(true);
    expect(eventView.deliveries[0].actions).toEqual(["approve", "cancel"]);

    // Contract without declared actions: still respondable, no actions field.
    await call(routes, "POST", "/api/events", {
      type: "lifecycle:session_complete",
      responseContract: { ttlMs: 1000 },
      target: { sessionId: "owned" },
    });
    // No contract at all: not respondable.
    await call(routes, "POST", "/api/events", { type: "t:nocontract", target: { sessionId: "owned" } });

    const mixed = ((await (await call(routes, "GET", "/api/sessions/owned/deliveries"))!.json()) as any).deliveries as Array<Record<string, any>>;
    const byType = new Map<string, Record<string, any>>(mixed.map((d) => [d.eventType, d]));
    expect(byType.get("lifecycle:session_complete")!.respondable).toBe(true);
    expect(byType.get("lifecycle:session_complete")!.actions).toBeUndefined();
    expect(byType.get("t:nocontract")!.respondable).toBe(false);
    expect(byType.get("t:nocontract")!.actions).toBeUndefined();

    // Once answered, a delivery is no longer respondable.
    await call(routes, "POST", `/api/deliveries/${deliveries[0].deliveryId}/response`, {
      response: "ok",
      action: "approve",
    });
    const after = ((await (await call(routes, "GET", "/api/sessions/owned/deliveries"))!.json()) as any).deliveries;
    const answered = after.find((d: any) => d.eventType === "lifecycle:plan_review");
    expect(answered.status).toBe("responded");
    expect(answered.respondable).toBe(false);
    expect(answered.actions).toEqual(["approve", "cancel"]);
  });

  it("answers a contract-bearing delivery and relays the response to the source session", async () => {
    // Source session publishes a contract-bearing event at another session it
    // owns, using its own triggerId as the fireId for response correlation.
    const pub = await call(routes, "POST", "/api/events", {
      type: "lifecycle:plan_review",
      payload: { title: "Do the thing" },
      responseContract: { actions: ["approve", "cancel", "edit"] },
      fireId: "child-trigger-1",
      source: { kind: "session", id: "owned" },
      target: { sessionId: "owned" },
    });
    const { deliveries } = (await pub!.json()) as any;

    const res = await call(routes, "POST", `/api/deliveries/${deliveries[0].deliveryId}/response`, {
      response: "Looks good",
      action: "approve",
    });
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).relayed).toBe(true);

    // Wire event back to the source echoes the publisher's fireId as triggerId
    const relay = responses.find((r) => r.event === "trigger_response");
    expect(relay!.data.triggerId).toBe("child-trigger-1");
    expect(relay!.data.action).toBe("approve");

    // Delivery is marked responded with the structured answer
    const view = (await (await call(routes, "GET", "/api/sessions/owned/deliveries"))!.json()) as any;
    expect(view.deliveries[0].status).toBe("responded");
    expect(view.deliveries[0].response).toEqual({ action: "approve", text: "Looks good" });
    expect(recordedResponses).toEqual([{
      sessionId: "owned",
      triggerId: deliveries[0].deliveryId,
      response: { action: "approve", text: "Looks good" },
    }]);
    expect(viewerBroadcasts).toContainEqual({
      sessionId: "owned",
      event: "trigger_delivered",
      data: { triggerId: deliveries[0].deliveryId },
    });
  });

  it("marks a response relay pending when the source session is unreachable", async () => {
    // The source session is offline: the response is recorded but cannot be
    // relayed — the delivery is marked so the source's next registration
    // drains and re-relays it (drainPendingResponseRelays).
    const pub = await call(routes, "POST", "/api/events", {
      type: "lifecycle:plan_review",
      payload: { title: "Offline source" },
      responseContract: { actions: ["approve"] },
      fireId: "offline-fire-1",
      source: { kind: "session", id: "offline-src" },
      target: { sessionId: "owned" },
    });
    const { deliveries } = (await pub!.json()) as any;

    const res = await call(routes, "POST", `/api/deliveries/${deliveries[0].deliveryId}/response`, {
      response: "Looks good",
      action: "approve",
    });
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).relayed).toBe(false);

    const marked = await store.getDelivery(deliveries[0].deliveryId);
    expect(marked?.status).toBe("responded");
    expect(marked?.responseRelayPending).toBe(true);
    // The drain query finds it keyed on the SOURCE session, not the recipient.
    const pending = await store.pendingResponseRelaysFor("offline-src");
    expect(pending.map((d: any) => d.deliveryId)).toEqual([deliveries[0].deliveryId]);
    expect(await store.pendingResponseRelaysFor("owned")).toHaveLength(0);
  });

  it("rejects double-responds (409), foreign deliveries (404), and invalid actions (400)", async () => {
    const pub = await call(routes, "POST", "/api/events", {
      type: "lifecycle:plan_review",
      responseContract: { actions: ["approve", "cancel"] },
      target: { sessionId: "owned" },
    });
    const { deliveries } = (await pub!.json()) as any;
    const id = deliveries[0].deliveryId;

    expect(
      (await call(routes, "POST", `/api/deliveries/${id}/response`, { response: "ok", action: 1 }))!.status,
    ).toBe(400);
    expect(
      (await call(routes, "POST", `/api/deliveries/${id}/response`, { response: "ok", action: "nuke" }))!.status,
    ).toBe(400);

    const ok = await call(routes, "POST", `/api/deliveries/${id}/response`, { response: "approved", action: "approve" });
    expect(ok!.status).toBe(200);

    const dup = await call(routes, "POST", `/api/deliveries/${id}/response`, { response: "again" });
    expect(dup!.status).toBe(409);

    expect((await call(routes, "POST", "/api/deliveries/dlv_missing/response", { response: "x" }))!.status).toBe(404);
  });

  it("rejects publishing as a session the caller does not own (source spoofing)", async () => {
    const res = await call(routes, "POST", "/api/events", {
      type: "spoof:attempt",
      source: { kind: "session", id: "stranger" },
      target: { sessionId: "owned" },
    });
    expect(res!.status).toBe(403);
    // The caller's own session is a valid source.
    const ok = await call(routes, "POST", "/api/events", {
      type: "spoof:ok",
      source: { kind: "session", id: "owned" },
      target: { sessionId: "owned" },
    });
    expect(ok!.status).toBe(200);
  });

  it("PUT cannot re-target a spawn route at a runner the caller does not own", async () => {
    const created = await call(routes, "POST", "/api/routes", {
      eventType: "t:putspawn",
      target: { kind: "spawn", spec: { runnerId: "runner-1" } },
      deliverAs: "followUp",
      origin: "ui",
    });
    const { route } = (await created!.json()) as any;
    expect(route.target.spec.ownerUserId).toBe("u1");

    // Cross-tenant re-target: another user's runner → 404, stamped spec intact.
    const steal = await call(routes, "PUT", `/api/routes/${route.routeId}`, {
      target: { kind: "spawn", spec: { runnerId: "runner-other", cwd: "/etc" } },
    });
    expect(steal!.status).toBe(404);
    const after = await store.getRoute(route.routeId);
    expect(after !== null && after.target.kind === "spawn" && after.target.spec.runnerId).toBe("runner-1");
    expect(after !== null && after.target.kind === "spawn" && after.target.spec.ownerUserId).toBe("u1");

    // Same-owner re-target is fine and can't drop the fail-closed stamp.
    const reown = await call(routes, "PUT", `/api/routes/${route.routeId}`, {
      target: { kind: "spawn", spec: { runnerId: "runner-1", cwd: "/tmp" } },
    });
    expect(reown!.status).toBe(200);
    const updated = await store.getRoute(route.routeId);
    expect(updated !== null && updated.target.kind === "spawn" && updated.target.spec.ownerUserId).toBe("u1");
    expect(updated !== null && updated.target.kind === "spawn" && updated.target.spec.cwd).toBe("/tmp");
  });

  it("relays lifecycle:session_complete responses to the parent delivery session", async () => {
    const pub = await call(routes, "POST", "/api/events", {
      type: "lifecycle:session_complete",
      fireId: "child-complete-1",
      responseContract: { ttlMs: 1000 },
      source: { kind: "session", id: "child" },
      target: { sessionId: "owned" },
    });
    const { deliveries } = (await pub!.json()) as any;
    const res = await call(routes, "POST", `/api/deliveries/${deliveries[0].deliveryId}/response`, {
      response: "acknowledged",
      action: "ack",
    });
    expect(res!.status).toBe(200);
    const relay = responses.find((r) => r.event === "trigger_response");
    expect(relay!.sessionId).toBe("owned");
    expect(relay!.sessionId).not.toBe("child");
    expect(relay!.data.triggerId).toBe("child-complete-1");
  });

  it("responses to escalation events resolve the original and relay its trigger id", async () => {
    const original = await call(routes, "POST", "/api/events", {
      type: "lifecycle:plan_review",
      responseContract: { ttlMs: 1000 },
      fireId: "child-trigger-9",
      source: { kind: "session", id: "child" },
      target: { sessionId: "owned" },
    });
    const originalJson = (await original!.json()) as any;
    for (const [sessionId, status] of [["pending-target", "pending"], ["expired-target", "expired"], ["escalated-target", "escalated"]] as const) {
      const delivery = await store.createDelivery({
        eventId: originalJson.eventId,
        eventType: "lifecycle:plan_review",
        sessionId,
        deliverAs: "followUp",
      });
      if (delivery && status !== "pending") await store.updateDelivery(delivery.deliveryId, { status });
    }

    const pub = await call(routes, "POST", "/api/events", {
      type: "lifecycle:escalation",
      payload: { reason: "needs human", originalTriggerId: "child-trigger-9" },
      responseContract: { escalate: false },
      fireId: "escalate:child-trigger-9",
      source: { kind: "session", id: "child" },
      target: { sessionId: "owned" },
    });
    const { deliveries } = (await pub!.json()) as any;
    const res = await call(routes, "POST", `/api/deliveries/${deliveries[0].deliveryId}/response`, {
      response: "Human says retry",
      action: "retry",
    });
    expect(res!.status).toBe(200);
    const relay = responses.find((r) => r.event === "trigger_response");
    // The waiter on the child matches its ORIGINAL id, not the escalate: fireId.
    expect(relay!.sessionId).toBe("child");
    expect(relay!.data.triggerId).toBe("child-trigger-9");

    const originalDeliveries = await store.listDeliveries({ eventId: originalJson.eventId });
    expect(originalDeliveries).toHaveLength(4);
    expect(originalDeliveries.every((delivery) => delivery.status === "responded")).toBe(true);
    expect(originalDeliveries.every((delivery) =>
      delivery.response?.action === "retry" && delivery.response.text === "Human says retry",
    )).toBe(true);
  });

  it("escalation originalTriggerId is the parent's deliveryId: resolves fireId + parent for session_complete", async () => {
    const original = await call(routes, "POST", "/api/events", {
      type: "lifecycle:session_complete",
      responseContract: { ttlMs: 1000 },
      fireId: "child-complete-1",
      source: { kind: "session", id: "child" },
      target: { sessionId: "owned" },
    });
    const originalJson = (await original!.json()) as any;
    const originalDeliveryId = originalJson.deliveries[0].deliveryId as string;

    const pub = await call(routes, "POST", "/api/events", {
      type: "lifecycle:escalation",
      payload: { reason: "parent escalated", originalTriggerId: originalDeliveryId },
      responseContract: { escalate: false },
      fireId: `escalate:${originalDeliveryId}`,
      source: { kind: "session", id: "child" },
      target: { sessionId: "owned" },
    });
    const { deliveries } = (await pub!.json()) as any;
    const res = await call(routes, "POST", `/api/deliveries/${deliveries[0].deliveryId}/response`, {
      response: "ack",
      action: "ack",
    });
    expect(res!.status).toBe(200);
    const relay = responses.find((r) => r.event === "trigger_response");
    // session_complete is handled by the PARENT (owned), correlated on the child's fireId.
    expect(relay!.sessionId).toBe("owned");
    expect(relay!.data.triggerId).toBe("child-complete-1");
    const originalDelivery = await store.getDelivery(originalDeliveryId);
    expect(originalDelivery?.status).toBe("responded");
  });

  it("feed is scoped to events the caller sourced or received", async () => {
    // Visible: published with a direct target into an owned session.
    const mine = await call(routes, "POST", "/api/events", {
      type: "scope:mine",
      target: { sessionId: "owned" },
    });
    const { eventId } = (await mine!.json()) as any;

    // Invisible: a foreign user's session event with its own delivery.
    const foreign = await store.insertEvent({
      type: "scope:foreign",
      source: { kind: "session", id: "stranger", auth: "cookie" },
      payload: { secret: "do-not-leak" },
    });
    await store.createDelivery({
      eventId: foreign.event.eventId,
      eventType: "scope:foreign",
      sessionId: "stranger",
      deliverAs: "steer",
    });

    // Invisible: no source ownership and no owned delivery.
    await store.insertEvent({
      type: "scope:mute",
      source: { kind: "service", id: "someone-else-service", auth: "socket" },
      payload: {},
    });

    const res = await call(routes, "GET", "/api/events");
    const json = (await res!.json()) as any;
    const types = json.events.map((e: any) => e.type);
    expect(types).toContain("scope:mine");
    expect(types).not.toContain("scope:foreign");
    expect(types).not.toContain("scope:mute");

    // Per-event deliveries stay scoped too.
    const dv = await call(routes, "GET", `/api/events/${eventId}/deliveries`);
    const own = ((await dv!.json()) as any).deliveries as Array<{ sessionId: string }>;
    expect(own.every((d) => d.sessionId === "owned")).toBe(true);
    const foreignDv = await call(routes, "GET", `/api/events/${foreign.event.eventId}/deliveries`);
    // No existence oracle: a foreign event 404s exactly like an unknown one.
    expect(foreignDv!.status).toBe(404);
  });
});

describe("dead-runner route cleanup", () => {
  let store: Awaited<typeof modsPromise>["store"];
  let routes: Awaited<typeof modsPromise>["routes"];
  let runnerOwner: Awaited<typeof modsPromise>["runnerOwner"];

  beforeAll(async () => {
    ({ store, routes, runnerOwner } = await modsPromise);
  });

  afterEach(async () => {
    mirrored.length = 0;
    deadRunners.clear();
    await memDb.deleteFrom("trigger_route").execute();
    await memDb.deleteFrom("runner_owner").execute();
  });

  /** Offline runner (no live data) owned durably by `owner`. */
  async function seedRunner(runnerId: string, owner: string) {
    await runnerOwner.rememberRunnerOwner(runnerId, owner);
  }

  it("GET /api/routes flags routes whose runner is dead", async () => {
    await seedRunner("runner-dead", "u1");
    const spawn = await store.createRoute({
      eventType: "hook:a", target: { kind: "spawn", spec: { runnerId: "runner-dead", ownerUserId: "u1" } },
      deliverAs: "steer", origin: "agent", ownerUserId: "u1",
    });
    const session = await store.createRoute({
      eventType: "time:cron", target: { kind: "session", sessionId: "gone", runnerId: "runner-dead" },
      deliverAs: "followUp", origin: "agent", ownerUserId: "u1",
    });
    const alive = await store.createRoute({
      eventType: "time:cron", target: { kind: "session", sessionId: "owned", runnerId: "runner-1" },
      deliverAs: "followUp", origin: "agent", ownerUserId: "u1",
    });
    deadRunners.set("runner-dead", "2026-08-01T00:00:00.000Z");

    const res = await call(routes, "GET", "/api/routes");
    const body = (await res!.json()) as { routes: Array<{ routeId: string; runnerDead?: boolean; runnerDeadSince?: string }> };
    const byId = new Map(body.routes.map((r) => [r.routeId, r]));
    expect(byId.get(spawn.routeId)).toMatchObject({ runnerDead: true, runnerDeadSince: "2026-08-01T00:00:00.000Z" });
    expect(byId.get(session.routeId)).toMatchObject({ runnerDead: true });
    expect(byId.get(alive.routeId)?.runnerDead).toBeUndefined();
  });

  it("DELETE /api/runners/:id/routes bulk-deletes stamped routes with unsubscribe deltas", async () => {
    await seedRunner("runner-dead", "u1");
    await store.createRoute({
      eventType: "hook:a", target: { kind: "spawn", spec: { runnerId: "runner-dead", ownerUserId: "u1" } },
      deliverAs: "steer", origin: "agent", ownerUserId: "u1",
    });
    const sched = await store.createRoute({
      eventType: "time:cron", target: { kind: "session", sessionId: "gone", runnerId: "runner-dead" },
      deliverAs: "followUp", origin: "agent", ownerUserId: "u1",
    });
    // Skipped: config (read-only) and webhook-owned routes on the same runner.
    await store.syncConfigRoutes([{
      eventType: "hook:cfg", target: { kind: "spawn", spec: { runnerId: "runner-dead" } }, deliverAs: "steer", origin: "config",
    }]);
    await store.createRoute({
      eventType: "hook:wh", target: { kind: "spawn", spec: { runnerId: "runner-dead", ownerUserId: "u1" } },
      deliverAs: "steer", origin: "ui", ownerUserId: "u1",
    }, { routeId: "rt_wh_1" });
    // Untouched: a different runner.
    const other = await store.createRoute({
      eventType: "time:cron", target: { kind: "session", sessionId: "owned", runnerId: "runner-1" },
      deliverAs: "followUp", origin: "agent", ownerUserId: "u1",
    });

    const res = await call(routes, "DELETE", "/api/runners/runner-dead/routes");
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true, removed: 2, skipped: 2 });
    await flush();

    const remaining = (await store.listRoutes()).map((r) => r.routeId).sort();
    expect(remaining).toContain(other.routeId);
    expect(remaining).toContain("rt_wh_1");
    expect(remaining.some((id) => id.startsWith("rt_cfg_"))).toBe(true);
    expect(remaining).toHaveLength(3);
    // Only session targets reconcile (spawn routes have no subscription entry).
    expect(mirrored).toEqual([
      expect.objectContaining({ action: "unsubscribe", routeId: sched.routeId, runnerId: "runner-dead", sessionId: "gone" }),
    ]);
  });

  it("DELETE /api/runners/:id/routes is owner-gated (404 shape) and allows ownerless runners", async () => {
    await seedRunner("runner-theirs", "u2");
    await store.createRoute({
      eventType: "hook:a", target: { kind: "spawn", spec: { runnerId: "runner-theirs", ownerUserId: "u2" } },
      deliverAs: "steer", origin: "agent", ownerUserId: "u2",
    });
    const denied = await call(routes, "DELETE", "/api/runners/runner-theirs/routes");
    expect(denied!.status).toBe(404);
    expect(await store.listRoutes()).toHaveLength(1);

    // Never registered since runner_owner landed → any authenticated user may clean up.
    await store.createRoute({
      eventType: "hook:b", target: { kind: "spawn", spec: { runnerId: "runner-orphan" } },
      deliverAs: "steer", origin: "agent", ownerUserId: "u1",
    });
    const ok = await call(routes, "DELETE", "/api/runners/runner-orphan/routes");
    expect(await ok!.json()).toEqual({ ok: true, removed: 1, skipped: 0 });
  });
});
