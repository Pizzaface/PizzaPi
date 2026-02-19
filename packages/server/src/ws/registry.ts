import type { ServerWebSocket } from "bun";
import { randomBytes, randomUUID } from "crypto";

export type WsRole = "tui" | "viewer" | "runner" | "hub";

export interface WsData {
    role: WsRole;
    /** Set after registration handshake */
    sessionId?: string;
    /** Auth token (TUI-side, to validate incoming events) */
    token?: string;
    /** For runner role: runner ID */
    runnerId?: string;
}

interface SharedSession {
    /** The TUI WebSocket that owns this session */
    tuiWs: ServerWebSocket<WsData>;
    token: string;
    viewers: Set<ServerWebSocket<WsData>>;
    collabMode: boolean;
    shareUrl: string;
    cwd: string;
    startedAt: string;
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

function broadcastToHub(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const ws of hubClients) {
        try {
            ws.send(data);
        } catch {}
    }
}

// ── Shared TUI sessions (live share) ─────────────────────────────────────────
const sharedSessions = new Map<string, SharedSession>();

export function registerTuiSession(
    ws: ServerWebSocket<WsData>,
    cwd: string = "",
): {
    sessionId: string;
    token: string;
    shareUrl: string;
} {
    const sessionId = randomUUID();
    const token = randomBytes(32).toString("hex");
    const shareUrl = `${process.env.PIZZAPI_BASE_URL ?? "http://localhost:5173"}/session/${sessionId}`;
    const startedAt = new Date().toISOString();
    sharedSessions.set(sessionId, {
        tuiWs: ws,
        token,
        viewers: new Set(),
        collabMode: false,
        shareUrl,
        cwd,
        startedAt,
    });
    broadcastToHub({ type: "session_added", sessionId, shareUrl, cwd, startedAt });
    return { sessionId, token, shareUrl };
}

/** Returns a public summary of all active TUI sessions (safe to send to hub clients). */
export function getSessions() {
    return Array.from(sharedSessions.entries()).map(([id, s]) => ({
        sessionId: id,
        shareUrl: s.shareUrl,
        cwd: s.cwd,
        startedAt: s.startedAt,
        viewerCount: s.viewers.size,
    }));
}

export function getSharedSession(sessionId: string) {
    return sharedSessions.get(sessionId);
}

export function addViewer(sessionId: string, ws: ServerWebSocket<WsData>): boolean {
    const session = sharedSessions.get(sessionId);
    if (!session) return false;
    session.viewers.add(ws);
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

export function endSharedSession(sessionId: string) {
    const session = sharedSessions.get(sessionId);
    if (!session) return;
    const msg = JSON.stringify({ type: "disconnected" });
    for (const viewer of session.viewers) {
        try {
            viewer.send(msg);
            viewer.close(1000, "Session ended");
        } catch {}
    }
    sharedSessions.delete(sessionId);
    broadcastToHub({ type: "session_removed", sessionId });
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
