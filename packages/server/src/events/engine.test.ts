import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { Delivery, Route, SourceIdentity, TriggerEvent } from "@pizzapi/protocol";

const memDb = new Kysely<any>({
  dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

const modsPromise = (async () => {
  mock.module("../auth.js", () => ({ getKysely: () => memDb }));
  // Tenant scope for runner reconcile: runner-1 is owned by u1.
  mock.module("../runner-owner.js", () => ({
    getRunnerOwner: async (runnerId: string) => (runnerId === "runner-1" ? "u1" : null),
    rememberRunnerOwner: async () => {},
    ensureRunnerOwnerTable: async () => {},
  }));
  mock.module("../ws/sio-registry/runners.js", () => ({ getRunnerData: async () => null }));
  const store = await import("./store.js");
  const engine = await import("./engine.js");
  const reconcile = await import("./reconcile.js");
  return { store, engine, reconcile };
})();

afterAll(() => mock.restore());

const source: SourceIdentity = { kind: "service", id: "github", auth: "socket", userId: "u1" };

function makeDeps(overrides?: Partial<import("./engine.js").EngineDeps>) {
  const delivered: Array<{ delivery: Delivery; event: TriggerEvent; route: Route | null }> = [];
  const deps: import("./engine.js").EngineDeps = {
    deliver: async (delivery: Delivery, event: TriggerEvent, route: Route | null) => {
      delivered.push({ delivery, event, route });
      return "delivered";
    },
    spawn: async () => "spawned-1",
    escalate: async () => null,
    relayResponse: async () => true,
    ...overrides,
  };
  return { deps, delivered };
}

describe("engine", () => {
  let store: Awaited<typeof modsPromise>["store"];
  let engine: Awaited<typeof modsPromise>["engine"];
  let reconcile: Awaited<typeof modsPromise>["reconcile"];

  beforeAll(async () => {
    ({ store, engine, reconcile } = await modsPromise);
    await store.ensureEventTables();
  });

  afterEach(async () => {
    await memDb.deleteFrom("trigger_delivery").execute();
    await memDb.deleteFrom("trigger_route").execute();
    await memDb.deleteFrom("trigger_event").execute();
    reconcile._resetRedisForTesting();
  });

  it("routes an event to matching session routes with filters", async () => {
    await store.createRoute({
      eventType: "github:pr_comment",
      target: { kind: "session", sessionId: "s1" },
      deliverAs: "followUp",
      filters: [{ field: "author", value: "alice" }],
      origin: "agent", ownerUserId: "u1",
    });
    await store.createRoute({
      eventType: "github:pr_comment",
      target: { kind: "session", sessionId: "s2" },
      deliverAs: "steer",
      filters: [{ field: "author", value: "bob" }],
      origin: "agent", ownerUserId: "u1",
    });

    const { deps, delivered } = makeDeps();
    const outcome = await engine.publishEvent(
      { type: "github:pr_comment", payload: { author: "alice" } },
      source,
      deps,
    );
    expect(outcome.created).toBe(true);
    expect(delivered.map((d) => d.delivery.sessionId)).toEqual(["s1"]);
    expect(outcome.deliveries[0].status).toBe("delivered");
  });

  it("ignores malformed route filters without aborting event publishing", async () => {
    await store.createRoute({
      eventType: "github:pr_comment",
      target: { kind: "session", sessionId: "bad-array" },
      deliverAs: "steer",
      filters: {} as any,
      origin: "agent", ownerUserId: "u1",
    });
    await store.createRoute({
      eventType: "github:pr_comment",
      target: { kind: "session", sessionId: "bad-entry" },
      deliverAs: "steer",
      filters: [null] as any,
      origin: "agent", ownerUserId: "u1",
    });
    await store.createRoute({
      eventType: "github:pr_comment",
      target: { kind: "session", sessionId: "missing-field" },
      deliverAs: "steer",
      filters: [{ value: "alice" }] as any,
      origin: "agent", ownerUserId: "u1",
    });
    await store.createRoute({
      eventType: "github:pr_comment",
      target: { kind: "session", sessionId: "valid" },
      deliverAs: "steer",
      filters: [{ field: "author", value: "alice" }],
      origin: "agent", ownerUserId: "u1",
    });

    const { deps, delivered } = makeDeps();
    await engine.publishEvent({ type: "github:pr_comment", payload: { author: "alice" } }, source, deps);
    expect(delivered.map(({ delivery }) => delivery.sessionId)).toEqual(["valid"]);
  });

  it("rejects un-namespaced event types", async () => {
    const { deps } = makeDeps();
    expect(engine.publishEvent({ type: "nope" }, source, deps)).rejects.toThrow(/namespaced/);
  });

  it("fireId dedup skips re-routing", async () => {
    const { deps, delivered } = makeDeps();
    await store.createRoute({
      eventType: "t:x",
      target: { kind: "session", sessionId: "s1" },
      deliverAs: "steer",
      origin: "agent", ownerUserId: "u1",
    });
    await engine.publishEvent({ type: "t:x", fireId: "f1" }, source, deps);
    const second = await engine.publishEvent({ type: "t:x", fireId: "f1" }, source, deps);
    expect(second.created).toBe(false);
    expect(delivered).toHaveLength(1);
  });

  it("steer wins when multiple routes target the same session", async () => {
    const base = { eventType: "t:x", origin: "agent" as const, ownerUserId: "u1" };
    await store.createRoute({ ...base, target: { kind: "session", sessionId: "s1" }, deliverAs: "followUp" });
    await store.createRoute({ ...base, target: { kind: "session", sessionId: "s1" }, deliverAs: "steer" });
    const { deps, delivered } = makeDeps();
    await engine.publishEvent({ type: "t:x" }, source, deps);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].delivery.deliverAs).toBe("steer");
  });

  it("spawn routes create a session then deliver into it", async () => {
    await store.createRoute({
      eventType: "webhook:deploy",
      target: { kind: "spawn", spec: { runnerId: "r1", cwd: "/tmp" } },
      deliverAs: "steer",
      origin: "config",
    });
    const { deps, delivered } = makeDeps();
    const outcome = await engine.publishEvent({ type: "webhook:deploy" }, source, deps);
    expect(outcome.spawnedSessions).toEqual(["spawned-1"]);
    expect(delivered.map((d) => d.delivery.sessionId)).toEqual(["spawned-1"]);
  });

  it("extraTargets acts as the implicit direct route", async () => {
    const { deps, delivered } = makeDeps();
    await engine.publishEvent({ type: "t:direct" }, source, deps, [{ sessionId: "s9" }]);
    expect(delivered.map((d) => d.delivery.sessionId)).toEqual(["s9"]);
    expect(delivered[0].delivery.deliverAs).toBe("steer");
  });

  it("failed handoff leaves the delivery pending for drain", async () => {
    const { deps } = makeDeps({ deliver: async () => "unreachable" });
    const outcome = await engine.publishEvent({ type: "t:x" }, source, deps, [{ sessionId: "s1" }]);
    expect(outcome.deliveries[0].status).toBe("pending");
    const pending = await store.pendingDeliveriesFor("s1");
    expect(pending).toHaveLength(1);
  });

  it("escalation sweep re-routes to parent and marks a successful copy delivered", async () => {
    const contract = { ttlMs: 1000 };
    let parentEmits = 0;
    const { deps } = makeDeps({
      deliver: async (delivery) => {
        if (delivery.sessionId !== "parent-1") return "unreachable";
        parentEmits++;
        return "delivered";
      },
      escalate: async () => "parent-1",
    });
    await engine.publishEvent(
      { type: "lifecycle:plan_review", responseContract: contract },
      source,
      deps,
      [{ sessionId: "child-1" }],
    );
    const future = new Date(Date.now() + 60_000);
    const handled = await engine.sweepExpiredContracts(deps, future);
    expect(handled).toBe(1);
    const escalated = await store.listDeliveries({ sessionId: "child-1" });
    expect(escalated[0].status).toBe("escalated");
    const parent = await store.listDeliveries({ sessionId: "parent-1" });
    expect(parent).toHaveLength(1);
    expect(parent[0].status).toBe("delivered");
    expect(await engine.drainPendingDeliveries("parent-1", deps)).toBe(0);
    expect(parentEmits).toBe(1);
  });

  it("contract with escalate:false expires instead of escalating", async () => {
    const { deps } = makeDeps({ deliver: async () => "unreachable" });
    await engine.publishEvent(
      { type: "t:q", responseContract: { ttlMs: 1000, escalate: false } },
      source,
      deps,
      [{ sessionId: "s1" }],
    );
    await engine.sweepExpiredContracts(deps, new Date(Date.now() + 60_000));
    const [d] = await store.listDeliveries({ sessionId: "s1" });
    expect(d.status).toBe("expired");
  });

  it("a responded delivery is never escalated/expired by the sweep (race guard)", async () => {
    const { deps } = makeDeps({ escalate: async () => "parent-x" });
    await engine.publishEvent(
      { type: "t:race", responseContract: { ttlMs: 1000 } },
      source,
      deps,
      [{ sessionId: "s1" }],
    );
    // Answer arrives, THEN the contract TTL lapses (sweep listing raced).
    const [d] = await store.listDeliveries({ sessionId: "s1" });
    await store.updateDelivery(d.deliveryId, {
      status: "responded",
      respondedAt: new Date().toISOString(),
    });
    await store.updateDelivery(d.deliveryId, {
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
    });
    const handled = await engine.sweepExpiredContracts(deps, new Date());
    expect(handled).toBe(0);
    const [after] = await store.listDeliveries({ sessionId: "s1" });
    expect(after.status).toBe("responded");
    expect(await store.listDeliveries({ sessionId: "parent-x" })).toHaveLength(0);
  });

  it("planDeliveries tie-breaks deterministically by route creation time", async () => {
    await store.createRoute({
      eventType: "t:tie", target: { kind: "session", sessionId: "s1" }, deliverAs: "steer", origin: "agent", ownerUserId: "u1",
      promptTemplate: "oldest",
    });
    await new Promise((r) => setTimeout(r, 5));
    await store.createRoute({
      eventType: "t:tie", target: { kind: "session", sessionId: "s1" }, deliverAs: "steer", origin: "agent", ownerUserId: "u1",
      promptTemplate: "newer",
    });
    const { deps, delivered } = makeDeps();
    await engine.publishEvent({ type: "t:tie" }, source, deps);
    expect(delivered).toHaveLength(1);
    // listRoutes returns updatedAt-desc (newest first) — the plan must still
    // keep the OLDEST route's template, not "whatever sorted first".
    expect(delivered[0].route?.promptTemplate).toBe("oldest");
  });

  it("keeps only the latest pending wake delivery for a session and event type", async () => {
    const offline = makeDeps({ deliver: async () => "unreachable" }).deps;
    const first = await engine.publishEvent({ type: "schedule:nightly", payload: { n: 1 } }, source, offline, [
      { sessionId: "s-offline", deliverAs: "followUp", wake: true },
    ]);
    const second = await engine.publishEvent({ type: "schedule:nightly", payload: { n: 2 } }, source, offline, [
      { sessionId: "s-offline", deliverAs: "followUp", wake: true },
    ]);

    expect((await store.getDelivery(first.deliveries[0].deliveryId))?.status).toBe("expired");
    expect((await store.getDelivery(second.deliveries[0].deliveryId))?.status).toBe("pending");
    const pending = await store.pendingDeliveriesFor("s-offline");
    expect(pending.map((delivery) => delivery.deliveryId)).toEqual([second.deliveries[0].deliveryId]);
  });

  it("does not reconcile disabled routes as active runner subscriptions", async () => {
    await store.createRoute({
      eventType: "time:cron",
      target: { kind: "session", sessionId: "disabled-session", runnerId: "runner-1" },
      deliverAs: "followUp",
      origin: "agent", ownerUserId: "u1",
      disabled: true,
    });
    const active = await store.createRoute({
      eventType: "time:cron",
      target: { kind: "session", sessionId: "active-session", runnerId: "runner-1" },
      deliverAs: "followUp",
      origin: "agent", ownerUserId: "u1",
    });

    expect(await reconcile.subscriptionsForRunner("runner-1")).toEqual([
      expect.objectContaining({ subscriptionId: active.routeId, sessionId: "active-session" }),
    ]);
  });

  it("uses a local reconcile revision above the last Redis revision on failure", async () => {
    let fail = false;
    reconcile._injectRedisForTesting({
      isOpen: true,
      incr: async () => {
        if (fail) throw new Error("redis unavailable");
        return 700;
      },
    });

    expect(await reconcile.nextReconcileRevision()).toBe(700);
    fail = true;
    expect(await reconcile.nextReconcileRevision()).toBe(701);
    expect(await reconcile.nextReconcileRevision()).toBe(702);
  });

  it("two concurrent drains claim a pending delivery only once", async () => {
    const offline = makeDeps({ deliver: async () => "unreachable" }).deps;
    await engine.publishEvent({ type: "t:queued" }, source, offline, [{ sessionId: "s-race" }]);

    let emits = 0;
    const online = makeDeps({
      deliver: async () => {
        emits++;
        return "delivered";
      },
    }).deps;
    const counts = await Promise.all([
      engine.drainPendingDeliveries("s-race", online),
      engine.drainPendingDeliveries("s-race", online),
    ]);

    expect(emits).toBe(1);
    expect(counts.sort()).toEqual([0, 1]);
    expect((await store.listDeliveries({ sessionId: "s-race" }))[0].status).toBe("delivered");
  });

  it("drains pending deliveries FIFO on demand (offline target → register)", async () => {
    // First publish: executor fails (session offline) → delivery stays pending.
    const failCalls: Array<{ delivery: Delivery; event: TriggerEvent; route: Route | null }> = [];
    const failDeps: import("./engine.js").EngineDeps = {
      deliver: async (delivery, event, route) => {
        failCalls.push({ delivery, event, route });
        return "unreachable";
      },
      spawn: async () => "spawned-1",
      escalate: async () => null,
      relayResponse: async () => true,
    };
    const out1 = await engine.publishEvent({ type: "schedule:nightly", payload: { n: 1 } }, source, failDeps, [
      { sessionId: "s-offline", deliverAs: "followUp", wake: true },
    ]);
    expect(out1.deliveries[0].status).toBe("pending");
    // Wake-bearing direct fires get a synthetic route so the executor can
    // see the wake policy.
    expect(failCalls[0].route?.target).toEqual({ kind: "session", sessionId: "s-offline", wake: true });

    // A second event queued while offline (FIFO order source).
    const out2 = await engine.publishEvent({ type: "schedule:nightly", payload: { n: 2 } }, source, makeDeps({ deliver: async () => "unreachable" }).deps, [
      { sessionId: "s-offline" },
    ]);
    expect(out2.deliveries[0].status).toBe("pending");

    // Session registers: drain delivers both in event order.
    const ok = makeDeps();
    const drained = await engine.drainPendingDeliveries("s-offline", ok.deps);
    expect(drained).toBe(2);
    const order = ok.delivered.map((d) => d.event.payload.n);
    expect(order).toEqual([1, 2]);

    const pending = await store.pendingDeliveriesFor("s-offline");
    expect(pending).toHaveLength(0);
    const view = await store.listDeliveries({ sessionId: "s-offline" });
    expect(view.every((d) => d.status === "delivered")).toBe(true);
  });
});

