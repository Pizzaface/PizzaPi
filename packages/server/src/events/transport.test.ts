// ============================================================================
// transport.test.ts — delivery-receipt transport behavior for both CLI
// generations (ADR-0002 delivery guarantees):
//   - legacy sessions (no acksSessionTrigger): plain emit, handoff=delivered
//   - ack-capable sessions: emit with ack callback, row stays inflight until
//     the ack settles it (delivered) or the timeout reverts it to pending
//   - unreachable sessions: revert to pending for the drain-on-register path
//   - emitDeliveryResponseRelay correlation (fireId / session_complete)
// ============================================================================

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import type { TriggerEvent } from "@pizzapi/protocol";

const memDb = new Kysely<any>({
  dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
});

// Controllable stand-in for the shared events Redis client (wake lock).
// `wakeRedis === null` simulates "Redis unavailable" without a real connect.
let wakeRedis: Record<string, unknown> | null = null;

type LocalSocket = {
  connected: boolean;
  emits: Array<{ event: string; data: any; ack?: (err: unknown, responses?: unknown[]) => void }>;
  emit: (event: string, data: any, ack?: (err: unknown, responses?: unknown[]) => void) => void;
  timeout: (ms: number) => { emit: (event: string, data: any, ack?: (err: unknown, responses?: unknown[]) => void) => void };
};

function makeLocalSocket(): LocalSocket {
  const s: LocalSocket = {
    connected: true,
    emits: [],
    emit: (event, data, ack) => s.emits.push({ event, data, ack }),
    // Mirror Socket.IO's .timeout().emit() ack pattern.
    timeout: () => ({ emit: (event, data, ack) => s.emits.push({ event, data, ack }) }),
  };
  return s;
}

// Mutable per-test fakes.
let sharedSession: Record<string, unknown> | null = null;
let localSocket: LocalSocket | null = null;
let relayAcked: { attempts: number; settle: (acked: boolean) => void } | null = null;
let relayVerified = false;
let runnerEmits: Array<{ runnerId: string; event: string; data: any }> = [];
// Cluster-wide runner presence for the cross-node spawn path.
let runnerPresence: { kind: "count"; count: number } | { kind: "unknown" } = { kind: "unknown" };

const modsPromise = (async () => {
  mock.module("../auth.js", () => ({ getKysely: () => memDb }));
  mock.module("./redis.js", () => ({
    getEventsRedis: async () => wakeRedis,
    _injectRedisForTesting: () => {},
    _resetRedisForTesting: () => {},
  }));
  mock.module("../ws/sio-registry.js", () => ({
    broadcastToSessionViewers: () => {},
    emitToRelaySessionVerified: async () => relayVerified,
    emitToRelaySessionAcked: async (_sessionId: string, _event: string, data: any, onSettled: (acked: boolean) => void) => {
      relayAcked = { attempts: 0, settle: onSettled };
      return true;
    },
    emitToRunner: (runnerId: string, event: string, data: any) => runnerEmits.push({ runnerId, event, data }),
    getIo: () => ({ of: () => ({}) }),
    runnerRoom: (id: string) => `runner:${id}`,
    countSocketsInRoomCluster: async () => runnerPresence,
    getLocalRunnerSocket: () => null,
    getLocalTuiSocket: () => localSocket,
    getSharedSession: async () => sharedSession,
    linkSessionToRunner: async () => {},
    recordRunnerSession: async () => {},
    waitForLocalTuiSocket: async () => true,
  }));
  mock.module("../ws/runner-control.js", () => ({ waitForSpawnAck: async () => ({ ok: true }) }));
  mock.module("../ws/sio-registry/runners.js", () => ({ getRunnerData: async () => null }));
  mock.module("../sessions/trigger-store.js", () => ({ pushTriggerHistory: async () => {}, recordTriggerResponse: async () => {} }));
  mock.module("../push.js", () => ({ sendPushToUser: async () => {} }));
  const store = await import("./store.js");
  const transport = await import("./transport.js");
  const engine = await import("./engine.js");
  return { store, transport, engine };
})();

afterAll(() => mock.restore());

function resetFakes() {
  sharedSession = null;
  localSocket = null;
  relayAcked = null;
  relayVerified = false;
  runnerEmits = [];
  wakeRedis = null;
  runnerPresence = { kind: "unknown" };
}

