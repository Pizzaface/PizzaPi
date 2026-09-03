import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";

/**
 * Durable runner ownership: a spawn route for an OFFLINE runner (no Redis
 * state) must stay manageable by its owner. Regression: runner state lived
 * only in Redis (TTL'd, deleted on disconnect), so DELETE returned
 * "Route not found" for every migrated (ownerUserId-less) route.
 */

const memDb = new Kysely<any>({
  dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

const modsPromise = (async () => {
  mock.module("../auth.js", () => ({ getKysely: () => memDb }));
  mock.module("../middleware.js", () => ({
    requireSession: async () => ({ userId: "u1", userName: "tester" }),
    validateApiKey: async () => ({ userId: "u1", userName: "api-tester" }),
  }));
  mock.module("../events/runner-liveness.js", () => ({
    runnerDeadSince: async () => null,
    sweepDeadRunners: async () => 0,
  }));
  mock.module("../ws/sio-registry.js", () => ({
    // Transitive importers (child-lifecycle, transport) need these named
    // exports or the partial mock breaks the whole module graph.
    countSocketsInRoomCluster: async () => ({ kind: "unknown" }),
    getIo: () => undefined,
    runnerRoom: (id: string) => `runner:${id}`,
    getSharedSession: async () => null,
    emitToRunner: () => {},
    getLocalTuiSocket: () => null,
    emitToRelaySessionVerified: async () => false,
    emitToRelaySessionAcked: async () => false,
    broadcastToSessionViewers: () => {},
    getLocalRunnerSocket: () => null,
    linkSessionToRunner: async () => {},
    recordRunnerSession: async () => {},
    waitForLocalTuiSocket: async () => true,
  }));
  mock.module("../ws/runner-control.js", () => ({ waitForSpawnAck: async () => ({ ok: true }) }));
  // No live runner state at all — every runner is offline.
  mock.module("../ws/sio-registry/runners.js", () => ({ getRunnerData: async () => null }));
  mock.module("../sessions/trigger-store.js", () => ({ pushTriggerHistory: async () => {}, recordTriggerResponse: async () => {} }));
  mock.module("../push.js", () => ({ sendPushToUser: async () => {} }));
  mock.module("../ws/namespaces/runner.js", () => ({ emitTriggerSubscriptionDelta: async () => {} }));
  const store = await import("../events/store.js");
  const owner = await import("../../src/runner-owner.js");
  const routes = await import("./events.js");
  return { store, owner, routes };
})();

afterAll(() => mock.restore());

function call(routes: any, method: string, path: string, body?: unknown) {
  const url = new URL(`http://x${path}`);
  const req = new Request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return routes.handleEventsRoute(req, url);
}

describe("spawn route management with offline runner", () => {
  let store: Awaited<typeof modsPromise>["store"];
  let owner: Awaited<typeof modsPromise>["owner"];
  let routes: Awaited<typeof modsPromise>["routes"];

  beforeAll(async () => {
    ({ store, owner, routes } = await modsPromise);
    await store.ensureEventTables();
    await owner.ensureRunnerOwnerTable();
  });

  afterEach(async () => {
    await memDb.deleteFrom("trigger_route").execute();
    await memDb.deleteFrom("runner_owner").execute();
  });

  it("deletes an ownerUserId-less route while the runner is offline via the durable owner record", async () => {
    const route = await store.createRoute(
      {
        eventType: "github:pr_comment",
        target: { kind: "spawn", spec: { runnerId: "runner-offline" } },
        deliverAs: "followUp",
        origin: "api",
      },
      { routeId: "listener:migrated:1" },
    );

    await owner.rememberRunnerOwner("runner-offline", "u1");
    expect(await owner.getRunnerOwner("runner-offline")).toBe("u1");

    const res = await call(routes, "DELETE", `/api/routes/${route.routeId}`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(await store.getRoute(route.routeId)).toBeNull();
  });

  it("deletes a fully ownerless orphan route (no durable record, runner offline)", async () => {
    const route = await store.createRoute(
      {
        eventType: "github:pr_comment",
        target: { kind: "spawn", spec: { runnerId: "runner-never-registered" } },
        deliverAs: "followUp",
        origin: "api",
      },
      { routeId: "listener:orphan:1" },
    );
    const res = await call(routes, "DELETE", `/api/routes/${route.routeId}`);
    expect(res.status).toBe(200);
    expect(await store.getRoute(route.routeId)).toBeNull();
  });

  it("GET /api/routes only lists routes the caller can manage", async () => {
    await owner.rememberRunnerOwner("runner-mine", "u1");
    await owner.rememberRunnerOwner("runner-theirs", "someone-else");
    const mine = await store.createRoute(
      { eventType: "a:b", target: { kind: "spawn", spec: { runnerId: "runner-mine" } }, deliverAs: "followUp", origin: "api" },
      { routeId: "r-mine" },
    );
    await store.createRoute(
      { eventType: "a:b", target: { kind: "spawn", spec: { runnerId: "runner-theirs" } }, deliverAs: "followUp", origin: "api" },
      { routeId: "r-theirs" },
    );
    const orphan = await store.createRoute(
      { eventType: "a:b", target: { kind: "spawn", spec: { runnerId: "runner-ghost" } }, deliverAs: "followUp", origin: "api" },
      { routeId: "r-orphan" },
    );
    const res = await call(routes, "GET", "/api/routes");
    expect(res.status).toBe(200);
    const ids = ((await res.json()).routes as Array<{ routeId: string }>).map((r) => r.routeId).sort();
    expect(ids).toEqual([mine.routeId, orphan.routeId].sort());
  });

  it("another user still cannot manage an offline runner's routes", async () => {
    await owner.rememberRunnerOwner("runner-other", "someone-else");
    const route = await store.createRoute(
      {
        eventType: "github:push",
        target: { kind: "spawn", spec: { runnerId: "runner-other" } },
        deliverAs: "followUp",
        origin: "api",
      },
      { routeId: "listener:migrated:2" },
    );
    const res = await call(routes, "DELETE", `/api/routes/${route.routeId}`);
    expect(res.status).toBe(404);
  });

  it("rememberRunnerOwner upserts and skips empty users", async () => {
    await owner.rememberRunnerOwner("r-x", "u1");
    await owner.rememberRunnerOwner("r-x", "u2");
    expect(await owner.getRunnerOwner("r-x")).toBe("u2");
    await owner.rememberRunnerOwner("r-x", null);
    expect(await owner.getRunnerOwner("r-x")).toBe("u2");
    await owner.rememberRunnerOwner("r-never", null);
    expect(await owner.getRunnerOwner("r-never")).toBeNull();
  });
});