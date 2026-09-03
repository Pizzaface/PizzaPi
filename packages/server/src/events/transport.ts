/**
 * Real-transport EngineDeps (ADR-0002).
 *
 * Bridges the routing engine to the live Socket.IO fabric. During the
 * migration the wire envelope stays in the legacy ConversationTrigger shape
 * (`session_trigger`) so existing CLI receivers keep working; Phase 4 swaps
 * the CLI to native TriggerEvent envelopes.
 */

import { randomUUID } from "crypto";
import type { Delivery, Route, TriggerEvent } from "@pizzapi/protocol";
import { renderEventText } from "@pizzapi/protocol";
import { createLogger } from "@pizzapi/tools";
import {
  broadcastToSessionViewers,
  countSocketsInRoomCluster,
  getIo,
  runnerRoom,
  emitToRelaySessionAcked,
  emitToRelaySessionVerified,
  emitToRunner,
  getLocalRunnerSocket,
  getLocalTuiSocket,
  getSharedSession,
  linkSessionToRunner,
  recordRunnerSession,
  waitForLocalTuiSocket,
} from "../ws/sio-registry.js";
import { waitForSpawnAck } from "../ws/runner-control.js";
import { getRunnerData } from "../ws/sio-registry/runners.js";
import { getHiddenModels } from "../user-hidden-models.js";
import { isHiddenModel } from "../routes/model-guard.js";
import { pushTriggerHistory } from "../sessions/trigger-store.js";
import { resolveSessionRunner } from "../sessions/ownership.js";
import { sendPushToUser } from "../push.js";
import { getDelivery, getEvent, getEventByFireId, listPendingWakeDeliveries, updateDelivery } from "./store.js";
import { settleDeliveryAck, type DeliverOutcome, type EngineDeps } from "./engine.js";
import { getEventsRedis } from "./redis.js";

const log = createLogger("event-transport");

/** How long the transport waits for a recipient's session_trigger ack before
 *  treating the handoff as lost (row returns to pending; re-delivery is
 *  deduped by the CLI's trackReceivedTrigger tombstones). */
const SESSION_TRIGGER_ACK_TIMEOUT_MS = 10_000;

function sourceLabel(event: TriggerEvent): string {
  const { source } = event;
  return source.kind === "session" ? source.id : `external:${source.id}`;
}

/** Legacy session_trigger envelope for the transition period. */
function toWireEnvelope(delivery: Delivery, event: TriggerEvent, route: Route | null) {
  const rendered = route?.promptTemplate ? renderEventText(event, undefined, route) : undefined;
  const payload = rendered ? { ...event.payload, prompt: rendered } : event.payload;
  return {
    type: event.type,
    sourceSessionId: sourceLabel(event),
    sourceSessionName: event.summary ?? event.source.name ?? `${event.source.kind} (${event.source.id})`,
    targetSessionId: delivery.sessionId,
    payload,
    deliverAs: delivery.deliverAs,
    expectsResponse: event.responseContract !== undefined,
    triggerId: delivery.deliveryId,
    ts: event.ts,
  };
}

async function emitToSession(sessionId: string, trigger: ReturnType<typeof toWireEnvelope>): Promise<boolean> {
  const local = getLocalTuiSocket(sessionId);
  if (local?.connected) {
    try {
      local.emit("session_trigger", { trigger });
      return true;
    } catch (err) {
      log.error(`Local emit failed for session ${sessionId}:`, err);
      return false;
    }
  }
  return emitToRelaySessionVerified(sessionId, "session_trigger", { trigger });
}

// ACKED_EMIT_MARKER
/**
 * Emit with a receipt ack (delivery guarantees): the recipient's ack callback
 * settles the delivery row asynchronously — this returns as soon as the emit
 * is handed to a live recipient, so the publish path never blocks on the ack.
 * Old CLIs never ack: the Socket.IO timeout fires onSettled(false) and the row
 * returns to pending for a re-delivery the CLI dedups by triggerId.
 */
