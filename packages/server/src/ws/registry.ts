import type { ServerWebSocket } from "bun";
import { randomBytes, randomUUID } from "crypto";
import {
    getEphemeralTtlMs,
    recordRelaySessionEnd,
    recordRelaySessionStart,
    recordRelaySessionState,
    touchRelaySession,
} from "../sessions/store.js";
import { appendRelayEventToCache } from "../sessions/redis.js";

export type WsRole = "tui" | "viewer" | "runner" | "hub";

export interface WsData {
    role: WsRole;
    /** Set after registration handshake */
    sessionId?: string;
    /** Auth token (TUI-side, to validate incoming events) */
    token?: string;
    /** For runner role: runner ID */
    runnerId?: string;
    /** Authenticated user ID (from API key) */
    userId?: string;
    /** Authenticated user name (from API key) */
    userName?: string;
}

interface SharedSession {
    /** The TUI WebSocket that owns this session */
    tuiWs: ServerWebSocket<WsData>;
    token: string;
    viewers: Set<ServerWebSocket<WsData>>;
    /** Whether viewer chat input is forwarded to the owning TUI session */
    collabMode: boolean;
    shareUrl: string;
    cwd: string;
    startedAt: string;
    userId?: string;
    userName?: string;
    isEphemeral: boolean;
    expiresAt: string | null;
    /** Last session_active state snapshot from the CLI, replayed to new viewers */
    lastState?: unknown;
    /** Monotonic sequence counter — incremented for every event forwarded to viewers */
    seq: number;
    /** Whether the agent is currently running (set from heartbeat events) */
    isActive: boolean;
    /** ISO timestamp of the most recent heartbeat received from the CLI */
    lastHeartbeatAt: string | null;
    /** Most recent heartbeat payload (forwarded to new viewers on connect) */
    lastHeartbeat: unknown | null;
}

interface RunnerEntry {
    ws: ServerWebSocket<WsData>;
    /** Sessions this runner has spawned, keyed by session ID */
    sessions: Map<string, Set<ServerWebSocket<WsData>>>;
}

// ── Hub connections (web UI watching session list) ────────────────────────────
const hubClients = new Set<ServerWebSocket<WsData>>();

export function addHubClient(ws: ServerWebSocket<WsData>) {
    hubClients.add(ws);
}

export function removeHubClient(ws: ServerWebSocket<WsData>) {
    hubClients.delete(ws);
}

function broadcastToHub(msg: unknown, targetUserId?: string) {
    const data = JSON.stringify(msg);
    for (const ws of hubClients) {
        if (targetUserId && ws.data.userId !== targetUserId) continue;
        try {
            ws.send(data);
        } catch {}
    }
}

// ── Shared TUI sessions (live share) ─────────────────────────────────────────
const sharedSessions = new Map<string, SharedSession>();

function nextEphemeralExpiry(): string {
    return new Date(Date.now() + getEphemeralTtlMs()).toISOString();
}

function refreshEphemeralExpiry(session: SharedSession) {
    if (!session.isEphemeral) return;
    session.expiresAt = nextEphemeralExpiry();
}

export function registerTuiSession(
    ws: ServerWebSocket<WsData>,
    cwd: string = "",
    opts: { isEphemeral?: boolean; collabMode?: boolean } = {},
): {
    sessionId: string;
    token: string;
    shareUrl: string;
} {
    const sessionId = randomUUID();
    const token = randomBytes(32).toString("hex");
    const shareUrl = `${process.env.PIZZAPI_BASE_URL ?? "http://localhost:5173"}/session/${sessionId}`;
    const startedAt = new Date().toISOString();
    const userId = ws.data.userId;
    const userName = ws.data.userName;
    const isEphemeral = opts.isEphemeral !== false;
    const collabMode = opts.collabMode !== false;

    sharedSessions.set(sessionId, {
        tuiWs: ws,
        token,
        viewers: new Set(),
        collabMode,
        shareUrl,
        cwd,
        startedAt,
        userId,
        userName,
        isEphemeral,
        expiresAt: isEphemeral ? nextEphemeralExpiry() : null,
        seq: 0,
        isActive: false,
        lastHeartbeatAt: null,
        lastHeartbeat: null,
    });

    void recordRelaySessionStart({
        sessionId,
        userId,
        userName,
        cwd,
        shareUrl,
        startedAt,
        isEphemeral,
    }).catch((error) => {
        console.error("Failed to persist relay session start", error);
    });

    broadcastToHub(
        { type: "session_added", sessionId, shareUrl, cwd, startedAt, userId, userName, isEphemeral, isActive: false, lastHeartbeatAt: null },
        userId,
    );
    return { sessionId, token, shareUrl };
}

/** Returns a public summary of active TUI sessions, optionally filtered by owner. */
export function getSessions(filterUserId?: string) {
    return Array.from(sharedSessions.entries())
        .filter(([, s]) => !filterUserId || s.userId === filterUserId)
        .map(([id, s]) => ({
            sessionId: id,
            shareUrl: s.shareUrl,
            cwd: s.cwd,
            startedAt: s.startedAt,
            viewerCount: s.viewers.size,
            userId: s.userId,
            userName: s.userName,
            isEphemeral: s.isEphemeral,
            expiresAt: s.expiresAt,
            isActive: s.isActive,
            lastHeartbeatAt: s.lastHeartbeatAt,
        }));
}

export function getSharedSession(sessionId: string) {
    return sharedSessions.get(sessionId);
}

