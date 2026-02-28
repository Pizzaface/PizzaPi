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
import { sessionCookieAuthMiddleware } from "./auth.js";
import {
    getSharedSession,
    addViewer,
    removeViewer,
    getSessionSeq,
    sendSnapshotToViewer,
    getLocalTuiSocket,
} from "../sio-registry.js";
import { getPersistedRelaySessionSnapshot } from "../../sessions/store.js";
import { getCachedRelayEvents } from "../../sessions/redis.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function isAgentEndEvent(evt: unknown): evt is AgentEndEvent {
    return (
        typeof evt === "object" &&
        evt !== null &&
        "type" in evt &&
        evt.type === "agent_end" &&
        "messages" in evt &&
        Array.isArray((evt as AgentEndEvent).messages)
    );
}

function isSessionActiveEvent(evt: unknown): evt is SessionActiveEvent {
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
 */
function findLatestSnapshotEvent(cachedEvents: unknown[]): Record<string, unknown> | null {
    for (let i = cachedEvents.length - 1; i >= 0; i--) {
        const raw = cachedEvents[i];
        if (isAgentEndEvent(raw)) return raw;
        if (isSessionActiveEvent(raw)) return raw;
    }
    return null;
}

/**
 * Try to send the latest snapshot event from the Redis event cache.
 * Returns true if a snapshot was sent, false otherwise.
 */
async function sendLatestSnapshotFromCache(
    socket: ViewerSocket,
    sessionId: string,
): Promise<boolean> {
    const cachedEvents = await getCachedRelayEvents(sessionId);
    if (cachedEvents.length === 0) return false;

    const snapshotEvent = findLatestSnapshotEvent(cachedEvents);
    if (!snapshotEvent) return false;

    socket.emit("event", { event: snapshotEvent, replay: true });
    return true;
}

/**
 * Replay a persisted (SQLite + Redis) snapshot for a session that is
 * no longer live. Sends the snapshot, then disconnects the viewer.
 */
async function replayPersistedSnapshot(
    socket: ViewerSocket,
    sessionId: string,
): Promise<void> {
    try {
        socket.emit("connected", { sessionId, replayOnly: true });

        // Fast path: send only the latest snapshot from Redis cache
        const sentFromCache = await sendLatestSnapshotFromCache(socket, sessionId);

        if (!sentFromCache) {
            const snapshot = await getPersistedRelaySessionSnapshot(sessionId);
            if (!snapshot || snapshot.state === null || snapshot.state === undefined) {
                socket.emit("error", { message: "Session not found" });
                socket.disconnect();
                return;
            }

            socket.emit("event", {
                event: { type: "session_active", state: snapshot.state },
            });
        }

        socket.emit("disconnected", { reason: "Session is no longer live (snapshot replay)." });
        // Use disconnect() without `true` so the client can still auto-reconnect
        // when the session comes back online. disconnect(true) sets reason to
        // "io server disconnect" on the client, which permanently disables
        // socket.io's auto-reconnect logic.
        socket.disconnect();
    } catch (error) {
        socket.emit("error", { message: "Failed to load session snapshot" });
        socket.disconnect();
        console.error("[sio/viewer] Failed to replay persisted snapshot:", error);
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
        // Extract sessionId from handshake auth or query
        const sessionId =
            (typeof socket.handshake.auth?.sessionId === "string"
                ? socket.handshake.auth.sessionId
                : undefined) ??
            (typeof socket.handshake.query?.sessionId === "string"
                ? socket.handshake.query.sessionId
                : undefined) ??
            "";

        if (!sessionId) {
            socket.emit("error", { message: "Missing session ID" });
            socket.disconnect(true);
            return;
        }

        socket.data.sessionId = sessionId;

        console.log(`[sio/viewer] connected: ${socket.id} sessionId=${sessionId}`);

        // Look up the live session
        const session = await getSharedSession(sessionId);
        if (!session) {
            // Session not live — try to replay a persisted snapshot
            await replayPersistedSnapshot(socket, sessionId);
            return;
        }

        // Session is live — send connection info and initial snapshot BEFORE
        // joining the broadcast room. This avoids a race where live streaming
        // deltas arrive (via the room) before the snapshot, causing the UI to
        // show partial content that then gets replaced by the snapshot — making
        // messages visibly "jump".
        //
        // Any events emitted between snapshot read and room join are detected
        // by the client's sequence-gap logic (seq gap > 1 → resync request).
        const lastSeq = await getSessionSeq(sessionId);
        socket.emit("connected", {
            sessionId,
            lastSeq,
            isActive: session.isActive,
            lastHeartbeatAt: session.lastHeartbeatAt,
            sessionName: session.sessionName,
        });

        // Send the snapshot while the viewer is NOT yet in the room.
        // Inline the snapshot send using already-fetched session data to avoid
        // an extra Redis round-trip (which would widen the race window).
        if (session.lastHeartbeat) {
            try {
                socket.emit("event", { event: JSON.parse(session.lastHeartbeat), seq: lastSeq });
            } catch {}
        }
        if (session.lastState) {
            try {
                socket.emit("event", { event: { type: "session_active", state: JSON.parse(session.lastState) }, seq: lastSeq });
            } catch {}
        } else {
            // No in-memory state — fall back to event cache
            await sendLatestSnapshotFromCache(socket, sessionId);
        }

        // NOW join the room for live events — any missed events between
        // snapshot read and this point will be caught by gap detection.
        const ok = await addViewer(sessionId, socket);
        if (!ok) {
            socket.emit("disconnected", { reason: "Session ended" });
            // Use disconnect() (not true) so the client can still auto-reconnect;
            // the session may have just cycled and will come back shortly.
            socket.disconnect();
            return;
        }

        // ── connected — viewer greeting, notify TUI ─────────────────────────
        socket.on("connected", () => {
            const tuiSocket = getLocalTuiSocket(sessionId);
            if (tuiSocket) {
                tuiSocket.emit("connected" as string, {});
            }
        });

        // ── resync — send fresh snapshot ─────────────────────────────────────
        socket.on("resync", async () => {
            await sendSnapshotToViewer(sessionId, socket);
        });

        // ── input — collab mode: forward user input to TUI ──────────────────
        socket.on("input", async (data) => {
            const currentSession = await getSharedSession(sessionId);
            if (!currentSession?.collabMode) return;

            const tuiSocket = getLocalTuiSocket(sessionId);
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
            const currentSession = await getSharedSession(sessionId);
            if (!currentSession?.collabMode) return;

            const tuiSocket = getLocalTuiSocket(sessionId);
            if (!tuiSocket) return;

            tuiSocket.emit("model_set" as string, {
                provider: data.provider,
                modelId: data.modelId,
            });
        });

        // ── exec — collab mode: forward remote command to TUI ────────────────
        socket.on("exec", async (data) => {
            const currentSession = await getSharedSession(sessionId);
            if (!currentSession?.collabMode) return;

            const tuiSocket = getLocalTuiSocket(sessionId);
            if (!tuiSocket) return;

            tuiSocket.emit("exec" as string, data);
        });

        // ── disconnect ───────────────────────────────────────────────────────
        socket.on("disconnect", async (reason) => {
            console.log(`[sio/viewer] disconnected: ${socket.id} sessionId=${sessionId} (${reason})`);
            await removeViewer(sessionId, socket);
        });
    });
}
