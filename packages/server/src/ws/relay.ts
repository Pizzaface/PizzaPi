import type { ServerWebSocket } from "bun";
import type { WsData } from "./registry.js";
import {
    addViewer,
    addHubClient,
    broadcastToViewers,
    endSharedSession,
    getSharedSession,
    getSessionState,
    getSessionSeq,
    getSessionLastHeartbeat,
    getSessions,
    getRunner,
    publishSessionEvent,
    registerRunner,
    registerTuiSession,
    removeHubClient,
    removeRunner,
    removeViewer,
    sendSnapshotToViewer,
    touchSessionActivity,
    updateSessionState,
    updateSessionHeartbeat,
} from "./registry.js";

// ── Thinking-block duration tracking ─────────────────────────────────────────
// Keyed by sessionId → contentIndex → value.
// We record the wall-clock time when thinking_start arrives, compute elapsed
// seconds when thinking_end arrives, then bake durationSeconds into the
// message_end / turn_end event before it is published to Redis / viewers.
// That way the duration survives page reloads via the Redis replay path.

const thinkingStartTimes = new Map<string, Map<number, number>>();
const thinkingDurations  = new Map<string, Map<number, number>>();

function clearThinkingMaps(sessionId: string) {
    thinkingStartTimes.delete(sessionId);
    thinkingDurations.delete(sessionId);
}

/** Stamp `durationSeconds` onto thinking blocks in a message_end / turn_end event. */
function augmentMessageThinkingDurations(
    event: Record<string, unknown>,
    durations: Map<number, number>,
): Record<string, unknown> {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message || !Array.isArray(message.content)) return event;
    let changed = false;
    const content = (message.content as unknown[]).map((block, i) => {
        if (!block || typeof block !== "object") return block;
        const b = block as Record<string, unknown>;
        if (b.type === "thinking" && durations.has(i) && b.durationSeconds === undefined) {
            changed = true;
            return { ...b, durationSeconds: durations.get(i) };
        }
        return block;
    });
    if (!changed) return event;
    return { ...event, message: { ...message, content } };
}
import { getPersistedRelaySessionSnapshot } from "../sessions/store.js";
import { getCachedRelayEvents } from "../sessions/redis.js";

function findLatestSnapshotEvent(cachedEvents: unknown[]): Record<string, unknown> | null {
    for (let i = cachedEvents.length - 1; i >= 0; i--) {
        const raw = cachedEvents[i];
        if (!raw || typeof raw !== "object") continue;
        const evt = raw as Record<string, unknown>;
        const type = typeof evt.type === "string" ? evt.type : "";

        // Prefer a full message list if present.
        if (type === "agent_end" && Array.isArray((evt as any).messages)) return evt;
        if (type === "session_active" && (evt as any).state !== undefined) return evt;
    }
    return null;
}

async function sendLatestSnapshotFromCache(ws: ServerWebSocket<WsData>, sessionId: string): Promise<boolean> {
    const cachedEvents = await getCachedRelayEvents(sessionId);
    if (cachedEvents.length === 0) return false;

    const snapshotEvent = findLatestSnapshotEvent(cachedEvents);
    if (!snapshotEvent) return false;

    try {
        ws.send(JSON.stringify({ type: "event", event: snapshotEvent, replay: true }));
        return true;
    } catch {
        return false;
    }
}

