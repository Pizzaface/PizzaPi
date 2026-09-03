/**
 * Unified trigger routing engine (ADR-0002).
 *
 * Pure orchestration: publish → match Routes → plan Deliveries → hand each
 * to injected delivery executors. Socket emission, session waking, and
 * spawning live behind `EngineDeps` so the engine is testable and the
 * transport wiring stays in the HTTP/socket layer.
 */

import type {
  Delivery,
  PublishEventInput,
  Route,
  SourceIdentity,
  TriggerEvent,
  TriggerFilter,
  TriggerFilterMode,
} from "@pizzapi/protocol";
import { isValidEventType, routeMatchesOwner } from "@pizzapi/protocol";
import { createLogger } from "@pizzapi/tools";
import {
  createDelivery,
  deleteDelivery,
  expirePendingDeliveries,
  expiredContractDeliveries,
  getDelivery,
  getEvent,
  getRoute,
  inflightDeliveries,
  insertEventWithPlan,
  listRoutes,
  listUnresolvedSpawnIntents,
  pendingDeliveriesFor,
  pendingResponseRelaysFor,
  updateDelivery,
  type PlannedDelivery,
} from "./store.js";

const log = createLogger("event-engine");

// ── Filter matching ──────────────────────────────────────────────────────────

function matchesSingleFilter(filter: TriggerFilter, payload: Record<string, unknown>): boolean {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw new Error("Filter must be an object");
  }
  if (typeof filter.field !== "string" || filter.field.length === 0) {
    throw new Error("Filter field must be a non-empty string");
  }
  const actual = payload[filter.field];
  if (filter.op === "contains") {
    if (typeof actual !== "string") return false;
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    return values.some((v) => actual.toLowerCase().includes(String(v).toLowerCase()));
  }
  const values = Array.isArray(filter.value) ? filter.value : [filter.value];
  // Loose equality on purpose: payloads arrive as JSON with mixed number/string types.
  // String compares are case-insensitive: GitHub logins/repos/branches are, and a
  // route filtering author "pizzaface" against payload "Pizzaface" silently
  // dropped every event.
  return values.some((v) =>
    typeof actual === "string" && typeof v === "string"
      ? actual.toLowerCase() === v.toLowerCase()
      // eslint-disable-next-line eqeqeq
      : actual == v,
  );
}

export function payloadMatchesFilters(
  payload: Record<string, unknown>,
  filters: TriggerFilter[] | undefined,
  filterMode: TriggerFilterMode = "and",
): boolean {
  if (filters === undefined) return true;
  if (!Array.isArray(filters)) throw new Error("Route filters must be an array");
  if (filters.length === 0) return true;
  if (filterMode !== "and" && filterMode !== "or") throw new Error(`Invalid filter mode: ${String(filterMode)}`);
  return filterMode === "or"
    ? filters.some((f) => matchesSingleFilter(f, payload))
    : filters.every((f) => matchesSingleFilter(f, payload));
}

// ── Route matching ───────────────────────────────────────────────────────────

export function matchRoutes(event: TriggerEvent, routes: Route[]): Route[] {
  return routes.filter((route) => {
    try {
      return (
        !route.disabled &&
        route.eventType === event.type &&
        // Tenant isolation: a user's event can only fire their own routes
        // (config routes without an owner are operator-level).
        routeMatchesOwner(route, event.source.userId) &&
        payloadMatchesFilters(event.payload, route.filters, route.filterMode ?? "and")
      );
    } catch (err) {
      const routeId = route && typeof route === "object" ? String(route.routeId) : "<unknown>";
      log.error(`Failed to evaluate filters for route ${routeId}:`, err);
      return false;
    }
  });
}

/**
 * Collapse matched routes into one planned delivery per session (exactly-once)
 * plus one spawn per spawn-route. When multiple routes hit the same session,
 * steer wins over followUp (more urgent) and the first route's template is kept.
 */
