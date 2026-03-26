// ============================================================================
// sessions.ts — Session and viewer lifecycle management
//
// Covers:
//   - TUI session registration, heartbeat, state, expiry sweep
//   - Viewer socket add/remove/broadcast
//   - Orphaned-session sweep
// ============================================================================

import type { Socket } from "socket.io";
import { randomBytes, randomUUID } from "crypto";
import {
    type RedisSessionData,
    setSession,
    getSession,
    updateSessionFields,
    deleteSession,
    getAllSessions,
    refreshSessionTTL,
    incrementSeq,
    getSeq,
    setPendingRunnerLink,
    getPendingRunnerLink,
    deletePendingRunnerLink,
    getRunnerAssociation,
    setRunnerAssociation,
    refreshRunnerAssociationTTL,
    scanExpiredSessions,
    addChildSession,
    addChildSessionMembership,
    removeChildSession,
    isChildDelinked,
    clearParentSessionId,
    refreshChildSessionsTTL,
    removePendingParentDelinkChild,
    getRunner as getRunnerState,
} from "../sio-state.js";
import {
    getPersistedRelaySessionRunner,
    recordRelaySessionStart,
    recordRelaySessionEnd,
    recordRelaySessionState,
    touchRelaySession,
} from "../../sessions/store.js";
import { appendRelayEventToCache } from "../../sessions/redis.js";
import { storeAndReplaceImages, storeAndReplaceImagesInEvent } from "../strip-images.js";
import { extractMetaFromHeartbeat } from "./meta.js";
import { severStaleParentLink } from "../stale-parent-link.js";
import type { SessionInfo } from "@pizzapi/protocol";
import {
    getIo,
    localTuiSockets,
    lastTouchTimes,
    TOUCH_THROTTLE_MS,
    viewerSessionRoom,
    relaySessionRoom,
    nextEphemeralExpiry,
    safeJsonParse,
    modelFromHeartbeat,
    emitToRunner,
} from "./context.js";
import { broadcastToHub } from "./hub.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("sio-registry");

// ── Internal helpers ─────────────────────────────────────────────────────────

