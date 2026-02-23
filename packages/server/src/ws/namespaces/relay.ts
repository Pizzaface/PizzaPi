// ============================================================================
// /relay namespace — TUI (CLI agent) ↔ Server
//
// Handles TUI registration, agent event pipeline with thinking-duration
// tracking, session lifecycle, inter-session messaging, and push notifications.
// ============================================================================

import type { Server as SocketIOServer, Namespace, Socket } from "socket.io";
import type {
    RelayClientToServerEvents,
    RelayServerToClientEvents,
    RelayInterServerEvents,
    RelaySocketData,
} from "@pizzapi/protocol";
import { apiKeyAuthMiddleware } from "./auth.js";
import {
    registerTuiSession,
    getSharedSession,
    getLocalTuiSocket,
    updateSessionState,
    updateSessionHeartbeat,
    touchSessionActivity,
    publishSessionEvent,
    endSharedSession,
    getViewerCount,
    broadcastToViewers,
} from "../sio-registry.js";
import {
    notifyAgentFinished,
    notifyAgentNeedsInput,
    notifyAgentError,
} from "../../push.js";

// ── Thinking-block duration tracking ─────────────────────────────────────────
// Keyed by sessionId → contentIndex → value.
// We record the wall-clock time when thinking_start arrives, compute elapsed
// seconds when thinking_end arrives, then bake durationSeconds into the
// message_end / turn_end event before it is published to Redis / viewers.

const thinkingStartTimes = new Map<string, Map<number, number>>();
const thinkingDurations = new Map<string, Map<number, number>>();

