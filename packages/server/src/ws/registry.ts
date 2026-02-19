import type { ServerWebSocket } from "bun";
import { randomBytes, randomUUID } from "crypto";

export type WsRole = "tui" | "viewer" | "runner";

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
}

interface RunnerEntry {
    ws: ServerWebSocket<WsData>;
    /** Sessions this runner has spawned, keyed by session ID */
    sessions: Map<string, Set<ServerWebSocket<WsData>>>;
}

// ── Shared TUI sessions (live share) ─────────────────────────────────────────
const sharedSessions = new Map<string, SharedSession>();

export function registerTuiSession(ws: ServerWebSocket<WsData>): {
    sessionId: string;
    token: string;
    shareUrl: string;
} {
    const sessionId = randomUUID();
    const token = randomBytes(32).toString("hex");
    const shareUrl = `${process.env.PIZZAPI_BASE_URL ?? "http://localhost:5173"}/session/${sessionId}`;
    sharedSessions.set(sessionId, { tuiWs: ws, token, viewers: new Set(), collabMode: false, shareUrl });
    return { sessionId, token, shareUrl };
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