async function emitToSessionAcked(
  sessionId: string,
  trigger: ReturnType<typeof toWireEnvelope>,
  deliveryId: string,
): Promise<boolean> {
  const local = getLocalTuiSocket(sessionId);
  if (local?.connected) {
    try {
      // Cast: Socket.IO's typed Socket doesn't expose .timeout().emit() acks.
      (local as any).timeout(SESSION_TRIGGER_ACK_TIMEOUT_MS).emit(
        "session_trigger",
        { trigger },
        (err: unknown, ackResponses: unknown[] = []) => {
          void settleDeliveryAck(deliveryId, !err && ackResponses.length > 0);
        },
      );
      return true;
    } catch (err) {
      log.error(`Local acked emit failed for session ${sessionId}:`, err);
      return false;
    }
  }
  return emitToRelaySessionAcked(sessionId, "session_trigger", { trigger }, (acked) => {
    void settleDeliveryAck(deliveryId, acked);
  }, SESSION_TRIGGER_ACK_TIMEOUT_MS);
}

/** Registered CLI generation: does this session ack session_trigger emissions? */
async function sessionAcksTriggers(sessionId: string): Promise<boolean> {
  try {
    // Redis miss / shared-session read failure must degrade to the legacy
    // no-ack path (handoff = delivered), never block delivery.
    return (await getSharedSession(sessionId))?.acksSessionTrigger === true;
  } catch {
    return false;
  }
}

// ── Offline-session wake ────────────────────────────────────────────────

/** In-flight wake attempts, deduped per session so concurrent schedule fires
 * (or retries) share one worker respawn instead of racing the daemon.
 * Secondary dedup only — the Redis wake lock below is the primary, so two
 * relay nodes cannot double-respawn the same session's worker. */
const pendingSessionWakes = new Map<string, Promise<boolean>>();

/** Wake-lock lease: ~ the waitForLocalTuiSocket window, so a crashed holder's
 *  lock expires about when its own wait would have. */
const WAKE_LOCK_LEASE_MS = 15_000;

function wakeLockKey(sessionId: string): string {
  return `pizzapi:trigger:wake-lock:${sessionId}`;
}