describe("engine tenant isolation", () => {
  let store: Awaited<typeof modsPromise>["store"];
  let engine: Awaited<typeof modsPromise>["engine"];
  beforeAll(async () => {
    ({ store, engine } = await modsPromise);
    await store.ensureEventTables();
  });
  afterEach(async () => {
    await memDb.deleteFrom("trigger_delivery").execute();
    await memDb.deleteFrom("trigger_route").execute();
    await memDb.deleteFrom("trigger_event").execute();
  });

  it("a user's event never fires another user's session or spawn routes", async () => {
    await store.createRoute({ eventType: "x:y", target: { kind: "session", sessionId: "b-session" }, deliverAs: "steer", origin: "ui", ownerUserId: "userB" });
    await store.createRoute({ eventType: "x:y", target: { kind: "spawn", spec: { runnerId: "b-runner", ownerUserId: "userB" } }, deliverAs: "steer", origin: "ui", ownerUserId: "userB" });
    await store.createRoute({ eventType: "x:y", target: { kind: "session", sessionId: "a-session" }, deliverAs: "steer", origin: "ui", ownerUserId: "userA" });
    let spawns = 0;
    const { deps, delivered } = makeDeps({ spawn: async () => { spawns++; return "spawned"; } });
    const outcome = await engine.publishEvent({ type: "x:y", payload: {} }, { kind: "api", id: "a", auth: "api-key", userId: "userA" }, deps);
    expect(spawns).toBe(0);
    expect(outcome.deliveries.map((d) => d.sessionId)).toEqual(["a-session"]);
    expect(delivered.every((d) => d.delivery.sessionId === "a-session")).toBe(true);
  });

  it("ownerless legacy routes match nothing; ownerless config routes match everyone", async () => {
    await store.createRoute({ eventType: "x:y", target: { kind: "session", sessionId: "legacy" }, deliverAs: "steer", origin: "agent" });
    await store.syncConfigRoutes([{ eventType: "x:y", target: { kind: "session", sessionId: "operator" }, deliverAs: "steer", origin: "config" }]);
    const { deps } = makeDeps();
    const outcome = await engine.publishEvent({ type: "x:y", payload: {} }, { kind: "api", id: "a", auth: "api-key", userId: "userA" }, deps);
    expect(outcome.deliveries.map((d) => d.sessionId)).toEqual(["operator"]);
  });

  it("fireId idempotency is scoped per owner", async () => {
    const { deps } = makeDeps();
    const a = await engine.publishEvent({ type: "x:y", payload: { who: "a" }, fireId: "k1" }, { kind: "api", id: "a", auth: "api-key", userId: "userA" }, deps);
    const b = await engine.publishEvent({ type: "x:y", payload: { who: "b" }, fireId: "k1" }, { kind: "api", id: "b", auth: "api-key", userId: "userB" }, deps);
    const a2 = await engine.publishEvent({ type: "x:y", payload: { who: "a" }, fireId: "k1" }, { kind: "api", id: "a", auth: "api-key", userId: "userA" }, deps);
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(b.event.eventId).not.toBe(a.event.eventId);
    expect(a2.created).toBe(false);
    expect(a2.event.eventId).toBe(a.event.eventId);
  });
});