export function planDeliveries(routes: Route[]): {
  sessions: Array<{ sessionId: string; route: Route }>;
  spawns: Route[];
} {
  // Deterministic: "first route wins" tie-breaks (deliverAs/template) must not
  // depend on listRoutes' updatedAt-desc ordering.
  const ordered = [...routes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const bySession = new Map<string, Route>();
  const spawns: Route[] = [];
  for (const route of ordered) {
    if (route.target.kind === "spawn") {
      spawns.push(route);
      continue;
    }
    const existing = bySession.get(route.target.sessionId);
    if (!existing || (existing.deliverAs === "followUp" && route.deliverAs === "steer")) {
      bySession.set(route.target.sessionId, route);
    }
  }
  return {
    sessions: [...bySession.entries()].map(([sessionId, route]) => ({ sessionId, route })),
    spawns,
  };
}

// ── Engine ───────────────────────────────────────────────────────────────────

export interface EngineDeps {
  /**
   * Hand a claimed Delivery to its session (emit session_trigger, wake if
   * needed). "delivered" = recipient confirmed receipt or a legacy CLI's
   * handoff is complete (engine marks delivered immediately); "inflight" =
   * emitted to an ack-capable session and the ack is pending (row stays
   * inflight; the transport settles it via settleDeliveryAck);
   * "unreachable" = no recipient now (engine reverts to pending for the
   * drain-on-reconnect path).
   */
  deliver(delivery: Delivery, event: TriggerEvent, route: Route | null): Promise<DeliverOutcome>;
  /**
   * Spawn a fresh session for a spawn-spec Route and return its sessionId,
   * or null on failure.
   */
  spawn(route: Route, event: TriggerEvent): Promise<string | null>;
  /**
   * Escalate an unanswered response-contract Delivery one hop up the chain
   * (parent session → human web-push). Returns the new target sessionId when
   * re-routed to a parent, or null when handed to the human/expired.
   */
  escalate(delivery: Delivery, event: TriggerEvent): Promise<string | null>;
  /**
   * Relay a recorded response back to the event's SOURCE session (the
   * publisher's waiter matches on its own triggerId). Returns true when the
   * relay reached the source.
   */
  relayResponse(delivery: Delivery, event: TriggerEvent): Promise<boolean>;
}

export type DeliverOutcome = "delivered" | "inflight" | "unreachable";

export interface PublishOutcome {
  event: TriggerEvent;
  created: boolean;
  deliveries: Delivery[];
  spawnedSessions: string[];
}

async function claimAndDeliver(
  delivery: Delivery,
  event: TriggerEvent,
  route: Route | null,
  deps: EngineDeps,
  operation: string,
): Promise<{ claimed: boolean; handedOff: boolean; delivery: Delivery }> {
  // Claim pending → inflight so a concurrent drain/register cannot double-emit;
  // a crashed emitter leaves the row inflight for the sweep to return to pending.
  const claimed = await updateDelivery(delivery.deliveryId, { status: "inflight" }, { guard: ["pending"] });
  if (!claimed) return { claimed: false, handedOff: false, delivery };

  try {
    const outcome = await deps.deliver(claimed, event, route);
    if (outcome === "inflight") {
      // Ack-capable recipient: the transport's ack/timeout callback settles
      // inflight → delivered / pending via settleDeliveryAck.
      return { claimed: true, handedOff: true, delivery: claimed };
    }
    if (outcome === "delivered") {
      const done = await updateDelivery(
        delivery.deliveryId,
        { status: "delivered", deliveredAt: new Date().toISOString() },
        { guard: ["inflight"] },
      );
      return { claimed: true, handedOff: true, delivery: done ?? claimed };
    }
  } catch (err) {
    log.error(`${operation} ${delivery.deliveryId} failed:`, err);
  }

  try {
    const reverted = await updateDelivery(
      delivery.deliveryId,
      { status: "pending", deliveredAt: undefined },
      { guard: ["inflight"] },
    );
    if (reverted) return { claimed: true, handedOff: false, delivery: reverted };
    log.error(`Failed to revert ${operation.toLowerCase()} ${delivery.deliveryId} to pending`);
  } catch (err) {
    log.error(`Failed to revert ${operation.toLowerCase()} ${delivery.deliveryId} to pending:`, err);
  }
  return { claimed: true, handedOff: false, delivery: (await getDelivery(delivery.deliveryId)) ?? claimed };
}

/**
 * Settle an inflight delivery from its (possibly late) ack callback.
 * acked → delivered; unacked (timeout/disconnect) → pending so the next
 * register re-delivers (the CLI dedups by triggerId). Guarded on inflight so
 * a raced response/expiry/second settle wins cleanly.
 */
export async function settleDeliveryAck(deliveryId: string, acked: boolean): Promise<Delivery | null> {
  return updateDelivery(
    deliveryId,
    acked
      ? { status: "delivered", deliveredAt: new Date().toISOString() }
      : { status: "pending", deliveredAt: undefined },
    { guard: ["inflight"] },
  );
}

/**
 * Backstop sweep for deliveries stuck inflight (emitter crashed between claim
 * and settle). Rows older than the ack window go back to pending and are
 * re-delivered on the next register.
 */
export async function sweepStaleInflight(olderThanMs = 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const stale = await inflightDeliveries(cutoff);
  let swept = 0;
  for (const delivery of stale) {
    if (await updateDelivery(delivery.deliveryId, { status: "pending" }, { guard: ["inflight"] })) swept++;
  }
  return swept;
}

/**
 * Orphan spawn-intent sweep: an intent claimed inflight whose spawn never
 * resolved (emit reached no runner, or the spawning process died) would
 * otherwise haunt the fireId-dedup resume path forever. 60s covers the
 * longest legitimate spawn (10s ack + 15s TUI wait) with margin.
 */
export async function sweepUnresolvedSpawnIntents(olderThanMs = 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  let dropped = 0;
  for (const intent of await listUnresolvedSpawnIntents(cutoff)) {
    if (await deleteDelivery(intent.deliveryId)) {
      dropped++;
      log.warn(`Dropped unresolved spawn intent ${intent.deliveryId} (${intent.sessionId}, ${intent.status}) — spawn never resolved`);
    }
  }
  return dropped;
}

/**
 * Re-relay responses that were recorded while the SOURCE session was offline.
 * Called when that source session registers, next to drainPendingDeliveries.
 */
export async function drainPendingResponseRelays(sessionId: string, deps: EngineDeps): Promise<number> {
  const pending = await pendingResponseRelaysFor(sessionId);
  let relayed = 0;
  for (const delivery of pending) {
    const event = await getEvent(delivery.eventId);
    if (!event) continue;
    try {
      if (await deps.relayResponse(delivery, event)) {
        const cleared = await updateDelivery(delivery.deliveryId, { responseRelayPending: undefined });
        if (cleared) relayed++;
      }
    } catch (err) {
      log.error(`Response relay drain failed for ${delivery.deliveryId}:`, err);
    }
  }
  if (relayed > 0) log.info(`Relayed ${relayed} pending response(s) to source session ${sessionId}`);
  return relayed;
}

/**
 * Resolve a claimed spawn-intent delivery row to the real spawned session
 * (placeholder `spawn:<routeId>:<eventId>` → sessionId, back to pending for
 * the normal claim-and-deliver flow). Returns null when the spawned session
 * already has a delivery for this event (the intent row is dropped) or the
 * claim guard was lost.
 */
async function resolveSpawnIntent(intent: Delivery, sessionId: string): Promise<Delivery | null> {
  try {
    const resolved = await updateDelivery(
      intent.deliveryId,
      { sessionId, status: "pending", spawnRouteId: undefined },
      { guard: ["inflight"] },
    );
    if (resolved) return resolved;
    log.error(`Spawn intent ${intent.deliveryId} lost its inflight guard before resolution`);
    return null;
  } catch (err) {
    // unique(eventId, sessionId): the target already has a delivery for this
    // event — drop the placeholder instead of failing the publish.
    log.warn(`Spawn intent ${intent.deliveryId} resolved onto an already-delivered session — dropping:`, err);
    await deleteDelivery(intent.deliveryId).catch(() => {});
    return null;
  }
}

/** Execute one planned spawn: claim the intent row (so a concurrent
 *  duplicate-fireId resume cannot double-spawn), run the side effect, resolve
 *  the intent to the real sessionId, and hand the delivery to the fresh
 *  session. */
async function runSpawn(
  intent: Delivery,
  route: Route | null,
  event: TriggerEvent,
  deps: EngineDeps,
  spawnedSessions: string[],
  settled: Delivery[],
  operation: string,
): Promise<void> {
  // Claim pending → inflight BEFORE the spawn side effect: the loser of a
  // concurrent duplicate fire skips instead of spawning twice.
  const claimed = await updateDelivery(intent.deliveryId, { status: "inflight" }, { guard: ["pending"] });
  if (!claimed) return;
  const spawnRouteId = intent.spawnRouteId!;
  const routeToUse = route ?? (await getRoute(spawnRouteId).catch(() => null));
  if (!routeToUse || routeToUse.target.kind !== "spawn") {
    log.error(`Spawn route ${spawnRouteId} for event ${event.eventId} is gone — dropping intent ${intent.deliveryId}`);
    await deleteDelivery(intent.deliveryId).catch(() => {});
    return;
  }
  const sessionId = await deps.spawn(routeToUse, event).catch((err) => {
    log.error(`${operation} spawn failed for route ${spawnRouteId} (event ${event.eventId}):`, err);
    return null;
  });
  if (!sessionId) {
    log.error(`${operation} spawn failed for route ${spawnRouteId} (event ${event.eventId})`);
    await deleteDelivery(intent.deliveryId).catch(() => {});
    return;
  }
  spawnedSessions.push(sessionId);
  const resolved = await resolveSpawnIntent(intent, sessionId);
  if (!resolved) return;
  const attempt = await claimAndDeliver(resolved, event, routeToUse, deps, `${operation} delivery`);
  settled.push(attempt.delivery);
}

/**
 * Publish an Event: plan routes + targets, persist the event and ALL its
 * delivery rows in ONE transaction, and only then run side effects
 * (spawn / emit / wake). A crash between the claim and the side effects leaves
 * a complete, resumable plan — a retry with the same fireId resumes it
 * instead of deduping to nothing.
 * `extraTargets` supports the implicit direct route (fire at one session).
 *
 * Per-source FIFO: publishes from the same source run through a per-source
 * promise chain so their delivery dispatch is serialized in publish order
 * (the seq assigned in the tx matches this order). Different sources run
 * concurrently; register-time drains are NOT chained (guarded claims make
 * overlap safe — ordering between a drain and a publish is best-effort).
 */
// ponytail: in-process map — multi-node publish ordering would need a
// distributed per-source lock (SQLite BEGIN IMMEDIATE could serve). Ceiling:
// two relay nodes receiving publishes from the same source may interleave.
const sourcePublishChains = new Map<string, Promise<unknown>>();

export async function publishEvent(
  input: PublishEventInput,
  source: SourceIdentity,
  deps: EngineDeps,
  extraTargets?: Array<{ sessionId: string; deliverAs?: "steer" | "followUp"; wake?: boolean }>,
): Promise<PublishOutcome> {
  if (!isValidEventType(input.type)) {
    throw new Error(`Invalid event type "${input.type}" — must be namespaced like "github:pr_comment"`);
  }

  const prev = sourcePublishChains.get(source.id) ?? Promise.resolve();
  const run = prev.then(() => publishEventUnchained(input, source, deps, extraTargets));
  // Swallow rejections for the chain tail so a failed publish never poisons
  // the source's future publishes; the original caller still sees the error.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  sourcePublishChains.set(source.id, tail);
  try {
    return await run;
  } finally {
    // Drop the chain entry once it is the settled tail — nothing queued behind
    // it, so the map cannot grow per source forever.
    if (sourcePublishChains.get(source.id) === tail) sourcePublishChains.delete(source.id);
  }
}

async function publishEventUnchained(
  input: PublishEventInput,
  source: SourceIdentity,
  deps: EngineDeps,
  extraTargets?: Array<{ sessionId: string; deliverAs?: "steer" | "followUp"; wake?: boolean }>,
): Promise<PublishOutcome> {
  // Route matching only reads type/payload/source — run it against the input
  // so the whole plan can be persisted before the event exists.
  const provisional: TriggerEvent = {
    eventId: "",
    type: input.type,
    source,
    payload: input.payload ?? {},
    ts: "",
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.responseContract ? { responseContract: input.responseContract } : {}),
  };
  const matched = matchRoutes(provisional, await listRoutes({ eventType: input.type }));
  const plan = planDeliveries(matched);

  const ttlMs = input.responseContract?.ttlMs;
  const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined;
  const implicitRoute = (t: { sessionId: string; deliverAs?: "steer" | "followUp"; wake?: boolean }): Route => ({
    routeId: "",
    eventType: input.type,
    target: { kind: "session", sessionId: t.sessionId, ...(t.wake ? { wake: true } : {}) },
    deliverAs: t.deliverAs ?? "steer",
    origin: "api",
    createdAt: "",
  });

  // Delivery plan, all rows pending, keyed for post-commit dispatch.
  // ponytail: a wake flag on a direct extraTarget lives only in this map — a
  // crash-before-emit resume delivers without re-waking (routes are durable,
  // direct wake targets are not).
  const dispatch = new Map<string, { route: Route | null; supersedePendingWake?: boolean }>();
  const planRows: PlannedDelivery[] = [];
  for (const s of plan.sessions) {
    planRows.push({ sessionId: s.sessionId, routeId: s.route.routeId, deliverAs: s.route.deliverAs, expiresAt });
    dispatch.set(s.sessionId, { route: s.route });
  }
  for (const sp of plan.spawns) {
    planRows.push({ sessionId: "", spawnRouteId: sp.routeId, deliverAs: sp.deliverAs, expiresAt });
    dispatch.set(sp.routeId, { route: sp });
  }
  for (const t of extraTargets ?? []) {
    planRows.push({ sessionId: t.sessionId, deliverAs: t.deliverAs ?? "steer", expiresAt });
    // Direct fires are implicit single-session Routes; the synthetic route
    // carries the wake flag through to the delivery executor.
    dispatch.set(t.sessionId, { route: t.wake ? implicitRoute(t) : null, supersedePendingWake: t.wake === true });
  }

  // Transactional publish: event + all planned delivery rows commit atomically.
  const { event, created, deliveries } = await insertEventWithPlan(
    {
      type: input.type,
      source,
      payload: input.payload ?? {},
      summary: input.summary,
      responseContract: input.responseContract,
    },
    input.fireId,
    planRows,
  );

  if (!created) {
    // fireId dedup: the original publish already planned this event. Resume
    // whatever a crash left unfinished (unresolved spawn intents, pending
    // handoffs) instead of returning immediately.
    return resumeUnfinished(event, deliveries, deps);
  }

  const spawnedSessions: string[] = [];
  const settled: Delivery[] = [];
  for (const delivery of deliveries) {
    const info = delivery.spawnRouteId ? dispatch.get(delivery.spawnRouteId) : dispatch.get(delivery.sessionId);
    if (delivery.spawnRouteId) {
      // Spawn side effect runs only after the intent row is durable.
      await runSpawn(delivery, info?.route ?? null, event, deps, spawnedSessions, settled, "Spawn");
      continue;
    }
    if (info?.supersedePendingWake) {
      // ponytail: repeated offline schedule wakes keep only the latest fire.
      await expirePendingDeliveries({
        sessionId: delivery.sessionId,
        eventType: event.type,
        exceptDeliveryId: delivery.deliveryId,
      });
    }
    const attempt = await claimAndDeliver(delivery, event, info?.route ?? null, deps, "Delivery");
    settled.push(attempt.delivery);
  }

  return { event, created, deliveries: settled, spawnedSessions };
}

