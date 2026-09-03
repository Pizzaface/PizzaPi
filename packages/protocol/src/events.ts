// ============================================================================
// events.ts — Unified trigger system core types (ADR-0002)
//
// Canonical vocabulary (see CONTEXT.md):
//   Source → Event → Route → Delivery
//
// Single source of truth for every trigger pathway. Replaces the CLI-local
// ConversationTrigger, the server-local TriggerRequest, and per-path schemas.
// ============================================================================

import type { JsonValue, TriggerFilter, TriggerFilterMode } from "./shared.js";

// ── Source ───────────────────────────────────────────────────────────────────

/** What kind of emitter published an Event. */
export type SourceKind = "session" | "service" | "webhook" | "api" | "scheduler";

/** How the source authenticated when publishing. */
export type SourceAuth = "socket" | "api-key" | "cookie" | "hmac" | "internal";

/**
 * Normalized, authenticated identity recorded on every Event regardless of
 * transport (socket auth, API key, per-webhook HMAC, ...).
 */
export interface SourceIdentity {
  kind: SourceKind;
  /** Stable id within the kind: sessionId, service name, webhookId, key id, ... */
  id: string;
  /** Human-readable name for feeds/UI (e.g. session name, service label). */
  name?: string;
  auth: SourceAuth;
  /**
   * Authenticated owner of the publish (tenant scope). Stamped server-side
   * from the principal — never client-supplied. Routes only match Events
   * whose owner equals the route owner (config routes without an owner are
   * operator-level and match every user). Absent only on legacy rows.
   */
  userId?: string;
}

// ── Event ────────────────────────────────────────────────────────────────────

/**
 * Optional declaration that an Event awaits an answer. Generalizes the old
 * ask_user_question / plan_review / session_complete pending-trigger handling.
 */
export interface ResponseContract {
  /** Actions the responder may take (e.g. ["approve", "cancel", "edit"]). */
  actions?: string[];
  /** How long a Delivery may sit unanswered before escalating/expiring. */
  ttlMs?: number;
  /**
   * Escalation chain for unanswered deliveries: parent session → human viewer
   * (web-push + pending-human feed entry) → expired. Defaults to true.
   */
  escalate?: boolean;
}

/**
 * The immutable fact that a trigger fired. Never mutated after publish.
 * (Named TriggerEvent to avoid colliding with the DOM `Event` type.)
 */
export interface TriggerEvent {
  eventId: string;
  /** Registered namespaced Event Type, e.g. "lifecycle:session_complete". */
  type: string;
  source: SourceIdentity;
  payload: Record<string, JsonValue>;
  /** Short human-readable summary for feeds. */
  summary?: string;
  responseContract?: ResponseContract;
  /**
   * Publisher's idempotency key. Also correlates responses: a session-source
   * publisher uses its own triggerId here, so the response relay can echo it
   * back and the publisher's waiter resolves.
   */
  fireId?: string;
  /** ISO 8601 publish timestamp. */
  ts: string;
}

/** Body of POST /api/events — everything but the server-assigned fields. */
export interface PublishEventInput {
  type: string;
  payload?: Record<string, JsonValue>;
  summary?: string;
  responseContract?: ResponseContract;
  /**
   * Idempotency key: republishing with the same fireId is a no-op.
   * (Carries forward the fire-once dedup from the scheduling work.)
   */
  fireId?: string;
}

// ── Event Type registry ──────────────────────────────────────────────────────

/**
 * A registered Event Type. Sources declare these up front; Routes filter on
 * declared schema fields and the UI renders type-aware.
 */
export interface EventTypeDef {
  /** Namespaced type name, e.g. "github:pr_comment", "schedule:nightly". */
  type: string;
  label: string;
  description?: string;
  /** JSON Schema for the payload; declared properties are filterable. */
  schema?: Record<string, unknown>;
  /**
   * Default render template for turning an Event into agent-visible text.
   * `{{field}}` placeholders resolve against the payload. A Route's own
   * promptTemplate overrides this. Replaces the payload.prompt convention.
   */
  template?: string;
  /** Session mode ids this type is scoped to. Absent/empty = everywhere. */
  modes?: string[];
}

// ── Route ────────────────────────────────────────────────────────────────────

/** How a Delivery reaches the agent: interrupt the turn, or queue after it. */
export type DeliverAs = "steer" | "followUp";

/** Where routes come from. Config-origin routes are read-only in the UI. */
export type RouteOrigin = "agent" | "ui" | "config" | "api";

