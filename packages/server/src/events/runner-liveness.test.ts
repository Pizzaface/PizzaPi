// sweepDeadRunners: 7-day-stale runner_owner rows with a confirmed-empty
// cluster room expire their pending wake deliveries and get a Redis marker;
// live or inconclusive runners are left alone.
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";

const memDb = new Kysely<any>({ dialect: new BunSqliteDialect({ database: new Database(":memory:") }) });

let presence: Record<string, { kind: "count"; count: number } | { kind: "unknown" }> = {};
const markers = new Map<string, string>();

const modsPromise = (async () => {
  mock.module("../auth.js", () => ({ getKysely: () => memDb }));
  mock.module("../ws/sio-registry.js", () => ({
    getIo: () => ({ of: () => ({}) }),
    runnerRoom: (id: string) => id,
    countSocketsInRoomCluster: async (_nsp: unknown, room: string) => presence[room] ?? { kind: "unknown" },
  }));
  mock.module("./redis.js", () => ({
    getEventsRedis: async () => ({
      isOpen: true,
      get: async (k: string) => markers.get(k) ?? null,
      set: async (k: string, v: string) => { markers.set(k, v); return "OK"; },
    }),
  }));
  const store = await import("./store.js");
  const owner = await import("../runner-owner.js");
  const liveness = await import("./runner-liveness.js");
  return { store, owner, liveness };
})();

afterAll(() => mock.restore());

describe("dead-runner sweep", () => {
  let m: Awaited<typeof modsPromise>;
  beforeAll(async () => {
    m = await modsPromise;
    await m.store.ensureEventTables();
    await m.owner.ensureRunnerOwnerTable();
  });
  afterEach(async () => {
    presence = {};
    markers.clear();
    for (const t of ["trigger_delivery", "trigger_event", "trigger_route", "runner_owner"]) await memDb.deleteFrom(t).execute();
  });

  const source = { kind: "api" as const, id: "sched", auth: "api-key" as const, userId: "u1" };
  const STALE = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();

  async function pendingWake(sessionId: string): Promise<string> {
    const { event } = await m.store.insertEvent({ type: "time:cron", source, payload: {} });
    const d = await m.store.createDelivery({ eventId: event.eventId, eventType: "time:cron", sessionId, deliverAs: "followUp" });
    await m.store.updateDelivery(d!.deliveryId, { wakeRequested: true, lastWakeAttemptAt: STALE });
    return d!.deliveryId;
  }

  it("expires pending wake deliveries of a dead runner, sets the marker, keeps routes", async () => {
    await m.owner.rememberRunnerOwner("r-dead", "u1");
    await memDb.updateTable("runner_owner").set({ lastSeenAt: STALE }).where("runnerId", "=", "r-dead").execute();
    const route = await m.store.createRoute({
      eventType: "time:cron", target: { kind: "session", sessionId: "s-dead", runnerId: "r-dead" },
      deliverAs: "followUp", origin: "agent", ownerUserId: "u1",
    });
    const dead = await pendingWake("s-dead");
    const unrelated = await pendingWake("s-elsewhere");
    presence["r-dead"] = { kind: "count", count: 0 };

    expect(await m.liveness.sweepDeadRunners()).toBe(1);
    expect((await m.store.getDelivery(dead))?.status).toBe("expired");
    expect((await m.store.getDelivery(unrelated))?.status).toBe("pending");
    expect(await m.store.getRoute(route.routeId)).not.toBeNull(); // schedules survive
    expect(markers.get("pizzapi:runner:dead:r-dead")).toBe(STALE);
    expect(await m.liveness.runnerDeadSince("r-dead")).toBe(STALE);
  });

  it("leaves fresh, live, or presence-unknown runners alone", async () => {
    await m.owner.rememberRunnerOwner("r-fresh", "u1"); // lastSeenAt = now
    await m.owner.rememberRunnerOwner("r-live", "u1");
    await m.owner.rememberRunnerOwner("r-blip", "u1");
    await memDb.updateTable("runner_owner").set({ lastSeenAt: STALE }).where("runnerId", "in", ["r-live", "r-blip"]).execute();
    presence["r-fresh"] = { kind: "count", count: 0 };
    presence["r-live"] = { kind: "count", count: 1 };
    // r-blip: unknown → assume alive

    expect(await m.liveness.sweepDeadRunners()).toBe(0);
    expect(markers.size).toBe(0);
  });

  it("a marked runner that came back is no longer reported dead", async () => {
    markers.set("pizzapi:runner:dead:r-back", STALE);
    presence["r-back"] = { kind: "count", count: 1 };
    expect(await m.liveness.runnerDeadSince("r-back")).toBeNull();
  });
});
