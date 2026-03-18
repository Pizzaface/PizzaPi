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
    emitToRelaySession,
    updateSessionState,
    updateSessionHeartbeat,
    touchSessionActivity,
    publishSessionEvent,
    endSharedSession,
    getViewerCount,
    broadcastToViewers,
} from "../sio-registry.js";
import {
    setPushPendingQuestion,
    clearPushPendingQuestion,
    deleteRunnerAssociation,
    removeChildSession,
} from "../sio-state.js";
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

// ── Chunked session_active assembly ──────────────────────────────────────────
// When a worker sends session_active with chunked:true, messages follow as
// session_messages_chunk events.  We buffer them here and assemble the full
// lastState after the final chunk so reconnecting viewers get complete data.

interface ChunkedSessionState {
    snapshotId: string;
    metadata: Record<string, unknown>; // everything except messages
    chunks: unknown[][]; // ordered message slices
    totalChunks: number;
    receivedChunks: number;
}

const pendingChunkedStates = new Map<string, ChunkedSessionState>();

// ── Per-session event serialization ──────────────────────────────────────────
// The async event handler must process events in arrival order per session.
// Without serialization, concurrent async handlers (e.g. chunk 0 hitting a
// Redis round-trip while chunk 1 skips it) can publish chunks out of order,
// scrambling the viewer's message assembly.
const sessionEventQueues = new Map<string, Promise<void>>();

function enqueueSessionEvent(sessionId: string, fn: () => Promise<void>): void {
    const prev = sessionEventQueues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn); // always chain, even on prior rejection
    sessionEventQueues.set(sessionId, next);
    // Clean up the map entry when the chain settles to avoid unbounded growth
    next.then(() => {
        if (sessionEventQueues.get(sessionId) === next) {
            sessionEventQueues.delete(sessionId);
        }
    });
}

/**
 * Get the partially assembled snapshot for a session that's mid-chunked-delivery.
 * Returns metadata + chunks received so far, or null if no chunked delivery is active.
 */
export function getPendingChunkedSnapshot(sessionId: string): { metadata: Record<string, unknown>; messages: unknown[]; snapshotId: string; totalMessages: number; receivedChunks: number; totalChunks: number } | null {
    const pending = pendingChunkedStates.get(sessionId);
    if (!pending) return null;
    const messages = pending.chunks.flat();
    return {
        metadata: pending.metadata,
        messages,
        snapshotId: pending.snapshotId,
        totalMessages: (pending.metadata as any).totalMessages ?? messages.length,
        receivedChunks: pending.receivedChunks,
        totalChunks: pending.totalChunks,
    };
}

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
        try {
            socket.emit("event_ack", { sessionId, seq: next });
        } catch (err) {
            // Redis adapter can throw EPIPE when the Redis connection is temporarily
            // closed. Log and swallow — the ack is best-effort and the TUI will
            // resend any un-acked events on reconnect.
            console.warn("[sio/relay] sendCumulativeEventAck emit failed (Redis EPIPE?):", (err as Error)?.message);
        }
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

/**
 * Manage the push-pending Redis key for AskUserQuestion lifecycle.
 * Awaited only for AskUserQuestion start/end events to avoid
 * blocking the hot relay path for high-frequency events.
 */
async function trackPushPendingState(
    sessionId: string,
    event: Record<string, unknown>,
): Promise<void> {
    if (event.type === "tool_execution_start" && event.toolName === "AskUserQuestion") {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        if (toolCallId) {
            await setPushPendingQuestion(sessionId, toolCallId);
        }
    }
    if (event.type === "tool_execution_end" && event.toolName === "AskUserQuestion") {
        // Pass toolCallId so only the matching key is cleared — prevents a
        // cancelled/overlapping AskUserQuestion from clearing the active one.
        const endToolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        await clearPushPendingQuestion(sessionId, endToolCallId);
    }
}