/** Spawn a fresh session as the delivery target. Auto-spawn is just routing. */
export interface SpawnSpec {
  /** Runner to spawn on. */
  runnerId: string;
  /**
   * Expected runner owner. When set, spawning fails closed if the runner
   * has been reclaimed by a different user since the route was created.
   */
  ownerUserId?: string;
  cwd?: string;
  model?: { provider: string; id: string };
  /** Instructions merged before the rendered event text. */
  promptTemplate?: string;
  autoClose?: boolean;
}

export type RouteTarget =
  | {
      kind: "session";
      sessionId: string;
      /**
       * Runner the target session lives on, stamped by the server at route
       * write time. Schedules outlive their session, so runner-scoped reads
       * (reconcile snapshots, schedule listings, wake ownership) resolve the
       * owning runner from the route itself — not from a live session.
       */
      runnerId?: string;
      /**
       * Wake policy: when the target session is offline, ask its runner to
       * respawn a worker that resumes this session, then deliver the pending
       * event once it registers. Used by schedule deliveries — a schedule
       * firing must reach the session that created it even if its worker
       * exited. Direct publishes set this via the target's wake flag.
       */
      wake?: boolean;
    }
  | { kind: "spawn"; spec: SpawnSpec };

/**
 * A rule deciding which sessions receive an Event. Subsumes the old
 * subscriptions, runner trigger listeners, and direct-addressed fires
 * (a direct fire is an implicit single-session Route).
 */
export interface Route {
  routeId: string;
  /** Event Type this route matches. */
  eventType: string;
  target: RouteTarget;
  /** Recipient-side urgency decision. */
  deliverAs: DeliverAs;
  filters?: TriggerFilter[];
  filterMode?: TriggerFilterMode;
  /** Values forwarded to the emitting service (e.g. which repo to watch). */
  params?: Record<string, JsonValue>;
  /** Overrides the Event Type's default template for this route. */
  promptTemplate?: string;
  origin: RouteOrigin;
  /**
   * Tenant scope: the user whose Events this route may match. Stamped by the
   * server from the creating principal (never trusted from clients). Config
   * routes may declare it; when absent on a config route the route is
   * operator-level and matches all users. Absent on ui/agent/api routes only
   * for legacy rows whose owner could not be backfilled — those match nothing.
   */
  ownerUserId?: string;
  disabled?: boolean;
  createdAt: string;
}

/** Everything the caller provides when creating a Route. */
export type RouteInput = Omit<Route, "routeId" | "createdAt">;

// ── Delivery ─────────────────────────────────────────────────────────────────

export type DeliveryStatus =
  | "pending" // queued, session not yet available
  | "inflight" // emitted to an ack-capable session; awaiting its ack (or timeout back to pending)
  | "delivered" // handed to the session (ack-confirmed, or legacy handoff)
  | "responded" // response contract answered
  | "escalated" // unanswered, re-routed up the escalation chain
  | "expired"; // TTL hit with no answer / no recipient

/**
 * One per-session attempt to hand an Event to a recipient. Durable:
 * exactly-once per (event, session), per-source FIFO, TTL-bounded.
 * Lifecycle: pending → inflight → delivered → responded, with inflight
 * reverting to pending on ack timeout/disconnect (re-delivered on the next
 * register; the CLI dedups by triggerId).
 */
export interface Delivery {
  deliveryId: string;
  eventId: string;
  /** Denormalized for feed queries without a join. */
  eventType: string;
  sessionId: string;
  /** Route that produced this delivery; absent for implicit direct routes. */
  routeId?: string;
  /** Set while a spawn Route's delivery is still an unresolved intent: the
   *  session does not exist until the spawn succeeds, so the row holds the
   *  `spawn:<routeId>:<eventId>` placeholder and this field names the route.
   *  Cleared when the row is resolved to the real sessionId. */
  spawnRouteId?: string;
  deliverAs: DeliverAs;
  status: DeliveryStatus;
  createdAt: string;
  deliveredAt?: string;
  respondedAt?: string;
  response?: { action?: string; text?: string };
  /** When the response was recorded but its relay to the source session failed;
   *  the source session's next registration drains and re-relays it. */
  responseRelayPending?: boolean;
  /** Set when the wake path ran for this delivery (schedule wake): the
   *  failed-wake retry sweep re-attempts the wake for pending+marked rows. */
  wakeRequested?: boolean;
  /** Last time a wake was attempted (initial or retry) — bounds retries to
   *  one re-attempt per delivery per 5 minutes. */
  lastWakeAttemptAt?: string;
  /** When the response contract TTL lapses. */
  expiresAt?: string;
}