/** Compare-and-delete: release only the lock this caller still owns. */
async function releaseWakeLock(redis: NonNullable<Awaited<ReturnType<typeof getEventsRedis>>>, sessionId: string, token: string): Promise<void> {
  try {
    await redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then
         return redis.call('DEL', KEYS[1])
       end
       return 0`,
      { keys: [wakeLockKey(sessionId)], arguments: [token] },
    );
  } catch (err) {
    // Lease expiry cleans up; a failed release just wastes the remaining lease.
    log.warn(`wake: failed to release lock for ${sessionId}:`, err);
  }
}

/**
 * Ask the session's runner to respawn a worker that RESUMES this session
 * (same relay session id, same conversation via resumeId). Fire-and-forget:
 * the Delivery stays pending and the drain-on-register path delivers once
 * the worker is back. Moved here from the legacy trigger route (ADR-0002):
 * wake is a delivery concern.
 */
export function wakeOfflineSession(
  sessionId: string,
  session: { runnerId?: string | null; cwd?: string },
): Promise<boolean> {
  const existing = pendingSessionWakes.get(sessionId);
  if (existing) return existing;

  const attempt = (async (): Promise<boolean> => {
    const runnerId = session.runnerId;
    if (!runnerId) return false;

    // Distributed wake lock: two relay nodes fanned by the Redis adapter can
    // both land the schedule fire and race a double respawn of the same
    // session's worker. SET NX + lease (~ waitForLocalTuiSocket window)
    // admits exactly one node; released via compare-and-delete so a slow
    // finisher never releases a successor's lock. No Redis (or a failed SET)
    // degrades to the local-map dedup only — single-node behavior.
    const redis = await getEventsRedis().catch(() => null);
    let lockToken: string | null = null;
    if (redis) {
      try {
        lockToken = randomUUID();
        const acquired = await redis.set(wakeLockKey(sessionId), lockToken, {
          NX: true,
          PX: WAKE_LOCK_LEASE_MS,
        });
        if (acquired !== "OK") {
          log.info(`wake: another node is already waking session ${sessionId}`);
          return false;
        }
      } catch (err) {
        // Lock failure must not block the wake — proceed local-only (the
        // daemon dedups resumes per session id anyway, and a duplicate
        // new_session on the runner resolves to the same relay session).
        log.warn(`wake: lock acquisition failed for ${sessionId} — proceeding unlocked:`, err);
        lockToken = null;
      }
    }

    try {
      // The runner may be connected to a DIFFERENT relay node. emitToRunner goes
      // through the per-runner room, which the Redis adapter fans out
      // cluster-wide.
      const isLocal = !!getLocalRunnerSocket(runnerId);
      const ackPromise = isLocal ? waitForSpawnAck(sessionId, 10_000) : null;
      try {
        emitToRunner(runnerId, "new_session", {
          sessionId,
          ...(session.cwd ? { cwd: session.cwd } : {}),
          // The daemon resolves the local .jsonl by session id; if the file is
          // gone it degrades to a fresh conversation under the same relay
          // session — still the schedule's home.
          resumeId: sessionId,
        });
      } catch (err) {
        log.warn(`wake: failed to send new_session for ${sessionId}:`, err);
        return false;
      }

      if (!ackPromise) {
        log.info(`wake: asked runner ${runnerId} on another node to resume ${sessionId}`);
        return true;
      }

      const ack = await ackPromise;
      if (ack.ok === false && !(ack as { timeout?: boolean }).timeout) {
        log.warn(`wake: runner rejected resume of ${sessionId}: ${(ack as { message?: string }).message ?? "unknown"}`);
        return false;
      }
      const ready = await waitForLocalTuiSocket(sessionId, 15_000);
      if (ready) {
        log.info(`wake: session ${sessionId} resumed and registered`);
      } else {
        log.warn(`wake: session ${sessionId} worker never registered`);
      }
      return !!ready;
    } finally {
      if (redis && lockToken) await releaseWakeLock(redis, sessionId, lockToken);
    }
  })().finally(() => {
    pendingSessionWakes.delete(sessionId);
  });

  pendingSessionWakes.set(sessionId, attempt);
  return attempt;
}

/** Failed-wake retry bound: one re-attempt per delivery per 5 minutes. */
const WAKE_RETRY_INTERVAL_MS = 5 * 60_000;

/**
 * Retry sweep for failed wakes: a wake whose waitForLocalTuiSocket timed out
 * left the delivery pending forever unless the session independently
 * registered. Re-attempt wakeOfflineSession for pending+marked rows whose
 * last wake attempt is past the retry interval. Claim-guarded: the pending-
 * guarded lastWakeAttemptAt write means a row claimed (inflight) or delivered
 * by a concurrent drain since the query wins and is skipped — no wake for an
 * already-settled delivery.
 */
export async function sweepFailedWakes(): Promise<number> {
  const cutoff = new Date(Date.now() - WAKE_RETRY_INTERVAL_MS).toISOString();
  const candidates = await listPendingWakeDeliveries({ retryNotBefore: cutoff });
  let retried = 0;
  for (const delivery of candidates) {
    // Guarded mark-then-wake: the update doubles as the retry bound (1 per 5
    // min) and as the claim guard (lost guard = drain won, skip the wake).
    const won = await updateDelivery(
      delivery.deliveryId,
      { lastWakeAttemptAt: new Date().toISOString() },
      { guard: ["pending"] },
    ).catch(() => null);
    if (!won) continue;
    const runner = await resolveSessionRunner(delivery.sessionId).catch(() => null);
    if (runner) {
      void wakeOfflineSession(delivery.sessionId, runner);
      retried++;
      log.info(`wake retry: re-attempting wake for delivery ${delivery.deliveryId} (session ${delivery.sessionId})`);
    }
  }
  return retried;
}

/**
 * Deliver a response to a pending contract-bearing delivery back to the
 * SOURCE session over the legacy trigger_response wire event. The child's
 * waiter matches on its own triggerId, which the publisher passed as fireId.
 */
export async function emitTriggerResponse(
  sourceSessionId: string,
  data: { triggerId: string; response: string; action?: string; targetSessionId?: string },
): Promise<boolean> {
  const local = getLocalTuiSocket(sourceSessionId);
  if (local?.connected) {
    try {
      local.emit("trigger_response", data);
      return true;
    } catch (err) {
      log.error(`trigger_response emit failed for ${sourceSessionId}:`, err);
      return false;
    }
  }
  return emitToRelaySessionVerified(sourceSessionId, "trigger_response", data);
}

export function createEngineDeps(): EngineDeps {
  return {
    async deliver(delivery, event, route): Promise<DeliverOutcome> {
      const trigger = toWireEnvelope(delivery, event, route);
      // Ack-capable sessions (new CLIs): emit with a receipt ack — the row is
      // inflight until the ack lands; a disconnect between emit and receipt
      // no longer loses the event. Legacy CLIs: plain emit, handoff = delivered.
      const acks = await sessionAcksTriggers(delivery.sessionId);
      const ok = acks
        ? await emitToSessionAcked(delivery.sessionId, trigger, delivery.deliveryId)
        : await emitToSession(delivery.sessionId, trigger);
      if (ok) {
        void Promise.resolve(
          pushTriggerHistory(delivery.sessionId, {
            triggerId: delivery.deliveryId,
            type: event.type,
            source: sourceLabel(event),
            summary: event.summary,
            payload: trigger.payload,
            deliverAs: delivery.deliverAs,
            ts: event.ts,
            direction: "inbound" as const,
          }),
        ).catch(() => {});
        broadcastToSessionViewers(delivery.sessionId, "trigger_delivered", { triggerId: delivery.deliveryId });
        return acks ? "inflight" : "delivered";
      } else if (route && route.target.kind === "session" && route.target.wake) {
        // Schedule wake: ask the runner to resume the session; the Delivery
        // stays pending and drains when the worker registers. Ownership was
        // checked at publish time — resolve the runner across live/persisted/
        // durable states since schedule targets are usually offline.
        const runner = await resolveSessionRunner(delivery.sessionId).catch(() => null);
        if (runner) {
          // Mark the row wake-eligible so the failed-wake retry sweep (a wake
          // whose worker never registered) and the dead-runner expiry can find
          // it; lastWakeAttemptAt bounds retries to 1 per 5 minutes.
          await updateDelivery(
            delivery.deliveryId,
            { wakeRequested: true, lastWakeAttemptAt: new Date().toISOString() },
          ).catch((err) => log.warn(`wake: failed to mark delivery ${delivery.deliveryId}:`, err));
          void wakeOfflineSession(delivery.sessionId, runner);
        }
      }
      return "unreachable";
    },

    async spawn(route, event) {
      if (route.target.kind !== "spawn") return null;
      const spec = route.target.spec;
      const sessionId = randomUUID();
      // Fire-time ownership and hidden-model checks apply before choosing the
      // local or cross-node transport path.
      const runnerData = await getRunnerData(spec.runnerId).catch(() => null);
      // SECURITY: fail-closed on reclaimed runners.
      if (spec.ownerUserId && runnerData?.userId !== spec.ownerUserId) {
        log.warn(`Spawn route ${route.routeId}: runner ${spec.runnerId} is not owned by the route owner — refusing spawn`);
        return null;
      }
      const hiddenModels = runnerData?.userId
        ? await getHiddenModels(runnerData.userId).catch(() => [] as string[])
        : [];
      const model = spec.model && !isHiddenModel(hiddenModels, spec.model) ? spec.model : undefined;
      if (spec.model && !model) {
        log.warn(`Spawn route ${route.routeId}: dropping hidden model ${spec.model.provider}/${spec.model.id}`);
      }

      const runnerSocket = getLocalRunnerSocket(spec.runnerId);
      if (!runnerSocket) {
        // Runner may be connected to a DIFFERENT relay node — emit through the
        // per-runner room (Redis-adapter fanned out cluster-wide), exactly like
        // the wake path. No local ack/TUI wait here: the runner records the
        // session itself on registration, and the delivery stays pending and
        // drains when the worker registers.
        // emitToRunner no-ops silently on an empty room, which would leave a
        // spawn intent that never resolves — verify cluster-wide presence
        // first. A confirmed-empty room fails the spawn (runSpawn drops the
        // intent); an inconclusive lookup still attempts (never treat a Redis
        // blip as "runner gone"; the intent sweep catches a true miss).
        const io = getIo();
        const presence = io
          ? await countSocketsInRoomCluster(io.of("/runner"), runnerRoom(spec.runnerId))
          : { kind: "unknown" as const };
        if (presence.kind === "count" && presence.count === 0) {
          log.warn(`Spawn route ${route.routeId}: runner ${spec.runnerId} has no live socket on any node — refusing spawn`);
          return null;
        }
        try {
          emitToRunner(spec.runnerId, "new_session", {
            sessionId,
            ...(spec.cwd ? { cwd: spec.cwd } : {}),
            ...(model ? { model } : {}),
            ...(hiddenModels.length > 0 ? { hiddenModels } : {}),
            ...(spec.autoClose ? { autoClose: true } : {}),
          });
        } catch (err) {
          log.warn(`Spawn route ${route.routeId}: emit to runner ${spec.runnerId} failed:`, err);
          return null;
        }
        log.info(`Spawn route ${route.routeId}: asked cluster runner ${spec.runnerId} for ${sessionId}`);
        return sessionId;
      }
      const ackPromise = waitForSpawnAck(sessionId, 10_000);
      try {
        runnerSocket.emit("new_session", {
          sessionId,
          ...(spec.cwd ? { cwd: spec.cwd } : {}),
          ...(model ? { model } : {}),
          ...(hiddenModels.length > 0 ? { hiddenModels } : {}),
          ...(spec.autoClose ? { autoClose: true } : {}),
        });
        const ack = await ackPromise;
        // Ack timeout ≠ failure — the session may come up anyway (see the
        // legacy listener spawn path for the rationale).
        if (ack.ok === false && !("timeout" in ack && ack.timeout)) return null;
        await recordRunnerSession(spec.runnerId, sessionId);
        await linkSessionToRunner(spec.runnerId, sessionId);
        await waitForLocalTuiSocket(sessionId, 15_000);
        return sessionId;
      } catch (err) {
        log.warn(`Spawn route ${route.routeId} failed:`, err);
        return null;
      }
    },

    async escalate(delivery, event) {
      // Hop 1: parent session, when the recipient has one.
      const session = await getSharedSession(delivery.sessionId);
      const parentId = session?.linkedParentId ?? session?.parentSessionId ?? null;
      if (parentId && parentId !== delivery.sessionId) {
        log.info(`Escalating delivery ${delivery.deliveryId} to parent session ${parentId}`);
        return parentId;
      }
      // Hop 2: human viewer — web push + pending-human entry in the feed.
      const userId = session?.userId ?? (await ownerOfRunnerFor(delivery.sessionId));
      if (userId) {
        await sendPushToUser(userId, {
          type: "agent_needs_input",
          title: "Trigger awaiting your response",
          body: event.summary ?? `${event.type} needs an answer`,
          sessionId: delivery.sessionId,
          data: { deliveryId: delivery.deliveryId },
        }).catch((err) => log.error("Escalation push failed:", err));
      }
      return null;
    },

    async relayResponse(delivery, event) {
      return emitDeliveryResponseRelay(delivery, event);
    },
  };
}

/**
 * Relay a recorded delivery response back to the event's SOURCE session over
 * the legacy trigger_response wire event, mirroring the respond route's
 * correlation rules: the source's waiter matches on its own triggerId, which
 * the publisher sent as fireId; session_complete answers route back through
 * the ORIGINAL delivery's session; escalations correlate on the child's
 * original triggerId carried in the payload. Shared by the respond route and
 * the drain-on-source-registration path so the two cannot drift.
 */
export async function emitDeliveryResponseRelay(delivery: Delivery, event: TriggerEvent): Promise<boolean> {
  if (event.source.kind !== "session" || !event.source.id) return false;
  const originalTriggerId = typeof event.payload?.originalTriggerId === "string"
    ? event.payload.originalTriggerId
    : undefined;
  let correlationId = event.fireId ?? delivery.deliveryId;
  let originalDelivery: Delivery | null = null;
  let originalEvent: TriggerEvent | null = null;
  if (originalTriggerId) {
    originalDelivery = await getDelivery(originalTriggerId).catch(() => null);
    originalEvent = originalDelivery
      ? await getEvent(originalDelivery.eventId).catch(() => null)
      : await getEventByFireId(originalTriggerId).catch(() => null);
    correlationId = originalEvent?.fireId ?? originalTriggerId;
  }
  const isSessionComplete = event.type === "lifecycle:session_complete"
    || originalEvent?.type === "lifecycle:session_complete";
  const relaySessionId = isSessionComplete
    ? (originalDelivery?.sessionId ?? delivery.sessionId)
    : event.source.id;
  return emitTriggerResponse(relaySessionId, {
    triggerId: correlationId,
    response: delivery.response?.text ?? "",
    ...(delivery.response?.action ? { action: delivery.response.action } : {}),
    targetSessionId: delivery.sessionId,
  });
}

async function ownerOfRunnerFor(sessionId: string): Promise<string | null> {
  const session = await getSharedSession(sessionId);
  if (!session?.runnerId) return null;
  const runner = await getRunnerData(session.runnerId).catch(() => null);
  return runner?.userId ?? null;
}