function normalizeSessionName(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

// ── Session Management ──────────────────────────────────────────────────────

export interface RegisterTuiSessionOpts {
    sessionId?: string;
    isEphemeral?: boolean;
    collabMode?: boolean;
    sessionName?: string | null;
    userId?: string;
    userName?: string;
    /** Parent session ID — set when registering a child session. */
    parentSessionId?: string | null;
}

/**
 * Register a TUI session via Socket.IO.
 *
 * 1. Generate token, sessionId, shareUrl
 * 2. Store session data in Redis
 * 3. Store socket reference locally
 * 4. Join relay session room
 * 5. Broadcast session_added to hub
 * 6. Persist to SQLite
 */
export async function registerTuiSession(
    socket: Socket,
    cwd: string = "",
    opts: RegisterTuiSessionOpts = {},
): Promise<{ sessionId: string; token: string; shareUrl: string; parentSessionId: string | null; wasDelinked: boolean }> {
    const requestedSessionId = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
    const sessionId = requestedSessionId.length > 0 ? requestedSessionId : randomUUID();
    const token = randomBytes(32).toString("hex");
    const shareUrl = `${process.env.PIZZAPI_BASE_URL ?? "http://localhost:5173"}/session/${sessionId}`;
    // startedAt is resolved after the existing-session check below so that
    // reconnects preserve the original value.  This is critical for the
    // epoch-based delink filter in delink_children.
    let startedAt: string;
    const userId = opts.userId ?? null;
    const userName = opts.userName ?? null;
    const isEphemeral = opts.isEphemeral !== false;
    const collabMode = opts.collabMode !== false;
    const sessionName = normalizeSessionName(opts.sessionName);

    // If session already exists, end it first (reconnect).
    // IMPORTANT: Clear the old socket's sessionId BEFORE ending the session
    // to prevent a race where the old socket's disconnect handler fires after
    // the new session is created and kills it.  Without this, Socket.IO
    // reconnects create a kill loop: new socket registers → old socket's
    // deferred disconnect fires → endSharedSession kills the new session →
    // Socket.IO reconnects → repeat.
    const existing = await getSession(sessionId);
    const previousParentSessionId = existing?.parentSessionId ?? null;
    if (existing) {
        const oldSocket = localTuiSockets.get(sessionId);
        if (oldSocket && oldSocket !== socket) {
            oldSocket.data.sessionId = undefined;
        }
        await endSharedSession(sessionId, "Session reconnected");
    }

    // Preserve the original startedAt on reconnect so that epoch-based
    // delink filtering works correctly.
    startedAt = existing?.startedAt ?? new Date().toISOString();

    // Check for pending runner link
    const pendingRunnerId = await getPendingRunnerLink(sessionId);
    let runnerId: string | null = null;
    let runnerName: string | null = null;

    if (pendingRunnerId) {
        await deletePendingRunnerLink(sessionId);
        const runner = await getRunnerState(pendingRunnerId);
        if (runner) {
            runnerId = pendingRunnerId;
            runnerName = runner.name;
            // Persist the durable association so it survives server restarts.
            // linkSessionToRunner couldn't set it because the session didn't
            // exist yet when the runner reported session_ready.
            await setRunnerAssociation(sessionId, runnerId, runnerName);
        }
    }

    // If no pending runner link, check for a durable runner association
    // that survived a server restart (stored as a TTL'd Redis key).
    if (!runnerId) {
        const assoc = await getRunnerAssociation(sessionId);
        if (assoc) {
            runnerId = assoc.runnerId;
            runnerName = assoc.runnerName;
        }
    }

    // Redis-side runner association keys can disappear during a Redis restart
    // even though SQLite still has durable session provenance. Fall back to the
    // persisted session row so reconnecting live sessions keep their runner link
    // (service panels, runner routing, etc.) after the relay re-registers.
    if (!runnerId) {
        const persistedRunner = await getPersistedRelaySessionRunner(sessionId);
        if (persistedRunner?.runnerId) {
            runnerId = persistedRunner.runnerId;
            runnerName = persistedRunner.runnerName;
            await setRunnerAssociation(sessionId, runnerId, runnerName);
        }
    }

    // Resolve parentSessionId: prefer the value from registration opts (sent
    // by the CLI), fall back to any pre-seeded value in Redis (legacy path).
    let resolvedParentSessionId =
        opts.parentSessionId ??
        existing?.parentSessionId ??
        null;
    // Set to true when resolvedParentSessionId is forced to null because the
    // parent explicitly delinked this child (via delink_children on /new).
    let wasExplicitlyDelinked = false;

    // linkedParentId is a durable "is this a linked child?" signal.
    // It mirrors resolvedParentSessionId for the normal case, but — unlike
    // parentSessionId — is NOT cleared when the parent is transiently offline
    // during a child reconnect.  It is only cleared on explicit delink or a
    // cross-user link attempt.  Absent on pre-existing sessions; callers fall
    // back to parentSessionId.
    let linkedParentId: string | null = resolvedParentSessionId;

    // Validate parent session exists and belongs to the same user.
    // If the parent disconnected or the ID is stale, clear it to avoid
    // dangling trigger flows that would time out.
    // Fall back to SQLite when Redis has no record (e.g. relay restarted and
    // the parent's Redis key has expired) so that parent links survive restarts.
    if (resolvedParentSessionId) {
        const candidateParentId = resolvedParentSessionId;
        const parentSession = await getSession(resolvedParentSessionId);
        if (!parentSession) {
            // Redis miss means the parent is temporarily offline.
            //
            // IMPORTANT: If the parent explicitly delinked this child via /new,
            // a delink marker will already be present. In that case we must
            // NOT re-add the child to the old parent's membership set, or the
            // old parent could regain child-only privileges when it reconnects.
            const delinked = await isChildDelinked(sessionId);
            if (delinked) {
                await severStaleParentLink({
                    parentSessionId: candidateParentId,
                    childSessionId: sessionId,
                    clearParentSessionId,
                    removeChildSession,
                });
                wasExplicitlyDelinked = true;
                linkedParentId = null; // explicit delink — clear durable signal
            } else {
                // Parent offline but not delinked: preserve linkedParentId so
                // push-notification suppression remains active during the outage.
                // Keep the child in the membership set so future delink_children
                // snapshots can still find it. The child CLI still preserves
                // parentSessionId and will re-send it when the parent reconnects.
                //
                // NOTE: We use addChildSessionMembership (not addChildSession) so
                // we do NOT clear any existing delink marker — the marker may have
                // been set by a previous /new and should still take effect when
                // the parent comes back online.
                await addChildSessionMembership(candidateParentId, sessionId);
                // linkedParentId stays as candidateParentId — intentional.
            }
            resolvedParentSessionId = null;
        } else if (parentSession.userId !== userId) {
            // Cross-user link attempt — evict from membership set as well.
            await severStaleParentLink({
                parentSessionId: candidateParentId,
                childSessionId: sessionId,
                clearParentSessionId,
                removeChildSession,
            });
            resolvedParentSessionId = null;
            linkedParentId = null; // cross-user link: clear durable signal too
        }
    }

    // Check if parent explicitly delinked this child (via delink_children).
    if (resolvedParentSessionId) {
        const delinked = await isChildDelinked(sessionId);
        if (delinked) {
            // Parent ran /new while this child was offline — clear the link
            // permanently and signal the client via wasDelinked.
            await severStaleParentLink({
                parentSessionId: resolvedParentSessionId,
                childSessionId: sessionId,
                clearParentSessionId,
                removeChildSession,
            });
            wasExplicitlyDelinked = true;
            resolvedParentSessionId = null;
            linkedParentId = null; // explicit delink — clear durable signal
        }
    }

    const sessionData: RedisSessionData = {
        sessionId,
        token,
        collabMode,
        shareUrl,
        cwd,
        startedAt,
        userId,
        userName,
        sessionName,
        isEphemeral,
        expiresAt: isEphemeral ? nextEphemeralExpiry() : null,
        isActive: false,
        lastHeartbeatAt: null,
        lastHeartbeat: null,
        lastState: null,
        runnerId,
        runnerName,
        seq: 0,
        parentSessionId: resolvedParentSessionId,
        linkedParentId,
    };

    await setSession(sessionId, sessionData);

    // Register parent→child relationship in Redis for the trigger system.
    // This is the authoritative place for linking — no more racy pre-seeding.
    if (resolvedParentSessionId) {
        await addChildSession(resolvedParentSessionId, sessionId);
        if (previousParentSessionId) {
            // The child is now linked to a parent again, so any old retry
            // entries for its previous parent can be discarded to avoid
            // later delink_children hits re-delinking this child incorrectly.
            await removePendingParentDelinkChild(previousParentSessionId, sessionId);
        }
    }

    // Store local socket reference
    localTuiSockets.set(sessionId, socket);

    // Join relay session room
    await socket.join(relaySessionRoom(sessionId));

    // Persist to SQLite
    void recordRelaySessionStart({
        sessionId,
        userId: userId ?? undefined,
        userName: userName ?? undefined,
        cwd,
        shareUrl,
        startedAt,
        isEphemeral,
        runnerId,
        runnerName,
    }).catch((error) => {
        log.error("Failed to persist relay session start:", error);
    });

    // Broadcast to hub
    await broadcastToHub(
        "session_added",
        {
            sessionId,
            shareUrl,
            cwd,
            startedAt,
            userId: userId ?? undefined,
            userName: userName ?? undefined,
            sessionName,
            isEphemeral,
            isActive: false,
            lastHeartbeatAt: null,
            model: null,
            runnerId,
            runnerName,
            parentSessionId: resolvedParentSessionId,
        } satisfies SessionInfo,
        userId ?? undefined,
    );

    return { sessionId, token, shareUrl, parentSessionId: resolvedParentSessionId, wasDelinked: wasExplicitlyDelinked };
}

/**
 * Get the local TUI socket for a session (only available on the server
 * that owns the session).
 */
export function getLocalTuiSocket(sessionId: string): Socket | undefined {
    return localTuiSockets.get(sessionId);
}

/**
 * Remove the local TUI socket reference for a session.
 */
export function removeLocalTuiSocket(sessionId: string): void {
    localTuiSockets.delete(sessionId);
}

/** Returns a public summary of active sessions from Redis. */
export async function getSessions(filterUserId?: string): Promise<SessionInfo[]> {
    const sessions = await getAllSessions(filterUserId);
    return sessions.map((s) => {
        const heartbeat = s.lastHeartbeat ? safeJsonParse(s.lastHeartbeat) : null;
        const model = modelFromHeartbeat(heartbeat);
        const rawWorkerType = (heartbeat as any)?.workerType;
        const workerType: "pi" | "claude-code" | undefined =
            rawWorkerType === "claude-code" ? "claude-code" :
            rawWorkerType === "pi" ? "pi" :
            undefined;

        return {
            sessionId: s.sessionId,
            shareUrl: s.shareUrl,
            cwd: s.cwd,
            startedAt: s.startedAt,
            // Viewer count is calculated from Socket.IO rooms
            viewerCount: 0, // Will be populated by caller using getViewerCount()
            userId: s.userId ?? undefined,
            userName: s.userName ?? undefined,
            sessionName: s.sessionName,
            isEphemeral: s.isEphemeral,
            expiresAt: s.expiresAt,
            isActive: s.isActive,
            lastHeartbeatAt: s.lastHeartbeatAt,
            model,
            runnerId: s.runnerId,
            runnerName: s.runnerName,
            parentSessionId: s.parentSessionId,
            workerType,
        };
    });
}

/** Get a single session's Redis data. */
export async function getSharedSession(sessionId: string): Promise<RedisSessionData | null> {
    return getSession(sessionId);
}

/** Update session state (lastState + sessionName detection). */
export async function updateSessionState(sessionId: string, state: unknown): Promise<void> {
    const session = await getSession(sessionId);
    if (!session) return;

    // Extract inline base64 images from messages before storing in Redis.
    // This can reduce multi-MB payloads to KB-sized state with URL references.
    // Wrapped in try/catch so a transient I/O failure (disk full, permissions)
    // falls back to the original state rather than dropping the update entirely.
    const userId = session.userId ?? "unknown";
    let strippedState: unknown;
    try {
        strippedState = await storeAndReplaceImages(state, sessionId, userId);
    } catch (err) {
        log.error("Image extraction failed, using original state:", err);
        strippedState = state;
    }

    const stateObj = strippedState && typeof strippedState === "object" ? (strippedState as Record<string, unknown>) : null;
    const hasSessionName = !!stateObj && Object.prototype.hasOwnProperty.call(stateObj, "sessionName");
    const nextSessionName = hasSessionName ? normalizeSessionName(stateObj?.sessionName) : session.sessionName;
    const sessionNameChanged = nextSessionName !== session.sessionName;

    const fields: Partial<RedisSessionData> = {
        lastState: JSON.stringify(strippedState ?? null),
        sessionName: nextSessionName,
    };

    if (session.isEphemeral) {
        fields.expiresAt = nextEphemeralExpiry();
    }

    await updateSessionFields(session.sessionId, fields);

    if (sessionNameChanged) {
        const heartbeat = session.lastHeartbeat ? safeJsonParse(session.lastHeartbeat) : null;
        await broadcastToHub(
            "session_status",
            {
                sessionId,
                isActive: session.isActive,
                lastHeartbeatAt: session.lastHeartbeatAt,
                sessionName: nextSessionName,
                model: modelFromHeartbeat(heartbeat),
            },
            session.userId ?? undefined,
        );
    }

    void recordRelaySessionState(sessionId, strippedState).catch((error) => {
        log.error("Failed to persist relay session state:", error);
    });
}

/** Get session last state from Redis. */
export async function getSessionState(sessionId: string): Promise<unknown | undefined> {
    const session = await getSession(sessionId);
    if (!session?.lastState) return undefined;
    return safeJsonParse(session.lastState);
}

/** Refresh ephemeral session expiry and SQLite touch. */
export async function touchSessionActivity(sessionId: string): Promise<void> {
    const now = Date.now();
    const lastTouch = lastTouchTimes.get(sessionId) || 0;

    if (now - lastTouch < TOUCH_THROTTLE_MS) {
        return;
    }
    lastTouchTimes.set(sessionId, now);

    const session = await getSession(sessionId);
    if (!session) return;

    if (session.isEphemeral) {
        await updateSessionFields(sessionId, { expiresAt: nextEphemeralExpiry() });
    }

    await refreshSessionTTL(sessionId);

    // Keep the durable runner association alive as long as the session is active
    if (session.runnerId) {
        await refreshRunnerAssociationTTL(sessionId);
    }

    void touchRelaySession(sessionId).catch((error) => {
        log.error("Failed to touch relay session:", error);
    });
}

/**
 * Broadcast a session event to viewers WITHOUT caching to Redis.
 * Used for transient events like session_messages_chunk that are only
 * needed during active streaming and would bloat the Redis cache.
 */
export async function broadcastSessionEventToViewers(sessionId: string, event: unknown): Promise<void> {
    const io = getIo();
    const seq = await incrementSeq(sessionId);
    try {
        io.of("/viewer")
            .to(viewerSessionRoom(sessionId))
            .emit("event", { event, seq });
    } catch (err) {
        log.warn("broadcastSessionEventToViewers failed:", (err as Error)?.message);
        try {
            io.of("/viewer")
                .local
                .to(viewerSessionRoom(sessionId))
                .emit("event", { event, seq });
        } catch {
            // Local delivery also failed — event may be lost but won't break cache
        }
    }
}

/**
 * Publish a session event to viewers via Socket.IO rooms.
 *
 * 1. Increment seq in Redis
 * 2. Append to Redis event cache
 * 3. Broadcast to viewer room
 */
export async function publishSessionEvent(sessionId: string, event: unknown): Promise<number> {
    const io = getIo();
    const session = await getSession(sessionId);

    if (session?.isEphemeral) {
        await updateSessionFields(sessionId, { expiresAt: nextEphemeralExpiry() });
    }

    // Strip inline base64 images from agent_end events (which carry full
    // message snapshots) before caching in Redis and broadcasting to viewers.
    // Wrapped in try/catch so a transient I/O failure falls back to the
    // original event rather than dropping it (viewers would miss the event).
    const userId = session?.userId ?? "unknown";
    let strippedEvent: unknown;
    try {
        strippedEvent = await storeAndReplaceImagesInEvent(event, sessionId, userId);
    } catch (err) {
        log.error("Image extraction from event failed, using original event:", err);
        strippedEvent = event;
    }

    const seq = await incrementSeq(sessionId);

    // Await the cache write so the event is durably stored before we broadcast.
    // If this also fails (same Redis blip), the event is lost — but at least
    // we don't falsely claim it was cached when swallowing the broadcast error.
    await appendRelayEventToCache(sessionId, strippedEvent, { isEphemeral: session?.isEphemeral });

    // Broadcast to all viewer sockets in the session room
    try {
        io.of("/viewer")
            .to(viewerSessionRoom(sessionId))
            .emit("event", { event: strippedEvent, seq });
    } catch (err) {
        // Redis adapter throws EPIPE when the Redis connection drops mid-broadcast.
        // Fall back to local-only delivery so viewers on this server still receive
        // the event and its seq — without seeing the new seq they'd never trigger
        // a resync and would permanently miss this event even though it was cached.
        log.warn("publishSessionEvent broadcast failed, falling back to local:", (err as Error)?.message);
        try {
            io.of("/viewer")
                .local
                .to(viewerSessionRoom(sessionId))
                .emit("event", { event: strippedEvent, seq });
        } catch {
            // Local delivery also failed — event may be lost for connected viewers,
            // but it's in the cache (if Redis accepted it) for future replay.
        }
    }

    return seq;
}

/** Update session liveness from a heartbeat event. */
export async function updateSessionHeartbeat(
    sessionId: string,
    heartbeat: Record<string, unknown>,
): Promise<void> {
    const session = await getSession(sessionId);
    if (!session) return;

    const prevHeartbeat = session.lastHeartbeat ? safeJsonParse(session.lastHeartbeat) : null;
    const prevModel = modelFromHeartbeat(prevHeartbeat);
    const prevModelKey = prevModel ? `${prevModel.provider}/${prevModel.id}` : null;

    const hasSessionName = Object.prototype.hasOwnProperty.call(heartbeat, "sessionName");
    const prevSessionName = session.sessionName;

    const wasActive = session.isActive;
    const isActive = heartbeat.active === true;
    const lastHeartbeatAt = new Date().toISOString();
    const nextSessionName = hasSessionName
        ? normalizeSessionName(heartbeat.sessionName)
        : session.sessionName;

    const fields: Partial<RedisSessionData> = {
        isActive,
        lastHeartbeatAt,
        lastHeartbeat: JSON.stringify(heartbeat),
    };

    if (hasSessionName) {
        fields.sessionName = nextSessionName;
    }

    if (session.isEphemeral) {
        fields.expiresAt = nextEphemeralExpiry();
    }

    await updateSessionFields(sessionId, fields);

    // Backward compat: extract meta-state from fat heartbeat payload.
    // Old CLI sessions still send all meta fields in the heartbeat.
    // New CLI sessions send slim heartbeats + discrete meta events separately.
    // This ensures the Redis metaState is always populated regardless of CLI version.
    await extractMetaFromHeartbeat(sessionId, heartbeat);

    // Heartbeats bypass touchSessionActivity, so refresh the runner
    // association TTL here to prevent it from expiring on long-lived
    // sessions that mostly emit heartbeats.
    if (session.runnerId) {
        await refreshRunnerAssociationTTL(sessionId);
    }

    const nextModel = modelFromHeartbeat(heartbeat);
    const nextModelKey = nextModel ? `${nextModel.provider}/${nextModel.id}` : null;
    const modelChanged = prevModelKey !== nextModelKey;
    const sessionNameChanged = hasSessionName && prevSessionName !== nextSessionName;

    if (wasActive !== isActive || modelChanged || sessionNameChanged) {
        await broadcastToHub(
            "session_status",
            {
                sessionId,
                isActive,
                lastHeartbeatAt,
                sessionName: nextSessionName,
                model: nextModel,
            },
            session.userId ?? undefined,
        );
    }
}

/** Get the current seq counter for a session. */
export async function getSessionSeq(sessionId: string): Promise<number> {
    return getSeq(sessionId);
}

/** Get the last heartbeat payload for a session. */
export async function getSessionLastHeartbeat(sessionId: string): Promise<unknown | null> {
    const session = await getSession(sessionId);
    if (!session?.lastHeartbeat) return null;
    return safeJsonParse(session.lastHeartbeat);
}

/**
 * Send the current snapshot to a viewer socket (for resync).
 */
export async function sendSnapshotToViewer(sessionId: string, socket: Socket): Promise<void> {
    const session = await getSession(sessionId);
    if (!session) return;

    const seq = session.seq;
    if (session.lastHeartbeat) {
        const heartbeat = safeJsonParse(session.lastHeartbeat);
        socket.emit("event", { event: heartbeat, seq });
    }
    if (session.lastState) {
        const state = safeJsonParse(session.lastState);
        socket.emit("event", { event: { type: "session_active", state }, seq });
    }
}

function viewerDisconnectPayload(reason: string): { reason: string; code?: "session_ended" | "session_reconnected" } {
    if (reason === "Session reconnected") {
        return { reason, code: "session_reconnected" };
    }
    if (reason === "Session ended") {
        return { reason, code: "session_ended" };
    }
    return { reason };
}

/** End a shared session: notify viewers, clean up Redis, broadcast to hub. */
export async function endSharedSession(sessionId: string, reason: string = "Session ended"): Promise<void> {
    const io = getIo();
    await deletePendingRunnerLink(sessionId);

    const session = await getSession(sessionId);
    if (!session) return;

    const disconnectPayload = viewerDisconnectPayload(reason);

    // Notify all viewers in the room and disconnect them
    try {
        io.of("/viewer")
            .to(viewerSessionRoom(sessionId))
            .emit("disconnected", disconnectPayload);
    } catch (err) {
        log.warn("endSharedSession viewer notify failed, falling back to local:", (err as Error)?.message);
        try {
            io.of("/viewer")
                .local
                .to(viewerSessionRoom(sessionId))
                .emit("disconnected", disconnectPayload);
        } catch {
            // Local delivery also failed.
        }
    }

    // Forcefully disconnect viewer sockets from the room
    // Use disconnectSockets() instead of fetchSockets() + loop to avoid expensive
    // cluster-wide Socket.IO queries.
    io.of("/viewer").in(viewerSessionRoom(sessionId)).disconnectSockets();

    // Clean up local socket reference
    localTuiSockets.delete(sessionId);
    lastTouchTimes.delete(sessionId);

    // Notify the runner daemon so it can clean up its runningSessions map
    // (especially important for adopted sessions after a daemon restart).
    // emitToRunner uses the per-runner room (joined on registration) so the
    // event reaches the correct runner via the Redis adapter even when it is
    // connected to a different relay node than the one calling this function.
    if (session.runnerId) {
        emitToRunner(session.runnerId, "session_ended", { sessionId, reason });
    }

    // Delete from Redis
    await deleteSession(sessionId);

    // Persist end in SQLite
    void recordRelaySessionEnd(sessionId).catch((error) => {
        log.error("Failed to persist relay session end:", error);
    });

    // Broadcast removal to hub
    await broadcastToHub("session_removed", { sessionId }, session.userId ?? undefined);
}

/** Sweep expired ephemeral sessions (Redis + Socket.IO rooms). */
export async function sweepExpiredSessions(nowMs: number = Date.now()): Promise<void> {
    const expiredIds = await scanExpiredSessions(nowMs);

    for (const sessionId of expiredIds) {
        // Notify TUI socket if local
        const tuiSocket = localTuiSockets.get(sessionId);
        if (tuiSocket) {
            tuiSocket.emit("session_expired", { sessionId });
            tuiSocket.disconnect(true);
        }

        await endSharedSession(sessionId, "Session expired");
    }

    // Sweep orphaned sessions: sessions in Redis with no active relay socket
    // whose last heartbeat is older than the staleness threshold. This handles
    // the case where a server restart kills sockets without firing disconnect
    // handlers, leaving stale session data in Redis.
    await sweepOrphanedSessions(nowMs);
}

/** Max age (ms) for a session heartbeat before it's considered stale. */
const HEARTBEAT_STALE_MS = 2 * 60 * 1000; // 2 minutes

/** Clean up sessions that have no local relay socket and a stale heartbeat. */
export async function sweepOrphanedSessions(nowMs: number): Promise<void> {
    const io = getIo();
    const allSessions = await getAllSessions();
    const candidates: Array<{ sessionId: string; lastActivity: number }> = [];

    for (const session of allSessions) {
        const { sessionId } = session;

        // Skip sessions that have an active local relay socket
        if (localTuiSockets.has(sessionId)) continue;

        // Check heartbeat staleness locally FIRST (fast memory check)
        // to avoid expensive cluster-wide N+1 socket queries for healthy sessions
        const lastHb = session.lastHeartbeatAt ? Date.parse(session.lastHeartbeatAt) : 0;
        const startedAt = session.startedAt ? Date.parse(session.startedAt) : 0;
        const lastActivity = Math.max(lastHb || 0, startedAt || 0);

        if (nowMs - lastActivity <= HEARTBEAT_STALE_MS) {
            continue; // Session is active/recent enough, skip remote socket check
        }

        candidates.push({ sessionId, lastActivity });
    }

    if (candidates.length === 0) return;

    // Session appears stale locally, verify if a relay socket exists on ANY server
    // ⚡ Bolt: Using Promise.allSettled avoids sequential N+1 adapter queries when checking multiple candidates
    const checks = candidates.map(c => {
        const roomName = relaySessionRoom(c.sessionId);
        return io.of("/relay").adapter.sockets(new Set([roomName]));
    });

    const results = await Promise.allSettled(checks);

    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const result = results[i];

        if (result.status === "rejected") {
            // If the query failed, err on the side of caution and keep the session alive
            continue;
        }

        // @jules Add a secondary guard immediately before teardown to avoid false positives
        // caused by race conditions during the deletion loop
        if (result.status === "fulfilled" && result.value.size > 0) {
            continue; // Socket exists remotely
        }

        // Verify locally right before teardown to catch fresh reconnections
        if (localTuiSockets.has(candidate.sessionId)) continue;

        log.info(
            `Sweeping orphaned session ${candidate.sessionId} ` +
            `(last activity: ${new Date(candidate.lastActivity).toISOString()})`,
        );
        await endSharedSession(candidate.sessionId, "Session orphaned (no active relay connection)");
    }
}