function clearThinkingMaps(sessionId: string): void {
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

// ── Per-socket ack tracking ──────────────────────────────────────────────────
// Tracks the highest cumulative event seq acknowledged back to each TUI socket.
// Stored outside socket.data because RelaySocketData doesn't include it.

const socketAckedSeqs = new Map<string, number>();

type RelaySocket = Socket<
    RelayClientToServerEvents,
    RelayServerToClientEvents,
    RelayInterServerEvents,
    RelaySocketData
>;

function sendCumulativeEventAck(socket: RelaySocket, seq: number): void {
    const socketId = socket.id;
    const previous = socketAckedSeqs.get(socketId) ?? 0;
    const next = seq > previous ? seq : previous;
    socketAckedSeqs.set(socketId, next);

    const sessionId = socket.data.sessionId;
    if (sessionId) {
        socket.emit("event_ack", { sessionId, seq: next });
    }
}

// ── Track thinking deltas ────────────────────────────────────────────────────

function trackThinkingDeltas(sessionId: string, event: Record<string, unknown>): void {
    if (event.type !== "message_update") return;

    const ae = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!ae) return;

    const deltaType = typeof ae.type === "string" ? ae.type : "";
    const contentIndex = typeof ae.contentIndex === "number" ? ae.contentIndex : -1;
    if (contentIndex < 0) return;

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

// ── Push notification checks ─────────────────────────────────────────────────

async function checkPushNotifications(
    sessionId: string,
    event: Record<string, unknown>,
): Promise<void> {
    const session = await getSharedSession(sessionId);
    const userId = session?.userId;
    if (!userId) return;

    const viewerCount = await getViewerCount(sessionId);
    if (viewerCount > 0) return;

    const sName = session?.sessionName ?? null;

    if (event.type === "agent_end") {
        notifyAgentFinished(userId, sessionId, sName);
    }

    if (event.type === "tool_execution_start" && event.toolName === "AskUserQuestion") {
        const args = event.args as Record<string, unknown> | undefined;
        const question = typeof args?.question === "string" ? args.question : undefined;
        notifyAgentNeedsInput(userId, sessionId, question, sName);
    }

    if (event.type === "cli_error") {
        const errMsg = typeof event.message === "string" ? event.message : undefined;
        notifyAgentError(userId, sessionId, errMsg, sName);
    }
}

// ── Namespace registration ───────────────────────────────────────────────────

export function registerRelayNamespace(io: SocketIOServer): void {
    const relay: Namespace<
        RelayClientToServerEvents,
        RelayServerToClientEvents,
        RelayInterServerEvents,
        RelaySocketData
    > = io.of("/relay");

    // Auth: validate API key from handshake
    relay.use(apiKeyAuthMiddleware() as Parameters<typeof relay.use>[0]);

    relay.on("connection", (socket) => {
        console.log(`[sio/relay] connected: ${socket.id}`);

        // ── register ─────────────────────────────────────────────────────────
        socket.on("register", async (data) => {
            const cwd = data.cwd ?? "";
            const isEphemeral = data.ephemeral !== false;
            const collabMode = data.collabMode !== false;

            const { sessionId, token, shareUrl } = await registerTuiSession(socket, cwd, {
                sessionId: data.sessionId,
                isEphemeral,
                collabMode,
                sessionName: data.sessionName,
                userId: socket.data.userId,
                userName: (socket.data as RelaySocketData & { userName?: string }).userName,
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
            });
        });

        // ── event — main event pipeline ──────────────────────────────────────
        socket.on("event", async (data) => {
            const sessionId = socket.data.sessionId;
            if (!sessionId || data.token !== socket.data.token) {
                socket.emit("error", { message: "Invalid token" });
                return;
            }

            // Fast path: acknowledge receipt immediately (cumulative)
            if (typeof data.seq === "number" && Number.isFinite(data.seq)) {
                sendCumulativeEventAck(socket, data.seq);
            }

            const event = data.event as Record<string, unknown> | undefined;
            if (!event) return;

            // Cache session_active state so new viewers get an immediate snapshot
            if (event.type === "session_active") {
                await updateSessionState(sessionId, event.state);
            } else if (event.type === "heartbeat") {
                await updateSessionHeartbeat(sessionId, event);
            } else {
                await touchSessionActivity(sessionId);
            }

            // Track thinking-block timing
            trackThinkingDeltas(sessionId, event);

            // Augment message_end / turn_end with thinking durations
            let eventToPublish: unknown = data.event;
            if (event.type === "message_end" || event.type === "turn_end") {
                const durations = thinkingDurations.get(sessionId);
                if (durations?.size) {
                    eventToPublish = augmentMessageThinkingDurations(event, durations);
                }
                clearThinkingMaps(sessionId);
            }

            // Publish to viewers via Redis cache + Socket.IO rooms
            await publishSessionEvent(sessionId, eventToPublish);

            // Push notifications (only when no browser viewers are watching)
            void checkPushNotifications(sessionId, event);
        });

        // ── session_end ──────────────────────────────────────────────────────
        socket.on("session_end", async (data) => {
            const sessionId = socket.data.sessionId;
            if (!sessionId || data.token !== socket.data.token) {
                socket.emit("error", { message: "Invalid token" });
                return;
            }

            clearThinkingMaps(sessionId);
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

        // ── session_message — inter-session messaging ────────────────────────
        socket.on("session_message", async (data) => {
            const sessionId = socket.data.sessionId;
            if (!sessionId || data.token !== socket.data.token) {
                socket.emit("error", { message: "Invalid token" });
                return;
            }

            const targetSessionId = data.targetSessionId;
            const messageText = data.message;
            if (!targetSessionId || !messageText) {
                socket.emit("error", { message: "session_message requires targetSessionId and message" });
                return;
            }

            const targetSession = await getSharedSession(targetSessionId);
            if (!targetSession) {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: "Target session not found or not connected",
                });
                return;
            }

            const targetSocket = getLocalTuiSocket(targetSessionId);
            if (!targetSocket) {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: "Target session not found or not connected",
                });
                return;
            }

            try {
                targetSocket.emit("session_message" as string, {
                    fromSessionId: sessionId,
                    message: messageText,
                    ts: new Date().toISOString(),
                });
            } catch {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: "Failed to deliver message to target session",
                });
            }
        });

        // ── disconnect ───────────────────────────────────────────────────────
        socket.on("disconnect", async (reason) => {
            console.log(`[sio/relay] disconnected: ${socket.id} (${reason})`);
            const sessionId = socket.data.sessionId;
            if (sessionId) {
                clearThinkingMaps(sessionId);
                await endSharedSession(sessionId);
            }
            socketAckedSeqs.delete(socket.id);
        });
    });
}
