import type { ServerWebSocket } from "bun";
import type { WsData } from "./registry.js";
import {
    addViewer,
    addHubClient,
    broadcastToViewers,
    endSharedSession,
    getSharedSession,
    getSessionState,
    getSessions,
    getRunner,
    registerRunner,
    registerTuiSession,
    removeHubClient,
    removeRunner,
    removeViewer,
    touchSessionActivity,
    updateSessionState,
} from "./registry.js";
import { getPersistedRelaySessionSnapshot } from "../sessions/store.js";

async function replayPersistedSnapshot(ws: ServerWebSocket<WsData>, sessionId: string) {
    try {
        const snapshot = await getPersistedRelaySessionSnapshot(sessionId);
        if (!snapshot || snapshot.state === null || snapshot.state === undefined) {
            ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
            ws.close(1008, "Session not found");
            return;
        }

        ws.send(JSON.stringify({ type: "connected", sessionId, replayOnly: true }));
        ws.send(JSON.stringify({ type: "event", event: { type: "session_active", state: snapshot.state } }));
        ws.send(JSON.stringify({ type: "disconnected", reason: "Session is no longer live (snapshot replay)." }));
        ws.close(1000, "Snapshot replay complete");
    } catch (error) {
        ws.send(JSON.stringify({ type: "error", message: "Failed to load session snapshot" }));
        ws.close(1011, "Failed to load session snapshot");
        console.error("Failed to replay persisted snapshot", error);
    }
}

/** Called when a WebSocket connection is opened. */
export function onOpen(ws: ServerWebSocket<WsData>) {
    // Role is set in the upgrade handler based on URL path.
    // TUI and runner connections perform a handshake via the first message.
    if (ws.data.role === "viewer" && ws.data.sessionId) {
        const sessionId = ws.data.sessionId;
        const ok = addViewer(sessionId, ws);
        if (!ok) {
            void replayPersistedSnapshot(ws, sessionId);
            return;
        }

        ws.send(JSON.stringify({ type: "connected", sessionId }));
        // Replay the last known session state so the viewer sees current content immediately
        const lastState = getSessionState(sessionId);
        if (lastState !== undefined) {
            ws.send(JSON.stringify({ type: "event", event: { type: "session_active", state: lastState } }));
        }
    } else if (ws.data.role === "hub") {
        addHubClient(ws);
        // Send only this user's active sessions on connect
        ws.send(JSON.stringify({ type: "sessions", sessions: getSessions(ws.data.userId) }));
    }
}

/** Called when a message arrives on a WebSocket. */
export function onMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
    let msg: Record<string, unknown>;
    try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
    }

    if (ws.data.role === "tui") {
        handleTuiMessage(ws, msg);
    } else if (ws.data.role === "viewer") {
        handleViewerMessage(ws, msg);
    } else if (ws.data.role === "runner") {
        handleRunnerMessage(ws, msg);
    }
    // hub role: read-only feed, no inbound messages handled
}

/** Called when a WebSocket closes. */
export function onClose(ws: ServerWebSocket<WsData>) {
    if (ws.data.role === "tui" && ws.data.sessionId) {
        endSharedSession(ws.data.sessionId);
    } else if (ws.data.role === "viewer" && ws.data.sessionId) {
        removeViewer(ws.data.sessionId, ws);
    } else if (ws.data.role === "runner" && ws.data.runnerId) {
        removeRunner(ws.data.runnerId);
    } else if (ws.data.role === "hub") {
        removeHubClient(ws);
    }
}

// ── TUI message handling ──────────────────────────────────────────────────────

function handleTuiMessage(ws: ServerWebSocket<WsData>, msg: Record<string, unknown>) {
    if (msg.type === "register") {
        // TUI registers a new shared session; cwd sent by CLI for display in hub UI
        const cwd = typeof msg.cwd === "string" ? msg.cwd : "";
        const isEphemeral = msg.ephemeral !== false;
        const collabMode = msg.collabMode !== false;
        const { sessionId, token, shareUrl } = registerTuiSession(ws, cwd, { isEphemeral, collabMode });
        ws.data.sessionId = sessionId;
        ws.data.token = token;
        ws.send(JSON.stringify({ type: "registered", sessionId, token, shareUrl, isEphemeral, collabMode }));
        return;
    }

    if (msg.type === "event" || msg.type === "session_end") {
        // Validate token
        if (!ws.data.sessionId || msg.token !== ws.data.token) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
            return;
        }

        if (msg.type === "session_end") {
            endSharedSession(ws.data.sessionId);
            ws.data.sessionId = undefined;
            return;
        }

        // Cache session_active state so new viewers get an immediate snapshot
        const event = msg.event as Record<string, unknown> | undefined;
        if (event && event.type === "session_active") {
            updateSessionState(ws.data.sessionId, event.state);
        } else {
            touchSessionActivity(ws.data.sessionId);
        }

        // Forward event to all viewers
        broadcastToViewers(ws.data.sessionId, JSON.stringify({ type: "event", event: msg.event }));
        return;
    }
}

// ── Viewer message handling ───────────────────────────────────────────────────

function handleViewerMessage(ws: ServerWebSocket<WsData>, msg: Record<string, unknown>) {
    if (!ws.data.sessionId) return;

    const session = getSharedSession(ws.data.sessionId);
    if (!session) return;

    // Collab mode: forward viewer input to TUI
    if (msg.type === "input" && session.collabMode && typeof msg.text === "string") {
        try {
            session.tuiWs.send(JSON.stringify({ type: "input", text: msg.text }));
        } catch {}
    }
}

// ── Runner message handling (Task 003) ───────────────────────────────────────

function handleRunnerMessage(ws: ServerWebSocket<WsData>, msg: Record<string, unknown>) {
    if (msg.type === "register_runner") {
        const runnerId = registerRunner(ws);
        ws.data.runnerId = runnerId;
        ws.send(JSON.stringify({ type: "runner_registered", runnerId }));
        return;
    }

    // Forward agent events from runner sessions to browser viewers
    if (msg.type === "runner_session_event") {
        const sessionId = msg.sessionId as string;
        broadcastToViewers(sessionId, JSON.stringify({ type: "event", event: msg.event }));
        return;
    }

    // session_ready / session_killed / sessions_list — forward to web UI viewers if any
    if (msg.type === "session_ready" || msg.type === "session_killed" || msg.type === "sessions_list") {
        const sessionId = msg.sessionId as string | undefined;
        if (sessionId) {
            broadcastToViewers(sessionId, JSON.stringify(msg));
        }
        return;
    }
}