/**
 * fireId-dedup resume: re-run side effects a crash interrupted after the
 * transactional publish committed. Unresolved spawn intents spawn now and
 * resolve; pending rows re-attempt the handoff; settled rows are untouched.
 */
async function resumeUnfinished(
  event: TriggerEvent,
  deliveries: Delivery[],
  deps: EngineDeps,
): Promise<PublishOutcome> {
  const spawnedSessions: string[] = [];
  const settled: Delivery[] = [];
  for (const delivery of deliveries) {
    if (delivery.spawnRouteId && delivery.sessionId.startsWith("spawn:")) {
      await runSpawn(delivery, null, event, deps, spawnedSessions, settled, "Resumed spawn");
      continue;
    }
    if (delivery.status === "pending") {
      // The crash interrupted the emit — re-attempt the handoff.
      const route = delivery.routeId ? await getRoute(delivery.routeId).catch(() => null) : null;
      const attempt = await claimAndDeliver(delivery, event, route, deps, "Resumed delivery");
      settled.push(attempt.delivery);
      continue;
    }
    // Already handed off or settled (inflight/delivered/responded/…) — untouched.
    settled.push(delivery);
  }
  if (spawnedSessions.length > 0 || settled.length > 0) {
    log.info(`Resumed ${spawnedSessions.length} spawn(s) for deduped event ${event.eventId}`);
  }
  return { event, created: false, deliveries: settled, spawnedSessions };
}

