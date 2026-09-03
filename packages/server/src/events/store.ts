/**
 * Unified trigger system durable store (ADR-0002).
 *
 * SQLite is the source of truth for Events, Routes, and Deliveries.
 * Redis is used elsewhere for live queues/fan-out only — never durability.
 *
 * Guarantees implemented here:
 *   - fireId idempotency: republishing the same fireId returns the original event
 *   - exactly-once per (event, session): unique index makes duplicate
 *     delivery creation a no-op
 *   - time-boxed retention: pruneEvents() deletes events + their deliveries
 */

import crypto from "crypto";
import { sql } from "kysely";
import type {
  Delivery,
  DeliverAs,
  DeliveryStatus,
  Route,
  RouteInput,
  TriggerEvent,
} from "@pizzapi/protocol";
import { createLogger } from "@pizzapi/tools";
import { getKysely } from "../auth.js";

const log = createLogger("event-store");

const EVENT_TABLE = "trigger_event" as const;
const ROUTE_TABLE = "trigger_route" as const;
const DELIVERY_TABLE = "trigger_delivery" as const;

export const DEFAULT_RETENTION_DAYS = 30;

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(8).toString("base64url")}`;
}

function parseJson<T>(json: string, what: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    log.error(`Corrupt ${what} row:`, err);
    return null;
  }
}

// ── Schema ───────────────────────────────────────────────────────────────────

/** True when `table` already has `column` (SQLite pragma table-info probe).
 *  Replaces the old try/catch ALTER pattern: already-migrated databases logged
 *  a noisy "duplicate column name" warning on every boot, and the catch also
 *  swallowed genuine ALTER failures (locked/corrupt DB) as warnings. */
async function hasColumn(table: string, column: string): Promise<boolean> {
  const db = getKysely();
  const res = await db.executeQuery(sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.compile(db));
  return res.rows.some((r) => r.name === column);
}

export async function ensureEventTables(): Promise<void> {
  const db = getKysely();
  await db.schema
    .createTable(EVENT_TABLE)
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("type", "text", (c) => c.notNull())
    .addColumn("fireId", "text")
    .addColumn("eventJson", "text", (c) => c.notNull())
    .addColumn("createdAt", "text", (c) => c.notNull())
    // Per-source FIFO ordering counter (ADR-0002): monotonic per source.id,
    // assigned inside the publish transaction. NULL on pre-upgrade rows.
    .addColumn("seq", "integer")
    .execute();
  // Tenant scope column. fireId idempotency is per owner: two publishers
  // reusing the same key must not collide (the second would silently get the
  // first's event). The old global unique index is replaced.
  if (!(await hasColumn(EVENT_TABLE, "ownerUserId"))) {
    await db.schema.alterTable(EVENT_TABLE).addColumn("ownerUserId", "text").execute();
  }
  await db.executeQuery(
    sql`UPDATE trigger_event SET ownerUserId = json_extract(eventJson, '$.source.userId') WHERE ownerUserId IS NULL`.compile(db),
  );
  // seq migration for existing databases: backfill from rowid (a globally
  // monotonic insertion counter, so every source's subsequence is monotonic)
  // so drain ordering stays correct for pre-upgrade rows.
  if (!(await hasColumn(EVENT_TABLE, "seq"))) {
    await db.schema.alterTable(EVENT_TABLE).addColumn("seq", "integer").execute();
  }
  await db.executeQuery(sql`UPDATE trigger_event SET seq = rowid WHERE seq IS NULL`.compile(db));
  await db.schema.dropIndex("trigger_event_fire_idx").ifExists().execute();
  await db.schema
    .createIndex("trigger_event_owner_fire_idx")
    .ifNotExists()
    .unique()
    .on(EVENT_TABLE)
    .columns(["ownerUserId", "fireId"])
    .execute();
  await db.schema
    .createIndex("trigger_event_type_time_idx")
    .ifNotExists()
    .on(EVENT_TABLE)
    .columns(["type", "createdAt"])
    .execute();

  await db.schema
    .createTable(ROUTE_TABLE)
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("eventType", "text", (c) => c.notNull())
    .addColumn("origin", "text", (c) => c.notNull())
    .addColumn("routeJson", "text", (c) => c.notNull())
    .addColumn("updatedAt", "text", (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("trigger_route_type_idx")
    .ifNotExists()
    .on(ROUTE_TABLE)
    .column("eventType")
    .execute();
  if (!(await hasColumn(ROUTE_TABLE, "ownerUserId"))) {
    await db.schema.alterTable(ROUTE_TABLE).addColumn("ownerUserId", "text").execute();
  }
  await db.executeQuery(
    sql`UPDATE trigger_route SET ownerUserId = json_extract(routeJson, '$.ownerUserId') WHERE ownerUserId IS NULL`.compile(db),
  );

  await db.schema
    .createTable(DELIVERY_TABLE)
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    // FK cascade declared for NEW databases only (SQLite cannot add FK
    // constraints to an existing table). It is DECLARATIVE: the server does not
    // enable `PRAGMA foreign_keys` (see applySqlitePerfPragmas — the schema has
    // long-standing unenforced FKs elsewhere). Orphan prevention comes from
    // pruneEvents(), which deletes deliveries explicitly inside its transaction;
    // the constraint only bites if a deployment opts into enforcement.
    .addColumn("eventId", "text", (c) => c.notNull().references("trigger_event.id").onDelete("cascade"))
    .addColumn("sessionId", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("deliveryJson", "text", (c) => c.notNull())
    .addColumn("updatedAt", "text", (c) => c.notNull())
    .execute();
  // Exposed column for contract TTL sweeps (indexed — the 30s sweep was an
  // unbounded scan when expiry lived only inside deliveryJson).
  if (!(await hasColumn(DELIVERY_TABLE, "expiresAt"))) {
    await db.schema.alterTable(DELIVERY_TABLE).addColumn("expiresAt", "text").execute();
  }
  // Backfill pre-upgrade rows from their JSON so in-flight contracts survive.
  await db.executeQuery(
    sql`UPDATE trigger_delivery SET expiresAt = json_extract(deliveryJson, '$.expiresAt') WHERE expiresAt IS NULL`.compile(db),
  );
  await db.schema
    .createIndex("trigger_delivery_expiry_idx")
    .ifNotExists()
    .on(DELIVERY_TABLE)
    .columns(["expiresAt"])
    .execute();
  await db.schema
    .createIndex("trigger_delivery_event_session_idx")
    .ifNotExists()
    .unique()
    .on(DELIVERY_TABLE)
    .columns(["eventId", "sessionId"])
    .execute();
  await db.schema
    .createIndex("trigger_delivery_session_idx")
    .ifNotExists()
    .on(DELIVERY_TABLE)
    .columns(["sessionId", "updatedAt"])
    .execute();
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface PublishResult {
  event: TriggerEvent;
  /** False when fireId dedup returned a previously published event. */
  created: boolean;
}

/** A delivery row planned alongside the event insert (transactional publish).
 *  Spawn-route rows carry a `spawnRouteId` instead of a real sessionId; the
 *  row's sessionId is the `spawn:<routeId>:<eventId>` placeholder until the
 *  spawn succeeds and the engine resolves it. */
export interface PlannedDelivery {
  sessionId: string;
  routeId?: string;
  deliverAs: DeliverAs;
  expiresAt?: string;
  spawnRouteId?: string;
}

/** Insert an event row and ALL its planned delivery rows (status pending) in
 *  ONE transaction, before any side effect (emit/spawn/wake) runs. A crash
 *  mid-publish can therefore never claim the fireId without its deliveries:
 *  either the whole publish is durable, or a retry with the same fireId finds
 *  nothing and re-plans from scratch. Duplicate fireId returns the original
 *  event plus its existing delivery rows so the caller can resume unfinished
 *  spawn intents / pending handoffs instead of deduping to nothing.
 */
export async function insertEventWithPlan(
  event: Omit<TriggerEvent, "eventId" | "ts">,
  fireId: string | undefined,
  plan: PlannedDelivery[],
): Promise<PublishResult & { deliveries: Delivery[] }> {
  const db = getKysely();
  return db.transaction().execute(async (trx) => {
    const full: TriggerEvent = {
      ...event,
      eventId: newId("evt"),
      ts: new Date().toISOString(),
      ...(fireId ? { fireId } : {}),
    };
    // Per-source FIFO (ADR-0002): assign the next seq for this source inside
    // the same tx that claims the event. SQLite serializes write
    // transactions, so concurrent publishes get distinct, commit-ordered
    // seqs per source.
    // ponytail: MAX(seq) scans via json_extract without an index — fine at
    // 30-day-retention volumes; add a sourceId column if it ever shows up.
    const seqRow = await trx.executeQuery(
      sql<{ next: number }>`SELECT coalesce(MAX(seq), 0) + 1 AS next FROM ${sql.table(EVENT_TABLE)}
        WHERE json_extract(eventJson, '$.source.id') = ${full.source.id}`.compile(trx),
    );
    const seq = Number(seqRow.rows[0]?.next ?? 1);
    try {
      await trx
        .insertInto(EVENT_TABLE)
        .values({
          id: full.eventId,
          type: full.type,
          fireId: fireId ?? null,
          ownerUserId: full.source.userId ?? null,
          eventJson: JSON.stringify(full),
          createdAt: full.ts,
          seq,
        })
        .execute();
    } catch (err) {
      if (fireId) {
        // Same-owner dedup only (NULL owners never collide in SQLite's
        // unique index, so an ownerless legacy publish always creates).
        const owner = full.source.userId;
        const existing = owner === undefined
          ? undefined
          : await trx
            .selectFrom(EVENT_TABLE)
            .select(["eventJson"])
            .where("fireId", "=", fireId)
            .where("ownerUserId", "=", owner)
            .executeTakeFirst();
        const parsed = existing ? parseJson<TriggerEvent>(existing.eventJson, "event") : null;
        if (parsed) {
          const rows = await trx
            .selectFrom(DELIVERY_TABLE)
            .select(["deliveryJson"])
            .where("eventId", "=", parsed.eventId)
            .execute();
          return {
            event: parsed,
            created: false,
            deliveries: rows
              .map((r) => parseJson<Delivery>(r.deliveryJson, "delivery"))
              .filter((d): d is Delivery => d !== null),
          };
        }
      }
      throw new Error("Failed to insert event", { cause: err });
    }

    // Event claimed atomically — now its delivery rows (exactly-once per
    // (event, session): duplicate rows are skipped, not fatal).
    const deliveries: Delivery[] = [];
    for (const p of plan) {
      const sessionId = p.spawnRouteId ? `spawn:${p.spawnRouteId}:${full.eventId}` : p.sessionId;
      const delivery: Delivery = {
        deliveryId: newId("dlv"),
        eventId: full.eventId,
        eventType: full.type,
        sessionId,
        ...(p.spawnRouteId ? { spawnRouteId: p.spawnRouteId } : {}),
        ...(p.routeId ? { routeId: p.routeId } : {}),
        deliverAs: p.deliverAs,
        status: "pending",
        createdAt: full.ts,
        ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}),
      };
      try {
        await trx
          .insertInto(DELIVERY_TABLE)
          .values({
            id: delivery.deliveryId,
            eventId: delivery.eventId,
            sessionId: delivery.sessionId,
            status: delivery.status,
            deliveryJson: JSON.stringify(delivery),
            updatedAt: delivery.createdAt,
            ...(delivery.expiresAt ? { expiresAt: delivery.expiresAt } : {}),
          })
          .execute();
        deliveries.push(delivery);
      } catch (err) {
        // unique(eventId, sessionId) — already delivered. Any other DB error
        // must not masquerade as dedup: it aborts (and rolls back) the tx.
        if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) continue;
        throw err;
      }
    }
    return { event: full, created: true, deliveries };
  });
}

/** Persist a new immutable Event. fireId collisions return the original. */
export async function insertEvent(
  event: Omit<TriggerEvent, "eventId" | "ts">,
  fireId?: string,
): Promise<PublishResult> {
  const db = getKysely();
  const full: TriggerEvent = {
    ...event,
    eventId: newId("evt"),
    ts: new Date().toISOString(),
    ...(fireId ? { fireId } : {}),
  };
  try {
    await db
      .insertInto(EVENT_TABLE)
      .values({
        id: full.eventId,
        type: full.type,
        fireId: fireId ?? null,
        ownerUserId: full.source.userId ?? null,
        eventJson: JSON.stringify(full),
        createdAt: full.ts,
      })
      .execute();
    return { event: full, created: true };
  } catch (err) {
    if (fireId) {
      // Same-owner dedup only (NULL owners never collide in SQLite's unique
      // index, so an ownerless legacy publish always creates).
      const owner = full.source.userId;
      const existing = owner === undefined
        ? undefined
        : await db
          .selectFrom(EVENT_TABLE)
          .select(["eventJson"])
          .where("fireId", "=", fireId)
          .where("ownerUserId", "=", owner)
          .executeTakeFirst();
      const parsed = existing ? parseJson<TriggerEvent>(existing.eventJson, "event") : null;
      if (parsed) return { event: parsed, created: false };
    }
    throw new Error("Failed to insert event", { cause: err });
  }
}

export async function getEvent(eventId: string): Promise<TriggerEvent | null> {
  const row = await getKysely()
    .selectFrom(EVENT_TABLE)
    .select(["eventJson"])
    .where("id", "=", eventId)
    .executeTakeFirst();
  return row ? parseJson<TriggerEvent>(row.eventJson, "event") : null;
}

export async function listEvents(opts?: {
  type?: string;
  limit?: number;
  before?: string;
}): Promise<TriggerEvent[]> {
  let q = getKysely()
    .selectFrom(EVENT_TABLE)
    .select(["eventJson"])
    .orderBy("createdAt", "desc")
    .limit(Math.min(Math.max(opts?.limit ?? 100, 1), 500));
  if (opts?.type) q = q.where("type", "=", opts.type);
  if (opts?.before) q = q.where("createdAt", "<", opts.before);
  const rows = await q.execute();
  return rows
    .map((r) => parseJson<TriggerEvent>(r.eventJson, "event"))
    .filter((e): e is TriggerEvent => e !== null);
}

/** Delete events older than the retention window, plus their deliveries.
 *  Single transaction: a crash mid-prune cannot leave deliveries whose
 *  event is gone (or vice versa). */
export async function pruneEvents(retentionDays = DEFAULT_RETENTION_DAYS): Promise<number> {
  const db = getKysely();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return db.transaction().execute(async (trx) => {
    // Subquery deletes: no big IN-list (SQLite variable cap) and no orphaned
    // deliveries if the process dies mid-prune. Redundant on new databases
    // (the trigger_delivery FK cascades) but required for databases created
    // before the FK existed — SQLite cannot add FKs to an existing table.
    await trx
      .deleteFrom(DELIVERY_TABLE)
      .where("eventId", "in", (eb) =>
        eb.selectFrom(EVENT_TABLE).select("id").where("createdAt", "<", cutoff),
      )
      .execute();
    const events = await trx.deleteFrom(EVENT_TABLE).where("createdAt", "<", cutoff).execute();
    return events.reduce((n, r) => n + Number(r.numDeletedRows ?? 0n), 0);
  });
}

/** Look up an Event by its publisher-supplied idempotency key. */
export async function getEventByFireId(fireId: string): Promise<TriggerEvent | null> {
  const row = await getKysely()
    .selectFrom(EVENT_TABLE)
    .select(["eventJson"])
    .where("fireId", "=", fireId)
    .executeTakeFirst();
  return row ? parseJson<TriggerEvent>(row.eventJson, "event") : null;
}

// ── Routes ───────────────────────────────────────────────────────────────────

export async function createRoute(input: RouteInput, opts?: { routeId?: string }): Promise<Route> {
  const route: Route = { ...input, routeId: opts?.routeId ?? newId("rt"), createdAt: new Date().toISOString() };
  await getKysely()
    .insertInto(ROUTE_TABLE)
    .values({
      id: route.routeId,
      eventType: route.eventType,
      origin: route.origin,
      ownerUserId: route.ownerUserId ?? null,
      routeJson: JSON.stringify(route),
      updatedAt: route.createdAt,
    })
    .execute();
  return route;
}

/** Replace a route's mutable fields. Config-origin routes may not be edited. */
export async function updateRoute(
  routeId: string,
  patch: Partial<Omit<Route, "routeId" | "origin" | "createdAt">>,
): Promise<Route | null> {
  const existing = await getRoute(routeId);
  if (!existing) return null;
  if (existing.origin === "config") {
    throw new Error("Config-origin routes are read-only; edit the config file");
  }
  const updated: Route = { ...existing, ...patch, routeId, origin: existing.origin, createdAt: existing.createdAt };
  await getKysely()
    .updateTable(ROUTE_TABLE)
    .set({
      eventType: updated.eventType,
      ownerUserId: updated.ownerUserId ?? null,
      routeJson: JSON.stringify(updated),
      updatedAt: new Date().toISOString(),
    })
    .where("id", "=", routeId)
    .execute();
  return updated;
}

export async function getRoute(routeId: string): Promise<Route | null> {
  const row = await getKysely()
    .selectFrom(ROUTE_TABLE)
    .select(["routeJson"])
    .where("id", "=", routeId)
    .executeTakeFirst();
  return row ? parseJson<Route>(row.routeJson, "route") : null;
}

export async function deleteRoute(routeId: string): Promise<boolean> {
  const existing = await getRoute(routeId);
  if (existing?.origin === "config") {
    throw new Error("Config-origin routes are read-only; edit the config file");
  }
  const res = await getKysely().deleteFrom(ROUTE_TABLE).where("id", "=", routeId).execute();
  return res.some((r) => (r.numDeletedRows ?? 0n) > 0n);
}

export async function listRoutes(opts?: { eventType?: string; ownerUserId?: string }): Promise<Route[]> {
  let q = getKysely().selectFrom(ROUTE_TABLE).select(["routeJson"]).orderBy("updatedAt", "desc");
  if (opts?.eventType) q = q.where("eventType", "=", opts.eventType);
  if (opts?.ownerUserId) q = q.where("ownerUserId", "=", opts.ownerUserId);
  const rows = await q.execute();
  return rows
    .map((r) => parseJson<Route>(r.routeJson, "route"))
    .filter((r): r is Route => r !== null);
}

/** Delete session-target routes on true session termination. */
export async function deleteSessionRoutes(
  sessionId: string,
  opts?: { preserveDurable?: boolean },
): Promise<Route[]> {
  const candidates = (await listRoutes()).filter(
    (route) =>
      route.target.kind === "session" &&
      route.target.sessionId === sessionId &&
      !(opts?.preserveDurable && route.eventType.startsWith("time:")),
  );
  const deleted: Route[] = [];
  for (const route of candidates) {
    const result = await getKysely().deleteFrom(ROUTE_TABLE).where("id", "=", route.routeId).execute();
    if (result.some((row) => (row.numDeletedRows ?? 0n) > 0n)) deleted.push(route);
  }
  return deleted;
}

/**
 * Reconcile config-origin routes against the declarative config file.
 * The file is the source of truth: config routes not in `desired` are
 * deleted, and every desired route is (re)created deterministically.
 */
export async function syncConfigRoutes(desired: RouteInput[]): Promise<void> {
  const db = getKysely();
  // Single transaction: a crash mid-sync can never leave the config route
  // set half-old half-new (deltas fan out to runners off the stored set).
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom(ROUTE_TABLE).where("origin", "=", "config").execute();
    for (const input of desired) {
      const route: Route = {
        ...input,
        origin: "config",
        // Deterministic id so re-syncs are stable for UI references.
        routeId: `rt_cfg_${crypto.createHash("sha256").update(JSON.stringify(input)).digest("base64url").slice(0, 16)}`,
        createdAt: new Date().toISOString(),
      };
      await trx
        .insertInto(ROUTE_TABLE)
        .values({
          id: route.routeId,
          eventType: route.eventType,
          origin: "config",
          ownerUserId: route.ownerUserId ?? null,
          routeJson: JSON.stringify(route),
          updatedAt: route.createdAt,
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
    }
  });
}

// ── Deliveries ───────────────────────────────────────────────────────────────

/**
 * Create a pending Delivery. Exactly-once per (event, session): if one
 * already exists, returns null (caller treats as already-handled).
 */
export async function createDelivery(
  input: Omit<Delivery, "deliveryId" | "status" | "createdAt">,
): Promise<Delivery | null> {
  const delivery: Delivery = {
    ...input,
    deliveryId: newId("dlv"),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  try {
    await getKysely()
      .insertInto(DELIVERY_TABLE)
      .values({
        id: delivery.deliveryId,
        eventId: delivery.eventId,
        sessionId: delivery.sessionId,
        status: delivery.status,
        deliveryJson: JSON.stringify(delivery),
        updatedAt: delivery.createdAt,
        ...(delivery.expiresAt ? { expiresAt: delivery.expiresAt } : {}),
      })
      .execute();
    return delivery;
  } catch (err) {
    // unique(eventId, sessionId) — already delivered. Any other DB error must
    // not masquerade as dedup (that would silently drop the delivery).
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) return null;
    throw err;
  }
}

export async function updateDelivery(
  deliveryId: string,
  patch: Partial<Pick<Delivery, "status" | "deliveredAt" | "respondedAt" | "response" | "expiresAt" | "responseRelayPending" | "sessionId" | "spawnRouteId" | "wakeRequested" | "lastWakeAttemptAt">>,
  opts?: { guard?: DeliveryStatus[] },
): Promise<Delivery | null> {
  const row = await getKysely()
    .selectFrom(DELIVERY_TABLE)
    .select(["deliveryJson"])
    .where("id", "=", deliveryId)
    .executeTakeFirst();
  const existing = row ? parseJson<Delivery>(row.deliveryJson, "delivery") : null;
  if (!existing) return null;
  const updated: Delivery = { ...existing, ...patch };
  let q = getKysely()
    .updateTable(DELIVERY_TABLE)
    .set({
      status: updated.status,
      // Keep the exposed columns in sync — the sweep and drain queries read
      // them, not the JSON. sessionId moves when a spawn intent resolves.
      ...(patch.sessionId !== undefined ? { sessionId: updated.sessionId } : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: updated.expiresAt ?? null } : {}),
      deliveryJson: JSON.stringify(updated),
      updatedAt: new Date().toISOString(),
    })
    .where("id", "=", deliveryId);
  if (opts?.guard) q = q.where("status", "in", opts.guard);
  const res = await q.execute();
  if (!res.some((r) => (r.numUpdatedRows ?? 0n) > 0n)) return null; // guard lost (response raced) — caller skips
  return updated;
}

/** Delete a delivery row (spawn intents whose route vanished or spawn failed). */
export async function deleteDelivery(deliveryId: string): Promise<boolean> {
  const res = await getKysely().deleteFrom(DELIVERY_TABLE).where("id", "=", deliveryId).execute();
  return res.some((r) => (r.numDeletedRows ?? 0n) > 0n);
}

export async function listDeliveries(opts: {
  sessionId?: string;
  eventId?: string;
  status?: DeliveryStatus | DeliveryStatus[];
  limit?: number;
}): Promise<Delivery[]> {
  let q = getKysely()
    .selectFrom(DELIVERY_TABLE)
    .select(["deliveryJson"])
    .orderBy("updatedAt", "desc")
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  if (opts.sessionId) q = q.where("sessionId", "=", opts.sessionId);
  if (opts.eventId) q = q.where("eventId", "=", opts.eventId);
  if (opts.status) {
    q = Array.isArray(opts.status)
      ? q.where("status", "in", opts.status)
      : q.where("status", "=", opts.status);
  }
  const rows = await q.execute();
  return rows
    .map((r) => parseJson<Delivery>(r.deliveryJson, "delivery"))
    .filter((d): d is Delivery => d !== null);
}

/**
 * Pending deliveries for a session in FIFO order per source event time
 * (drain queue when a session becomes available).
 */
export async function getDelivery(deliveryId: string): Promise<Delivery | null> {
  const row = await getKysely()
    .selectFrom(DELIVERY_TABLE)
    .select(["deliveryJson"])
    .where("id", "=", deliveryId)
    .executeTakeFirst();
  return row ? parseJson<Delivery>(row.deliveryJson, "delivery") : null;
}

export async function pendingDeliveriesFor(sessionId: string): Promise<Delivery[]> {
  const rows = await getKysely()
    .selectFrom(DELIVERY_TABLE)
    .innerJoin(EVENT_TABLE, `${EVENT_TABLE}.id`, `${DELIVERY_TABLE}.eventId`)
    .select([`${DELIVERY_TABLE}.deliveryJson` as const])
    .where(`${DELIVERY_TABLE}.sessionId`, "=", sessionId)
    .where(`${DELIVERY_TABLE}.status`, "=", "pending")
    // Per-source FIFO (ADR-0002): source publish order first (seq), then
    // event time, then a stable id tie-break for same-timestamp events.
    .orderBy(`${EVENT_TABLE}.seq`, "asc")
    .orderBy(`${EVENT_TABLE}.createdAt`, "asc")
    .orderBy(`${DELIVERY_TABLE}.id`, "asc")
    .execute();
  return rows
    .map((r) => parseJson<Delivery>(r.deliveryJson, "delivery"))
    .filter((d): d is Delivery => d !== null);
}

/**
 * Deliveries stuck in inflight past the ack window — their settler died
 * (process crash mid-emit). The sweep returns them to pending so the next
 * register re-delivers; the CLI dedups by triggerId, so re-delivery is safe.
 */
export async function inflightDeliveries(olderThanIso: string): Promise<Delivery[]> {
  const rows = await getKysely()
    .selectFrom(DELIVERY_TABLE)
    .select(["deliveryJson"])
    .where("status", "=", "inflight")
    .where("updatedAt", "<", olderThanIso)
    .execute();
  return rows
    .map((r) => parseJson<Delivery>(r.deliveryJson, "delivery"))
    .filter((d): d is Delivery => d !== null);
}

/**
 * Spawn-intent rows (`spawn:<routeId>:<eventId>` placeholder) still
 * unresolved past the cutoff: the emit reached no runner, or the spawning
 * process died between claim (inflight) and resolution. Pending rows count
 * too (crash between the publish tx and the claim).
 */
export async function listUnresolvedSpawnIntents(olderThanIso: string): Promise<Delivery[]> {
  const rows = await getKysely()
    .selectFrom(DELIVERY_TABLE)
    .select(["deliveryJson"])
    .where("sessionId", "like", "spawn:%")
    .where("status", "in", ["pending", "inflight"])
    .where("updatedAt", "<", olderThanIso)
    .execute();
  return rows
    .map((r) => parseJson<Delivery>(r.deliveryJson, "delivery"))
    .filter((d): d is Delivery => d !== null);
}

/**
 * Pending deliveries marked wakeRequested (the wake path ran but the worker
 * never registered). Input to the failed-wake retry sweep and the dead-runner
 * expiry. `retryNotBefore` bounds retries: only rows whose last wake attempt
 * is older than the cutoff are returned. `sessionIds` scopes to a runner's
 * sessions (dead-runner cleanup).
 * ponytail: wakeRequested lives in deliveryJson (json_extract scan) — fine at
 * 30-day-retention volumes; add an exposed column if it ever shows up.
 */
export async function listPendingWakeDeliveries(
  opts?: { retryNotBefore?: string; sessionIds?: string[] },
): Promise<Delivery[]> {
  let q = getKysely()
    .selectFrom(DELIVERY_TABLE)
    .select(["deliveryJson"])
    .where("status", "=", "pending")
    .where(sql<boolean>`json_extract(deliveryJson, '$.wakeRequested') = 1`);
  if (opts?.retryNotBefore !== undefined) {
    // NULL lastWakeAttemptAt (crash before the mark landed) coalesces to '' —
    // lexicographically below every ISO cutoff, so the backstop still retries.
    q = q.where(sql<boolean>`coalesce(json_extract(deliveryJson, '$.lastWakeAttemptAt'), '') <= ${opts.retryNotBefore}`);
  }
  if (opts?.sessionIds !== undefined) {
    if (opts.sessionIds.length === 0) return [];
    q = q.where("sessionId", "in", opts.sessionIds);
  }
  const rows = await q.execute();
  return rows
    .map((r) => parseJson<Delivery>(r.deliveryJson, "delivery"))
    .filter((d): d is Delivery => d !== null);
}

/**
 * Responded deliveries whose response never reached the SOURCE session
 * (relay failed while the source was offline). Drained when that source
 * session registers.
 */
export async function pendingResponseRelaysFor(sourceSessionId: string): Promise<Delivery[]> {
  const db = getKysely();
  const rows = await db.executeQuery(
    sql<{ deliveryJson: string }>`
      SELECT d.deliveryJson FROM ${sql.table(DELIVERY_TABLE)} d
      JOIN ${sql.table(EVENT_TABLE)} e ON e.id = d.eventId
      WHERE json_extract(d.deliveryJson, '$.responseRelayPending') = 1
        AND json_extract(e.eventJson, '$.source.kind') = 'session'
        AND json_extract(e.eventJson, '$.source.id') = ${sourceSessionId}
    `.compile(db),
  );
  return rows.rows
    .map((r) => parseJson<Delivery>(r.deliveryJson, "delivery"))
    .filter((d): d is Delivery => d !== null);
}

/**
 * Expire older pending deliveries superseded by a newer wake delivery.
 * SQLite rowid ordering prevents concurrent older publishers from expiring a
 * delivery inserted after their own.
 */
export async function expirePendingDeliveries(input: {
  sessionId: string;
  eventType: string;
  exceptDeliveryId: string;
}): Promise<number> {
  const db = getKysely();
  const result = await db.executeQuery(
    sql<{ id: string }>`
      SELECT id FROM ${sql.table(DELIVERY_TABLE)}
      WHERE sessionId = ${input.sessionId}
        AND status IN ('pending', 'inflight')
        AND id <> ${input.exceptDeliveryId}
        AND json_extract(deliveryJson, '$.eventType') = ${input.eventType}
        AND rowid < (SELECT rowid FROM ${sql.table(DELIVERY_TABLE)} WHERE id = ${input.exceptDeliveryId})
    `.compile(db),
  );
  let expired = 0;
  for (const row of result.rows) {
    if (await updateDelivery(row.id, { status: "expired" }, { guard: ["pending", "inflight"] })) expired++;
  }
  return expired;
}

/** Deliveries whose response-contract TTL has lapsed (escalation sweep).
 *  SQL-side: expiresAt is an indexed column, so the 30s sweep stays empty-set
 *  cheap instead of JSON-parsing the whole table. */
export async function expiredContractDeliveries(now = new Date()): Promise<Delivery[]> {
  const rows = await getKysely()
    .selectFrom(DELIVERY_TABLE)
    .select(["deliveryJson"])
    .where("status", "in", ["pending", "inflight", "delivered"])
    .where("expiresAt", "<=", now.toISOString())
    .execute();
  return rows
    .map((r) => parseJson<Delivery>(r.deliveryJson, "delivery"))
    .filter((d): d is Delivery => d !== null && d.expiresAt !== undefined);
}

/** Events for a batch of ids — delivery annotation (one query, no N+1). */
export async function eventsForIds(eventIds: string[]): Promise<TriggerEvent[]> {
  if (eventIds.length === 0) return [];
  const rows = await getKysely()
    .selectFrom(EVENT_TABLE)
    .select(["eventJson"])
    .where("id", "in", [...new Set(eventIds)])
    .execute();
  return rows
    .map((r) => parseJson<TriggerEvent>(r.eventJson, "event"))
    .filter((e): e is TriggerEvent => e !== null);
}

/** Deliveries for a batch of events — feed visibility checks (one query). */
export async function deliveriesForEvents(eventIds: string[]): Promise<Delivery[]> {
  if (eventIds.length === 0) return [];
  const rows = await getKysely()
    .selectFrom(DELIVERY_TABLE)
    .select(["deliveryJson"])
    .where("eventId", "in", eventIds)
    .execute();
  return rows
    .map((r) => parseJson<Delivery>(r.deliveryJson, "delivery"))
    .filter((d): d is Delivery => d !== null);
}

// ── Tenant backfill ──────────────────────────────────────────────────────────

/** Non-config routes with no owner yet (legacy rows) — startup backfill input. */
export async function listOwnerlessRoutes(): Promise<Route[]> {
  const rows = await getKysely()
    .selectFrom(ROUTE_TABLE)
    .select(["routeJson"])
    .where("ownerUserId", "is", null)
    .where("origin", "!=", "config")
    .execute();
  return rows
    .map((r) => parseJson<Route>(r.routeJson, "route"))
    .filter((r): r is Route => r !== null && r.ownerUserId === undefined);
}

/** Stamp a route's owner (migration-only: bypasses the config read-only rule). */
export async function setRouteOwner(routeId: string, ownerUserId: string): Promise<void> {
  const existing = await getRoute(routeId);
  if (!existing) return;
  const updated: Route = { ...existing, ownerUserId };
  await getKysely()
    .updateTable(ROUTE_TABLE)
    .set({ ownerUserId, routeJson: JSON.stringify(updated) })
    .where("id", "=", routeId)
    .execute();
}
