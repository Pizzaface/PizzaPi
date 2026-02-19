import type { ServerWebSocket } from "bun";
import type { WsData } from "./registry.js";
import {
    addViewer,
    broadcastToViewers,
    endSharedSession,
    getSharedSession,
    getRunner,
    registerRunner,
    registerTuiSession,
    removeRunner,
    removeViewer,
} from "./registry.js";

/** Called when a WebSocket connection is opened. */
export function onOpen(ws: ServerWebSocket<WsData>) {
    // Role is set in the upgrade handler based on URL path.
    // TUI and runner connections perform a handshake via the first message.
    if (ws.data.role === "viewer" && ws.data.sessionId) {
        const ok = addViewer(ws.data.sessionId, ws);
        if (!ok) {
            ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
            ws.close(1008, "Session not found");
        } else {
            ws.send(JSON.stringify({ type: "connected", sessionId: ws.data.sessionId }));
        }
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
}

/** Called when a WebSocket closes. */
export function onClose(ws: ServerWebSocket<WsData>) {
    if (ws.data.role === "tui" && ws.data.sessionId) {
        endSharedSession(ws.data.sessionId);
    } else if (ws.data.role === "viewer" && ws.data.sessionId) {
        removeViewer(ws.data.sessionId, ws);
    } else if (ws.data.role === "runner" && ws.data.runnerId) {
        removeRunner(ws.data.runnerId);
    }
}

// ── TUI message handling ──────────────────────────────────────────────────────

function handleTuiMessage(ws: ServerWebSocket<WsData>, msg: Record<string, unknown>) {
    if (msg.type === "register") {
        // TUI registers a new shared session
        const { sessionId, token, shareUrl } = registerTuiSession(ws);
        ws.data.sessionId = sessionId;
        ws.data.token = token;
        ws.send(JSON.stringify({ type: "registered", sessionId, token, shareUrl }));
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