describe("delivery receipt acks (inflight settle)", () => {
  let store: Awaited<typeof modsPromise>["store"];
  let engine: Awaited<typeof modsPromise>["engine"];
  beforeAll(async () => {
    ({ store, engine } = await modsPromise);
    await store.ensureEventTables();
  });
  afterEach(async () => {
    await memDb.deleteFrom("trigger_delivery").execute();
    await memDb.deleteFrom("trigger_route").execute();
    await memDb.deleteFrom("trigger_event").execute();
  });

  it("legacy handoff (deliver=delivered) marks the row delivered immediately", async () => {
    const { deps } = makeDeps({ deliver: async () => "delivered" });
    const outcome = await engine.publishEvent({ type: "t:x" }, source, deps, [{ sessionId: "s-legacy" }]);
    expect(outcome.deliveries[0].status).toBe("delivered");
  });

  it("ack-capable handoff stays inflight until the ack settles it delivered", async () => {
    const { deps } = makeDeps({ deliver: async () => "inflight" });
    const outcome = await engine.publishEvent({ type: "t:x" }, source, deps, [{ sessionId: "s-new" }]);
    expect(outcome.deliveries[0].status).toBe("inflight");

    const settled = await engine.settleDeliveryAck(outcome.deliveries[0].deliveryId, true);
    expect(settled?.status).toBe("delivered");
    expect(settled?.deliveredAt).toBeDefined();
  });

  it("ack timeout → pending → drained on next register (lifecycle boundary)", async () => {
    // Emit to an ack-capable session whose connection dies before receipt.
    const { deps } = makeDeps({ deliver: async () => "inflight" });
    const outcome = await engine.publishEvent({ type: "t:x" }, source, deps, [{ sessionId: "s-flap" }]);
    expect(outcome.deliveries[0].status).toBe("inflight");

    // Ack timeout fires (no ack will ever come): row returns to pending.
    await engine.settleDeliveryAck(outcome.deliveries[0].deliveryId, false);
    expect((await store.getDelivery(outcome.deliveries[0].deliveryId))?.status).toBe("pending");
    expect(await store.pendingDeliveriesFor("s-flap")).toHaveLength(1);

    // Session registers: drain re-delivers, now with a legacy-confirmed handoff.
    const drained = await engine.drainPendingDeliveries("s-flap", makeDeps({ deliver: async () => "delivered" }).deps);
    expect(drained).toBe(1);
    expect((await store.listDeliveries({ sessionId: "s-flap" }))[0].status).toBe("delivered");
  });

  it("a raced response beats a late ack settle (guard holds)", async () => {
    const { deps } = makeDeps({ deliver: async () => "inflight" });
    const outcome = await engine.publishEvent({ type: "t:x" }, source, deps, [{ sessionId: "s-race2" }]);
    const id = outcome.deliveries[0].deliveryId;

    // Response arrives while the ack is still in flight.
    const won = await store.updateDelivery(id, { status: "responded", respondedAt: new Date().toISOString() }, { guard: ["inflight"] });
    expect(won?.status).toBe("responded");

    // The late ack must not clobber the responded row.
    expect(await engine.settleDeliveryAck(id, true)).toBeNull();
    expect((await store.getDelivery(id))?.status).toBe("responded");
  });

  it("sweepStaleInflight returns old inflight rows to pending, fresh ones stay", async () => {
    const { deps } = makeDeps({ deliver: async () => "inflight" });
    await engine.publishEvent({ type: "t:x" }, source, deps, [{ sessionId: "s-stale" }]);
    await engine.publishEvent({ type: "t:y" }, source, deps, [{ sessionId: "s-fresh" }]);

    // Age the first row past the sweep window (crashed emitter backstop).
    await memDb
      .updateTable("trigger_delivery")
      .set({ updatedAt: new Date(Date.now() - 120_000).toISOString() })
      .where("sessionId", "=", "s-stale")
      .execute();

    expect(await engine.sweepStaleInflight(60_000)).toBe(1);
    expect((await store.listDeliveries({ sessionId: "s-stale" }))[0].status).toBe("pending");
    expect((await store.listDeliveries({ sessionId: "s-fresh" }))[0].status).toBe("inflight");
  });

  it("drainPendingResponseRelays re-relays a failed response relay on source registration", async () => {
    // A child session published a contract event; the parent answered, but the
    // relay to the (offline) child source failed → marker stays for the drain.
    const childSource: SourceIdentity = { kind: "session", id: "child-src", auth: "socket", userId: "u1" };
    const { event } = await store.insertEvent({ type: "t:ask", source: childSource, payload: {}, responseContract: {} }, "fire-relay-1");
    const delivery = await store.createDelivery({
      eventId: event.eventId, eventType: event.type, sessionId: "parent-s", deliverAs: "steer",
    });
    expect(delivery).not.toBeNull();
    await store.updateDelivery(delivery!.deliveryId, {
      status: "responded",
      respondedAt: new Date().toISOString(),
      response: { action: "approve", text: "go ahead" },
      responseRelayPending: true,
    }, { guard: ["pending"] });

    // Not the source session → nothing drained.
    const wrongDeps = makeDeps({ relayResponse: async () => true }).deps;
    expect(await engine.drainPendingResponseRelays("someone-else", wrongDeps)).toBe(0);

    // Source registers: the stored response re-relays and the marker clears.
    let relayedIds: string[] = [];
    const deps = makeDeps({
      relayResponse: async (d) => { relayedIds.push(d.deliveryId); return true; },
    }).deps;
    expect(await engine.drainPendingResponseRelays("child-src", deps)).toBe(1);
    expect(relayedIds).toEqual([delivery!.deliveryId]);
    expect((await store.getDelivery(delivery!.deliveryId))?.responseRelayPending).toBeUndefined();

    // A relay that still fails keeps the marker for the next registration.
    await store.updateDelivery(delivery!.deliveryId, { responseRelayPending: true });
    const failing = makeDeps({ relayResponse: async () => false }).deps;
    expect(await engine.drainPendingResponseRelays("child-src", failing)).toBe(0);
    expect((await store.getDelivery(delivery!.deliveryId))?.responseRelayPending).toBe(true);
  });
});