/**
 * Delivery as the deliveries endpoints hand it to the UI: the durable row
 * plus view fields derived from the owning Event's ResponseContract, so the
 * client can render respond controls without a second round-trip.
 */
export interface DeliveryView extends Delivery {
  /** True when the Event carries a ResponseContract and this delivery may still be answered. */
  respondable: boolean;
  /** Actions the ResponseContract declares — drives one button per action. */
  actions?: string[];
}

// ── Runtime guards ───────────────────────────────────────────────────────────

const SOURCE_KINDS: readonly string[] = ["session", "service", "webhook", "api", "scheduler"];
const SOURCE_AUTHS: readonly string[] = ["socket", "api-key", "cookie", "hmac", "internal"];
const DELIVERY_STATUSES: readonly string[] = ["pending", "inflight", "delivered", "responded", "escalated", "expired"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Namespaced event type: `namespace:name`, lowercase alnum/_/- segments. */
export function isValidEventType(type: unknown): type is string {
  return typeof type === "string" && /^[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_.-]*$/.test(type);
}

export function isSourceIdentity(v: unknown): v is SourceIdentity {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    v.id.length > 0 &&
    SOURCE_KINDS.includes(v.kind as string) &&
    SOURCE_AUTHS.includes(v.auth as string) &&
    (v.name === undefined || typeof v.name === "string") &&
    (v.userId === undefined || typeof v.userId === "string")
  );
}

/**
 * Tenant-scope check: may this Route match this Event's owner?
 * Config routes without an owner are operator-level (match everyone).
 * Any other route without an owner is a legacy row that matches nothing.
 */
export function routeMatchesOwner(route: Pick<Route, "origin" | "ownerUserId">, eventOwnerUserId: string | undefined): boolean {
  if (route.ownerUserId === undefined) return route.origin === "config";
  return eventOwnerUserId !== undefined && route.ownerUserId === eventOwnerUserId;
}

export function isTriggerEvent(v: unknown): v is TriggerEvent {
  return (
    isRecord(v) &&
    typeof v.eventId === "string" &&
    v.eventId.length > 0 &&
    isValidEventType(v.type) &&
    isSourceIdentity(v.source) &&
    isRecord(v.payload) &&
    typeof v.ts === "string"
  );
}

export function isRouteTarget(v: unknown): v is RouteTarget {
  if (!isRecord(v)) return false;
  if (v.kind === "session") {
    return typeof v.sessionId === "string"
      && v.sessionId.length > 0
      && (v.runnerId === undefined || typeof v.runnerId === "string")
      && (v.wake === undefined || typeof v.wake === "boolean");
  }
  if (v.kind === "spawn") {
    if (!isRecord(v.spec)) return false;
    const spec = v.spec;
    const modelValid = spec.model === undefined
      || (isRecord(spec.model) && typeof spec.model.provider === "string" && typeof spec.model.id === "string");
    return typeof spec.runnerId === "string"
      && spec.runnerId.length > 0
      && (spec.cwd === undefined || typeof spec.cwd === "string")
      && modelValid
      && (spec.promptTemplate === undefined || typeof spec.promptTemplate === "string")
      && (spec.autoClose === undefined || typeof spec.autoClose === "boolean")
      && (spec.ownerUserId === undefined || typeof spec.ownerUserId === "string");
  }
  return false;
}

export function isDeliveryStatus(v: unknown): v is DeliveryStatus {
  return typeof v === "string" && DELIVERY_STATUSES.includes(v);
}

/**
 * Render an Event to agent-visible text: route promptTemplate wins, then the
 * Event Type's template, then a generic fallback. `{{field}}` placeholders
 * resolve against the payload (missing fields render empty).
 */
export function renderEventText(
  event: TriggerEvent,
  typeDef?: Pick<EventTypeDef, "template">,
  route?: Pick<Route, "promptTemplate">,
): string {
  const template = route?.promptTemplate ?? typeDef?.template;
  if (!template) {
    const summary = event.summary ? `${event.summary}\n` : "";
    return `${summary}Event ${event.type} from ${event.source.kind}:${event.source.id}\n${JSON.stringify(event.payload, null, 2)}`;
  }
  return template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_, field: string) => {
    let value: unknown = event.payload;
    for (const part of field.split(".")) {
      if (!isRecord(value)) return "";
      value = value[part];
    }
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}
