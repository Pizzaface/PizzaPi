/**
 * Unified trigger system HTTP surface (ADR-0002).
 *
 *   POST   /api/events                    — publish an Event (the one fire path)
 *   GET    /api/events                    — global feed (type/before/limit)
 *   GET    /api/events/:id/deliveries     — deliveries for one event
 *   POST   /api/deliveries/:id/response   — answer a contract-bearing delivery
 *   GET    /api/sessions/:id/deliveries   — per-session delivery view
 *   GET    /api/routes                    — list routes (eventType filter)
 *   POST   /api/routes                    — create a route
 *   PUT    /api/routes/:id                — update (config routes are read-only)
 *   DELETE /api/routes/:id                — delete (config routes are read-only)
 *   DELETE /api/runners/:id/routes        — bulk-delete every route stamped with a runner
 *
 * Auth: session cookie or API key, normalized into a SourceIdentity.
 */

import type { DeliveryView, PublishEventInput, ResponseContract, RouteInput, SourceIdentity, TriggerEvent } from "@pizzapi/protocol";
import type { Delivery } from "@pizzapi/protocol";
import { isRouteTarget, isValidEventType } from "@pizzapi/protocol";
import { createLogger } from "@pizzapi/tools";
import { requireSession, validateApiKey } from "../middleware.js";
import { broadcastToSessionViewers, getSharedSession } from "../ws/sio-registry.js";
import { publishEvent } from "../events/engine.js";
import { createEngineDeps, emitDeliveryResponseRelay } from "../events/transport.js";
import {
  createRoute,
  deleteRoute,
  deliveriesForEvents,
  eventsForIds,
  getDelivery,
  getEvent,
  getEventByFireId,
  getRoute,
  listDeliveries,
  listEvents,
  listRoutes,
  updateDelivery,
  updateRoute,
} from "../events/store.js";
import { resolveSessionRunner, resolveSessionOwner, sessionOwnerUnresolvable } from "../sessions/ownership.js";
import { recordTriggerResponse } from "../sessions/trigger-store.js";
import { emitTriggerSubscriptionDelta } from "../ws/namespaces/runner.js";
import { getRunnerData } from "../ws/sio-registry/runners.js";
import { getRunnerOwner } from "../runner-owner.js";
import { routeToSubscription } from "../events/reconcile.js";
import { runnerDeadSince } from "../events/runner-liveness.js";
import type { Route } from "@pizzapi/protocol";
import type { RouteHandler } from "./types.js";

const log = createLogger("events-api");

async function authenticate(req: Request): Promise<{ userId: string; userName: string } | Response> {
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) return validateApiKey(req, apiKey);
  return requireSession(req);
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

/**
 * Stamp UI view fields onto deliveries: `respondable` mirrors the respond
 * endpoint's guard (contract present, not yet responded — expired/escalated
 * stay answerable, better late), `actions` drives one button per declared
 * action. One batched event lookup per request — no per-delivery queries.
 */