/**
 * Drain a session's pending deliveries (FIFO) through the delivery executor.
 * Called when a session registers — pending events queued while it was
 * offline (or while a wake was in flight) deliver now.
 */
export async function drainPendingDeliveries(sessionId: string, deps: EngineDeps): Promise<number> {
  const pending = await pendingDeliveriesFor(sessionId);
  let drained = 0;
  for (const delivery of pending) {
    const event = await getEvent(delivery.eventId);
    if (!event) {
      await updateDelivery(delivery.deliveryId, { status: "expired" });
      drained++;
      continue;
    }
    const attempt = await claimAndDeliver(delivery, event, null, deps, "Drain of delivery");
    if (attempt.claimed && attempt.handedOff) drained++;
    // unsuccessful deliveries are reverted to pending for the next register
  }
  if (drained > 0) log.info(`Drained ${drained} pending delivery(ies) to session ${sessionId}`);
  return drained;
}

/**
 * Escalation sweep: find deliveries whose response-contract TTL lapsed and
 * push each one hop up the chain. Re-routed deliveries get a fresh delivery
 * to the parent; the original is marked escalated (or expired at chain end
 * or when the contract opted out of escalation).
 */
export async function sweepExpiredContracts(deps: EngineDeps, now = new Date()): Promise<number> {
  const expired = await expiredContractDeliveries(now);
  let handled = 0;
  for (const delivery of expired) {
    const event = await getEvent(delivery.eventId);
    if (!event) {
      await updateDelivery(delivery.deliveryId, { status: "expired" }, { guard: ["pending", "inflight", "delivered"] });
      continue;
    }
    if (event.responseContract?.escalate === false) {
      await updateDelivery(delivery.deliveryId, { status: "expired" }, { guard: ["pending", "inflight", "delivered"] });
      handled++;
      continue;
    }
    try {
      // Re-read immediately before the side effect: a response that raced the
      // expiry query must not trigger a human push.
      const current = await getDelivery(delivery.deliveryId);
      if (!current || (current.status !== "pending" && current.status !== "inflight" && current.status !== "delivered")) continue;
      const nextSessionId = await deps.escalate(current, event);
      // Guard = [pending, inflight, delivered]: a response that raced the
      // sweep wins — never clobber a responded row or double-escalate it.
      const won = await updateDelivery(
        delivery.deliveryId,
        { status: nextSessionId ? "escalated" : "expired" },
        { guard: ["pending", "inflight", "delivered"] },
      );
      if (!won) continue;
      if (nextSessionId) {
        const next = await createDelivery({
          eventId: event.eventId,
          eventType: event.type,
          sessionId: nextSessionId,
          deliverAs: "steer",
          expiresAt: event.responseContract?.ttlMs
            ? new Date(now.getTime() + event.responseContract.ttlMs).toISOString()
            : undefined,
        });
        if (next) {
          await claimAndDeliver(next, event, null, deps, "Escalation delivery");
        } else {
          log.warn(
            `Escalation parent ${nextSessionId} already has a delivery for event ${event.eventId} ` +
            `(from ${delivery.deliveryId})`,
          );
        }
      }
      handled++;
    } catch (err) {
      log.error(`Escalation failed for delivery ${delivery.deliveryId}:`, err);
    }
  }
  return handled;
}