// ── Viewer Management ───────────────────────────────────────────────────────

/**
 * Add a viewer to a session (joins the viewer room).
 * Returns false if the session doesn't exist.
 */
export async function addViewer(sessionId: string, socket: Socket): Promise<boolean> {
    const session = await getSession(sessionId);
    if (!session) return false;

    await socket.join(viewerSessionRoom(sessionId));
    await touchSessionActivity(sessionId);
    return true;
}

/** Remove a viewer from a session (leaves the viewer room). */
export async function removeViewer(sessionId: string, socket: Socket): Promise<void> {
    socket.leave(viewerSessionRoom(sessionId));
}

/**
 * Broadcast data to all viewers of a session via Socket.IO rooms.
 */
export function broadcastToViewers(sessionId: string, eventName: string, data: unknown): void {
    const io = getIo();
    try {
        io.of("/viewer")
            .to(viewerSessionRoom(sessionId))
            .emit(eventName, data);
    } catch (err) {
        // Redis adapter throws EPIPE when the connection drops mid-broadcast.
        // Unlike sequenced session events, payloads like exec_result are not
        // cached in Redis, so viewers can't recover them via replay. Fall back
        // to local-only delivery so at least viewers connected to this server
        // instance still receive the event.
        log.warn("broadcastToViewers Redis broadcast failed, falling back to local:", (err as Error)?.message);
        try {
            io.of("/viewer")
                .local
                .to(viewerSessionRoom(sessionId))
                .emit(eventName, data);
        } catch {
            // Local delivery also failed — nothing more we can do.
        }
    }
}

/**
 * Get the number of viewer sockets in a session room.
 * Works across all servers via the Redis adapter.
 */
export async function getViewerCount(sessionId: string): Promise<number> {
    const io = getIo();
    // ⚡ Bolt: Fast size query on adapter prevents fetching full RemoteSocket objects across cluster
    const sockets = await io.of("/viewer").adapter.sockets(new Set([viewerSessionRoom(sessionId)]));
    return sockets.size;
}