describe("trigger transport delivery receipt", () => {
  let store: Awaited<typeof modsPromise>["store"];
  let transport: Awaited<typeof modsPromise>["transport"];
  let engine: Awaited<typeof modsPromise>["engine"];

  beforeAll(async () => {
    ({ store, transport, engine } = await modsPromise);
    await store.ensureEventTables();
  });

  afterEach(async () => {
    resetFakes();
    await memDb.deleteFrom("trigger_delivery").execute();
    await memDb.deleteFrom("trigger_event").execute();
  });

  async function publishTo(sessionId: string): Promise<{ deliveryId: string; event: TriggerEvent }> {
    const source = { kind: "api" as const, id: "hook", auth: "api-key" as const, userId: "u1" };
    const deps = transport.createEngineDeps();
    const outcome = await engine.publishEvent({ type: "t:x" }, source, deps, [{ sessionId }]);
    return { deliveryId: outcome.deliveries[0].deliveryId, event: outcome.event };
  }

  it("legacy CLI (no acksSessionTrigger): plain emit, handoff marks delivered", async () => {
    localSocket = makeLocalSocket();
    sharedSession = { sessionId: "s-legacy" }; // registered by an old CLI: no flag

    const { deliveryId } = await publishTo("s-legacy");
    expect(localSocket.emits.map((e) => e.event)).toEqual(["session_trigger"]);
    expect(localSocket.emits[0].ack).toBeUndefined(); // no ack requested
    expect((await store.getDelivery(deliveryId))?.status).toBe("delivered");
  });

  it("ack-capable CLI: row stays inflight until the ack settles it delivered", async () => {
    localSocket = makeLocalSocket();
    sharedSession = { sessionId: "s-new", acksSessionTrigger: true };

    const { deliveryId } = await publishTo("s-new");
    expect((await store.getDelivery(deliveryId))?.status).toBe("inflight");
    expect(localSocket.emits[0].ack).toBeTypeOf("function");

    // Recipient's ack lands: inflight → delivered.
    localSocket.emits[0].ack!(null, [{ ok: true }]);
    await new Promise((r) => setTimeout(r, 0));
    const settled = await store.getDelivery(deliveryId);
    expect(settled?.status).toBe("delivered");
    expect(settled?.deliveredAt).toBeDefined();
  });

  it("ack-capable CLI: ack timeout reverts the row to pending for re-delivery", async () => {
    localSocket = makeLocalSocket();
    sharedSession = { sessionId: "s-flap", acksSessionTrigger: true };

    const { deliveryId } = await publishTo("s-flap");
    expect((await store.getDelivery(deliveryId))?.status).toBe("inflight");

    // Socket.IO timeout callback: (err, []) — no ack will ever come.
    localSocket.emits[0].ack!(new Error("operation has timed out"));
    await new Promise((r) => setTimeout(r, 0));
    expect((await store.getDelivery(deliveryId))?.status).toBe("pending");
    // Pending rows drain on the next register — the CLI dedups by triggerId.
    expect(await store.pendingDeliveriesFor("s-flap")).toHaveLength(1);
  });

  it("cluster path (no local socket): verified room emit for legacy, acked emit for new CLIs", async () => {
    // Legacy, cluster-delivered: handoff = delivered.
    localSocket = null;
    relayVerified = true;
    sharedSession = { sessionId: "s-legacy-cluster" };
    const legacy = await publishTo("s-legacy-cluster");
    expect((await store.getDelivery(legacy.deliveryId))?.status).toBe("delivered");
    expect(relayAcked).toBeNull(); // plain verified emit, no ack wiring

    // Ack-capable, cluster-delivered: emit handed off, ack settles async.
    sharedSession = { sessionId: "s-new-cluster", acksSessionTrigger: true };
    const fresh = await publishTo("s-new-cluster");
    expect((await store.getDelivery(fresh.deliveryId))?.status).toBe("inflight");
    expect(relayAcked).not.toBeNull();
    relayAcked!.settle(true);
    await new Promise((r) => setTimeout(r, 0));
    expect((await store.getDelivery(fresh.deliveryId))?.status).toBe("delivered");
  });

  it("no recipient anywhere: row reverts to pending", async () => {
    localSocket = null;
    relayVerified = false;
    sharedSession = null;
    const { deliveryId } = await publishTo("s-gone");
    expect((await store.getDelivery(deliveryId))?.status).toBe("pending");
  });

  it("emitDeliveryResponseRelay correlates on fireId for session sources", async () => {
    const source = { kind: "session" as const, id: "child-1", auth: "socket" as const, userId: "u1" };
    const { event } = await store.insertEvent({ type: "t:ask", source, payload: {} }, "fire-relay-9");
    const d = await store.createDelivery({ eventId: event.eventId, eventType: event.type, sessionId: "parent-9", deliverAs: "steer" });
    await store.updateDelivery(d!.deliveryId, {
      status: "responded",
      respondedAt: new Date().toISOString(),
      response: { action: "approve", text: "ship it" },
    }, { guard: ["pending"] });

    // Wire the trigger_response capture through the real local socket.
    localSocket = makeLocalSocket();
    // Callers pass the RECORDED delivery (the respond route passes the row
    // it just updated with the response — the correlation source).
    const recorded = await store.getDelivery(d!.deliveryId);
    const ok = await transport.emitDeliveryResponseRelay(recorded!, event);
    expect(ok).toBe(true);
    expect(localSocket.emits.map((e) => e.event)).toEqual(["trigger_response"]);
    const data = localSocket.emits[0].data as { triggerId: string; response: string; action?: string; targetSessionId: string };
    // The child's waiter matches on its own triggerId == the publisher's fireId.
    expect(data.triggerId).toBe("fire-relay-9");
    expect(data.response).toBe("ship it");
    expect(data.action).toBe("approve");
    expect(data.targetSessionId).toBe("parent-9");
  });

  it("emitDeliveryResponseRelay ignores non-session sources", async () => {
    const source = { kind: "api" as const, id: "hook", auth: "api-key" as const, userId: "u1" };
    const { event } = await store.insertEvent({ type: "t:x", source, payload: {} });
    const d = await store.createDelivery({ eventId: event.eventId, eventType: event.type, sessionId: "s-1", deliverAs: "steer" });
    localSocket = makeLocalSocket();
    expect(await transport.emitDeliveryResponseRelay(d!, event)).toBe(false);
    expect(localSocket.emits).toHaveLength(0);
  });

  it("relayResponse dep drains recorded responses through the same correlation", async () => {
    const source = { kind: "session" as const, id: "child-2", auth: "socket" as const, userId: "u1" };
    const { event } = await store.insertEvent({ type: "t:ask", source, payload: {} }, "fire-relay-10");
    const d = await store.createDelivery({ eventId: event.eventId, eventType: event.type, sessionId: "parent-10", deliverAs: "steer" });
    await store.updateDelivery(d!.deliveryId, {
      status: "responded",
      respondedAt: new Date().toISOString(),
      response: { text: "ok" },
      responseRelayPending: true,
    }, { guard: ["pending"] });

    localSocket = makeLocalSocket();
    const deps = transport.createEngineDeps();
    const relayed = await engine.drainPendingResponseRelays("child-2", deps);
    expect(relayed).toBe(1);
    expect((await store.getDelivery(d!.deliveryId))?.responseRelayPending).toBeUndefined();
    expect(localSocket.emits[0].event).toBe("trigger_response");
  });
});

