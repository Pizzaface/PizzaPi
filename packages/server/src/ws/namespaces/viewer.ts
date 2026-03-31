// ============================================================================
// /viewer namespace — Browser viewer ↔ Server
//
// Handles viewer connection to sessions, snapshot replay for disconnected
// sessions, collab-mode input/model/exec forwarding to the TUI socket,
// and resync requests.
// ============================================================================

import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type {
    ViewerClientToServerEvents,
    ViewerServerToClientEvents,
    ViewerInterServerEvents,
    ViewerSocketData,
} from "@pizzapi/protocol";

// Inline definition mirrors packages/protocol/src/shared.ts ServiceEnvelope.
// Using a local alias avoids a cross-worktree symlink resolution issue where
// node_modules/@pizzapi/protocol points to the main branch's dist, not this
// worktree's updated dist.
type ServiceEnvelope = { serviceId: string; type: string; requestId?: string; payload: unknown };
import { sessionCookieAuthMiddleware } from "./auth.js";
import { getRunnerServiceAnnounce } from "./runner.js";
import {
    getSharedSession,
    getSharedSessionSummary,
    addViewer,
    removeViewer,
    getSessionSeq,
    sendSnapshotToViewer,
    getLocalTuiSocket,
    emitToRelaySession,
    emitToRelaySessionVerified,
    emitToRunner,
    broadcastToSessionViewers,
} from "../sio-registry.js";
import { isChildOfParent } from "../sio-state/index.js";
import { getPendingChunkedSnapshot } from "./relay/index.js";
import { getPersistedRelaySessionSnapshot } from "../../sessions/store.js";
import { getCachedRelayEvents, getLatestCachedSnapshotEvent } from "../../sessions/redis.js";
import { recordTriggerResponse } from "../../sessions/trigger-store.js";
import { createLogger } from "@pizzapi/tools";

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = createLogger("sio/viewer");

type ViewerSocket = Socket<
    ViewerClientToServerEvents,
    ViewerServerToClientEvents,
    ViewerInterServerEvents,
    ViewerSocketData
>;

interface AgentEndEvent extends Record<string, unknown> {
    type: "agent_end";
    messages: unknown[];
}

interface SessionActiveEvent extends Record<string, unknown> {
    type: "session_active";
    state: unknown;
}

/** @internal — exported for unit tests only */
export function isAgentEndEvent(evt: unknown): evt is AgentEndEvent {
    return (
        typeof evt === "object" &&
        evt !== null &&
        "type" in evt &&
        evt.type === "agent_end" &&
        "messages" in evt &&
        Array.isArray((evt as AgentEndEvent).messages)
    );
}

/** @internal — exported for unit tests only */
export function isSessionActiveEvent(evt: unknown): evt is SessionActiveEvent {
    return (
        typeof evt === "object" &&
        evt !== null &&
        "type" in evt &&
        evt.type === "session_active" &&
        "state" in evt &&
        (evt as SessionActiveEvent).state !== undefined
    );
}

/**
 * Scan cached events from newest to oldest, looking for the latest
 * full-state snapshot (agent_end with messages, or session_active with state).
 * @internal — exported for unit tests only
 */
export function findLatestSnapshotEvent(cachedEvents: unknown[]): Record<string, unknown> | null {
    for (let i = cachedEvents.length - 1; i >= 0; i--) {
        const raw = cachedEvents[i];
        if (isAgentEndEvent(raw)) return raw;
        if (isSessionActiveEvent(raw)) return raw;
    }
    return null;
}

/** @internal — exported for unit tests only */
export function onViewerConnectedSignal(
    viewerReadyForRunnerSignal: boolean,
    pendingConnectedSignal: boolean,
): { pendingConnectedSignal: boolean; forwardNow: boolean } {
    if (viewerReadyForRunnerSignal) {
        return { pendingConnectedSignal: false, forwardNow: true };
    }
    return { pendingConnectedSignal: true, forwardNow: false };
}

