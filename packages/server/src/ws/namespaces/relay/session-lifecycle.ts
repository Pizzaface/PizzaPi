// ── Session lifecycle handlers ────────────────────────────────────────────────
// Handles register, session_end, exec_result, and disconnect events.

import type { RelaySocketData } from "@pizzapi/protocol";
import { shouldPreserveOnSocketDisconnect } from "../../../health.js";
import {
    registerTuiSession,
    getLocalTuiSocket,
    broadcastToViewers,
    endSharedSession,
} from "../../sio-registry.js";
import {
    clearPushPendingQuestion,
    deleteRunnerAssociation,
} from "../../sio-state/index.js";
import { socketAckedSeqs } from "./ack-tracker.js";
import { clearThinkingMaps } from "./thinking-tracker.js";
import { pendingChunkedStates, enqueueSessionEvent } from "./event-pipeline.js";
import type { RelaySocket } from "./types.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("sio/relay");

export function registerSessionLifecycleHandlers(socket: RelaySocket): void {
    // ── register ─────────────────────────────────────────────────────────
    socket.on("register", async (data) => {
        const cwd = data.cwd ?? "";
        const isEphemeral = data.ephemeral !== false;
        const collabMode = data.collabMode !== false;

        const { sessionId, token, shareUrl, parentSessionId, wasDelinked } = await registerTuiSession(socket, cwd, {
            sessionId: data.sessionId,
            isEphemeral,
            collabMode,
            sessionName: data.sessionName,
            userId: socket.data.userId,
            userName: (socket.data as RelaySocketData & { userName?: string }).userName,
            parentSessionId: data.parentSessionId ?? undefined,
        });

        socket.data.sessionId = sessionId;
        socket.data.token = token;
        socket.data.cwd = cwd;
        socketAckedSeqs.set(socket.id, 0);

        socket.emit("registered", {
            sessionId,
            token,
            shareUrl,
            isEphemeral,
            collabMode,
            parentSessionId,
            // Server wall-clock time — lets the client compute
            // clock offset for accurate epoch-based delink filtering.
            serverTime: Date.now(),
            supportsSessionTriggerAck: true,
            // Only include wasDelinked when it is true to keep the payload
            // minimal for non-child or non-delinked sessions.
            ...(wasDelinked ? { wasDelinked: true } : {}),
        });
    });

    // ── session_end ──────────────────────────────────────────────────────
    socket.on("session_end", async (data) => {
        const sessionId = socket.data.sessionId;
        if (!sessionId || data.token !== socket.data.token) {
            socket.emit("error", { message: "Invalid token" });
            return;
        }

        clearThinkingMaps(sessionId);
        // Defer chunked-state cleanup until all previously-queued
        // session_messages_chunk handlers have finished.  If we deleted
        // pendingChunkedStates immediately, any chunks still queued in
        // enqueueSessionEvent() would wake up, find no pending state, and
        // skip final assembly — leaving the session with a stale snapshot.
        enqueueSessionEvent(sessionId, async () => {
            pendingChunkedStates.delete(sessionId);
        });
        void clearPushPendingQuestion(sessionId);
        // Graceful end — delete the durable runner association so it
        // isn't restored if a new session reuses this ID later.
        await deleteRunnerAssociation(sessionId);
        await endSharedSession(sessionId);
        socket.data.sessionId = undefined;
        socketAckedSeqs.delete(socket.id);
    });

    // ── exec_result — forward to viewers ─────────────────────────────────
    socket.on("exec_result", (data) => {
        const sessionId = socket.data.sessionId;
        if (!sessionId) return;
        broadcastToViewers(sessionId, "exec_result", data);
    });

    // ── disconnect ───────────────────────────────────────────────────────
    socket.on("disconnect", async (reason) => {
        log.info(`disconnected: ${socket.id} (${reason})`);
        const sessionId = socket.data.sessionId;
        if (sessionId) {
            // If a newer socket already re-registered this session (reconnect),
            // don't tear down the new session.  registerTuiSession clears our
            // sessionId as a primary guard, but this check is defense-in-depth
            // for any remaining race windows.
            const currentSocket = getLocalTuiSocket(sessionId);
            if (currentSocket && currentSocket !== socket) {
                log.info(`disconnect for ${socket.id} — session ${sessionId} already owned by ${currentSocket.id}, skipping teardown`);
                socketAckedSeqs.delete(socket.id);
                return;
            }

            // During graceful shutdown (io.close()), Socket.IO disconnects
            // all sockets with reason "server shutting down".  Skip
            // destructive Redis cleanup for those — the TUI worker is
            // still alive and will reconnect to the new server instance.
            if (shouldPreserveOnSocketDisconnect(reason)) {
                log.info(`server shutting down — preserving Redis state for session ${sessionId}`);
                socketAckedSeqs.delete(socket.id);
                return;
            }

            clearThinkingMaps(sessionId);
            pendingChunkedStates.delete(sessionId);
            void clearPushPendingQuestion(sessionId);
            // NOTE: We intentionally do NOT remove the child from the
            // parent's children set here.  Doing so races with
            // delink_children: if the child disconnects before the parent
            // fires /new, delink_children's getChildSessions() snapshot
            // won't include it and no delink marker will be written.  When
            // the child reconnects, registerTuiSession() would re-link it
            // to the parent's new conversation.  Leaving the membership in
            // place is harmless — delink_children will clean it up, and
            // stale entries are pruned when the session key expires.
            await endSharedSession(sessionId);
        }
        socketAckedSeqs.delete(socket.id);
    });
}
