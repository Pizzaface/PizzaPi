import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { SourceIdentity } from "@pizzapi/protocol";

const memDb = new Kysely<any>({
  dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

const storePromise = (async () => {
  mock.module("../auth.js", () => ({ getKysely: () => memDb }));
  return await import("./store.js");
})();

afterAll(() => mock.restore());

const source: SourceIdentity = { kind: "api", id: "test", auth: "api-key", userId: "u1" };

function eventInput(type = "test:fired", payload: Record<string, any> = { n: 1 }) {
  return { type, source, payload };
}

describe("event store", () => {
  let store: Awaited<typeof storePromise>;

  beforeAll(async () => {
    store = await storePromise;
    await store.ensureEventTables();
  });

  afterEach(async () => {
    await memDb.deleteFrom("trigger_delivery").execute();
    await memDb.deleteFrom("trigger_route").execute();
    await memDb.deleteFrom("trigger_event").execute();
  });

  it("publishes and reads back an event", async () => {
    const { event, created } = await store.insertEvent(eventInput());
    expect(created).toBe(true);
    expect(event.eventId).toStartWith("evt_");
    const loaded = await store.getEvent(event.eventId);
    expect(loaded?.payload).toEqual({ n: 1 });
  });

  it("fireId dedup returns the original event", async () => {
    const first = await store.insertEvent(eventInput(), "fire-1");
    const second = await store.insertEvent(eventInput("test:fired", { n: 2 }), "fire-1");
    expect(second.created).toBe(false);
    expect(second.event.eventId).toBe(first.event.eventId);
    expect(second.event.payload).toEqual({ n: 1 });
  });

  it("lists events newest-first with type filter", async () => {
    await store.insertEvent(eventInput("a:one"));
    await store.insertEvent(eventInput("b:two"));
    const all = await store.listEvents();
    expect(all.length).toBe(2);
    const filtered = await store.listEvents({ type: "a:one" });
    expect(filtered.map((e) => e.type)).toEqual(["a:one"]);
  });

  it("clamps event and delivery limits to at least one", async () => {
    const first = await store.insertEvent(eventInput("test:first"));
    const second = await store.insertEvent(eventInput("test:second"));
    await store.createDelivery({
      eventId: first.event.eventId,
      eventType: first.event.type,
      sessionId: "s1",
      deliverAs: "steer",
    });
    await store.createDelivery({
      eventId: second.event.eventId,
      eventType: second.event.type,
      sessionId: "s1",
      deliverAs: "steer",
    });

    expect(await store.listEvents({ limit: -10 })).toHaveLength(1);
    expect(await store.listEvents({ limit: 0 })).toHaveLength(1);
    expect(await store.listDeliveries({ sessionId: "s1", limit: -10 })).toHaveLength(1);
    expect(await store.listDeliveries({ sessionId: "s1", limit: 0 })).toHaveLength(1);
  });

  it("prunes old events and their deliveries", async () => {
    const { event } = await store.insertEvent(eventInput());
    await store.createDelivery({ eventId: event.eventId, eventType: event.type, sessionId: "s1", deliverAs: "followUp" });
    // Backdate the event past retention
    await memDb.updateTable("trigger_event").set({ createdAt: "2000-01-01T00:00:00Z" }).execute();
    const pruned = await store.pruneEvents(30);
    expect(pruned).toBe(1);
    expect(await store.getEvent(event.eventId)).toBeNull();
    expect(await store.listDeliveries({ sessionId: "s1" })).toHaveLength(0);
  });

  it("routes: create/update/delete; config routes are read-only", async () => {
    const route = await store.createRoute({
      eventType: "test:fired",
      target: { kind: "session", sessionId: "s1" },
      deliverAs: "steer",
      origin: "agent",
    });
    const updated = await store.updateRoute(route.routeId, { deliverAs: "followUp" });
    expect(updated?.deliverAs).toBe("followUp");
    expect(await store.deleteRoute(route.routeId)).toBe(true);

    await store.syncConfigRoutes([
      { eventType: "cfg:evt", target: { kind: "session", sessionId: "s2" }, deliverAs: "steer", origin: "config" },
    ]);
    const [cfg] = await store.listRoutes({ eventType: "cfg:evt" });
    expect(cfg.origin).toBe("config");
    expect(store.updateRoute(cfg.routeId, { deliverAs: "followUp" })).rejects.toThrow(/read-only/);
    expect(store.deleteRoute(cfg.routeId)).rejects.toThrow(/read-only/);

    // Re-sync with empty desired set removes config routes
    await store.syncConfigRoutes([]);
    expect(await store.listRoutes({ eventType: "cfg:evt" })).toHaveLength(0);
  });

  it("deletes only non-durable session routes when preserving durable routes", async () => {
    const removed = await store.createRoute({
      eventType: "github:comment",
      target: { kind: "session", sessionId: "s1", runnerId: "r1" },
      deliverAs: "steer",
      origin: "agent",
    });
    const durable = await store.createRoute({
      eventType: "time:cron",
      target: { kind: "session", sessionId: "s1", runnerId: "r1" },
      deliverAs: "followUp",
      origin: "agent",
    });
    const otherSession = await store.createRoute({
      eventType: "github:comment",
      target: { kind: "session", sessionId: "s2", runnerId: "r1" },
      deliverAs: "steer",
      origin: "agent",
    });
    await store.createRoute({
      eventType: "github:comment",
      target: { kind: "spawn", spec: { runnerId: "r1" } },
      deliverAs: "steer",
      origin: "agent",
    });

    const deleted = await store.deleteSessionRoutes("s1", { preserveDurable: true });
    expect(deleted.map((route) => route.routeId)).toEqual([removed.routeId]);
    const remaining = await store.listRoutes();
    expect(remaining.map((route) => route.routeId)).toContain(durable.routeId);
    expect(remaining.map((route) => route.routeId)).toContain(otherSession.routeId);
    expect(remaining).toHaveLength(3);
  });

  it("deliveries are exactly-once per (event, session)", async () => {
    const { event } = await store.insertEvent(eventInput());
    const d1 = await store.createDelivery({ eventId: event.eventId, eventType: event.type, sessionId: "s1", deliverAs: "steer" });
    const d2 = await store.createDelivery({ eventId: event.eventId, eventType: event.type, sessionId: "s1", deliverAs: "steer" });
    expect(d1).not.toBeNull();
    expect(d2).toBeNull();
    const other = await store.createDelivery({ eventId: event.eventId, eventType: event.type, sessionId: "s2", deliverAs: "steer" });
    expect(other).not.toBeNull();
  });

  it("pending deliveries drain FIFO by event time", async () => {
    const a = await store.insertEvent(eventInput("t:a"));
    await memDb.updateTable("trigger_event").set({ createdAt: "2020-01-01T00:00:00Z" }).where("id", "=", a.event.eventId).execute();
    const b = await store.insertEvent(eventInput("t:b"));
    await store.createDelivery({ eventId: b.event.eventId, eventType: "t:b", sessionId: "s1", deliverAs: "followUp" });
    await store.createDelivery({ eventId: a.event.eventId, eventType: "t:a", sessionId: "s1", deliverAs: "followUp" });
    const pending = await store.pendingDeliveriesFor("s1");
    expect(pending.map((d) => d.eventType)).toEqual(["t:a", "t:b"]);
  });

  it("expires only older pending deliveries for the same session and event type", async () => {
    const olderEvent = await store.insertEvent(eventInput("time:cron", { n: 1 }));
    const older = await store.createDelivery({
      eventId: olderEvent.event.eventId,
      eventType: olderEvent.event.type,
      sessionId: "s1",
      deliverAs: "followUp",
    });
    const otherTypeEvent = await store.insertEvent(eventInput("time:interval", { n: 2 }));
    const otherType = await store.createDelivery({
      eventId: otherTypeEvent.event.eventId,
      eventType: otherTypeEvent.event.type,
      sessionId: "s1",
      deliverAs: "followUp",
    });
    const newerEvent = await store.insertEvent(eventInput("time:cron", { n: 3 }));
    const newer = await store.createDelivery({
      eventId: newerEvent.event.eventId,
      eventType: newerEvent.event.type,
      sessionId: "s1",
      deliverAs: "followUp",
    });

    expect(await store.expirePendingDeliveries({
      sessionId: "s1",
      eventType: "time:cron",
      exceptDeliveryId: newer!.deliveryId,
    })).toBe(1);
    expect((await store.getDelivery(older!.deliveryId))?.status).toBe("expired");
    expect((await store.getDelivery(newer!.deliveryId))?.status).toBe("pending");
    expect((await store.getDelivery(otherType!.deliveryId))?.status).toBe("pending");
    // An older publisher finishing late cannot expire a newer row.
    expect(await store.expirePendingDeliveries({
      sessionId: "s1",
      eventType: "time:cron",
      exceptDeliveryId: older!.deliveryId,
    })).toBe(0);
    expect((await store.getDelivery(newer!.deliveryId))?.status).toBe("pending");
  });

  it("delivery lifecycle updates and TTL expiry sweep", async () => {
    const { event } = await store.insertEvent(eventInput());
    const d = await store.createDelivery({
      eventId: event.eventId,
      eventType: event.type,
      sessionId: "s1",
      deliverAs: "steer",
      expiresAt: "2000-01-01T00:00:00Z",
    });
    const expired = await store.expiredContractDeliveries();
    expect(expired.map((x) => x.deliveryId)).toEqual([d!.deliveryId]);

    const responded = await store.updateDelivery(d!.deliveryId, {
      status: "responded",
      response: { action: "approve" },
      respondedAt: new Date().toISOString(),
    });
    expect(responded?.status).toBe("responded");
    // Responded deliveries no longer show up in the expiry sweep
    expect(await store.expiredContractDeliveries()).toHaveLength(0);
  });

  it("updateDelivery guard skips transitions outside the allowed statuses", async () => {
    const { event } = await store.insertEvent(eventInput());
    const d = await store.createDelivery({
      eventId: event.eventId,
      eventType: event.type,
      sessionId: "s1",
      deliverAs: "steer",
    });
    // Sweep-style escalation must not clobber a responded row.
    await store.updateDelivery(d!.deliveryId, { status: "responded" });
    const lost = await store.updateDelivery(
      d!.deliveryId,
      { status: "escalated" },
      { guard: ["pending", "delivered"] },
    );
    expect(lost).toBeNull();
    const [after] = await store.listDeliveries({ sessionId: "s1" });
    expect(after.status).toBe("responded");
    // Guarded transitions within the allowed set still win.
    const p2 = await store.createDelivery({ eventId: event.eventId, eventType: event.type, sessionId: "s2", deliverAs: "steer" });
    const won = await store.updateDelivery(
      p2!.deliveryId,
      { status: "escalated" },
      { guard: ["pending", "delivered", "expired", "escalated"] },
    );
    expect(won?.status).toBe("escalated");
  });

  it("expiredContractDeliveries reads the indexed expiresAt column (backfill + sync)", async () => {
    const { event } = await store.insertEvent(eventInput());
    const lapsed = await store.createDelivery({
      eventId: event.eventId,
      eventType: event.type,
      sessionId: "s1",
      deliverAs: "steer",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const future = await store.createDelivery({
      eventId: event.eventId,
      eventType: event.type,
      sessionId: "s2",
      deliverAs: "steer",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const expired = await store.expiredContractDeliveries();
    expect(expired.map((x) => x.deliveryId)).toEqual([lapsed!.deliveryId]);
    // Column-backed expiry is queryable directly (the sweep's SQL predicate).
    const rows = await memDb
      .selectFrom("trigger_delivery")
      .select(["id", "expiresAt"])
      .where("expiresAt", "is not", null)
      .execute();
    expect(rows.map((r) => r.id).sort()).toEqual([future!.deliveryId, lapsed!.deliveryId].sort());
  });
  it("inflightDeliveries returns only rows past the cutoff", async () => {
    const { event } = await store.insertEvent(eventInput());
    const d = await store.createDelivery({ eventId: event.eventId, eventType: event.type, sessionId: "s1", deliverAs: "steer" });
    await store.updateDelivery(d!.deliveryId, { status: "inflight" }, { guard: ["pending"] });

    // Fresh inflight row: not swept yet.
    expect(await store.inflightDeliveries(new Date(Date.now() - 60_000).toISOString())).toHaveLength(0);
    expect(await store.inflightDeliveries(new Date(Date.now() + 60_000).toISOString())).toHaveLength(1);

    // Age it: now it is stale.
    await memDb.updateTable("trigger_delivery").set({ updatedAt: new Date(Date.now() - 120_000).toISOString() }).where("id", "=", d!.deliveryId).execute();
    const stale = await store.inflightDeliveries(new Date(Date.now() - 60_000).toISOString());
    expect(stale.map((x) => x.deliveryId)).toEqual([d!.deliveryId]);
    expect(stale[0].status).toBe("inflight");
  });

  it("responseRelayPending marker round-trips through updateDelivery", async () => {
    const { event } = await store.insertEvent(eventInput());
    const d = await store.createDelivery({ eventId: event.eventId, eventType: event.type, sessionId: "s1", deliverAs: "steer" });
    await store.updateDelivery(d!.deliveryId, {
      status: "responded",
      respondedAt: new Date().toISOString(),
      response: { text: "ok" },
      responseRelayPending: true,
    }, { guard: ["pending"] });
    expect((await store.getDelivery(d!.deliveryId))?.responseRelayPending).toBe(true);

    // Clearing the marker drops it from the JSON entirely.
    await store.updateDelivery(d!.deliveryId, { responseRelayPending: undefined });
    const cleared = await store.getDelivery(d!.deliveryId);
    expect(cleared?.responseRelayPending).toBeUndefined();
    expect(JSON.parse(JSON.stringify(cleared)).responseRelayPending).toBeUndefined();
  });

  it("pendingResponseRelaysFor matches only the source session's marked deliveries", async () => {
    const sessionSource = { kind: "session" as const, id: "child-1", auth: "socket" as const, userId: "u1" };
    const { event } = await store.insertEvent({ type: "t:ask", source: sessionSource, payload: {} });
    const d = await store.createDelivery({ eventId: event.eventId, eventType: event.type, sessionId: "parent-1", deliverAs: "steer" });
    await store.updateDelivery(d!.deliveryId, {
      status: "responded",
      respondedAt: new Date().toISOString(),
      response: { text: "ok" },
      responseRelayPending: true,
    }, { guard: ["pending"] });

    // A responded-but-relayed-ok delivery must not drain again.
    const { event: e2 } = await store.insertEvent({ type: "t:ask", source: sessionSource, payload: {} });
    const d2 = await store.createDelivery({ eventId: e2.eventId, eventType: e2.type, sessionId: "parent-1", deliverAs: "steer" });
    await store.updateDelivery(d2!.deliveryId, { status: "responded", respondedAt: new Date().toISOString(), response: { text: "ok" } }, { guard: ["pending"] });

    // Non-session sources never match.
    const { event: e3 } = await store.insertEvent(eventInput("t:api"));
    const d3 = await store.createDelivery({ eventId: e3.eventId, eventType: e3.type, sessionId: "parent-1", deliverAs: "steer" });
    await store.updateDelivery(d3!.deliveryId, { status: "responded", respondedAt: new Date().toISOString(), response: { text: "ok" }, responseRelayPending: true }, { guard: ["pending"] });

    const rows = await store.pendingResponseRelaysFor("child-1");
    expect(rows.map((x) => x.deliveryId)).toEqual([d!.deliveryId]);
    expect(await store.pendingResponseRelaysFor("parent-1")).toHaveLength(0);
  });

  it("expirePendingDeliveries also supersedes inflight rows", async () => {
    const { event: e1 } = await store.insertEvent(eventInput("time:cron"));
    const { event: e2 } = await store.insertEvent(eventInput("time:cron"));
    const older = await store.createDelivery({ eventId: e1.eventId, eventType: e1.type, sessionId: "s1", deliverAs: "followUp" });
    const newer = await store.createDelivery({ eventId: e2.eventId, eventType: e2.type, sessionId: "s1", deliverAs: "followUp" });
    // The older row is mid-ack-wait (inflight) when the newer wake fires.
    await store.updateDelivery(older!.deliveryId, { status: "inflight" }, { guard: ["pending"] });
    expect(await store.expirePendingDeliveries({ sessionId: "s1", eventType: "time:cron", exceptDeliveryId: newer!.deliveryId })).toBe(1);
    expect((await store.getDelivery(older!.deliveryId))?.status).toBe("expired");
  });

  it("expiredContractDeliveries includes inflight rows", async () => {
    const { event } = await store.insertEvent(eventInput());
    const d = await store.createDelivery({ eventId: event.eventId, eventType: event.type, sessionId: "s1", deliverAs: "steer", expiresAt: "2000-01-01T00:00:00Z" });
    await store.updateDelivery(d!.deliveryId, { status: "inflight" }, { guard: ["pending"] });
    expect((await store.expiredContractDeliveries()).map((x) => x.deliveryId)).toEqual([d!.deliveryId]);
  });
});

describe("event store tenant scope", () => {
  let store: Awaited<typeof storePromise>;
  beforeAll(async () => {
    store = await storePromise;
    await store.ensureEventTables();
  });
  afterEach(async () => {
    await memDb.deleteFrom("trigger_route").execute();
    await memDb.deleteFrom("trigger_event").execute();
  });

  it("ownerless publishes never dedup (NULL owner rows are distinct)", async () => {
    const a = await store.insertEvent({ type: "t:x", source: { kind: "api", id: "x", auth: "api-key" }, payload: {} }, "k");
    const b = await store.insertEvent({ type: "t:x", source: { kind: "api", id: "x", auth: "api-key" }, payload: {} }, "k");
    expect(a.created && b.created).toBe(true);
  });

  it("listRoutes filters by ownerUserId; ownerless backfill helpers round-trip", async () => {
    const mine = await store.createRoute({ eventType: "t:x", target: { kind: "session", sessionId: "s" }, deliverAs: "steer", origin: "ui", ownerUserId: "me" });
    const legacy = await store.createRoute({ eventType: "t:x", target: { kind: "session", sessionId: "s2" }, deliverAs: "steer", origin: "agent" });
    expect((await store.listRoutes({ ownerUserId: "me" })).map((r) => r.routeId)).toEqual([mine.routeId]);
    expect((await store.listOwnerlessRoutes()).map((r) => r.routeId)).toEqual([legacy.routeId]);
    await store.setRouteOwner(legacy.routeId, "me");
    expect((await store.listOwnerlessRoutes())).toHaveLength(0);
    expect((await store.getRoute(legacy.routeId))?.ownerUserId).toBe("me");
    const col = await memDb.selectFrom("trigger_route").select("ownerUserId").where("id", "=", legacy.routeId).executeTakeFirst();
    expect(col?.ownerUserId).toBe("me");
  });
});

describe("transactional publish (insertEventWithPlan)", () => {
  let store: Awaited<typeof storePromise>;
  beforeAll(async () => {
    store = await storePromise;
    await store.ensureEventTables();
  });
  afterEach(async () => {
    await memDb.deleteFrom("trigger_delivery").execute();
    await memDb.deleteFrom("trigger_route").execute();
    await memDb.deleteFrom("trigger_event").execute();
  });

  it("inserts the event and ALL planned delivery rows in one call", async () => {
    const { event, created, deliveries } = await store.insertEventWithPlan(eventInput(), "fire-tx-1", [
      { sessionId: "s1", deliverAs: "steer" },
      { sessionId: "s2", deliverAs: "followUp", routeId: "rt_1" },
      { sessionId: "", spawnRouteId: "rt_spawn", deliverAs: "steer" },
    ]);
    expect(created).toBe(true);
    // All rows are durable the moment the call resolves — a crash between the
    // event insert and the delivery inserts is impossible (single tx).
    expect((await store.getEvent(event.eventId))?.eventId).toBe(event.eventId);
    expect(deliveries).toHaveLength(3);
    expect(deliveries.every((d) => d.status === "pending")).toBe(true);
    // Spawn intent rows carry the placeholder + spawnRouteId.
    const intent = deliveries.find((d) => d.spawnRouteId);
    expect(intent?.sessionId).toBe(`spawn:rt_spawn:${event.eventId}`);
    expect(intent?.routeId).toBeUndefined();
    // Regular rows keep their real session ids.
    expect(deliveries.filter((d) => !d.spawnRouteId).map((d) => d.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("rolls back the event when a delivery insert fails mid-transaction", async () => {
    const before = await memDb.selectFrom("trigger_event").select("id").execute();
    // A plan row that violates the NOT NULL sessionId column mid-tx —
    // simulates a crash between the event insert and the delivery inserts.
    let threw = false;
    try {
      await store.insertEventWithPlan(eventInput(), "fire-tx-2", [
        { sessionId: "s1", deliverAs: "steer" },
        { sessionId: null as any, deliverAs: "steer" },
      ]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Nothing persisted: no claimed fireId, no orphaned deliveries. A retry
    // with the same fireId plans from scratch instead of deduping to nothing.
    const after = await memDb.selectFrom("trigger_event").select("id").execute();
    expect(after).toHaveLength(before.length);
    const rows = await memDb.selectFrom("trigger_delivery").select("id").execute();
    expect(rows).toHaveLength(0);
    const retry = await store.insertEventWithPlan(eventInput(), "fire-tx-2", [{ sessionId: "s1", deliverAs: "steer" }]);
    expect(retry.created).toBe(true);
  });

  it("duplicate fireId returns the original event WITH its existing delivery rows", async () => {
    const first = await store.insertEventWithPlan(eventInput(), "fire-tx-3", [
      { sessionId: "s1", deliverAs: "steer" },
      { sessionId: "", spawnRouteId: "rt_spawn", deliverAs: "steer" },
    ]);
    const second = await store.insertEventWithPlan(eventInput("test:other"), "fire-tx-3", []);
    expect(second.created).toBe(false);
    expect(second.event.eventId).toBe(first.event.eventId);
    expect(second.deliveries.map((d) => d.deliveryId).sort()).toEqual(first.deliveries.map((d) => d.deliveryId).sort());
  });

  it("exactly-once: duplicate sessionIds in one plan collapse to one row", async () => {
    const { deliveries } = await store.insertEventWithPlan(eventInput(), "fire-tx-4", [
      { sessionId: "s1", deliverAs: "steer" },
      { sessionId: "s1", deliverAs: "followUp" },
    ]);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].deliverAs).toBe("steer");
  });

  it("updateDelivery moves a spawn intent onto the real sessionId (column + JSON)", async () => {
    const { event, deliveries } = await store.insertEventWithPlan(eventInput(), "fire-tx-5", [
      { sessionId: "", spawnRouteId: "rt_spawn", deliverAs: "steer" },
    ]);
    const intent = deliveries[0];
    const resolved = await store.updateDelivery(
      intent.deliveryId,
      { sessionId: "spawned-real", spawnRouteId: undefined },
      { guard: ["pending"] },
    );
    expect(resolved?.sessionId).toBe("spawned-real");
    expect(resolved?.spawnRouteId).toBeUndefined();
    // The exposed sessionId column moved too — drain queries find the row.
    expect(await store.pendingDeliveriesFor("spawned-real")).toHaveLength(1);
    expect(await store.pendingDeliveriesFor(intent.sessionId)).toHaveLength(0);
    expect(resolved?.eventId).toBe(event.eventId);
  });

  it("deleteDelivery removes a row (dropped spawn intents)", async () => {
    const { deliveries } = await store.insertEventWithPlan(eventInput(), "fire-tx-6", [
      { sessionId: "s1", deliverAs: "steer" },
    ]);
    expect(await store.deleteDelivery(deliveries[0].deliveryId)).toBe(true);
    expect(await store.getDelivery(deliveries[0].deliveryId)).toBeNull();
    expect(await store.deleteDelivery(deliveries[0].deliveryId)).toBe(false);
  });
});

describe("per-source FIFO (seq)", () => {
  let store: Awaited<typeof storePromise>;
  beforeAll(async () => {
    store = await storePromise;
    await store.ensureEventTables();
  });
  afterEach(async () => {
    await memDb.deleteFrom("trigger_delivery").execute();
    await memDb.deleteFrom("trigger_event").execute();
  });

  function seqOf(eventId: string): Promise<number | null> {
    return memDb
      .selectFrom("trigger_event")
      .select("seq")
      .where("id", "=", eventId)
      .executeTakeFirst()
      .then((r: any) => r?.seq ?? null);
  }

  it("assigns monotonically increasing seq per source (interleaved sources are independent)", async () => {
    const srcA = { kind: "session" as const, id: "src-a", auth: "socket" as const, userId: "u1" };
    const srcB = { kind: "session" as const, id: "src-b", auth: "socket" as const, userId: "u1" };
    const a1 = await store.insertEventWithPlan({ type: "t:x", source: srcA, payload: {} }, undefined, []);
    const b1 = await store.insertEventWithPlan({ type: "t:x", source: srcB, payload: {} }, undefined, []);
    const a2 = await store.insertEventWithPlan({ type: "t:x", source: srcA, payload: {} }, undefined, []);
    const b2 = await store.insertEventWithPlan({ type: "t:x", source: srcB, payload: {} }, undefined, []);

    expect(await seqOf(a1.event.eventId)).toBe(1);
    expect(await seqOf(b1.event.eventId)).toBe(1);
    expect(await seqOf(a2.event.eventId)).toBe(2);
    expect(await seqOf(b2.event.eventId)).toBe(2);
  });

  it("pendingDeliveriesFor orders by (event seq, createdAt, deliveryId)", async () => {
    // Craft seq values directly to pin the ordering contract, independent of
    // which source fired when.
    const src = { kind: "session" as const, id: "src-a", auth: "socket" as const, userId: "u1" };
    const e1 = await store.insertEventWithPlan({ type: "t:x", source: src, payload: { n: 1 } }, undefined, [{ sessionId: "s", deliverAs: "steer" }]);
    const e2 = await store.insertEventWithPlan({ type: "t:x", source: src, payload: { n: 2 } }, undefined, [{ sessionId: "s", deliverAs: "steer" }]);
    const e3 = await store.insertEventWithPlan({ type: "t:x", source: src, payload: { n: 3 } }, undefined, [{ sessionId: "s", deliverAs: "steer" }]);
    // Invert the natural order: seq 3, 1, 2.
    await memDb.updateTable("trigger_event").set({ seq: 30 }).where("id", "=", e1.event.eventId).execute();
    await memDb.updateTable("trigger_event").set({ seq: 10 }).where("id", "=", e2.event.eventId).execute();
    await memDb.updateTable("trigger_event").set({ seq: 20 }).where("id", "=", e3.event.eventId).execute();

    const pending = await store.pendingDeliveriesFor("s");
    expect(pending.map((d) => JSON.parse(JSON.stringify(d)).eventId)).toEqual([
      e2.event.eventId,
      e3.event.eventId,
      e1.event.eventId,
    ]);
  });

  it("backfills pre-upgrade rows (NULL seq) from rowid so old events drain first", async () => {
    const src = { kind: "session" as const, id: "src-old", auth: "socket" as const, userId: "u1" };
    const old = await store.insertEventWithPlan({ type: "t:x", source: src, payload: {} }, undefined, [{ sessionId: "s", deliverAs: "steer" }]);
    // Simulate a pre-upgrade row: strip its seq.
    await memDb.updateTable("trigger_event").set({ seq: null }).where("id", "=", old.event.eventId).execute();
    const fresh = await store.insertEventWithPlan({ type: "t:x", source: src, payload: {} }, undefined, [{ sessionId: "s", deliverAs: "steer" }]);

    // NULL seq sorts first in SQLite ASC — the pre-upgrade event drains first.
    const pending = await store.pendingDeliveriesFor("s");
    expect(pending.map((d) => d.eventId)).toEqual([old.event.eventId, fresh.event.eventId]);
  });
});

describe("storage integrity (FK cascade, tx prune/sync)", () => {
  let store: Awaited<typeof storePromise>;
  beforeAll(async () => {
    store = await storePromise;
    // Fresh :memory: database at module scope → ensureEventTables creates
    // trigger_delivery WITH the FK cascade (new-database schema).
    await store.ensureEventTables();
    // PRAGMA foreign_keys is per-connection and OFF by default; the server
    // turns it on in applySqlitePerfPragmas. Enable it here the same way.
    await memDb.executeQuery(sql`PRAGMA foreign_keys = ON`.compile(memDb));
  });
  afterAll(async () => {
    await memDb.executeQuery(sql`PRAGMA foreign_keys = OFF`.compile(memDb));
  });
  afterEach(async () => {
    await memDb.deleteFrom("trigger_delivery").execute();
    await memDb.deleteFrom("trigger_event").execute();
  });

  it("new databases: deleting an event cascades its deliveries (FK ON)", async () => {
    const { event } = await store.insertEventWithPlan(eventInput(), "fk-1", [
      { sessionId: "s1", deliverAs: "steer" },
    ]);
    expect(await store.listDeliveries({ sessionId: "s1" })).toHaveLength(1);
    // Direct event delete (not pruneEvents) — the FK does the cleanup.
    await memDb.deleteFrom("trigger_event").where("id", "=", event.eventId).execute();
    expect(await store.getEvent(event.eventId)).toBeNull();
    expect(await store.listDeliveries({ sessionId: "s1" })).toHaveLength(0);
  });

  it("deliveries cannot reference a missing event on new databases (FK ON)", async () => {
    let rejected = false;
    try {
      await memDb
        .insertInto("trigger_delivery")
        .values({
          id: "dlv_ghost",
          eventId: "evt_missing",
          sessionId: "s1",
          status: "pending",
          deliveryJson: "{}",
          updatedAt: new Date().toISOString(),
        })
        .execute();
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it("pruneEvents removes old events and their deliveries in one transaction", async () => {
    const old = await store.insertEventWithPlan(eventInput("t:old"), "fk-2", [
      { sessionId: "s-old", deliverAs: "steer" },
    ]);
    await store.insertEventWithPlan(eventInput("t:fresh"), "fk-3", [
      { sessionId: "s-fresh", deliverAs: "steer" },
    ]);
    await memDb.updateTable("trigger_event").set({ createdAt: "2000-01-01T00:00:00Z" }).where("id", "=", old.event.eventId).execute();

    expect(await store.pruneEvents(30)).toBe(1);
    expect(await store.getEvent(old.event.eventId)).toBeNull();
    expect(await store.listDeliveries({ sessionId: "s-old" })).toHaveLength(0);
    // Fresh rows survive.
    expect(await store.listDeliveries({ sessionId: "s-fresh" })).toHaveLength(1);
  });

  it("syncConfigRoutes replaces the config route set atomically", async () => {
    await store.syncConfigRoutes([
      { eventType: "cfg:a", target: { kind: "session", sessionId: "s1" }, deliverAs: "steer", origin: "config" },
      { eventType: "cfg:b", target: { kind: "session", sessionId: "s2" }, deliverAs: "steer", origin: "config" },
    ]);
    // Non-config routes must survive the sync.
    await store.createRoute({ eventType: "agent:x", target: { kind: "session", sessionId: "s3" }, deliverAs: "steer", origin: "agent" });
    await store.syncConfigRoutes([
      { eventType: "cfg:c", target: { kind: "session", sessionId: "s9" }, deliverAs: "followUp", origin: "config" },
    ]);
    const routes = await store.listRoutes();
    expect(routes.map((r) => `${r.origin}:${r.eventType}`).sort()).toEqual(["agent:agent:x", "config:cfg:c"]);
  });
});