/** @internal — exported for unit tests only */
export function onViewerReadyForRunnerSignal(
    pendingConnectedSignal: boolean,
): { pendingConnectedSignal: boolean; forwardNow: boolean } {
    if (!pendingConnectedSignal) {
        return { pendingConnectedSignal: false, forwardNow: false };
    }
    return { pendingConnectedSignal: false, forwardNow: true };
}

/** @internal — exported for unit tests only */
export function withHubMetaSource<T extends Record<string, unknown>>(payload: T): T & { meta_source: "hub" } {
    return { ...payload, meta_source: "hub" };
}

/** @internal — exported for unit tests only */
export function withMetaViaHubHint<T extends Record<string, unknown>>(event: T): T & { _metaViaHub: true } {
    return { ...event, _metaViaHub: true };
}

/** @internal — exported for unit tests only */
export function withLivenessOnlyHint<T extends Record<string, unknown>>(event: T): T & { _livenessOnly: true } {
    return { ...event, _livenessOnly: true };
}

/** @internal — exported for unit tests only */
export function isViewerSwitchCurrent(currentGeneration: number | undefined, requestedGeneration?: number): boolean {
    return requestedGeneration === undefined || currentGeneration === requestedGeneration;
}

/**
 * Try to send the latest snapshot event from the Redis event cache.
 * Returns true if a snapshot was sent, false otherwise.
 */
async function sendLatestSnapshotFromCache(
    socket: ViewerSocket,
    sessionId: string,
    generation?: number,
): Promise<boolean> {
    const snapshotEvent = await getLatestCachedSnapshotEvent(sessionId);
    if (!snapshotEvent) return false;

    socket.emit("event", { event: snapshotEvent, replay: true, generation });
    return true;
}

/**
 * Replay a persisted (SQLite + Redis) snapshot for a session that is
 * no longer live. Sends the snapshot, then disconnects the viewer.
 */
async function replayPersistedSnapshot(
    socket: ViewerSocket,
    sessionId: string,
    userId: string,
    generation?: number,
): Promise<void> {
    try {
        const snapshot = await getPersistedRelaySessionSnapshot(sessionId, userId);
        if (!snapshot) {
            socket.emit("error", { message: "Session not found" });
            socket.disconnect();
            return;
        }

        socket.emit("connected", withHubMetaSource({ sessionId, replayOnly: true, generation }));

        // Fast path: send only the latest snapshot from Redis cache
        // (ownership already validated by persisted snapshot lookup above)
        const sentFromCache = await sendLatestSnapshotFromCache(socket, sessionId, generation);

        if (!sentFromCache) {
            // Cache miss — fall back to persisted state from SQLite.
            // If the persisted state is also null (e.g. no relay_session_state
            // row yet), there is nothing to replay.
            if (snapshot.state === null || snapshot.state === undefined) {
                socket.emit("error", { message: "Session snapshot not available" });
                socket.disconnect();
                return;
            }
            socket.emit("event", {
                event: withMetaViaHubHint({ type: "session_active", state: snapshot.state }),
                generation,
            });
        }

        socket.emit("disconnected", {
            reason: "Session is no longer live (snapshot replay).",
            code: "snapshot_replay",
            generation,
        });
        // Use disconnect() without `true` so the client can still auto-reconnect
        // when the session comes back online. disconnect(true) sets reason to
        // "io server disconnect" on the client, which permanently disables
        // socket.io's auto-reconnect logic.
        socket.disconnect();
    } catch (error) {
        socket.emit("error", { message: "Failed to load session snapshot" });
        socket.disconnect();
        log.error("Failed to replay persisted snapshot:", error);
    }
}

// ── Namespace registration ───────────────────────────────────────────────────