async function checkPushNotifications(
    sessionId: string,
    event: Record<string, unknown>,
): Promise<void> {
    // ⚡ Bolt: Fast synchronous check to bypass expensive Redis operations (getSharedSession/getViewerCount)
    // for high-frequency stream events (like text deltas) that don't trigger push notifications.
    if (
        event.type !== "agent_end" &&
        event.type !== "cli_error" &&
        !(event.type === "tool_execution_start" && event.toolName === "AskUserQuestion")
    ) {
        return;
    }

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
        // Extract first question text and options: try questions[] format, fall back to legacy.
        // Only include quick-reply options for single-question prompts — multi-question
        // prompts require the full UI since a push reply can only carry one answer.
        let question: string | undefined;
        let options: string[] | undefined;
        let questionCount = 0;
        if (Array.isArray(args?.questions)) {
            for (const q of args!.questions as unknown[]) {
                if (q && typeof q === "object" && typeof (q as any).question === "string" && (q as any).question.trim()) {
                    questionCount++;
                    if (!question) {
                        question = ((q as any).question as string).trim();
                        if (Array.isArray((q as any).options)) {
                            options = ((q as any).options as unknown[]).filter((o): o is string => typeof o === "string" && o.trim().length > 0);
                        }
                    }
                }
            }
        }
        if (!question && typeof args?.question === "string" && args.question.trim()) {
            question = (args.question as string).trim();
            questionCount = 1;
            if (Array.isArray(args?.options)) {
                options = (args.options as unknown[]).filter((o): o is string => typeof o === "string" && o.trim().length > 0);
            }
        }
        // Quick-reply actions require: single question + collab mode + toolCallId.
        // Multi-question prompts need the full UI; non-collab sessions reject
        // push answers with 403; missing toolCallId means /api/push/answer will
        // reject with 400 — so don't show action buttons in any of those cases.
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
        const canQuickReply = questionCount <= 1 && session?.collabMode === true && !!toolCallId;
        notifyAgentNeedsInput(userId, sessionId, question, sName, canQuickReply ? options : undefined, toolCallId);
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

            const { sessionId, token, shareUrl, parentSessionId } = await registerTuiSession(socket, cwd, {
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
            });
        });

        // ── event — main event pipeline ──────────────────────────────────────
        socket.on("event", (data) => {
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

            // Serialize async processing per session to guarantee chunk order.
            enqueueSessionEvent(sessionId, async () => {

            // Cache session_active state so new viewers get an immediate snapshot
            if (event.type === "session_active") {
                const state = event.state as Record<string, unknown> | undefined;
                if (state?.chunked) {
                    // Chunked session: store metadata and start accumulating chunks.
                    // Don't persist incomplete state to lastState — viewers would
                    // get an empty messages array on reconnect.
                    const snapshotId = typeof state.snapshotId === "string" ? state.snapshotId : "";
                    const { messages: _msgs, chunked: _c, snapshotId: _sid, totalMessages: _tm, ...metadata } = state;
                    pendingChunkedStates.set(sessionId, {
                        snapshotId,
                        metadata,
                        chunks: [],
                        totalChunks: 0,
                        receivedChunks: 0,
                    });
                    // Touch activity but DON'T update lastState yet
                    await touchSessionActivity(sessionId);
                } else {
                    // Non-chunked: persist immediately (original path)
                    pendingChunkedStates.delete(sessionId);
                    await updateSessionState(sessionId, event.state);
                }
            } else if (event.type === "session_messages_chunk") {
                // Accumulate chunk into the pending state.  When the final
                // chunk arrives, assemble the full state and persist to lastState.
                const pending = pendingChunkedStates.get(sessionId);
                const chunkSnapshotId = typeof event.snapshotId === "string" ? event.snapshotId : "";
                const chunkIndex = typeof event.chunkIndex === "number" ? event.chunkIndex : -1;
                const chunkMessages = Array.isArray(event.messages) ? event.messages as unknown[] : [];
                const isFinal = !!event.final;
                const totalChunks = typeof event.totalChunks === "number" ? event.totalChunks : 0;

                if (pending && pending.snapshotId === chunkSnapshotId && chunkIndex >= 0) {
                    pending.chunks[chunkIndex] = chunkMessages;
                    pending.receivedChunks++;
                    pending.totalChunks = totalChunks;

                    if (isFinal && pending.receivedChunks >= pending.totalChunks) {
                        // All chunks received — assemble and persist the full state
                        const allMessages = pending.chunks.flat();
                        const fullState = { ...pending.metadata, messages: allMessages };
                        pendingChunkedStates.delete(sessionId);
                        await updateSessionState(sessionId, fullState);

                        // Publish a full session_active to the Redis replay cache
                        // so that findLatestSnapshotEvent() finds the assembled
                        // state instead of the metadata-only SA from chunk start.
                        await publishSessionEvent(sessionId, {
                            type: "session_active",
                            state: fullState,
                        });
                    } else {
                        await touchSessionActivity(sessionId);
                    }
                } else {
                    // Stale or unmatched chunk — just touch activity
                    await touchSessionActivity(sessionId);
                }
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

            // Track push-pending state for AskUserQuestion (awaited to ensure
            // set/clear ordering; only runs for AskUserQuestion start/end events).
            if (event.toolName === "AskUserQuestion" &&
                (event.type === "tool_execution_start" || event.type === "tool_execution_end")) {
                await trackPushPendingState(sessionId, event);
            }
            // Push notifications (fire-and-forget — not on hot path)
            void checkPushNotifications(sessionId, event);

            }); // end enqueueSessionEvent
        });

        // ── session_end ──────────────────────────────────────────────────────
        socket.on("session_end", async (data) => {
            const sessionId = socket.data.sessionId;
            if (!sessionId || data.token !== socket.data.token) {
                socket.emit("error", { message: "Invalid token" });
                return;
            }

            clearThinkingMaps(sessionId);
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

            const senderSession = await getSharedSession(sessionId);
            const targetSession = await getSharedSession(targetSessionId);
            if (!targetSession) {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: "Target session not found or not connected",
                });
                return;
            }

            // Enforce same-user ownership to prevent cross-user message injection,
            // especially for deliverAs:"input" which starts new agent turns.
            if (!senderSession?.userId || !targetSession?.userId || senderSession.userId !== targetSession.userId) {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: "Target session belongs to a different user",
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
                if (data.deliverAs === "input") {
                    // Deliver as agent input — starts a new turn (used by tell_child).
                    // Mirrors the viewer namespace "input" handler behavior.
                    targetSocket.emit("input" as string, {
                        text: messageText,
                        attachments: [],
                        client: "agent",
                        deliverAs: "followUp",
                    });
                } else {
                    // Deliver to message bus (used by send_message / wait_for_message).
                    targetSocket.emit("session_message" as string, {
                        fromSessionId: sessionId,
                        message: messageText,
                        ts: new Date().toISOString(),
                    });
                }
            } catch {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: "Failed to deliver message to target session",
                });
            }
        });

        // ── session_trigger — child-to-parent trigger routing ────────────────
        socket.on("session_trigger", async (data) => {
            const sessionId = socket.data.sessionId;
            if (!sessionId || data?.token !== socket.data.token) {
                socket.emit("error", { message: "Invalid token" });
                return;
            }

            const trigger = data?.trigger;
            if (!trigger?.targetSessionId || !trigger?.triggerId) {
                socket.emit("error", { message: "session_trigger requires trigger with targetSessionId and triggerId" });
                return;
            }

            const targetSessionId = trigger.targetSessionId;

            // Find the target session's relay socket and validate ownership
            const targetSession = await getSharedSession(targetSessionId);
            if (!targetSession) {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: `Target session ${targetSessionId} is not connected`,
                });
                return;
            }

            // Validate that the target session belongs to the same user
            const senderSession = await getSharedSession(sessionId);
            if (!senderSession?.userId || senderSession.userId !== targetSession.userId) {
                socket.emit("error", { message: "Target session belongs to a different user" });
                return;
            }

            const targetSocket = getLocalTuiSocket(targetSessionId);
            if (!targetSocket) {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: `Target session ${targetSessionId} is not connected`,
                });
                return;
            }

            try {
                // For escalations targeting the sender's own session, preserve the
                // original child sourceSessionId so the viewer can attribute the
                // escalation to the correct child. For all other triggers, enforce
                // server-side identity to prevent spoofing.
                if (trigger.type === "escalate" && targetSessionId === sessionId) {
                    // Escalation to self — keep original sourceSessionId for viewer attribution
                } else {
                    trigger.sourceSessionId = sessionId;
                }
                targetSocket.emit("session_trigger" as any, { trigger });
            } catch {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: "Failed to deliver trigger to target session",
                });
            }
        });

        // ── trigger_response — parent-to-child response routing ────────────
        socket.on("trigger_response" as any, async (data: {
            token: string;
            triggerId: string;
            response: string;
            action?: string;
            targetSessionId: string;
        }) => {
            const { triggerId, response, action, targetSessionId } = data ?? {};
            if (!triggerId || !response || !targetSessionId) {
                socket.emit("error", { message: "trigger_response requires triggerId, response, and targetSessionId" });
                return;
            }

            // Validate sender is authenticated and token matches
            if (!socket.data.sessionId || data?.token !== socket.data.token) {
                socket.emit("error", { message: "Invalid token" });
                return;
            }

            // Validate that the target session belongs to the same user
            const senderSession = await getSharedSession(socket.data.sessionId);
            const targetSession = await getSharedSession(targetSessionId);
            if (!senderSession?.userId || !targetSession?.userId || senderSession.userId !== targetSession.userId) {
                socket.emit("error", { message: "Target session belongs to a different user" });
                return;
            }

            // Enforce parent→child direction: trigger_response should only flow
            // from a parent to its child. The reverse direction (child→parent) is
            // not needed — children emit session_trigger to parents, and parents
            // respond with trigger_response to children. Allowing child→parent
            // would let a sibling session inject responses into another child's
            // pending trigger through the parent's forwarding handler.
            const isParentOfTarget = targetSession.parentSessionId === socket.data.sessionId;
            if (!isParentOfTarget) {
                socket.emit("error", { message: "Sender is not the parent of the target session" });
                return;
            }

            const triggerPayload = { triggerId, response, ...(action ? { action } : {}) };
            // Try local socket first, fall back to relay room for cross-node delivery
            const targetSocket = getLocalTuiSocket(targetSessionId);
            if (targetSocket) {
                try {
                    targetSocket.emit("trigger_response" as any, triggerPayload);
                } catch {
                    socket.emit("session_message_error", {
                        targetSessionId,
                        error: "Failed to deliver trigger response to target session",
                    });
                }
            } else if (!emitToRelaySession(targetSessionId, "trigger_response", triggerPayload)) {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: `Target session ${targetSessionId} is not connected`,
                });
            }
        });

        // ── disconnect ───────────────────────────────────────────────────────
        socket.on("disconnect", async (reason) => {
            console.log(`[sio/relay] disconnected: ${socket.id} (${reason})`);
            const sessionId = socket.data.sessionId;
            if (sessionId) {
                // If a newer socket already re-registered this session (reconnect),
                // don't tear down the new session.  registerTuiSession clears our
                // sessionId as a primary guard, but this check is defense-in-depth
                // for any remaining race windows.
                const currentSocket = getLocalTuiSocket(sessionId);
                if (currentSocket && currentSocket !== socket) {
                    console.log(`[sio/relay] disconnect for ${socket.id} — session ${sessionId} already owned by ${currentSocket.id}, skipping teardown`);
                    socketAckedSeqs.delete(socket.id);
                    return;
                }

                clearThinkingMaps(sessionId);
                pendingChunkedStates.delete(sessionId);
                void clearPushPendingQuestion(sessionId);
                // Clean up child-index entry so stale memberships don't persist
                const session = await getSharedSession(sessionId);
                if (session?.parentSessionId) {
                    void removeChildSession(session.parentSessionId, sessionId);
                }
                await endSharedSession(sessionId);
            }
            socketAckedSeqs.delete(socket.id);
        });
    });
}
