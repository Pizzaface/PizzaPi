// ============================================================================
// sio-registry.ts — High-level Socket.IO registry
//
// Mirrors the API surface of registry.ts but uses:
//   - Redis (via sio-state.ts) for cross-server shared state
//   - Socket.IO rooms for viewer/hub client tracking
//   - Socket.IO namespaces for broadcasting
//
// Local Maps are used ONLY for per-server socket references (WebSocket
// handles cannot be serialized to Redis).
//
// All public functions are async (Redis calls are involved).
//
// The existing registry.ts and relay.ts remain intact for backward
// compatibility with raw Bun WebSocket clients during the migration period.
// ============================================================================

import type { Server as SocketIOServer, Socket, Namespace } from "socket.io";
import { randomBytes, randomUUID } from "crypto";
import {
    type RedisSessionData,
    type RedisRunnerData,
    type RedisTerminalData,
    setSession,
    getSession,
    updateSessionFields,
    deleteSession,
    getAllSessions,
    refreshSessionTTL,
    incrementSeq,
    getSeq,
    setRunner,
    getRunner as getRunnerState,
    updateRunnerFields,
    deleteRunner as deleteRunnerState,
    getAllRunners,
    refreshRunnerTTL,
    setTerminal,
    getTerminal as getTerminalState,
    updateTerminalFields,
    deleteTerminal as deleteTerminalState,
    getTerminalsForRunner as getTerminalsForRunnerState,
    setPendingRunnerLink,
    getPendingRunnerLink,
    deletePendingRunnerLink,
    setRunnerAssociation,
    getRunnerAssociation,
    deleteRunnerAssociation,
    refreshRunnerAssociationTTL,
    scanExpiredSessions,
    addChildSession,
} from "./sio-state.js";
import {
    getEphemeralTtlMs,
    recordRelaySessionStart,
    recordRelaySessionEnd,
    recordRelaySessionState,
    touchRelaySession,
} from "../sessions/store.js";
import { appendRelayEventToCache } from "../sessions/redis.js";
import { storeAndReplaceImages, storeAndReplaceImagesInEvent } from "./strip-images.js";
import type { ModelInfo, RunnerSkill, RunnerAgent, SessionInfo, RunnerInfo } from "@pizzapi/protocol";

// ── Socket.IO server reference ──────────────────────────────────────────────

let io: SocketIOServer;

/** Call once at startup after creating the Socket.IO server. */
export function initSioRegistry(socketIoServer: SocketIOServer): void {
    io = socketIoServer;
}

// ── Room name conventions ───────────────────────────────────────────────────

/** Room that all hub clients join (on the /hub namespace). */
const HUB_ROOM = "hub";

/** Room for a specific user's hub feed (on the /hub namespace). */
function hubUserRoom(userId: string): string {
    return `hub:user:${userId}`;
}

/** Room that all viewers of a session join (on the /viewer namespace). */
function viewerSessionRoom(sessionId: string): string {
    return `session:${sessionId}`;
}

/** Room that the TUI relay socket joins (on the /relay namespace). */
function relaySessionRoom(sessionId: string): string {
    return `session:${sessionId}`;
}

/** Room for a specific terminal viewer (on the /terminal namespace). */
function terminalRoom(terminalId: string): string {
    return `terminal:${terminalId}`;
}

// ── Local socket references (per-server, NOT shared via Redis) ──────────────

/** TUI relay sockets: sessionId → Socket on /relay namespace. */
const localTuiSockets = new Map<string, Socket>();

/** Runner sockets: runnerId → Socket on /runner namespace. */
const localRunnerSockets = new Map<string, Socket>();

/** Terminal viewer sockets: terminalId → Set of Sockets on /terminal namespace.
 *  Multiple viewers per terminal are supported so that both the mobile overlay
 *  and the desktop panel (which React mounts simultaneously but CSS-hides one)
 *  both receive PTY data. */
const localTerminalViewerSockets = new Map<string, Set<Socket>>();

/** Terminal data buffer: terminalId → buffered messages (replayed when viewer connects). */
const localTerminalBuffers = new Map<string, unknown[]>();

/** Terminal GC timers: terminalId → timer handle. */
const localTerminalGcTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Runner credential store (in-memory, per-server).
 * Maps runnerId → runnerSecret for persistent runner identity validation.
 * Matches the behavior of the existing registry.ts.
 */
