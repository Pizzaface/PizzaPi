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
    scanExpiredSessions,
} from "./sio-state.js";
import {
    getEphemeralTtlMs,
    recordRelaySessionStart,
    recordRelaySessionEnd,
    recordRelaySessionState,
    touchRelaySession,
} from "../sessions/store.js";
import { appendRelayEventToCache } from "../sessions/redis.js";
import type { ModelInfo, RunnerSkill, SessionInfo, RunnerInfo } from "@pizzapi/protocol";

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
): Promise<{ sessionId: string; token: string; shareUrl: string }> {
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
    };

    await setSession(sessionId, sessionData);

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
        } satisfies SessionInfo,
        userId ?? undefined,
    );

    return { sessionId, token, shareUrl };
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

    const stateObj = state && typeof state === "object" ? (state as Record<string, unknown>) : null;
    const hasSessionName = !!stateObj && Object.prototype.hasOwnProperty.call(stateObj, "sessionName");
    const nextSessionName = hasSessionName ? normalizeSessionName(stateObj?.sessionName) : session.sessionName;
    const sessionNameChanged = nextSessionName !== session.sessionName;

    const fields: Partial<RedisSessionData> = {
        lastState: JSON.stringify(state ?? null),
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

    void recordRelaySessionState(sessionId, state).catch((error) => {
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
    const session = await getSession(sessionId);
    if (!session) return;

    if (session.isEphemeral) {
        await updateSessionFields(sessionId, { expiresAt: nextEphemeralExpiry() });
    }

    await refreshSessionTTL(sessionId);

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

    const seq = await incrementSeq(sessionId);

    void appendRelayEventToCache(sessionId, event, { isEphemeral: session?.isEphemeral });

    // Broadcast to all viewer sockets in the session room
    io.of("/viewer")
        .to(viewerSessionRoom(sessionId))
        .emit("event", { event, seq });

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
    const viewerSockets = await io.of("/viewer").in(viewerSessionRoom(sessionId)).fetchSockets();
    for (const vs of viewerSockets) {
        vs.leave(viewerSessionRoom(sessionId));
    }

    // Clean up local socket reference
    localTuiSockets.delete(sessionId);

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
async function sweepOrphanedSessions(nowMs: number): Promise<void> {
    const allSessions = await getAllSessions();

    for (const session of allSessions) {
        const { sessionId } = session;

        // Skip sessions that have an active local relay socket
        if (localTuiSockets.has(sessionId)) continue;

        // Check if the relay socket exists on ANY server via Socket.IO rooms
        const relaySockets = await io.of("/relay").in(relaySessionRoom(sessionId)).fetchSockets();
        if (relaySockets.length > 0) continue;

        // No relay socket anywhere — check heartbeat staleness
        const lastHb = session.lastHeartbeatAt ? Date.parse(session.lastHeartbeatAt) : 0;
        const startedAt = session.startedAt ? Date.parse(session.startedAt) : 0;
        const lastActivity = Math.max(lastHb || 0, startedAt || 0);

        if (nowMs - lastActivity > HEARTBEAT_STALE_MS) {
            console.log(
                `[sio-registry] Sweeping orphaned session ${sessionId} ` +
                `(last activity: ${new Date(lastActivity).toISOString()})`,
            );
            await endSharedSession(sessionId, "Session orphaned (no active relay connection)");
        }
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
    userId?: string | null;
    userName?: string | null;
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

    const runnerData: RedisRunnerData = {
        runnerId,
        userId: opts.userId ?? null,
        userName: opts.userName ?? null,
        name: opts.name?.trim() || null,
        roots: JSON.stringify(roots),
        skills: JSON.stringify(skills),
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
    }
}

/** Get all runners as RunnerInfo, optionally filtered by user. */
export async function getRunners(filterUserId?: string): Promise<RunnerInfo[]> {
    const runners = await getAllRunners(filterUserId);
    const results: RunnerInfo[] = [];

    for (const r of runners) {
        // Count sessions linked to this runner
        const allSessions = await getAllSessions(r.userId ?? undefined);
        const sessionCount = allSessions.filter((s) => s.runnerId === r.runnerId).length;

        results.push({
            runnerId: r.runnerId,
            name: r.name,
            roots: safeJsonParse(r.roots) ?? [],
            sessionCount,
            skills: safeJsonParse(r.skills) ?? [],
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