async function replayPersistedSnapshot(ws: ServerWebSocket<WsData>, sessionId: string) {
    try {
        ws.send(JSON.stringify({ type: "connected", sessionId, replayOnly: true }));

        // Fast path: instead of replaying the entire event buffer, try to send only the
        // latest session snapshot (last session_active / agent_end) so the UI can load
        // instantly from the newest state.
        const sentFromCache = await sendLatestSnapshotFromCache(ws, sessionId);

        if (!sentFromCache) {
            const snapshot = await getPersistedRelaySessionSnapshot(sessionId);
            if (!snapshot || snapshot.state === null || snapshot.state === undefined) {
                ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
                ws.close(1008, "Session not found");
                return;
            }

            ws.send(JSON.stringify({ type: "event", event: { type: "session_active", state: snapshot.state } }));
        }

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
        if (!getSharedSession(sessionId)) {
            void replayPersistedSnapshot(ws, sessionId);
            return;
        }

        const lastSeq = getSessionSeq(sessionId);
        const session = getSharedSession(sessionId);
        ws.send(JSON.stringify({
            type: "connected",
            sessionId,
            lastSeq,
            isActive: session?.isActive ?? false,
            lastHeartbeatAt: session?.lastHeartbeatAt ?? null,
            sessionName: session?.sessionName ?? null,
        }));


        // Add viewer immediately so they don't miss subsequent live events.
        const ok = addViewer(sessionId, ws);
        if (!ok) {
            ws.send(JSON.stringify({ type: "disconnected", reason: "Session ended" }));
            ws.close(1000, "Session ended");
            return;
        }

        // Fast load: send only the latest snapshot (instead of replaying the full
        // Redis event buffer). The UI will render instantly from this state.
        const lastHeartbeat = getSessionLastHeartbeat(sessionId);
        if (lastHeartbeat) {
            try {
                ws.send(JSON.stringify({ type: "event", event: lastHeartbeat, seq: lastSeq }));
            } catch {}
        }

        const lastState = getSessionState(sessionId);
        if (lastState !== undefined) {
            try {
                ws.send(JSON.stringify({ type: "event", event: { type: "session_active", state: lastState }, seq: lastSeq }));
            } catch {}
        } else {
            // If we don't have an in-memory snapshot (e.g. relay restart), fall back
            // to the latest cached snapshot from Redis.
            void sendLatestSnapshotFromCache(ws, sessionId);
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
        clearThinkingMaps(ws.data.sessionId);
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

function sendCumulativeEventAck(ws: ServerWebSocket<WsData>, seq: number) {
    const previous = ws.data.lastAckedSeq ?? 0;
    const next = seq > previous ? seq : previous;
    ws.data.lastAckedSeq = next;

    try {
        ws.send(JSON.stringify({ type: "event_ack", sessionId: ws.data.sessionId, seq: next }));
    } catch {}
}

function handleTuiMessage(ws: ServerWebSocket<WsData>, msg: Record<string, unknown>) {
    if (msg.type === "register") {
        // TUI registers a shared session; sessionId is provided by CLI so reconnects preserve identity.
        const cwd = typeof msg.cwd === "string" ? msg.cwd : "";
        const requestedSessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
        const isEphemeral = msg.ephemeral !== false;
        const collabMode = msg.collabMode !== false;
        const sessionName =
            typeof msg.sessionName === "string"
                ? msg.sessionName
                : msg.sessionName === null
                  ? null
                  : undefined;
        const { sessionId, token, shareUrl } = registerTuiSession(ws, cwd, {
            sessionId: requestedSessionId,
            isEphemeral,
            collabMode,
            sessionName,
        });
        ws.data.sessionId = sessionId;
        ws.data.token = token;
        ws.data.lastAckedSeq = 0;
        ws.send(JSON.stringify({ type: "registered", sessionId, token, shareUrl, isEphemeral, collabMode }));
        return;
    }

    if (msg.type === "exec_result" && ws.data.sessionId) {
        broadcastToViewers(ws.data.sessionId, JSON.stringify(msg));
        return;
    }

    if (msg.type === "event" || msg.type === "session_end") {
        // Validate token
        if (!ws.data.sessionId || msg.token !== ws.data.token) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
            return;
        }

        if (msg.type === "session_end") {
            clearThinkingMaps(ws.data.sessionId);
            endSharedSession(ws.data.sessionId);
            ws.data.sessionId = undefined;
            ws.data.lastAckedSeq = undefined;
            return;
        }

        // Fast path: acknowledge receipt immediately (cumulative), before heavier work
        // like state transforms, Redis cache append, or viewer fanout.
        if (typeof msg.seq === "number" && Number.isFinite(msg.seq)) {
            sendCumulativeEventAck(ws, msg.seq);
        }

        // Cache session_active state so new viewers get an immediate snapshot
        const event = msg.event as Record<string, unknown> | undefined;
        if (event && event.type === "session_active") {
            updateSessionState(ws.data.sessionId, event.state);
        } else if (event && event.type === "heartbeat") {
            // Update liveness tracking from heartbeat — do not persist to Redis cache
            // (too chatty; viewers receive heartbeats via publishSessionEvent below).
            updateSessionHeartbeat(ws.data.sessionId, event);
        } else {
            touchSessionActivity(ws.data.sessionId);
        }

        // Track thinking-block timing so we can stamp durationSeconds on message_end.
        const sessionId = ws.data.sessionId;
        let eventToPublish: unknown = msg.event;

        if (event && event.type === "message_update") {
            const ae = event.assistantMessageEvent as Record<string, unknown> | undefined;
            if (ae) {
                const deltaType = typeof ae.type === "string" ? ae.type : "";
                const contentIndex = typeof ae.contentIndex === "number" ? ae.contentIndex : -1;
                if (contentIndex >= 0) {
                    if (deltaType === "thinking_start") {
                        if (!thinkingStartTimes.has(sessionId)) thinkingStartTimes.set(sessionId, new Map());
                        thinkingStartTimes.get(sessionId)!.set(contentIndex, Date.now());
                    } else if (deltaType === "thinking_end") {
                        const startTime = thinkingStartTimes.get(sessionId)?.get(contentIndex);
                        if (startTime !== undefined) {
                            const durationSeconds = Math.ceil((Date.now() - startTime) / 1000);
                            if (!thinkingDurations.has(sessionId)) thinkingDurations.set(sessionId, new Map());
                            thinkingDurations.get(sessionId)!.set(contentIndex, durationSeconds);
                            thinkingStartTimes.get(sessionId)?.delete(contentIndex);
                        }
                    }
                }
            }
        }

        if (event && (event.type === "message_end" || event.type === "turn_end")) {
            const durations = thinkingDurations.get(sessionId);
            if (durations?.size) {
                eventToPublish = augmentMessageThinkingDurations(event, durations);
            }
            // Reset for the next assistant message.
            clearThinkingMaps(sessionId);
        }

        // Cache + forward event to viewers (for reconnect replay).
        publishSessionEvent(sessionId, eventToPublish);
        return;
    }
}

// ── Viewer message handling ───────────────────────────────────────────────────

function handleViewerMessage(ws: ServerWebSocket<WsData>, msg: Record<string, unknown>) {
    if (!ws.data.sessionId) return;

    const session = getSharedSession(ws.data.sessionId);
    if (!session) return;

    // Viewer requests a fresh snapshot (e.g. after detecting a sequence gap).
    if (msg.type === "resync") {
        sendSnapshotToViewer(ws.data.sessionId, ws);
        return;
    }

    // Notify TUI that a new viewer has connected so it can push capabilities.
    if (msg.type === "connected") {
        try {
            session.tuiWs.send(JSON.stringify({ type: "connected" }));
        } catch {}
        return;
    }

    // Collab mode: forward viewer input (+ optional attachments metadata) to TUI
    if (msg.type === "input" && session.collabMode && typeof msg.text === "string") {
        const attachments = Array.isArray(msg.attachments)
            ? msg.attachments
                  .filter((entry) => entry && typeof entry === "object")
                  .map((entry) => {
                      const item = entry as Record<string, unknown>;
                      return {
                          attachmentId: typeof item.attachmentId === "string" ? item.attachmentId : undefined,
                          mediaType: typeof item.mediaType === "string" ? item.mediaType : undefined,
                          filename: typeof item.filename === "string" ? item.filename : undefined,
                          url: typeof item.url === "string" ? item.url : undefined,
                      };
                  })
                  .filter(
                      (item) =>
                          (typeof item.attachmentId === "string" && item.attachmentId.length > 0) ||
                          (typeof item.url === "string" && item.url.length > 0),
                  )
            : [];

        const client = typeof msg.client === "string" ? msg.client : undefined;

        try {
            session.tuiWs.send(JSON.stringify({ type: "input", text: msg.text, attachments, client }));
        } catch {}
        return;
    }

    if (
        msg.type === "model_set" &&
        session.collabMode &&
        typeof msg.provider === "string" &&
        typeof msg.modelId === "string"
    ) {
        try {
            session.tuiWs.send(JSON.stringify({ type: "model_set", provider: msg.provider, modelId: msg.modelId }));
        } catch {}
        return;
    }

    if (msg.type === "exec" && session.collabMode && typeof msg.id === "string" && typeof msg.command === "string") {
        try {
            session.tuiWs.send(JSON.stringify(msg));
        } catch {}
        return;
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
        publishSessionEvent(sessionId, msg.event);
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