describe("distributed wake lock (multi-node)", () => {
  let transport: Awaited<typeof modsPromise>["transport"];

  beforeAll(async () => {
    ({ transport } = await modsPromise);
  });

  afterEach(() => resetFakes());

  it("acquires the per-session lock, emits new_session, releases on completion", async () => {
    const sets: Array<{ key: string; value: string; opts: unknown }> = [];
    const evals: Array<{ keys: string[]; arguments: string[] }> = [];
    wakeRedis = {
      isOpen: true,
      set: async (key: string, value: string, opts: unknown) => {
        sets.push({ key, value, opts });
        return "OK";
      },
      eval: async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
        evals.push({ keys: opts.keys, arguments: [...opts.arguments] });
        return 1;
      },
    };

    // getLocalRunnerSocket is mocked to null → cross-node path → returns true
    // right after the emit; the lock releases in the finally block.
    const ok = await transport.wakeOfflineSession("s-wake", { runnerId: "runner-1", cwd: "/work" });
    expect(ok).toBe(true);
    expect(sets).toHaveLength(1);
    expect(sets[0].key).toBe("pizzapi:trigger:wake-lock:s-wake");
    expect(sets[0].opts).toEqual({ NX: true, PX: 15_000 });
    expect(runnerEmits).toEqual([{
      runnerId: "runner-1",
      event: "new_session",
      data: expect.objectContaining({ sessionId: "s-wake", resumeId: "s-wake", cwd: "/work" }),
    }]);
    // Compare-and-delete releases exactly the token this holder acquired.
    expect(evals).toHaveLength(1);
    expect(evals[0].keys[0]).toBe("pizzapi:trigger:wake-lock:s-wake");
    expect(evals[0].arguments[0]).toBe(sets[0].value);
  });

  it("returns false without emitting when another node holds the lock", async () => {
    wakeRedis = {
      isOpen: true,
      set: async () => null, // SET NX lost — another relay node owns the wake
      eval: async () => 0,
    };
    const ok = await transport.wakeOfflineSession("s-locked", { runnerId: "runner-1" });
    expect(ok).toBe(false);
    expect(runnerEmits).toHaveLength(0); // no new_session raced at the runner
  });

  it("degrades to local-only dedup when Redis is unavailable", async () => {
    wakeRedis = null; // connectRedisClient() returned null
    const ok = await transport.wakeOfflineSession("s-noredis", { runnerId: "runner-1" });
    expect(ok).toBe(true);
    expect(runnerEmits).toHaveLength(1);
  });

  it("concurrent wakes on this node share one attempt (local map dedup)", async () => {
    const sets: string[] = [];
    wakeRedis = {
      isOpen: true,
      set: async (_key: string, value: string) => {
        sets.push(value);
        await new Promise((r) => setTimeout(r, 20));
        return "OK";
      },
      eval: async () => 1,
    };
    const [a, b] = await Promise.all([
      transport.wakeOfflineSession("s-dedup", { runnerId: "runner-1" }),
      transport.wakeOfflineSession("s-dedup", { runnerId: "runner-1" }),
    ]);
    expect([a, b]).toEqual([true, true]); // second call joined the first attempt
    expect(sets).toHaveLength(1);
    expect(runnerEmits).toHaveLength(1);
  });
});