export function registerViewerNamespace(io: SocketIOServer): void {
    const viewer: Namespace<
        ViewerClientToServerEvents,
        ViewerServerToClientEvents,
        ViewerInterServerEvents,
        ViewerSocketData
    > = io.of("/viewer");

    // Auth: validate session cookie from handshake
    viewer.use(sessionCookieAuthMiddleware() as Parameters<typeof viewer.use>[0]);

    viewer.on("connection", async (socket) => {
        // Optional initial session ID from the handshake. Newer clients keep one
        // viewer socket alive and switch sessions logically via switch_session,
        // but we preserve handshake-based bootstrap for backward compatibility.
        const initialSessionId =
            (typeof socket.handshake.auth?.sessionId === "string"
                ? socket.handshake.auth.sessionId
                : undefined) ??
            (typeof socket.handshake.query?.sessionId === "string"
                ? socket.handshake.query.sessionId
                : undefined) ??
            "";

        const viewerUserId = socket.data.userId;
        if (!viewerUserId) {
            socket.emit("error", { message: "Unauthorized" });
            socket.disconnect(true);
            return;
        }

log.info(`connected: ${socket.id} userId=${viewerUserId}`);

        if (socket.data.protocolCompatible === false) {
            socket.emit("error", {
                message: "Protocol mismatch detected between UI and server. Some real-time features may be unavailable until you refresh/update the UI.",
            });
        }

        // ── Register ALL event handlers FIRST ────────────────────────────────
        // Handlers must be registered synchronously before any async work
        // (snapshot sending, addViewer, etc.) to avoid a race condition where
        // the client receives "connected", immediately fires "exec" or
        // "input", but the handler isn't registered yet because we're still
        // awaiting Redis calls. This is the root cause of Check+Kill failing
        // for non-active sessions (especially when ending 3+ sessions at
        // once — the concurrent async work widens the race window).

        // Gate forwarding of viewer "connected" → runner until this viewer has
        // joined the room. Otherwise a fast runner can emit session_active/chunks
        // before addViewer() completes, forcing a resync and visible startup lag.
        let viewerReadyForRunnerSignal = false;
        let pendingConnectedSignal = false;

        const getCurrentSessionId = (): string | null => socket.data.sessionId ?? null;
        const getCurrentGeneration = (): number | undefined =>
            typeof socket.data.generation === "number" ? socket.data.generation : undefined;

        const activateSession = async (nextSessionId: string, generation?: number): Promise<void> => {
            if (!nextSessionId) {
                socket.data.sessionId = undefined;
                return;
            }

            socket.data.generation = generation;
            const previousSessionId = getCurrentSessionId();
            if (previousSessionId && previousSessionId !== nextSessionId) {
                await removeViewer(previousSessionId, socket);
                if (!isViewerSwitchCurrent(getCurrentGeneration(), generation)) return;
            }

            const sessionSummary = await getSharedSessionSummary(nextSessionId);
            if (!isViewerSwitchCurrent(getCurrentGeneration(), generation)) return;

            if (!sessionSummary) {
                socket.data.sessionId = undefined;
                socket.emit("disconnected", { reason: "Session ended", code: "session_ended", generation });
                return;
            }

            if (!sessionSummary.userId || sessionSummary.userId !== viewerUserId) {
                socket.data.sessionId = undefined;
                socket.emit("error", { message: "Session not found", generation });
                return;
            }

            // Join the room first, then allow the viewer's "connected" signal to
            // reach the runner. This avoids losing the first live snapshot/chunks
            // and reduces startup resync churn.
            const ok = await addViewer(nextSessionId, socket, {
                sessionSummaryHint: sessionSummary,
                touchAsync: true,
            });
            if (!isViewerSwitchCurrent(getCurrentGeneration(), generation)) {
                if (ok) {
                    await removeViewer(nextSessionId, socket);
                }
                return;
            }
            if (!ok) {
                socket.data.sessionId = undefined;
                socket.emit("disconnected", { reason: "Session ended", code: "session_ended", generation });
                return;
            }

            socket.data.sessionId = nextSessionId;
            viewerReadyForRunnerSignal = true;
            const flush = onViewerReadyForRunnerSignal(pendingConnectedSignal);
            pendingConnectedSignal = flush.pendingConnectedSignal;
            if (flush.forwardNow) {
                emitToRelaySession(nextSessionId, "connected" as string, {});
            }

            // Re-fetch session state and seq AFTER addViewer() to avoid emitting
            // stale data. Between the initial fetch and here, the runner may have
            // published a newer session_active (especially for chunked delivery).
            // Using the old lastState + old lastSeq would overwrite the fresh
            // snapshot and rewind lastSeqRef on the client, triggering a bogus
            // resync on actively changing sessions.
            const [freshSession, freshSeq] = await Promise.all([
                getSharedSession(nextSessionId),
                getSessionSeq(nextSessionId),
            ]);

            if (!isViewerSwitchCurrent(getCurrentGeneration(), generation)) {
                await removeViewer(nextSessionId, socket);
                return;
            }

            if (!freshSession) {
                socket.data.sessionId = undefined;
                socket.emit("disconnected", { reason: "Session ended", code: "session_ended", generation });
                return;
            }

            socket.emit("connected", withHubMetaSource({
                sessionId: nextSessionId,
                lastSeq: freshSeq,
                isActive: freshSession.isActive,
                lastHeartbeatAt: freshSession.lastHeartbeatAt,
                sessionName: freshSession.sessionName,
                generation,
            }));

            // Send cached service_announce so the viewer knows which runner
            // services are available without waiting for a fresh announce.
            log.info(`service_announce check: runnerId=${freshSession.runnerId ?? "null"}`);
            if (freshSession.runnerId) {
                const announce = getRunnerServiceAnnounce(freshSession.runnerId);
                const serviceIds = announce?.serviceIds ?? [];
                log.info(`service_announce: runnerId=${freshSession.runnerId}, cached serviceIds=[${serviceIds.join(",")}]`);
                if (serviceIds.length > 0) {
                    socket.emit("service_announce", { ...announce!, generation });
                }
            }

            // Emit an immediate heartbeat snapshot while the runner pushes a fresh
            // session_active in response to "connected".
            if (freshSession.lastHeartbeat) {
                try {
                    socket.emit("event", {
                        event: withLivenessOnlyHint(JSON.parse(freshSession.lastHeartbeat)),
                        seq: freshSeq,
                        generation,
                    });
                } catch {}
            }

            // If a chunked delivery is in-flight, lastState is stale (chunked
            // session_active intentionally skips updating it). Emitting the old
            // non-chunked snapshot here would overwrite the chunked header the
            // viewer already received via the room broadcast, clear chunk-tracking
            // in App.tsx, and cause remaining chunks to be dropped. Skip it and
            // let the runner's fresh chunked delivery hydrate the viewer instead.
            const chunkedPending = getPendingChunkedSnapshot(nextSessionId);
            if (freshSession.lastState && !chunkedPending) {
                try {
                    socket.emit("event", {
                        event: withMetaViaHubHint({ type: "session_active", state: JSON.parse(freshSession.lastState) }),
                        seq: freshSeq,
                        generation,
                    });
                } catch {}
            } else if (!chunkedPending) {
                // No in-memory state — fall back to event cache.
                // Don't send partial chunked snapshots here — they'd arrive as
                // non-chunked SA events, set lastCompletedSnapshotRef, and cause
                // the UI to reject subsequent chunks from the active stream.
                // The runner re-emits a fresh snapshot on the "connected" event
                // below, which will properly restart chunked delivery.
                await sendLatestSnapshotFromCache(socket, nextSessionId, generation);
            }
        };

        // ── switch_session — reuse the viewer socket across session changes ─
        socket.on("switch_session", async (data) => {
            if (!data || typeof data.sessionId !== "string" || !data.sessionId) return;
            await activateSession(data.sessionId, typeof data.generation === "number" ? data.generation : undefined);
        });

        // ── connected — viewer greeting, notify TUI ─────────────────────────
        // Use emitToRelaySession for cluster-wide reach — the runner may
        // be on a different server node in multi-node deployments.
        socket.on("connected", () => {
            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) return;
            const next = onViewerConnectedSignal(viewerReadyForRunnerSignal, pendingConnectedSignal);
            pendingConnectedSignal = next.pendingConnectedSignal;
            if (next.forwardNow) {
                emitToRelaySession(currentSessionId, "connected" as string, {});
            }
        });

        // ── resync — send fresh snapshot ─────────────────────────────────────
        socket.on("resync", async () => {
            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) return;
            // If a chunked delivery is in-flight on this node, skip
            // sendSnapshotToViewer() entirely — that helper unconditionally
            // emits lastState (the previous completed non-chunked snapshot),
            // which would clear chunkedDeliveryRef on the client and cause all
            // remaining session_messages_chunk events from the active stream to
            // be dropped.  Ask the runner for a fresh chunked delivery instead;
            // it will arrive in-order via the room broadcast.
            //
            // Note: getPendingChunkedSnapshot() reads node-local in-memory state.
            // In a multi-node deployment this returns null when the delivery is
            // managed by a different server node.  In that case we fall through to
            // sendSnapshotToViewer(), which is the same behaviour as before this
            // guard was added — a degraded-but-safe fallback for a deployment
            // topology PizzaPi doesn't formally support.
            const resyncChunkedPending = getPendingChunkedSnapshot(currentSessionId);
            if (resyncChunkedPending) {
                // A chunked delivery is in-flight on this node.  DON'T request
                // a room-wide re-emit via emitToRelaySession("connected") —
                // that triggers emitSessionActive() on the runner which
                // broadcasts to ALL viewers, resetting every watcher's
                // transcript even though only this one viewer needed recovery.
                //
                // Fall through to sendSnapshotToViewer() below instead.  This
                // sends the previous completed (non-chunked) lastState — it's
                // slightly stale but gives the viewer a complete transcript.
                // The non-chunked SA will set lastCompletedSnapshotRef on the
                // client, which rejects remaining chunks from the in-flight
                // delivery.  That's acceptable: the viewer has a working
                // transcript, and the next session_active (from normal agent
                // activity or a later resync after the chunked delivery
                // finishes) will bring them fully up to date.
            }

            await sendSnapshotToViewer(currentSessionId, socket);

            // If no lastState was available (e.g. mid-chunked-delivery),
            // ask the runner to re-emit a fresh snapshot rather than sending
            // a partial non-chunked SA (which would set lastCompletedSnapshotRef
            // and cause the UI to reject all subsequent chunks from the
            // still-active stream).
            // Use emitToRelaySession for cluster-wide reach — the runner may
            // be on a different server node in multi-node deployments.
            const session = await getSharedSession(currentSessionId);
            if (!session?.lastState) {
                emitToRelaySession(currentSessionId, "connected" as string, {});
            }
        });

        // ── input — collab mode: forward user input to TUI ──────────────────
        socket.on("input", async (data) => {
            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) return;
            const currentSession = await getSharedSession(currentSessionId);
            if (!currentSession?.collabMode) return;

            const tuiSocket = getLocalTuiSocket(currentSessionId);
            if (!tuiSocket) return;

            // Parse and validate attachments
            const attachments = Array.isArray(data.attachments)
                ? data.attachments
                      .filter(
                          (entry): entry is Record<string, unknown> =>
                              entry !== null && typeof entry === "object",
                      )
                      .map((item) => ({
                          attachmentId:
                              typeof item.attachmentId === "string" ? item.attachmentId : undefined,
                          mediaType: typeof item.mediaType === "string" ? item.mediaType : undefined,
                          filename: typeof item.filename === "string" ? item.filename : undefined,
                          url: typeof item.url === "string" ? item.url : undefined,
                      }))
                      .filter(
                          (item) =>
                              (typeof item.attachmentId === "string" && item.attachmentId.length > 0) ||
                              (typeof item.url === "string" && item.url.length > 0),
                      )
                : [];

            const payload: Record<string, unknown> = {
                text: data.text,
                attachments,
            };
            if (data.client) payload.client = data.client;
            if (data.deliverAs === "steer" || data.deliverAs === "followUp") {
                payload.deliverAs = data.deliverAs;
            }

            tuiSocket.emit("input" as string, payload);
        });

        // ── model_set — collab mode: forward model switch to TUI ─────────────
        socket.on("model_set", async (data) => {
            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) return;
            const currentSession = await getSharedSession(currentSessionId);
            if (!currentSession?.collabMode) return;

            const tuiSocket = getLocalTuiSocket(currentSessionId);
            if (!tuiSocket) return;

            tuiSocket.emit("model_set" as string, {
                provider: data.provider,
                modelId: data.modelId,
            });
        });

        // ── exec — collab mode: forward remote command to TUI ────────────────
        socket.on("exec", async (data) => {
            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) return;
            const currentSession = await getSharedSession(currentSessionId);
            if (!currentSession?.collabMode) return;

            const tuiSocket = getLocalTuiSocket(currentSessionId);
            if (!tuiSocket) return;

            tuiSocket.emit("exec" as string, data);
        });

        // ── mcp_oauth_paste — user pasted OAuth callback URL ──────────────
        // Forward the extracted auth code to the runner's relay session so
        // the OAuth provider can complete the token exchange.
        // Uses verified delivery (like trigger_response): acks on success
        // so the UI can distinguish delivered pastes from dropped ones.
        socket.on("mcp_oauth_paste", async (data: any, ack?: (...args: any[]) => void) => {
            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) {
                if (typeof ack === "function") ack({ ok: false, error: "No active session" });
                return;
            }
            const currentSession = await getSharedSession(currentSessionId);
            if (!currentSession?.collabMode) {
                if (typeof ack === "function") ack({ ok: false, error: "Session not in collab mode" });
                return;
            }

            const { nonce, code, state } = data ?? {};
            if (typeof nonce !== "string" || typeof code !== "string") {
                if (typeof ack === "function") ack({ ok: false, error: "Missing nonce or code" });
                return;
            }

            const payload = {
                nonce,
                code,
                ...(typeof state === "string" ? { state } : {}),
            };

            // Try local TUI socket first, fall back to relay room.
            const tuiSocket = getLocalTuiSocket(currentSessionId);
            if (tuiSocket) {
                tuiSocket.emit("mcp_oauth_paste" as string, payload);
                if (typeof ack === "function") ack({ ok: true });
            } else if (await emitToRelaySessionVerified(currentSessionId, "mcp_oauth_paste", payload)) {
                if (typeof ack === "function") ack({ ok: true });
            } else {
                if (typeof ack === "function") ack({ ok: false, error: "Runner session unavailable" });
            }
        });

        // ── trigger_response — human viewer responds to child trigger ────────
        // Route directly to the child session via its relay socket,
        // bypassing the parent CLI. This avoids depending on an in-memory
        // handler in the parent to forward the response.
        socket.on("trigger_response", async (data: any, ack?: (...args: any[]) => void) => {
            const { triggerId, response, action, targetSessionId } = data ?? {};
            if (!triggerId || response == null) return;

            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) return;

            // Require collab mode — same gate as input/exec/model_set
            const currentSession = await getSharedSession(currentSessionId);
            if (!currentSession?.collabMode) return;

            // If targetSessionId is explicitly provided, route to that child.
            // Validate ownership: the target session must belong to the same user.
            if (targetSessionId) {
                const targetSession = await getSharedSession(targetSessionId);
                if (!targetSession) {
                    // Target session no longer exists (child exited) — don't ack so the
                    // UI keeps retry controls visible, and emit trigger_error for feedback.
                    socket.emit("trigger_error", { message: `Child session ${targetSessionId} is no longer available`, triggerId });
                    return;
                }
                if (targetSession.userId !== viewerUserId) {
                    // Security: belongs to a different user — nack with trigger_error.
                    socket.emit("trigger_error", { message: `Target session ${targetSessionId} not found or unauthorized`, triggerId });
                    return;
                }
                // Security: verify the target is a child of the current session to prevent
                // cross-session trigger injection between unrelated sessions of the same user.
                const childVerified = await isChildOfParent(currentSessionId, targetSessionId);
                if (!childVerified) {
                    socket.emit("trigger_error", { message: `Target session ${targetSessionId} is not a child of this session`, triggerId });
                    return;
                }
                const triggerPayload = {
                    triggerId,
                    response,
                    ...(action ? { action } : {}),
                };
                // Try local socket first, fall back to relay room for cross-node delivery.
                // Only ack on successful delivery so the client can distinguish
                // delivered responses from dropped ones.
                const childSocket = getLocalTuiSocket(targetSessionId);
                if (childSocket) {
                    childSocket.emit("trigger_response" as string, triggerPayload);
                    // Record the response in the parent's trigger history so the
                    // TriggersPanel shows it as responded (not perpetually pending).
                    void recordTriggerResponse(currentSessionId, triggerId, { action, text: response }).catch(() => {});
                    broadcastToSessionViewers(currentSessionId, "trigger_delivered", { triggerId });
                    if (typeof ack === "function") ack();
                } else if (await emitToRelaySessionVerified(targetSessionId, "trigger_response", triggerPayload)) {
                    void recordTriggerResponse(currentSessionId, triggerId, { action, text: response }).catch(() => {});
                    broadcastToSessionViewers(currentSessionId, "trigger_delivered", { triggerId });
                    if (typeof ack === "function") ack();
                } else {
                    socket.emit("trigger_error", { message: `Failed to deliver trigger response to child session ${targetSessionId}`, triggerId });
                }
                return;
            }

            // Fallback: forward to the parent session's TUI socket (or relay room)
            const triggerPayloadForParent = {
                triggerId,
                response,
                ...(action ? { action } : {}),
                targetSessionId,
            };
            const tuiSocket = getLocalTuiSocket(currentSessionId);
            if (tuiSocket) {
                tuiSocket.emit("trigger_response" as string, triggerPayloadForParent);
                void recordTriggerResponse(currentSessionId, triggerId, { action, text: response }).catch(() => {});
                broadcastToSessionViewers(currentSessionId, "trigger_delivered", { triggerId });
                if (typeof ack === "function") ack();
            } else if (await emitToRelaySessionVerified(currentSessionId, "trigger_response", triggerPayloadForParent)) {
                void recordTriggerResponse(currentSessionId, triggerId, { action, text: response }).catch(() => {});
                broadcastToSessionViewers(currentSessionId, "trigger_delivered", { triggerId });
                if (typeof ack === "function") ack();
            } else {
                socket.emit("trigger_error", { message: `Failed to deliver trigger response to session ${currentSessionId}`, triggerId });
            }
        });

        // ── service_message — viewer → runner: forward service envelope ──────
        // Viewers send service_message to interact with runner services
        // (e.g. request file listings, git status, etc.) without the relay
        // needing to understand service-specific semantics.
        // IMPORTANT: service handlers are registered on the /runner namespace
        // socket, NOT on the /relay TUI socket. emitToRelaySession would target
        // the TUI worker (/relay namespace) which does NOT handle service_message
        // events — all viewer-initiated service requests would be silently dropped.
        // We must route to the runner via emitToRunner(runnerId, ...) instead.
        socket.on("service_message", async (envelope: ServiceEnvelope) => {
            const currentSessionId = getCurrentSessionId();
            if (!currentSessionId) return;
            const currentSession = await getSharedSession(currentSessionId);
            if (!currentSession?.collabMode) return;
            const runnerId = currentSession.runnerId;
            if (!runnerId) return;
            // Attach sessionId so the runner service knows which session to respond to
            emitToRunner(runnerId, "service_message", { ...envelope, sessionId: currentSessionId });
        });

        // ── disconnect ───────────────────────────────────────────────────────
        socket.on("disconnect", async (reason) => {
            const currentSessionId = getCurrentSessionId();
            log.info(`disconnected: ${socket.id} sessionId=${currentSessionId ?? "none"} (${reason})`);
            if (currentSessionId) {
                await removeViewer(currentSessionId, socket);
            }
        });

        // ── Optional initial session bootstrap (backward compatibility) ─────
        if (initialSessionId) {
            const initialSession = await getSharedSession(initialSessionId);
            if (!initialSession) {
                // Session not live — try to replay a persisted snapshot for older
                // clients that still bind the session in the handshake.
                await replayPersistedSnapshot(socket, initialSessionId, viewerUserId);
                return;
            }

            if (!initialSession.userId || initialSession.userId !== viewerUserId) {
                socket.emit("error", { message: "Session not found" });
                socket.disconnect(true);
                return;
            }

            await activateSession(initialSessionId, 0);
        }
    });
}
