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
    getSessionLastHeartbeat,
    getSessionState,
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

/**
 * Scan cached events from newest to oldest, looking for the latest
 * full-state snapshot (agent_end with messages, or session_active with state).
 */
function findLatestSnapshotEvent(cachedEvents: unknown[]): Record<string, unknown> | null {
    for (let i = cachedEvents.length - 1; i >= 0; i--) {
        const raw = cachedEvents[i];
        if (!raw || typeof raw !== "object") continue;
        const evt = raw as Record<string, unknown>;
        const type = typeof evt.type === "string" ? evt.type : "";

        if (type === "agent_end" && Array.isArray((evt as Record<string, unknown>).messages)) return evt;
        if (type === "session_active" && (evt as Record<string, unknown>).state !== undefined) return evt;
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
                socket.disconnect(true);
                return;
            }

            socket.emit("event", {
                event: { type: "session_active", state: snapshot.state },
            });
        }

        socket.emit("disconnected", { reason: "Session is no longer live (snapshot replay)." });
        socket.disconnect(true);
    } catch (error) {
        socket.emit("error", { message: "Failed to load session snapshot" });
        socket.disconnect(true);
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

        // Session is live — send connection info
        const lastSeq = await getSessionSeq(sessionId);
        socket.emit("connected", {
            sessionId,
            lastSeq,
            isActive: session.isActive,
            lastHeartbeatAt: session.lastHeartbeatAt,
            sessionName: session.sessionName,
        });

        // Add viewer to the session room (must happen before snapshot send
        // so the viewer doesn't miss events emitted in between)
        const ok = await addViewer(sessionId, socket);
        if (!ok) {
            socket.emit("disconnected", { reason: "Session ended" });
            socket.disconnect(true);
            return;
        }

        // Send the latest snapshot (heartbeat + state) from Redis
        await sendSnapshotToViewer(sessionId, socket);

        // If no in-memory state was available, fall back to event cache
        if (!session.lastState) {
            await sendLatestSnapshotFromCache(socket, sessionId);
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