describe("transactional publish + spawn intents", () => {
  let store: Awaited<typeof modsPromise>["store"];
  let engine: Awaited<typeof modsPromise>["engine"];
  beforeAll(async () => {
    ({ store, engine } = await modsPromise);
    await store.ensureEventTables();
  });
  afterEach(async () => {
    await memDb.deleteFrom("trigger_delivery").execute();
    await memDb.deleteFrom("trigger_route").execute();
    await memDb.deleteFrom("trigger_event").execute();
  });

  it("persists spawn intents in the publish tx and resolves them after the spawn", async () => {
    await store.createRoute({
      eventType: "webhook:deploy",
      target: { kind: "spawn", spec: { runnerId: "r1", cwd: "/tmp" } },
      deliverAs: "steer",
      origin: "config",
    });
    const { deps, delivered } = makeDeps({ spawn: async () => "spawned-9" });
    const outcome = await engine.publishEvent({ type: "webhook:deploy", fireId: "deploy-1" }, source, deps);
    expect(outcome.created).toBe(true);
    expect(outcome.spawnedSessions).toEqual(["spawned-9"]);
    // The delivery landed on the REAL session, not the placeholder.
    expect(delivered.map((d) => d.delivery.sessionId)).toEqual(["spawned-9"]);
    const row = await store.getDelivery(outcome.deliveries[0].deliveryId);
    expect(row?.sessionId).toBe("spawned-9");
    expect(row?.spawnRouteId).toBeUndefined();
  });

  it("a failed spawn drops its intent row (no dangling placeholder deliveries)", async () => {
    await store.createRoute({
      eventType: "webhook:deploy",
      target: { kind: "spawn", spec: { runnerId: "r1" } },
      deliverAs: "steer",
      origin: "config",
    });
    const { deps } = makeDeps({ spawn: async () => null });
    const outcome = await engine.publishEvent({ type: "webhook:deploy", fireId: "deploy-2" }, source, deps);
    expect(outcome.spawnedSessions).toEqual([]);
    expect(outcome.deliveries).toHaveLength(0);
    // The intent row is gone: no pending spawn:… row can pollute drains.
    expect(await store.pendingDeliveriesFor("spawn:")).toHaveLength(0);
    const rows = await memDb.selectFrom("trigger_delivery").select("id").execute();
    expect(rows).toHaveLength(0);
  });

  it("crash after the tx (spawn side effect never ran) → duplicate fireId resumes the intent", async () => {
    const route = await store.createRoute({
      eventType: "webhook:deploy",
      target: { kind: "spawn", spec: { runnerId: "r1" } },
      deliverAs: "steer",
      origin: "config",
    });
    // The committed-then-crashed state: the tx landed (event + spawn intent
    // row), but the process died before the spawn side effect could run.
    const { event } = await store.insertEventWithPlan(
      { type: "webhook:deploy", source, payload: {} },
      "deploy-3",
      [{ sessionId: "", spawnRouteId: route.routeId, deliverAs: "steer" }],
    );
    const intents = await memDb.selectFrom("trigger_delivery").select(["id", "sessionId"]).execute();
    expect(intents).toHaveLength(1);
    expect(intents[0].sessionId).toStartWith("spawn:");

    // Retry with the same fireId: instead of deduping to nothing, the engine
    // resumes the unresolved intent, spawns, resolves, and delivers.
    let spawns = 0;
    const resumeDeps = makeDeps({
      spawn: async () => { spawns++; return "spawned-late"; },
      deliver: async () => "delivered",
    }).deps;
    const retry = await engine.publishEvent({ type: "webhook:deploy", fireId: "deploy-3" }, source, resumeDeps);
    expect(retry.created).toBe(false);
    expect(retry.event.eventId).toBe(event.eventId);
    expect(spawns).toBe(1);
    expect(retry.spawnedSessions).toEqual(["spawned-late"]);
    expect(retry.deliveries[0].sessionId).toBe("spawned-late");
    expect(retry.deliveries[0].status).toBe("delivered");
    const row = await store.getDelivery(intents[0].id);
    expect(row?.sessionId).toBe("spawned-late");
    expect(row?.spawnRouteId).toBeUndefined();
  });

  it("sweepUnresolvedSpawnIntents drops stale spawn placeholders (pending or inflight) but not fresh ones", async () => {
    const route = await store.createRoute({
      eventType: "webhook:deploy",
      target: { kind: "spawn", spec: { runnerId: "r1" } },
      deliverAs: "steer",
      origin: "config",
    });
    const plan = [{ sessionId: "", spawnRouteId: route.routeId, deliverAs: "steer" as const }];
    const a = await store.insertEventWithPlan({ type: "webhook:deploy", source, payload: {} }, "sw-a", plan);
    const b = await store.insertEventWithPlan({ type: "webhook:deploy", source, payload: {} }, "sw-b", plan);
    const c = await store.insertEventWithPlan({ type: "webhook:deploy", source, payload: {} }, "sw-c", plan);
    // a: pending (crash before claim); b: inflight (emit reached no runner);
    // c: fresh inflight (legit spawn in progress) — must survive.
    await store.updateDelivery(b.deliveries[0].deliveryId, { status: "inflight" }, { guard: ["pending"] });
    await store.updateDelivery(c.deliveries[0].deliveryId, { status: "inflight" }, { guard: ["pending"] });
    const old = new Date(Date.now() - 120_000).toISOString();
    await memDb.updateTable("trigger_delivery").set({ updatedAt: old })
      .where("id", "in", [a.deliveries[0].deliveryId, b.deliveries[0].deliveryId]).execute();

    expect(await engine.sweepUnresolvedSpawnIntents(60_000)).toBe(2);
    expect(await store.getDelivery(a.deliveries[0].deliveryId)).toBeNull();
    expect(await store.getDelivery(b.deliveries[0].deliveryId)).toBeNull();
    expect((await store.getDelivery(c.deliveries[0].deliveryId))?.status).toBe("inflight");
  });

  it("a thrown spawn side effect is a handled failure: intent dropped, not resumed", async () => {
    await store.createRoute({
      eventType: "webhook:deploy",
      target: { kind: "spawn", spec: { runnerId: "r1" } },
      deliverAs: "steer",
      origin: "config",
    });
    const crashDeps = makeDeps({ spawn: async () => { throw new Error("runner exploded"); } }).deps;
    const first = await engine.publishEvent({ type: "webhook:deploy", fireId: "deploy-4" }, source, crashDeps);
    expect(first.created).toBe(true);
    expect(first.spawnedSessions).toEqual([]);
    // Handled failure ≠ crash: the intent row is dropped, nothing dangles.
    expect((await memDb.selectFrom("trigger_delivery").select("id").execute())).toHaveLength(0);
  });

  it("crash after the tx (emit interrupted) → duplicate fireId re-attempts the pending handoff", async () => {
    // First publish hands off to an ack-capable session and dies before settle.
    const crashDeps = makeDeps({ deliver: async () => "inflight" }).deps;
    await engine.publishEvent({ type: "t:x", fireId: "emit-1" }, source, crashDeps, [{ sessionId: "s-tx" }]);
    expect((await store.pendingDeliveriesFor("s-tx"))).toHaveLength(0); // inflight, not pending

    // Simulate the ack never arriving: the sweep returns it to pending.
    expect(await engine.sweepStaleInflight(-60_000)).toBe(1); // cutoff in the future: everything stale

    // Retry with the same fireId resumes the pending row.
    let emits = 0;
    const retryDeps = makeDeps({ deliver: async () => { emits++; return "delivered"; } }).deps;
    const retry = await engine.publishEvent({ type: "t:x", fireId: "emit-1" }, source, retryDeps, [{ sessionId: "s-tx" }]);
    expect(retry.created).toBe(false);
    expect(emits).toBe(1);
    expect(retry.deliveries[0].status).toBe("delivered");
  });

  it("duplicate fireId on a fully-delivered event re-emits nothing", async () => {
    const { deps, delivered } = makeDeps();
    await engine.publishEvent({ type: "t:x", fireId: "done-1" }, source, deps, [{ sessionId: "s-done" }]);
    const second = await engine.publishEvent({ type: "t:x", fireId: "done-1" }, source, deps, [{ sessionId: "s-done" }]);
    expect(second.created).toBe(false);
    expect(delivered).toHaveLength(1);
    expect(second.deliveries.map((d) => d.status)).toEqual(["delivered"]);
  });

  it("concurrent publishes with the same fireId claim exactly one event (tx dedup)", async () => {
    const { deps } = makeDeps();
    const results = await Promise.all([
      engine.publishEvent({ type: "t:x", fireId: "race-1" }, source, deps, [{ sessionId: "s-race1" }]),
      engine.publishEvent({ type: "t:x", fireId: "race-1" }, source, deps, [{ sessionId: "s-race1" }]),
      engine.publishEvent({ type: "t:x", fireId: "race-1" }, source, deps, [{ sessionId: "s-race1" }]),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    // Exactly-once per (event, session): one delivery row, one emit.
    const rows = await memDb.selectFrom("trigger_delivery").select("id").execute();
    expect(rows).toHaveLength(1);
    const view = await store.listDeliveries({ sessionId: "s-race1" });
    expect(view).toHaveLength(1);
  });
});

describe("per-source FIFO dispatch", () => {
  let store: Awaited<typeof modsPromise>["store"];
  let engine: Awaited<typeof modsPromise>["engine"];
  beforeAll(async () => {
    ({ store, engine } = await modsPromise);
    await store.ensureEventTables();
  });
  afterEach(async () => {
    await memDb.deleteFrom("trigger_delivery").execute();
    await memDb.deleteFrom("trigger_route").execute();
    await memDb.deleteFrom("trigger_event").execute();
  });

  it("concurrent publishes from one source dispatch serially in publish order", async () => {
    // Each deliver hangs a tick so an unserialized dispatch would interleave.
    const order: number[] = [];
    const deps = makeDeps({
      deliver: async (_d, event) => {
        const n = (event.payload as { n: number }).n;
        await new Promise((r) => setTimeout(r, 5));
        order.push(n);
        return "delivered";
      },
    }).deps;

    const publishes = [1, 2, 3, 4, 5].map((n) =>
      engine.publishEvent({ type: "t:fifo", payload: { n } }, source, deps, [{ sessionId: "s-fifo" }]),
    );
    await Promise.all(publishes);

    expect(order).toEqual([1, 2, 3, 4, 5]);
    // seqs match the (serialized) publish order.
    const rows = await memDb
      .selectFrom("trigger_event")
      .select(["eventJson", "seq"])
      .orderBy("seq", "asc")
      .execute();
    expect(rows.map((r: any) => JSON.parse(r.eventJson).payload.n)).toEqual([1, 2, 3, 4, 5]);
  });

  it("a failed publish does not poison the source's chain", async () => {
    const seen: string[] = [];
    const deps = makeDeps({
      deliver: async (_d, event) => {
        seen.push(String((event.payload as { tag?: string }).tag));
        return "delivered";
      },
    }).deps;
    // A publish whose transaction fails rejects to its caller (the emit-side
    // deliver failure is caught by claimAndDeliver and reverts to pending)…
    let rejected = false;
    await engine.publishEvent({ type: "t:fifo", payload: { tag: "boom" } }, source, deps, [
      { sessionId: null as any },
    ]).then(() => undefined, () => { rejected = true; });
    expect(rejected).toBe(true);

    // …but the source's chain is not poisoned: the next publish dispatches.
    await engine.publishEvent({ type: "t:fifo", payload: { tag: "after" } }, source, deps, [
      { sessionId: "s-poison" },
    ]);
    expect(seen).toEqual(["after"]);
  });

  it("different sources do not serialize against each other", async () => {
    // Source B's publish must not wait behind a slow source-A publish.
    let aDone = false;
    const slowDeps = makeDeps({
      deliver: async () => {
        await new Promise((r) => setTimeout(r, 40));
        aDone = true;
        return "delivered";
      },
    }).deps;
    const fastSource: SourceIdentity = { kind: "service", id: "fast", auth: "socket", userId: "u1" };
    const fastDeps = makeDeps({
      deliver: async () => {
        // If chained behind A, aDone would already be true here.
        expect(aDone).toBe(false);
        return "delivered";
      },
    }).deps;

    const slow = engine.publishEvent({ type: "t:slow" }, source, slowDeps, [{ sessionId: "s-slow" }]);
    await new Promise((r) => setTimeout(r, 5));
    const fast = engine.publishEvent({ type: "t:fast" }, fastSource, fastDeps, [{ sessionId: "s-fast" }]);
    await Promise.all([slow, fast]);
    expect(aDone).toBe(true);
  });
});