describe("failed-wake retry sweep (multi-node)", () => {
  let store: Awaited<typeof modsPromise>["store"];
  let transport: Awaited<typeof modsPromise>["transport"];
  let engine: Awaited<typeof modsPromise>["engine"];

  beforeAll(async () => {
    ({ store, transport, engine } = await modsPromise);
  });

  beforeEach(async () => {
    resetFakes();
    // Offline session owned by runner-1: resolveSessionRunner's live path.
    sharedSession = { sessionId: "ignored", userId: "u1", runnerId: "runner-1" } as Record<string, unknown>;
    wakeRedis = null; // no lock contention — local-only wakes
  });

  afterEach(async () => {
    await memDb.deleteFrom("trigger_delivery").execute();
    await memDb.deleteFrom("trigger_event").execute();
  });

  const OLD = new Date(Date.now() - 10 * 60_000).toISOString();

  /** Publish a wake fire at an offline session → pending + wake-marked row. */
  async function wakeFire(sessionId: string): Promise<string> {
    const source = { kind: "api" as const, id: "sched", auth: "api-key" as const, userId: "u1" };
    const deps = transport.createEngineDeps();
    const outcome = await engine.publishEvent({ type: "time:cron" }, source, deps, [
      { sessionId, deliverAs: "followUp", wake: true },
    ]);
    return outcome.deliveries[0].deliveryId;
  }

  it("the wake path marks the delivery wakeRequested + lastWakeAttemptAt", async () => {
    relayVerified = false; // session unreachable → wake path runs
    const deliveryId = await wakeFire("s-mark");
    await new Promise((r) => setTimeout(r, 20)); // fire-and-forget wake + mark
    const row = await store.getDelivery(deliveryId);
    expect(row?.status).toBe("pending"); // stayed pending for drain-on-register
    expect(row?.wakeRequested).toBe(true);
    expect(row?.lastWakeAttemptAt).toBeDefined();
    expect(runnerEmits.map((e) => e.event)).toEqual(["new_session"]);
  });

  it("re-attempts wakes for pending rows past the 5-minute retry bound", async () => {
    relayVerified = false;
    const deliveryId = await wakeFire("s-retry");
    await new Promise((r) => setTimeout(r, 20));
    expect(runnerEmits).toHaveLength(1); // initial wake

    // Simulate the wake failing (worker never registered) and time passing.
    await store.updateDelivery(deliveryId, { lastWakeAttemptAt: OLD });

    const retried = await transport.sweepFailedWakes();
    expect(retried).toBe(1);
    await new Promise((r) => setTimeout(r, 20)); // fire-and-forget re-wake
    expect(runnerEmits).toHaveLength(2); // re-attempted new_session
    expect((await store.getDelivery(deliveryId))?.lastWakeAttemptAt).not.toBe(OLD); // bound refreshed

    // Immediate re-sweep: the fresh attempt is inside the window — no retry.
    expect(await transport.sweepFailedWakes()).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(runnerEmits).toHaveLength(2);
  });

  it("never retries a delivered or inflight row (claim guards win)", async () => {
    relayVerified = false;
    const deliveredId = await wakeFire("s-delivered");
    await new Promise((r) => setTimeout(r, 20));
    await store.updateDelivery(deliveredId, { lastWakeAttemptAt: OLD });
    // A register-drain claimed and delivered the row before the sweep ran.
    await store.updateDelivery(deliveredId, { status: "delivered", deliveredAt: new Date().toISOString() }, { guard: ["inflight", "pending"] });

    const inflightId = await wakeFire("s-inflight");
    await new Promise((r) => setTimeout(r, 20));
    await store.updateDelivery(inflightId, { status: "inflight" }, { guard: ["pending"] });

    expect(await transport.sweepFailedWakes()).toBe(0);
    expect(runnerEmits).toHaveLength(2); // only the two initial wakes
  });

  it("respects the wake lock on retry — a locked session is not re-woken", async () => {
    relayVerified = false;
    const deliveryId = await wakeFire("s-locked-retry");
    await new Promise((r) => setTimeout(r, 20));
    await store.updateDelivery(deliveryId, { lastWakeAttemptAt: OLD });

    wakeRedis = { isOpen: true, set: async () => null, eval: async () => 0 };
    expect(await transport.sweepFailedWakes()).toBe(1); // sweep counted the attempt…
    expect(runnerEmits).toHaveLength(1); // …but the lock refused the emit
  });
});
describe("cross-node spawn presence (multi-node)", () => {
  let store: Awaited<typeof modsPromise>["store"];
  let transport: Awaited<typeof modsPromise>["transport"];
  let engine: Awaited<typeof modsPromise>["engine"];

  beforeAll(async () => {
    ({ store, transport, engine } = await modsPromise);
  });

  beforeEach(() => resetFakes());
  afterEach(async () => {
    await memDb.deleteFrom("trigger_delivery").execute();
    await memDb.deleteFrom("trigger_route").execute();
    await memDb.deleteFrom("trigger_event").execute();
  });

  async function fireSpawnRoute(): Promise<{ spawned: string[]; intents: number }> {
    await store.createRoute({
      eventType: "hook:deploy",
      target: { kind: "spawn", spec: { runnerId: "runner-far" } },
      deliverAs: "steer",
      origin: "config",
    });
    const source = { kind: "api" as const, id: "hook", auth: "api-key" as const, userId: "u1" };
    const out = await engine.publishEvent({ type: "hook:deploy" }, source, transport.createEngineDeps());
    const intents = (await memDb.selectFrom("trigger_delivery").select("sessionId").execute())
      .filter((r: { sessionId: string }) => r.sessionId.startsWith("spawn:")).length;
    return { spawned: out.spawnedSessions, intents };
  }

  it("refuses a cross-node spawn when the runner room is confirmed empty (intent dropped)", async () => {
    runnerPresence = { kind: "count", count: 0 };
    const { spawned, intents } = await fireSpawnRoute();
    expect(spawned).toEqual([]);
    expect(runnerEmits).toHaveLength(0);
    expect(intents).toBe(0); // runSpawn deleted the placeholder
  });

  it("emits cross-node when the runner is present on another node", async () => {
    runnerPresence = { kind: "count", count: 1 };
    const { spawned } = await fireSpawnRoute();
    expect(spawned).toHaveLength(1);
    expect(runnerEmits.map((e) => [e.runnerId, e.event])).toEqual([["runner-far", "new_session"]]);
  });

  it("still attempts the spawn when presence is inconclusive (Redis blip ≠ runner gone)", async () => {
    runnerPresence = { kind: "unknown" };
    const { spawned } = await fireSpawnRoute();
    expect(spawned).toHaveLength(1);
    expect(runnerEmits).toHaveLength(1);
  });
});