export function updateSessionState(sessionId: string, state: unknown) {
    const session = sharedSessions.get(sessionId);
    if (!session) return;

    session.lastState = state;
    refreshEphemeralExpiry(session);

    void recordRelaySessionState(sessionId, state).catch((error) => {
        console.error("Failed to persist relay session state", error);
    });
}

export function getSessionState(sessionId: string): unknown | undefined {
    return sharedSessions.get(sessionId)?.lastState;
}

export function touchSessionActivity(sessionId: string) {
    const session = sharedSessions.get(sessionId);
    if (!session) return;
    refreshEphemeralExpiry(session);
    void touchRelaySession(sessionId).catch((error) => {
        console.error("Failed to touch relay session", error);
    });
}

export function addViewer(sessionId: string, ws: ServerWebSocket<WsData>): boolean {
    const session = sharedSessions.get(sessionId);
    if (!session) return false;
    session.viewers.add(ws);
    touchSessionActivity(sessionId);
    return true;
}

export function removeViewer(sessionId: string, ws: ServerWebSocket<WsData>) {
    sharedSessions.get(sessionId)?.viewers.delete(ws);
}

export function broadcastToViewers(sessionId: string, data: string) {
    const session = sharedSessions.get(sessionId);
    if (!session) return;
    for (const viewer of session.viewers) {
        try {
            viewer.send(data);
        } catch {}
    }
}

export function publishSessionEvent(sessionId: string, event: unknown) {
    const session = sharedSessions.get(sessionId);
    if (session) {
        refreshEphemeralExpiry(session);
        session.seq += 1;
    }

    const seq = session?.seq;
    void appendRelayEventToCache(sessionId, event, { isEphemeral: session?.isEphemeral });
    broadcastToViewers(sessionId, JSON.stringify({ type: "event", event, seq }));
}

/** Update session liveness state from a heartbeat event. */
export function updateSessionHeartbeat(sessionId: string, heartbeat: Record<string, unknown>) {
    const session = sharedSessions.get(sessionId);
    if (!session) return;

    const wasActive = session.isActive;
    session.isActive = heartbeat.active === true;
    session.lastHeartbeatAt = new Date().toISOString();
    session.lastHeartbeat = heartbeat;
    refreshEphemeralExpiry(session);

    // Notify hub clients when active status changes so session list updates live.
    if (wasActive !== session.isActive) {
        broadcastToHub(
            {
                type: "session_status",
                sessionId,
                isActive: session.isActive,
                lastHeartbeatAt: session.lastHeartbeatAt,
            },
            session.userId,
        );
    }
}

/** Returns the current seq counter for a session (used in viewer connected message). */
export function getSessionSeq(sessionId: string): number {
    return sharedSessions.get(sessionId)?.seq ?? 0;
}

/** Returns the last heartbeat payload for a session (replayed to newly-connected viewers). */
export function getSessionLastHeartbeat(sessionId: string): unknown | null {
    return sharedSessions.get(sessionId)?.lastHeartbeat ?? null;
}

/** Sends the current snapshot to a viewer WebSocket (used for resync requests). */
export function sendSnapshotToViewer(sessionId: string, ws: ServerWebSocket<WsData>) {
    const session = sharedSessions.get(sessionId);
    if (!session) return;

    const seq = session.seq;
    if (session.lastHeartbeat) {
        try {
            ws.send(JSON.stringify({ type: "event", event: session.lastHeartbeat, seq }));
        } catch {}
    }
    if (session.lastState !== undefined) {
        try {
            ws.send(JSON.stringify({ type: "event", event: { type: "session_active", state: session.lastState }, seq }));
        } catch {}
    }
}

export function endSharedSession(sessionId: string, reason: string = "Session ended") {
    const session = sharedSessions.get(sessionId);
    if (!session) return;

    const msg = JSON.stringify({ type: "disconnected", reason });
    for (const viewer of session.viewers) {
        try {
            viewer.send(msg);
            viewer.close(1000, reason);
        } catch {}
    }

    sharedSessions.delete(sessionId);

    void recordRelaySessionEnd(sessionId).catch((error) => {
        console.error("Failed to persist relay session end", error);
    });

    broadcastToHub({ type: "session_removed", sessionId }, session.userId);
}

export function sweepExpiredSharedSessions(nowMs: number = Date.now()) {
    for (const [sessionId, session] of sharedSessions.entries()) {
        if (!session.isEphemeral || !session.expiresAt) continue;
        const expiresAtMs = Date.parse(session.expiresAt);
        if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) continue;

        try {
            session.tuiWs.send(JSON.stringify({ type: "session_expired", sessionId }));
            session.tuiWs.close(1001, "Session expired");
        } catch {}

        endSharedSession(sessionId, "Session expired");
    }
}

// ── Runner registry (Task 003) ───────────────────────────────────────────────
const runners = new Map<string, RunnerEntry>();

export function registerRunner(ws: ServerWebSocket<WsData>): string {
    const runnerId = randomUUID();
    runners.set(runnerId, { ws, sessions: new Map() });
    return runnerId;
}

export function getRunners() {
    return Array.from(runners.entries()).map(([id, r]) => ({
        runnerId: id,
        sessionCount: r.sessions.size,
    }));
}

export function getRunner(runnerId: string) {
    return runners.get(runnerId);
}

export function removeRunner(runnerId: string) {
    runners.delete(runnerId);
}