const runnerSecrets = new Map<string, string>();

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Throttle interval for touchSessionActivity to reduce DB writes. */
const TOUCH_THROTTLE_MS = 2000;

/** Last time a session was touched: sessionId → timestamp (ms). */
const lastTouchTimes = new Map<string, number>();

function nextEphemeralExpiry(): string {
    return new Date(Date.now() + getEphemeralTtlMs()).toISOString();
}

function normalizeSessionName(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function modelFromHeartbeat(rawHeartbeat: unknown): ModelInfo | null {
    const rawModel = (rawHeartbeat as any)?.model;
    return rawModel &&
        typeof rawModel === "object" &&
        typeof (rawModel as any).provider === "string" &&
        typeof (rawModel as any).id === "string"
        ? {
              provider: (rawModel as any).provider as string,
              id: (rawModel as any).id as string,
              name: typeof (rawModel as any).name === "string" ? ((rawModel as any).name as string) : undefined,
          }
        : null;
}

function normalizeRoot(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const normalized = trimmed.replace(/\\/g, "/");
    return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function normalizeSkills(raw: unknown): RunnerSkill[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((s): s is Record<string, unknown> => s !== null && typeof s === "object")
        .map((s) => ({
            name: typeof s.name === "string" ? s.name : "",
            description: typeof s.description === "string" ? s.description : "",
            filePath: typeof s.filePath === "string" ? s.filePath : "",
        }))
        .filter((s) => s.name.length > 0);
}

function normalizeAgents(raw: unknown): RunnerAgent[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((a): a is Record<string, unknown> => a !== null && typeof a === "object")
        .map((a) => ({
            name: typeof a.name === "string" ? a.name : "",
            description: typeof a.description === "string" ? a.description : "",
            filePath: typeof a.filePath === "string" ? a.filePath : "",
        }))
        .filter((a) => a.name.length > 0);
}

// ── Hub broadcasting ────────────────────────────────────────────────────────

/**
 * Broadcast a message to all hub clients, optionally filtered by user.
 * Uses Socket.IO rooms on the /hub namespace.
 */
export async function broadcastToHub(
    eventName: string,
    data: unknown,
    targetUserId?: string,
): Promise<void> {
    const hubNs = io.of("/hub");
    if (targetUserId) {
        hubNs.to(hubUserRoom(targetUserId)).emit(eventName, data);
    } else {
        hubNs.to(HUB_ROOM).emit(eventName, data);
    }
}

// ── Hub client management ───────────────────────────────────────────────────

/**
 * Add a hub client socket (joins the hub room).
 * Called from the /hub namespace connection handler.
 */
export async function addHubClient(socket: Socket, userId?: string): Promise<void> {
    await socket.join(HUB_ROOM);
    if (userId) {
        await socket.join(hubUserRoom(userId));
    }
}

/**
 * Remove a hub client socket (leaves the hub room).
 * Socket.IO automatically removes sockets from rooms on disconnect,
 * but this can be called explicitly if needed.
 */
export async function removeHubClient(socket: Socket, userId?: string): Promise<void> {
    socket.leave(HUB_ROOM);
    if (userId) {
        socket.leave(hubUserRoom(userId));
    }
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
): Promise<{ sessionId: string; token: string; shareUrl: string; parentSessionId: string | null }> {
    const requestedSessionId = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
    const sessionId = requestedSessionId.length > 0 ? requestedSessionId : randomUUID();
    const token = randomBytes(32).toString("hex");
    const shareUrl = `${process.env.PIZZAPI_BASE_URL ?? "http://localhost:5173"}/session/${sessionId}`;
    const startedAt = new Date().toISOString();
    const userId = opts.userId ?? null;
    const userName = opts.userName ?? null;
    const isEphemeral = opts.isEphemeral !== false;
    const collabMode = opts.collabMode !== false;
    const sessionName = normalizeSessionName(opts.sessionName);

    // If session already exists, end it first (reconnect)
    const existing = await getSession(sessionId);
    if (existing) {
        await endSharedSession(sessionId, "Session reconnected");
    }

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

    // Resolve parentSessionId: prefer the value from registration opts (sent
    // by the CLI), fall back to any pre-seeded value in Redis (legacy path).
    let resolvedParentSessionId =
        opts.parentSessionId ??
        existing?.parentSessionId ??
        null;

    // Validate parent session exists and belongs to the same user.
    // If the parent disconnected or the ID is stale, clear it to avoid
    // dangling trigger flows that would time out.
    if (resolvedParentSessionId) {
        const parentSession = await getSession(resolvedParentSessionId);
        if (!parentSession || parentSession.userId !== userId) {
            resolvedParentSessionId = null;
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
    };

    await setSession(sessionId, sessionData);

    // Register parent→child relationship in Redis for the trigger system.
    // This is the authoritative place for linking — no more racy pre-seeding.
    if (resolvedParentSessionId) {
        await addChildSession(resolvedParentSessionId, sessionId);
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
    }).catch((error) => {
        console.error("[sio-registry] Failed to persist relay session start:", error);
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

    return { sessionId, token, shareUrl, parentSessionId: resolvedParentSessionId };
}

/**
 * Get the local TUI socket for a session (only available on the server
 * that owns the session).
 */
export function getLocalTuiSocket(sessionId: string): Socket | undefined {
    return localTuiSockets.get(sessionId);
}

/**
 * Emit an event to the relay session room (cluster-wide via Redis adapter).
 * This reaches the runner's relay socket regardless of which server instance
 * the callback lands on. Returns true if the emit was dispatched.
 */
export function emitToRelaySession(sessionId: string, eventName: string, data: unknown): boolean {
    if (!io) return false;
    io.of("/relay")
        .to(relaySessionRoom(sessionId))
        .emit(eventName, data);
    return true;
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
    const userId = session.userId ?? "unknown";
    const strippedState = await storeAndReplaceImages(state, sessionId, userId);

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
        console.error("[sio-registry] Failed to persist relay session state:", error);
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
        console.error("[sio-registry] Failed to touch relay session:", error);
    });
}

/**
 * Publish a session event to viewers via Socket.IO rooms.
 *
 * 1. Increment seq in Redis
 * 2. Append to Redis event cache
 * 3. Broadcast to viewer room
 */
export async function publishSessionEvent(sessionId: string, event: unknown): Promise<number> {
    const session = await getSession(sessionId);

    if (session?.isEphemeral) {
        await updateSessionFields(sessionId, { expiresAt: nextEphemeralExpiry() });
    }

    // Strip inline base64 images from agent_end events (which carry full
    // message snapshots) before caching in Redis and broadcasting to viewers.
    const userId = session?.userId ?? "unknown";
    const strippedEvent = await storeAndReplaceImagesInEvent(event, sessionId, userId);

    const seq = await incrementSeq(sessionId);

    void appendRelayEventToCache(sessionId, strippedEvent, { isEphemeral: session?.isEphemeral });

    // Broadcast to all viewer sockets in the session room
    io.of("/viewer")
        .to(viewerSessionRoom(sessionId))
        .emit("event", { event: strippedEvent, seq });

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
        ? normalizeSessionName((heartbeat as any).sessionName)
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

/** End a shared session: notify viewers, clean up Redis, broadcast to hub. */
export async function endSharedSession(sessionId: string, reason: string = "Session ended"): Promise<void> {
    await deletePendingRunnerLink(sessionId);

    const session = await getSession(sessionId);
    if (!session) return;

    // Notify all viewers in the room and disconnect them
    io.of("/viewer")
        .to(viewerSessionRoom(sessionId))
        .emit("disconnected", { reason });

    // Forcefully disconnect viewer sockets from the room
    // Use socketsLeave instead of fetchSockets() + loop to avoid expensive
    // cluster-wide Socket.IO queries.
    io.of("/viewer").in(viewerSessionRoom(sessionId)).socketsLeave(viewerSessionRoom(sessionId));

    // Clean up local socket reference
    localTuiSockets.delete(sessionId);
    lastTouchTimes.delete(sessionId);

    // Notify the runner daemon so it can clean up its runningSessions map
    // (especially important for adopted sessions after a daemon restart).
    if (session.runnerId) {
        const runnerSocket = localRunnerSockets.get(session.runnerId);
        if (runnerSocket?.connected) {
            runnerSocket.emit("session_ended", { sessionId });
        }
    }

    // Delete from Redis
    await deleteSession(sessionId);

    // Persist end in SQLite
    void recordRelaySessionEnd(sessionId).catch((error) => {
        console.error("[sio-registry] Failed to persist relay session end:", error);
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

        console.log(
            `[sio-registry] Sweeping orphaned session ${candidate.sessionId} ` +
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
    io.of("/viewer")
        .to(viewerSessionRoom(sessionId))
        .emit(eventName, data);
}

/**
 * Get the number of viewer sockets in a session room.
 * Works across all servers via the Redis adapter.
 */
export async function getViewerCount(sessionId: string): Promise<number> {
    const sockets = await io.of("/viewer").in(viewerSessionRoom(sessionId)).allSockets();
    return sockets.size;
}

// ── Runner Management ───────────────────────────────────────────────────────

export interface RegisterRunnerOpts {
    name?: string | null;
    roots?: string[];
    requestedRunnerId?: string;
    runnerSecret?: string;
    skills?: RunnerSkill[];
    agents?: RunnerAgent[];
    plugins?: unknown[];
    userId?: string | null;
    userName?: string | null;
    version?: string | null;
}

/**
 * Register a runner via Socket.IO.
 *
 * Handles persistent identity via runnerId + runnerSecret (same logic
 * as the existing registry.ts).
 *
 * Returns the runnerId on success, or an Error on auth failure.
 */
export async function registerRunner(
    socket: Socket,
    opts: RegisterRunnerOpts = {},
): Promise<string | Error> {
    const requestedId = opts.requestedRunnerId?.trim();
    const secret = opts.runnerSecret?.trim();

    let runnerId: string;

    if (requestedId && secret) {
        const existingSecret = runnerSecrets.get(requestedId);
        if (existingSecret !== undefined) {
            if (existingSecret !== secret) {
                return new Error(`Runner authentication failed: secret mismatch for runner ${requestedId}`);
            }
            // Re-registration: clean up stale socket
            localRunnerSockets.delete(requestedId);
        } else {
            runnerSecrets.set(requestedId, secret);
        }
        runnerId = requestedId;
    } else {
        runnerId = randomUUID();
    }

    const roots = (opts.roots ?? [])
        .filter((r) => typeof r === "string")
        .map(normalizeRoot)
        .filter(Boolean);

    const skills = normalizeSkills(opts.skills);
    const agents = normalizeAgents(opts.agents);
    const plugins = Array.isArray(opts.plugins)
        ? opts.plugins
            .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
            .map(normalizePlugin)
            .filter((p): p is Record<string, unknown> => p !== null)
        : [];

    const runnerData: RedisRunnerData = {
        runnerId,
        userId: opts.userId ?? null,
        userName: opts.userName ?? null,
        name: opts.name?.trim() || null,
        roots: JSON.stringify(roots),
        skills: JSON.stringify(skills),
        agents: JSON.stringify(agents),
        plugins: JSON.stringify(plugins),
        version: typeof opts.version === "string" ? opts.version : null,
    };

    await setRunner(runnerId, runnerData);
    localRunnerSockets.set(runnerId, socket);

    return runnerId;
}

/** Update skills for an already-registered runner. */
export async function updateRunnerSkills(runnerId: string, skills: RunnerSkill[]): Promise<void> {
    const normalized = normalizeSkills(skills);
    await updateRunnerFields(runnerId, { skills: JSON.stringify(normalized) });
}

/** Update agents for an already-registered runner. */
export async function updateRunnerAgents(runnerId: string, agents: RunnerAgent[]): Promise<void> {
    const normalized = normalizeAgents(agents);
    await updateRunnerFields(runnerId, { agents: JSON.stringify(normalized) });
}

/**
 * Normalize a plugin info object to guaranteed types.
 * Ensures all arrays are arrays, booleans are booleans, strings are strings.
 */
function normalizePlugin(raw: Record<string, unknown>): Record<string, unknown> | null {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) return null;

    return {
        name,
        description: typeof raw.description === "string" ? raw.description : "",
        rootPath: typeof raw.rootPath === "string" ? raw.rootPath : "",
        commands: Array.isArray(raw.commands) ? raw.commands.filter((c: unknown) => c && typeof c === "object") : [],
        hookEvents: Array.isArray(raw.hookEvents) ? raw.hookEvents.filter((e: unknown) => typeof e === "string") : [],
        skills: Array.isArray(raw.skills) ? raw.skills.filter((s: unknown) => s && typeof s === "object") : [],
        agents: Array.isArray(raw.agents) ? raw.agents.filter((a: unknown) => a && typeof a === "object") : undefined,
        rules: Array.isArray(raw.rules)
            ? raw.rules.filter((r: unknown): r is { name: string } => r !== null && typeof r === "object" && typeof (r as any).name === "string")
            : undefined,
        hasMcp: raw.hasMcp === true,
        hasAgents: raw.hasAgents === true,
        hasLsp: raw.hasLsp === true,
        version: typeof raw.version === "string" ? raw.version : undefined,
        author: typeof raw.author === "string" ? raw.author : undefined,
    };
}

/**
 * Persist the runner's discovered Claude Code plugins to Redis.
 * Plugins are stored as a JSON-serialized array in the runner hash.
 * Each plugin is schema-normalized to guarantee expected field types.
 */
export async function updateRunnerPlugins(runnerId: string, plugins: unknown[]): Promise<void> {
    const normalized = Array.isArray(plugins)
        ? plugins
            .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
            .map(normalizePlugin)
            .filter((p): p is Record<string, unknown> => p !== null)
        : [];
    await updateRunnerFields(runnerId, { plugins: JSON.stringify(normalized) });
}

/** Record that a runner spawned a session. */
export async function recordRunnerSession(runnerId: string, sessionId: string): Promise<void> {
    // Runner-session associations tracked via session.runnerId in Redis
    const session = await getSession(sessionId);
    if (session) {
        await updateSessionFields(sessionId, { runnerId });
    }
}

/**
 * Associate a session with the runner that spawned it, then notify hub.
 */
export async function linkSessionToRunner(runnerId: string, sessionId: string): Promise<void> {
    const runner = await getRunnerState(runnerId);
    if (!runner) return;

    const session = await getSession(sessionId);
    if (!session) {
        // TUI worker hasn't connected yet — store link for later
        await setPendingRunnerLink(sessionId, runnerId);
        return;
    }

    await updateSessionFields(sessionId, {
        runnerId,
        runnerName: runner.name,
    });

    // Store a durable runner association that survives server restarts.
    // The session hash is deleted on relay disconnect, but this TTL key
    // persists so reconnecting TUI agents can restore their runner link.
    await setRunnerAssociation(sessionId, runnerId, runner.name);

    const heartbeat = session.lastHeartbeat ? safeJsonParse(session.lastHeartbeat) : null;

    await broadcastToHub(
        "session_status",
        {
            sessionId,
            isActive: session.isActive,
            lastHeartbeatAt: session.lastHeartbeatAt,
            sessionName: session.sessionName,
            model: modelFromHeartbeat(heartbeat),
            runnerId,
            runnerName: runner.name,
        },
        session.userId ?? undefined,
    );
}

/** Remove a runner session association. */
export async function removeRunnerSession(runnerId: string, sessionId: string): Promise<void> {
    const session = await getSession(sessionId);
    if (session && session.runnerId === runnerId) {
        await updateSessionFields(sessionId, { runnerId: null, runnerName: null });
        await deleteRunnerAssociation(sessionId);
    }
}

/**
 * Return sessions that are still connected to the relay and belong to the given runner.
 * Used after a runner daemon restart to let it re-adopt orphaned worker processes.
 */
export async function getConnectedSessionsForRunner(runnerId: string): Promise<Array<{ sessionId: string; cwd: string }>> {
    const allSessions = await getAllSessions();
    const results: Array<{ sessionId: string; cwd: string }> = [];
    for (const s of allSessions) {
        if (s.runnerId !== runnerId) continue;
        // Only include sessions whose TUI socket is still connected (worker is alive)
        const tuiSocket = localTuiSockets.get(s.sessionId);
        if (tuiSocket && tuiSocket.connected) {
            results.push({ sessionId: s.sessionId, cwd: s.cwd });
        }
    }
    return results;
}

/** Get all runners as RunnerInfo, optionally filtered by user. */
export async function getRunners(filterUserId?: string): Promise<RunnerInfo[]> {
    const runners = await getAllRunners(filterUserId);
    const allSessions = await getAllSessions(filterUserId);

    // Aggregate session counts by runnerId in memory
    const sessionCounts = new Map<string, number>();
    for (const s of allSessions) {
        if (s.runnerId) {
            sessionCounts.set(s.runnerId, (sessionCounts.get(s.runnerId) ?? 0) + 1);
        }
    }

    const results: RunnerInfo[] = [];

    for (const r of runners) {
        results.push({
            runnerId: r.runnerId,
            name: r.name,
            roots: safeJsonParse(r.roots) ?? [],
            sessionCount: sessionCounts.get(r.runnerId) ?? 0,
            skills: safeJsonParse(r.skills) ?? [],
            agents: safeJsonParse(r.agents ?? "[]") ?? [],
            plugins: safeJsonParse(r.plugins ?? "[]") ?? [],
            version: r.version ?? null,
        });
    }

    return results;
}

/** Get a single runner's data. */
export async function getRunnerData(runnerId: string): Promise<RedisRunnerData | null> {
    return getRunnerState(runnerId);
}

/** Get the local runner socket (only on the server that owns the connection). */
export function getLocalRunnerSocket(runnerId: string): Socket | undefined {
    return localRunnerSockets.get(runnerId);
}

/** Remove a runner from Redis and local socket map. */
export async function removeRunner(runnerId: string): Promise<void> {
    localRunnerSockets.delete(runnerId);
    await deleteRunnerState(runnerId);
}

/** Refresh a runner's TTL in Redis (call on heartbeat/activity). */
export async function touchRunner(runnerId: string): Promise<void> {
    await refreshRunnerTTL(runnerId);
}

// ── Terminal Management ─────────────────────────────────────────────────────

export interface TerminalSpawnOpts {
    cwd?: string;
    shell?: string;
    cols?: number;
    rows?: number;
}

/** How long to keep a terminal entry after exit waiting for a late viewer (ms). */
const TERMINAL_GC_DELAY_MS = 30_000;

/** How long to wait for a viewer before cleaning up an unspawned terminal (ms). */
const TERMINAL_PENDING_TIMEOUT_MS = 60_000;

/**
 * Register a terminal in Redis + set up local buffer and GC timer.
 */
export async function registerTerminal(
    terminalId: string,
    runnerId: string,
    userId: string,
    spawnOpts: TerminalSpawnOpts = {},
): Promise<void> {
    const data: RedisTerminalData = {
        terminalId,
        runnerId,
        userId,
        spawned: false,
        exited: false,
        spawnOpts: JSON.stringify(spawnOpts),
    };

    await setTerminal(terminalId, data);
    localTerminalBuffers.set(terminalId, []);

    // GC timer: if no viewer connects within timeout, remove unspawned terminal
    const timer = setTimeout(async () => {
        const t = await getTerminalState(terminalId);
        if (t && !t.spawned) {
            console.log(`[sio-terminal] GC: removing unspawned terminal ${terminalId} (no viewer within ${TERMINAL_PENDING_TIMEOUT_MS}ms)`);
            await cleanupTerminal(terminalId);
        }
    }, TERMINAL_PENDING_TIMEOUT_MS);

    localTerminalGcTimers.set(terminalId, timer);
}

/**
 * Attach a viewer socket to a terminal.
 * Replays buffered messages and joins the terminal room.
 */
export async function setTerminalViewer(terminalId: string, socket: Socket): Promise<boolean> {
    const entry = await getTerminalState(terminalId);
    if (!entry) return false;

    const viewers = localTerminalViewerSockets.get(terminalId) ?? new Set<Socket>();
    viewers.add(socket);
    localTerminalViewerSockets.set(terminalId, viewers);
    await socket.join(terminalRoom(terminalId));

    // Clear pending-timeout timer
    const pendingTimer = localTerminalGcTimers.get(terminalId);
    if (pendingTimer && !entry.spawned) {
        clearTimeout(pendingTimer);
        localTerminalGcTimers.delete(terminalId);
    }

    // Replay buffered messages
    const buffer = localTerminalBuffers.get(terminalId) ?? [];
    if (buffer.length > 0) {
        console.log(`[sio-terminal] replaying ${buffer.length} buffered messages for terminal ${terminalId}`);
        for (const msg of buffer) {
            const msgObj = msg as Record<string, unknown>;
            const eventName = (msgObj.type as string) ?? "terminal_data";
            socket.emit(eventName, msg);
        }
        buffer.length = 0;
    }

    // If terminal already exited, schedule cleanup
    if (entry.exited) {
        const existingTimer = localTerminalGcTimers.get(terminalId);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(async () => {
            await cleanupTerminal(terminalId);
        }, 2_000);
        localTerminalGcTimers.set(terminalId, timer);
    }

    return true;
}

/** Mark terminal as spawned in Redis. */
export async function markTerminalSpawned(terminalId: string): Promise<void> {
    await updateTerminalFields(terminalId, { spawned: true });
}

/** Remove a terminal viewer socket. */
export async function removeTerminalViewer(terminalId: string, socket: Socket): Promise<void> {
    const viewers = localTerminalViewerSockets.get(terminalId);
    if (viewers) {
        viewers.delete(socket);
        if (viewers.size === 0) {
            localTerminalViewerSockets.delete(terminalId);
        }
    }
    socket.leave(terminalRoom(terminalId));

    // If terminal exited and viewer left, clean up
    const entry = await getTerminalState(terminalId);
    if (entry?.exited) {
        const timer = localTerminalGcTimers.get(terminalId);
        if (timer) clearTimeout(timer);
        await cleanupTerminal(terminalId);
    }
}

/** Get terminal data from Redis. */
export async function getTerminalEntry(terminalId: string): Promise<RedisTerminalData | null> {
    return getTerminalState(terminalId);
}

/** Mark a terminal as exited and schedule cleanup. */
export async function removeTerminal(terminalId: string): Promise<void> {
    const entry = await getTerminalState(terminalId);
    if (!entry) {
        await cleanupTerminal(terminalId);
        return;
    }

    await updateTerminalFields(terminalId, { exited: true });

    const viewers = localTerminalViewerSockets.get(terminalId);
    if (viewers && viewers.size > 0) {
        // Viewer(s) attached — clean up after short delay
        const existingTimer = localTerminalGcTimers.get(terminalId);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(async () => {
            await cleanupTerminal(terminalId);
        }, 2_000);
        localTerminalGcTimers.set(terminalId, timer);
        return;
    }

    // No viewer — keep buffered messages for late viewer, then GC
    const existingTimer = localTerminalGcTimers.get(terminalId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(async () => {
        console.log(`[sio-terminal] GC: removing terminal ${terminalId} (no viewer within ${TERMINAL_GC_DELAY_MS}ms)`);
        await cleanupTerminal(terminalId);
    }, TERMINAL_GC_DELAY_MS);
    localTerminalGcTimers.set(terminalId, timer);
}

/** Send data from runner to all terminal viewers. Buffers if no viewer attached. */
export function sendToTerminalViewer(terminalId: string, msg: unknown): void {
    const viewers = localTerminalViewerSockets.get(terminalId);
    if (!viewers || viewers.size === 0) {
        // Buffer for later replay
        const buffer = localTerminalBuffers.get(terminalId);
        if (buffer) {
            buffer.push(msg);
        } else {
            const type = msg && typeof msg === "object" ? (msg as any).type : "?";
            console.warn(`[sio-terminal] sendToTerminalViewer: no entry for ${terminalId} (msg.type=${type}) — dropped`);
        }
        return;
    }

    const msgObj = msg as Record<string, unknown>;
    const eventName = (msgObj.type as string) ?? "terminal_data";
    // Broadcast to all connected viewers (mobile overlay + desktop panel may
    // both be mounted simultaneously with separate sockets).
    for (const viewer of viewers) {
        viewer.emit(eventName, msg);
    }
}

/** Get all terminal IDs for a runner from Redis. */
export async function getTerminalIdsForRunner(runnerId: string): Promise<string[]> {
    const terminals = await getTerminalsForRunnerState(runnerId);
    return terminals.map((t) => t.terminalId);
}

/** Internal cleanup helper — removes all local + Redis state for a terminal. */
async function cleanupTerminal(terminalId: string): Promise<void> {
    const timer = localTerminalGcTimers.get(terminalId);
    if (timer) clearTimeout(timer);
    localTerminalGcTimers.delete(terminalId);
    localTerminalViewerSockets.delete(terminalId);
    localTerminalBuffers.delete(terminalId);
    await deleteTerminalState(terminalId);
}

// ── JSON parse helper ───────────────────────────────────────────────────────

function safeJsonParse(value: string): any {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}