function annotateDeliveries(
  deliveries: Delivery[],
  contracts: Map<string, ResponseContract | undefined>,
): DeliveryView[] {
  return deliveries.map((d) => {
    const contract = contracts.get(d.eventId);
    return {
      ...d,
      respondable: !!contract && d.status !== "responded",
      ...(contract?.actions ? { actions: contract.actions } : {}),
    };
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validatePublishFields(body: Record<string, unknown>): string | null {
  if (body.payload !== undefined && !isPlainObject(body.payload)) return "payload must be a plain object";
  if (body.summary !== undefined && typeof body.summary !== "string") return "summary must be a string";
  if (body.fireId !== undefined && (typeof body.fireId !== "string" || body.fireId.length === 0)) {
    return "fireId must be a non-empty string";
  }

  if (body.responseContract !== undefined) {
    if (!isPlainObject(body.responseContract)) return "responseContract must be an object";
    const contract = body.responseContract;
    if (
      contract.ttlMs !== undefined &&
      (typeof contract.ttlMs !== "number" || !Number.isFinite(contract.ttlMs) || contract.ttlMs <= 0)
    ) {
      return "responseContract.ttlMs must be a finite number greater than zero";
    }
    if (contract.actions !== undefined && (!Array.isArray(contract.actions) || !contract.actions.every((a) => typeof a === "string"))) {
      return "responseContract.actions must be an array of strings";
    }
    if (contract.escalate !== undefined && typeof contract.escalate !== "boolean") {
      return "responseContract.escalate must be a boolean";
    }
  }

  if (body.target !== undefined) {
    if (!isPlainObject(body.target)) return "target must be an object";
    if (body.target.deliverAs !== undefined && body.target.deliverAs !== "steer" && body.target.deliverAs !== "followUp") {
      return "target.deliverAs must be steer | followUp";
    }
  }

  if (body.source !== undefined) {
    if (!isPlainObject(body.source)) return "source must be an object";
    const source = body.source;
    if (
      source.kind !== undefined &&
      source.kind !== "session" && source.kind !== "service" && source.kind !== "scheduler" && source.kind !== "api"
    ) {
      return "source.kind must be session | service | scheduler | api";
    }
    if (source.id !== undefined && typeof source.id !== "string") return "source.id must be a string";
    if (source.name !== undefined && typeof source.name !== "string") return "source.name must be a string";
    if (source.kind === "session" && (typeof source.id !== "string" || source.id.length === 0)) {
      return "source.id is required for session sources";
    }
  }

  return null;
}

function isFilterValue(value: unknown): boolean {
  const isScalar = (item: unknown) =>
    typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item));
  return Array.isArray(value) ? value.every(isScalar) : isScalar(value);
}

/** Validate mutable Route fields before they can reach durable route matching. */
export function validateRouteFields(patch: unknown): string | null {
  if (!isPlainObject(patch)) return "Route body must be an object";
  if (patch.eventType !== undefined && !isValidEventType(patch.eventType)) return "Invalid eventType";
  if (patch.deliverAs !== undefined && patch.deliverAs !== "steer" && patch.deliverAs !== "followUp") {
    return "deliverAs must be steer | followUp";
  }
  if (patch.filters !== undefined) {
    if (!Array.isArray(patch.filters)) return "filters must be an array";
    for (const filter of patch.filters) {
      if (!isPlainObject(filter) || typeof filter.field !== "string" || filter.field.length === 0) {
        return "filters must have a non-empty string field";
      }
      if (!isFilterValue(filter.value)) return "filters must have a valid value";
      if (filter.op !== undefined && filter.op !== "eq" && filter.op !== "contains") {
        return "filters op must be eq | contains";
      }
      if (filter.caseSensitive !== undefined && typeof filter.caseSensitive !== "boolean") {
        return "filters caseSensitive must be a boolean";
      }
    }
  }
  if (patch.filterMode !== undefined && patch.filterMode !== "and" && patch.filterMode !== "or") {
    return "filterMode must be and | or";
  }
  if (patch.params !== undefined && !isPlainObject(patch.params)) return "params must be a plain object";
  if (patch.promptTemplate !== undefined && typeof patch.promptTemplate !== "string") {
    return "promptTemplate must be a string";
  }
  if (patch.disabled !== undefined && typeof patch.disabled !== "boolean") return "disabled must be a boolean";
  return null;
}

/** Verify the caller owns the referenced session (404 shape — never leak existence). */
async function ownsSession(sessionId: string, userId: string): Promise<boolean> {
  const session = await getSharedSession(sessionId);
  return !!session && session.userId === userId;
}

/**
 * Stamp a session-target route with its owning runner so runner-scoped reads
 * (reconcile snapshots, schedule listings, wake ownership) resolve without a
 * live session. Skipped when the session's runner is unknown — the route is
 * unreachable until the session registers anyway.
 */
async function withSessionRunnerId(
  target: Extract<RouteInput["target"], { kind: "session" }>,
  userId: string,
): Promise<
  | { ok: true; target: Extract<RouteInput["target"], { kind: "session" }> }
  | { ok: false; error: string }
> {
  const resolved = await resolveSessionRunner(target.sessionId).catch(() => null);
  if (resolved?.runnerId) {
    if (target.runnerId !== undefined && target.runnerId !== resolved.runnerId) {
      return { ok: false, error: "runnerId does not match session" };
    }
    return { ok: true, target: { ...target, runnerId: resolved.runnerId } };
  }

  // The session has no resolvable runner (e.g. a relay-only session). A
  // caller-provided runner is honored only when the caller owns it — a
  // session route stamped with someone else's runner would push reconcile
  // deltas/schedules onto that runner.
  if (target.runnerId !== undefined) {
    const live = await getRunnerData(target.runnerId).catch(() => null);
    const owner = live?.userId ?? (await getRunnerOwner(target.runnerId));
    if (owner !== userId) return { ok: false, error: "Runner not found or not owned by you" };
    return { ok: true, target };
  }
  return { ok: true, target };
}

/**
 * Validate a route target for the caller and stamp it for durable ownership:
 * spawn targets must reference a runner owned by the caller and carry the
 * creator's userId (transport fails closed on reclaimed runners); session
 * targets must be owned by the caller and get their runner stamped so
 * runner-scoped reads (reconcile, wake) resolve offline. Used by both POST
 * and PUT — the PUT path previously skipped all of this (any route owner
 * could re-target any runner), which was a cross-tenant spawn hole.
 */
async function validateAndStampTarget(
  target: RouteInput["target"],
  userId: string,
): Promise<{ ok: true; target: RouteInput["target"] } | { ok: false; status: number; error: string }> {
  if (target.kind === "spawn") {
    const runner = await getRunnerData(target.spec.runnerId).catch(() => null);
    if (!runner || runner.userId !== userId) {
      return { ok: false, status: 404, error: "Runner not found or not owned by you" };
    }
    return { ok: true, target: { ...target, spec: { ...target.spec, ownerUserId: userId } } };
  }
  if (!(await ownsSession(target.sessionId, userId))) {
    return { ok: false, status: 404, error: "Session not found or not connected" };
  }
  const stamped = await withSessionRunnerId(target, userId);
  if (!stamped.ok) return { ok: false, status: /not found/i.test(stamped.error) ? 404 : 400, error: stamped.error };
  return stamped;
}

/**
 * Feed visibility: an Event is visible to the caller when they are its source
 * (their session or their own api-source identity) or when one of its
 * deliveries targets a session they own. Without scoping, any authenticated
 * user could read every other user's event payloads.
 * ponytail: ownership lookups are per unique sessionId — cache if the feed
 * ever sits behind a hot multi-user path.
 */
async function userCanSeeEvent(event: TriggerEvent, user: { userId: string; userName: string }, cache: Map<string, boolean>): Promise<boolean> {
  if (event.source.kind === "session") {
    const key = `src:${event.source.id}`;
    let owned = cache.get(key);
    if (owned === undefined) {
      owned = (await resolveSessionOwner(event.source.id, user.userId).catch(() => null)) !== null;
      cache.set(key, owned);
    }
    if (owned) return true;
  }
  // Tenant scope: the authenticated owner stamped at publish (immutable id,
  // never the mutable userName).
  if (event.source.userId !== undefined && event.source.userId === user.userId) return true;
  return false;
}

/** True when any of the session ids is owned by the user (results cached). */
async function hasOwnedSession(sessionIds: string[], userId: string, cache: Map<string, boolean>): Promise<boolean> {
  const unknown = [...new Set(sessionIds)].filter((id) => !cache.has(id));
  await Promise.all(
    unknown.map(async (id) => {
      cache.set(id, (await resolveSessionOwner(id, userId).catch(() => null)) !== null);
    }),
  );
  return sessionIds.some((id) => cache.get(id) === true);
}

/** Notify the target session's runner of a route change (reconcile delta). */
async function notifyRouteChange(action: "subscribe" | "update" | "unsubscribe", route: Route): Promise<void> {
  const entry = routeToSubscription(route);
  if (!entry) return;
  try {
    await emitTriggerSubscriptionDelta(entry.runnerId, { action, subscription: entry });
  } catch (err) {
    log.error(`Route ${route.routeId}: reconcile delta (${action}) failed:`, err);
  }
}

/** The runner a route is stamped with (spawn spec or session target), if any. */
function routeRunnerId(route: Route): string | undefined {
  return route.target.kind === "spawn" ? route.target.spec.runnerId : route.target.runnerId;
}

/** Whether an active subscription must be removed from its old target first. */
function sessionTargetChanged(existing: Route, updated: Route): boolean {
  if (existing.target.kind !== "session") return false;
  return updated.target.kind !== "session"
    || existing.target.sessionId !== updated.target.sessionId
    || existing.target.runnerId !== updated.target.runnerId;
}

/**
 * Ownership for route management: session targets resolve through live →
 * persisted → durable-owner fallbacks (schedules outlive their sessions);
 * spawn routes belong to their stamped creator or the runner's owner.
 */
async function canManageRoute(route: Route, userId: string): Promise<boolean> {
  // Tenant scope wins outright; the fallbacks below only serve legacy rows
  // whose owner could not be backfilled.
  if (route.ownerUserId !== undefined) return route.ownerUserId === userId;
  if (route.target.kind === "spawn") {
    if (route.target.spec.ownerUserId) return route.target.spec.ownerUserId === userId;
    // Live runner state is Redis-only (TTL'd, deleted on disconnect) — offline
    // runners fall back to the durable owner record so their routes never
    // become unmanageable. A runner that never registered since the durable
    // table landed is the only unresolvable case.
    const runner = await getRunnerData(route.target.spec.runnerId).catch(() => null);
    if (runner) return runner.userId === userId;
    const owner = await getRunnerOwner(route.target.spec.runnerId);
    // Ownerless orphan (runner never registered since runner_owner landed):
    // manageable by any authenticated user — the alternative is a route that
    // fires forever with no way to cancel it.
    return owner === null || owner === userId;
  }
  if ((await resolveSessionOwner(route.target.sessionId, userId)) !== null) return true;
  return sessionOwnerUnresolvable(route.target.sessionId);
}

export const handleEventsRoute: RouteHandler = async (req, url) => {
  // ── POST /api/events ───────────────────────────────────────────────────────
  if (url.pathname === "/api/events" && req.method === "POST") {
    const identity = await authenticate(req);
    if (identity instanceof Response) return identity;

    let parsedBody: unknown;
    try {
      parsedBody = await req.json();
    } catch {
      return badRequest("Invalid JSON body");
    }
    if (!isPlainObject(parsedBody)) return badRequest("Event body must be an object");
    const validationError = validatePublishFields(parsedBody);
    if (validationError) return badRequest(validationError);
    const body = parsedBody as unknown as PublishEventInput & {
      source?: { kind?: "session" | "service" | "scheduler" | "api"; id?: string; name?: string };
      target?: { sessionId?: string; deliverAs?: "steer" | "followUp"; wake?: boolean };
    };
    if (typeof body.type !== "string") return badRequest("Missing event type");

    const viaApiKey = !!req.headers.get("x-api-key");
    // Session-kind sources must actually belong to the caller — otherwise any
    // authenticated user could publish as someone else's session and steer the
    // response relay at it. Service/scheduler kinds are feed labels only.
    if (body.source?.kind === "session" && typeof body.source.id === "string") {
      if ((await resolveSessionOwner(body.source.id, identity.userId).catch(() => null)) === null) {
        return Response.json({ error: "Source session not found or not owned by you" }, { status: 403 });
      }
    }
    const source: SourceIdentity = {
      kind: body.source?.kind === "session" ? "session" : body.source?.kind === "service" ? "service" : body.source?.kind === "scheduler" ? "scheduler" : "api",
      id: body.source?.id ?? identity.userName,
      ...(body.source?.name ? { name: body.source.name } : {}),
      auth: viaApiKey ? "api-key" : "cookie",
      // Tenant scope — from the principal, never the body.
      userId: identity.userId,
    };

    // Implicit direct route: ownership-checked before delivery. Wake fires
    // (schedules) use tolerant ownership — the target session may be offline
    // or fully pruned while its schedule lives on (ADR-0002).
    let extraTargets: Array<{ sessionId: string; deliverAs?: "steer" | "followUp"; wake?: boolean }> | undefined;
    if (body.target?.sessionId) {
      const targetSessionId = body.target.sessionId;
      const owned = body.target.wake === true
        ? (await resolveSessionOwner(targetSessionId, identity.userId)) !== null
        : await ownsSession(targetSessionId, identity.userId);
      if (!owned) {
        return Response.json({ error: "Session not found or not connected" }, { status: 404 });
      }
      extraTargets = [{
        sessionId: targetSessionId,
        deliverAs: body.target.deliverAs,
        ...(body.target.wake === true ? { wake: true } : {}),
      }];
    }

    try {
      const outcome = await publishEvent(
        { type: body.type, payload: body.payload, summary: body.summary, responseContract: body.responseContract, fireId: body.fireId },
        source,
        createEngineDeps(),
        extraTargets,
      );
      return Response.json({
        ok: true,
        eventId: outcome.event.eventId,
        created: outcome.created,
        deliveries: outcome.deliveries.map((d) => ({ deliveryId: d.deliveryId, sessionId: d.sessionId, status: d.status })),
        spawnedSessions: outcome.spawnedSessions,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Publish failed";
      if (/Invalid event type/.test(message)) return badRequest(message);
      log.error("Publish failed:", err);
      return Response.json({ error: "Publish failed" }, { status: 500 });
    }
  }

  // ── GET /api/events ────────────────────────────────────────────
  if (url.pathname === "/api/events" && req.method === "GET") {
    const identity = await authenticate(req);
    if (identity instanceof Response) return identity;
    const limitRaw = url.searchParams.get("limit");
    const parsedLimit = limitRaw === null ? NaN : Number(limitRaw);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(500, Math.max(1, Math.trunc(parsedLimit)))
      : undefined;
    const events = await listEvents({
      type: url.searchParams.get("type") ?? undefined,
      before: url.searchParams.get("before") ?? undefined,
      limit,
    });
    // Scope the feed: events the caller sourced, plus events with a delivery
    // into a session they own. Cross-user payloads never leave the server.
    const deliveries = await deliveriesForEvents(events.map((e) => e.eventId));
    const byEvent = new Map<string, string[]>();
    for (const d of deliveries) {
      const list = byEvent.get(d.eventId);
      if (list) list.push(d.sessionId);
      else byEvent.set(d.eventId, [d.sessionId]);
    }
    const ownership = new Map<string, boolean>();
    const visible: typeof events = [];
    for (const event of events) {
      if (await userCanSeeEvent(event, identity, ownership)) {
        visible.push(event);
        continue;
      }
      const targets = byEvent.get(event.eventId) ?? [];
      const owned = await hasOwnedSession(targets, identity.userId, ownership);
      if (owned) visible.push(event);
    }
    return Response.json({ events: visible });
  }

  // ── GET /api/events/:id/deliveries ─────────────────────────────────────────
  const eventDeliveries = url.pathname.match(/^\/api\/events\/([^/]+)\/deliveries$/);
  if (eventDeliveries && req.method === "GET") {
    const identity = await authenticate(req);
    if (identity instanceof Response) return identity;
    const eventId = decodeURIComponent(eventDeliveries[1]);
    const event = await getEvent(eventId);
    if (!event) return Response.json({ error: "Event not found" }, { status: 404 });
    const allForVisibility = await deliveriesForEvents([eventId]);
    const ownership = new Map<string, boolean>();
    const canSee = await userCanSeeEvent(event, identity, ownership)
      || await hasOwnedSession(allForVisibility.map((delivery) => delivery.sessionId), identity.userId, ownership);
    if (!canSee) return Response.json({ error: "Event not found" }, { status: 404 });

    const all = await listDeliveries({ eventId });
    // Only deliveries into sessions the caller can see — never hand another
    // user's session ids over.
    const visible: typeof all = [];
    for (const d of all) {
      if (await hasOwnedSession([d.sessionId], identity.userId, ownership)) visible.push(d);
    }
    return Response.json({ deliveries: annotateDeliveries(visible, new Map([[eventId, event.responseContract]])) });
  }

  // ── GET /api/sessions/:id/deliveries ───────────────────────────────────────
  const sessionDeliveries = url.pathname.match(/^\/api\/sessions\/([^/]+)\/deliveries$/);
  if (sessionDeliveries && req.method === "GET") {
    const identity = await authenticate(req);
    if (identity instanceof Response) return identity;
    const sessionId = decodeURIComponent(sessionDeliveries[1]);
    if (!(await ownsSession(sessionId, identity.userId))) {
      return Response.json({ error: "Session not found or not connected" }, { status: 404 });
    }
    const deliveries = await listDeliveries({ sessionId });
    const events = await eventsForIds(deliveries.map((d) => d.eventId));
    return Response.json({
      deliveries: annotateDeliveries(deliveries, new Map(events.map((e) => [e.eventId, e.responseContract]))),
    });
  }

  // ── Routes CRUD ────────────────────────────────────────────────────────────
  if (url.pathname === "/api/routes" && req.method === "GET") {
    const identity = await authenticate(req);
    if (identity instanceof Response) return identity;
    const all = await listRoutes({ eventType: url.searchParams.get("eventType") ?? undefined });
    // Scope the list to what this user can manage — the same predicate
    // DELETE/PUT enforce, so every listed route is actually actionable.
    // (canManageRoute short-circuits on ownerUserId; the per-route fallbacks
    // only run for legacy ownerless rows.)
    const manageable = await Promise.all(all.map((r) => canManageRoute(r, identity.userId)));
    const visible = all.filter((_, i) => manageable[i]);
    // Dead-runner flag (marker + no live presence), one lookup per runner.
    const deadSince = new Map<string, string | null>();
    for (const runnerId of new Set(visible.map(routeRunnerId).filter((id): id is string => !!id))) {
      deadSince.set(runnerId, await runnerDeadSince(runnerId).catch(() => null));
    }
    return Response.json({
      routes: visible.map((r) => {
        const since = deadSince.get(routeRunnerId(r) ?? "");
        return since ? { ...r, runnerDead: true, runnerDeadSince: since } : r;
      }),
    });
  }

  // ── DELETE /api/runners/:runnerId/routes ── bulk cleanup (dead runners) ────
  const runnerRoutes = url.pathname.match(/^\/api\/runners\/([^/]+)\/routes$/);
  if (runnerRoutes && req.method === "DELETE") {
    const identity = await authenticate(req);
    if (identity instanceof Response) return identity;
    const runnerId = decodeURIComponent(runnerRoutes[1]);
    // Owner auth: live runner state, then the durable owner record. An
    // ownerless runner (never registered since runner_owner landed) is
    // manageable by any authenticated user — same stance as canManageRoute,
    // otherwise its routes fire forever with no way to cancel them.
    const live = await getRunnerData(runnerId).catch(() => null);
    const owner = live?.userId ?? (await getRunnerOwner(runnerId));
    if (owner !== null && owner !== identity.userId) {
      return Response.json({ error: "Runner not found or not owned by you" }, { status: 404 });
    }
    const stamped = (await listRoutes()).filter((r) => routeRunnerId(r) === runnerId);
    // Config routes are read-only (deleteRoute throws); webhook routes belong
    // to the webhooks surface (their webhook row would dangle). Skip both,
    // report them, delete the rest.
    const deletable = stamped.filter((r) => r.origin !== "config" && !r.routeId.startsWith("rt_wh_"));
    let removed = 0;
    for (const route of deletable) {
      if (await deleteRoute(route.routeId)) {
        removed++;
        await notifyRouteChange("unsubscribe", route);
      }
    }
    return Response.json({ ok: true, removed, skipped: stamped.length - deletable.length });
  }

  if (url.pathname === "/api/routes" && req.method === "POST") {
    const identity = await authenticate(req);
    if (identity instanceof Response) return identity;
    let parsedBody: unknown;
    try {
      parsedBody = await req.json();
    } catch {
      return badRequest("Invalid JSON body");
    }
    const validationError = validateRouteFields(parsedBody);
    if (validationError) return badRequest(validationError);
    const body = parsedBody as Partial<RouteInput>;
    if (!isValidEventType(body.eventType) || !isRouteTarget(body.target)) {
      return badRequest("Route requires eventType and a valid target");
    }
    if (body.deliverAs !== "steer" && body.deliverAs !== "followUp") {
      return badRequest("Route requires deliverAs: steer | followUp");
    }
    if (body.origin === "config") return badRequest("Config routes come from the config file");
    const stamped = await validateAndStampTarget(body.target, identity.userId);
    if (!stamped.ok) return Response.json({ error: stamped.error }, { status: stamped.status });
    const route = await createRoute({
      ...body,
      eventType: body.eventType,
      target: stamped.target,
      deliverAs: body.deliverAs,
      origin: body.origin === "agent" ? "agent" : "ui",
      // Tenant scope is server-stamped; a client-supplied value is ignored.
      ownerUserId: identity.userId,
    });
    await notifyRouteChange("subscribe", route);
    return Response.json({ ok: true, route });
  }

  // ── POST /api/deliveries/:id/response ──────────────────────────────────

  const respondMatch = url.pathname.match(/^\/api\/deliveries\/([^/]+)\/response$/);
  if (respondMatch && req.method === "POST") {
    const identity = await authenticate(req);
    if (identity instanceof Response) return identity;

    let parsedBody: unknown;
    try {
      parsedBody = await req.json();
    } catch {
      return badRequest("Invalid JSON body");
    }
    if (!isPlainObject(parsedBody)) return badRequest("Response body must be an object");
    const body = parsedBody as { response?: string; action?: unknown };
    if (typeof body.response !== "string" || body.response.trim() === "") {
      return badRequest("Response text is required");
    }
    if (body.action !== undefined && typeof body.action !== "string") {
      return badRequest("action must be a string");
    }

    const deliveryId = decodeURIComponent(respondMatch[1]);
    const delivery = await getDelivery(deliveryId);
    if (!delivery || !(await ownsSession(delivery.sessionId, identity.userId))) {
      return Response.json({ error: "Delivery not found" }, { status: 404 });
    }
    if (delivery.status === "responded") {
      return Response.json({ error: "Delivery already responded" }, { status: 409 });
    }

    const event = await getEvent(delivery.eventId);
    if (!event) return Response.json({ error: "Event not found" }, { status: 404 });

    const contract = event.responseContract;
    if (!contract) return badRequest("Event has no response contract");
    if (contract.actions && body.action && !contract.actions.includes(body.action)) {
      return badRequest(`Invalid action "${body.action}" — allowed: ${contract.actions.join(", ")}`);
    }

    // Status-guarded: only one concurrent response wins; the loser gets 409
    // instead of double-relaying. Expired/escalated stays respondable (better
    // late) — recorded here rather than on the escalation copy. Inflight is
    // included: the CLI's ack settle could still be racing this response.
    const respondedAt = new Date().toISOString();
    const response = { action: body.action, text: body.response };
    const won = await updateDelivery(deliveryId, {
      status: "responded",
      respondedAt,
      response,
    }, { guard: ["pending", "inflight", "delivered", "expired", "escalated"] });
    if (!won) {
      return Response.json({ error: "Delivery already responded" }, { status: 409 });
    }

    // A human response to an escalation also resolves every still-open
    // Delivery for the original event. Otherwise its contract sweep can
    // escalate again after the answer has already been given.
    // The parent tracks received triggers by deliveryId (toWireEnvelope puts
    // the deliveryId in `triggerId`), so originalTriggerId is normally the
    // original DELIVERY id; legacy senders may pass the child's fireId.
    const originalTriggerId = typeof event.payload?.originalTriggerId === "string"
      ? event.payload.originalTriggerId
      : undefined;
    let originalDelivery: Awaited<ReturnType<typeof getDelivery>> = null;
    let originalEvent: Awaited<ReturnType<typeof getEvent>> = null;
    if (originalTriggerId) {
      originalDelivery = await getDelivery(originalTriggerId);
      originalEvent = originalDelivery
        ? await getEvent(originalDelivery.eventId)
        : await getEventByFireId(originalTriggerId);
      if (originalEvent) {
        const originalDeliveries = await deliveriesForEvents([originalEvent.eventId]);
        await Promise.all(originalDeliveries.map((original) => updateDelivery(original.deliveryId, {
          status: "responded",
          respondedAt,
          response,
        }, { guard: ["pending", "inflight", "delivered", "expired", "escalated"] })));
      }
    }

    // Keep the legacy trigger history and attention badge in sync with the
    // durable Delivery response. Redis/history failures must not undo it.
    void recordTriggerResponse(delivery.sessionId, deliveryId, response).catch((err) => {
      log.warn(`Delivery ${deliveryId}: failed to record legacy response:`, err);
    });
    try {
      broadcastToSessionViewers(delivery.sessionId, "trigger_delivered", { triggerId: deliveryId });
    } catch (err) {
      log.warn(`Delivery ${deliveryId}: failed to broadcast response:`, err);
    }

    // Session sources get the answer relayed back over the wire; the source
    // waiter matches on its own triggerId, which the publisher sent as fireId.
    // Correlation (session_complete parent ownership, escalation original
    // trigger ids) lives in emitDeliveryResponseRelay so the immediate relay
    // and the drain-on-source-registration path cannot drift.
    const relayed = await emitDeliveryResponseRelay(won ?? delivery, event).catch(() => false);
    if (event.source.kind === "session" && event.source.id && !relayed) {
      // The response is durable (responded) but the source was unreachable —
      // mark it for drainPendingResponseRelays on the source's next register.
      await updateDelivery(deliveryId, { responseRelayPending: true }, { guard: ["responded"] })
        .catch((err) => log.warn(`Delivery ${deliveryId}: failed to mark responseRelayPending:`, err));
    }

    log.info(`Delivery ${deliveryId} responded by session ${delivery.sessionId} (relayed: ${relayed})`);
    return Response.json({ ok: true, deliveryId, relayed });
  }

  const routeMatch = url.pathname.match(/^\/api\/routes\/([^/]+)$/);
  if (routeMatch && (req.method === "PUT" || req.method === "DELETE")) {
    const identity = await authenticate(req);
    if (identity instanceof Response) return identity;
    const routeId = decodeURIComponent(routeMatch[1]);
    const existing = await getRoute(routeId);
    if (!existing) return Response.json({ error: "Route not found" }, { status: 404 });
    // Route management must respect the route's owner: session targets resolve
    // through live/persisted/durable ownership (schedules outlive sessions);
    // spawn routes belong to their stamped creator or the runner's owner.
    if (!(await canManageRoute(existing, identity.userId))) {
      return Response.json({ error: "Route not found" }, { status: 404 });
    }
    try {
      if (req.method === "DELETE") {
        await deleteRoute(routeId);
        await notifyRouteChange("unsubscribe", existing);
        return Response.json({ ok: true });
      }
      let parsedPatch: unknown;
      try {
        parsedPatch = await req.json();
      } catch {
        return badRequest("Invalid JSON body");
      }
      // Read-only check BEFORE target validation so a 4xx error shape can't be
      // used to probe runner/session existence behind operator-managed routes.
      if (existing.origin === "config") {
        return Response.json({ error: "Config-origin routes are read-only; edit the config file" }, { status: 403 });
      }
      const validationError = validateRouteFields(parsedPatch);
      if (validationError) return badRequest(validationError);
      let patch = parsedPatch as Partial<RouteInput>;
      if (patch.target !== undefined) {
        if (!isRouteTarget(patch.target)) return badRequest("Invalid target");
        // Same validation + ownership stamping as POST — a PUT must never be
        // able to re-target a spawn route at a runner the caller doesn't own
        // (or drop the ownerUserId fail-closed stamp).
        const stamp = await validateAndStampTarget(patch.target as RouteInput["target"], identity.userId);
        if (!stamp.ok) return Response.json({ error: stamp.error }, { status: stamp.status });
        patch = { ...patch, target: stamp.target };
      }
      // ownerUserId is never client-writable; a legacy ownerless route gets
      // adopted by whoever can manage it (already verified above).
      const { ownerUserId: _ignored, ...safePatch } = patch as Partial<RouteInput> & { ownerUserId?: string };
      const updated = await updateRoute(routeId, { ...safePatch, ownerUserId: existing.ownerUserId ?? identity.userId });
      if (updated) {
        const wasDisabled = existing.disabled === true;
        const isDisabled = updated.disabled === true;
        if (!wasDisabled && isDisabled) {
          await notifyRouteChange("unsubscribe", existing);
        } else if (wasDisabled && !isDisabled) {
          await notifyRouteChange("subscribe", updated);
        } else if (!isDisabled) {
          if (sessionTargetChanged(existing, updated)) {
            await notifyRouteChange("unsubscribe", existing);
          }
          await notifyRouteChange("update", updated);
        }
      }
      return Response.json({ ok: true, route: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Route operation failed";
      if (/read-only/.test(message)) return Response.json({ error: message }, { status: 403 });
      throw err;
    }
  }

  return undefined;
};

