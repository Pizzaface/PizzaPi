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
    getLocalRunnerSocket,
    emitToRelaySession,
    emitToRelaySessionVerified,
    emitToRelaySessionAwaitingAck,
    emitToRunner,
    updateSessionState,
    updateSessionHeartbeat,
    touchSessionActivity,
    publishSessionEvent,
    broadcastSessionEventToViewers,
    endSharedSession,
    getViewerCount,
    broadcastToViewers,
} from "../sio-registry.js";
import { appendRelayEventToCache } from "../../sessions/redis.js";
import { storeAndReplaceImagesInEvent } from "../strip-images.js";
import {
    setPushPendingQuestion,
    clearPushPendingQuestion,
    deleteRunnerAssociation,
    removeChildSession,
    removeChildren,
    addPendingParentDelinkChildren,
    getChildSessions,
    getPendingParentDelinkChildren,
    removePendingParentDelinkChild,
    isPendingParentDelinkChild,
    getSession,
    markChildAsDelinked,
    isChildDelinked,
    isChildOfParent,
    refreshChildSessionsTTL,
    clearParentSessionId,
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
    // Clean up the map entry when the chain settles to avoid unbounded growth.
    // Use .finally() so cleanup runs even if fn rejects (otherwise the map
    // entry leaks indefinitely on error, causing unbounded memory growth).
    next.finally(() => {
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
                // Only include wasDelinked when it is true to keep the payload
                // minimal for non-child or non-delinked sessions.
                ...(wasDelinked ? { wasDelinked: true } : {}),
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

                        // Append a full session_active to the Redis replay cache
                        // so that findLatestSnapshotEvent() finds the assembled
                        // state instead of the metadata-only SA from chunk start.
                        // We do NOT use publishSessionEvent() here because that
                        // would broadcast the full assembled state as a single
                        // oversized frame to all viewers — the same transport
                        // issue chunking was designed to avoid.  Viewers already
                        // have the complete data from the chunk stream.
                        // Strip inline images before caching to keep the cache
                        // entry small and consistent with publishSessionEvent's
                        // image-stripping pipeline.
                        const session = await getSharedSession(sessionId);
                        const userId = session?.userId ?? "unknown";
                        const snapshotEvent = { type: "session_active" as const, state: fullState };
                        let eventToCache: unknown = snapshotEvent;
                        try {
                            eventToCache = await storeAndReplaceImagesInEvent(
                                snapshotEvent, sessionId, userId,
                            );
                        } catch {
                            // Fall back to original if image stripping fails
                        }
                        await appendRelayEventToCache(sessionId, eventToCache, {
                            isEphemeral: session?.isEphemeral,
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

            // For session_messages_chunk and chunked session_active, broadcast
            // to viewers WITHOUT caching.  Chunks are transient and only needed
            // during active hydration; the final assembled snapshot is cached
            // separately when assembly completes.  The metadata-only chunked
            // session_active must also skip the cache — if the stream is
            // interrupted before the final chunk, the replay path would find
            // this empty-messages snapshot and show a blank transcript instead
            // of the last durable state.
            const isChunkedSessionActive =
                event.type === "session_active" &&
                !!(event.state as Record<string, unknown> | undefined)?.chunked;
            if (event.type === "session_messages_chunk" || isChunkedSessionActive) {
                await broadcastSessionEventToViewers(sessionId, eventToPublish);
            } else {
                // Publish to viewers via Redis cache + Socket.IO rooms
                await publishSessionEvent(sessionId, eventToPublish);
            }

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

            // Block messages from delinked children. If the sender's session
            // still carries a parentSessionId pointing at the target (i.e. it
            // was a linked child), but the target has already delinked it via
            // /new, reject the message so stale children can't inject traffic
            // into the parent's new conversation.
            if (senderSession.parentSessionId === targetSessionId) {
                const stillLinked = await isChildOfParent(targetSessionId, sessionId);
                if (!stillLinked) {
                    socket.emit("session_message_error", {
                        targetSessionId,
                        error: "Sender is no longer a child of the target session",
                    });
                    return;
                }
            }

            // Block stale parent→child traffic. deliverAs:"input" always
            // requires a live parent→child link (used by tell_child and
            // session_complete follow-up). Plain session_message (used by
            // send_message) is also blocked when the target's parentSessionId
            // still names the sender — the parent may have run /new and
            // delinked this child, so the old parent's plain messages must not
            // reach the child's brand-new conversation either.
            const isParentToChildTraffic = data.deliverAs === "input" || targetSession.parentSessionId === sessionId;
            if (isParentToChildTraffic) {
                const targetIsChild = await isChildOfParent(sessionId, targetSessionId);
                if (!targetIsChild) {
                    socket.emit("session_message_error", {
                        targetSessionId,
                        error: "Target session is not a child of the sender",
                    });
                    return;
                }
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

            if (targetSessionId !== sessionId && await isPendingParentDelinkChild(targetSessionId, sessionId)) {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: "Sender is currently being delinked from the target session",
                });
                return;
            }

            // Reject triggers from sessions that are no longer children of the target.
            // This closes a race window after delink_children: a connected child that
            // emits session_trigger before it processes parent_delinked could otherwise
            // inject a stale trigger into the parent's new conversation.
            // Self-triggers (escalations) are explicitly excluded.
            if (targetSessionId !== sessionId) {
                const senderIsChild = await isChildOfParent(targetSessionId, sessionId);
                if (!senderIsChild) {
                    socket.emit("session_message_error", {
                        targetSessionId,
                        error: "Sender is no longer a child of the target session",
                    });
                    return;
                }
                await refreshChildSessionsTTL(targetSessionId);
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
        }, ack: ((result: { ok: boolean; error?: string }) => void) | undefined) => {
            const { triggerId, response, action, targetSessionId } = data ?? {};
            if (!triggerId || !response || !targetSessionId) {
                socket.emit("error", { message: "trigger_response requires triggerId, response, and targetSessionId" });
                if (typeof ack === "function") ack({ ok: false, error: "Missing required fields" });
                return;
            }

            // Validate sender is authenticated and token matches
            if (!socket.data.sessionId || data?.token !== socket.data.token) {
                socket.emit("error", { message: "Invalid token" });
                if (typeof ack === "function") ack({ ok: false, error: "Invalid token" });
                return;
            }

            // Validate that the target session belongs to the same user
            const senderSession = await getSharedSession(socket.data.sessionId);
            const targetSession = await getSharedSession(targetSessionId);
            if (!senderSession?.userId || !targetSession?.userId || senderSession.userId !== targetSession.userId) {
                socket.emit("error", { message: "Target session belongs to a different user" });
                if (typeof ack === "function") ack({ ok: false, error: "Target session belongs to a different user" });
                return;
            }

            // Enforce parent→child direction: trigger_response should only flow
            // from a parent to its child. The reverse direction (child→parent) is
            // not needed — children emit session_trigger to parents, and parents
            // respond with trigger_response to children. Allowing child→parent
            // would let a sibling session inject responses into another child's
            // pending trigger through the parent's forwarding handler.
            //
            // Fall back to the children membership set when the child's session
            // hash has parentSessionId=null because the parent was transiently
            // offline during the child's last reconnect (Fix #3: the set membership
            // is preserved by addChildSessionMembership in that path).
            const isParentOfTarget = targetSession.parentSessionId === socket.data.sessionId
                || await isChildOfParent(socket.data.sessionId, targetSessionId);
            if (!isParentOfTarget) {
                socket.emit("error", { message: "Sender is not the parent of the target session" });
                if (typeof ack === "function") ack({ ok: false, error: "Sender is not the parent of the target session" });
                return;
            }

            const triggerPayload = { triggerId, response, ...(action ? { action } : {}) };
            // Try local socket first, then verified room delivery for cross-node
            // routing. We only ack success when at least one relay recipient is
            // actually present.
            const targetSocket = getLocalTuiSocket(targetSessionId);
            if (targetSocket?.connected) {
                try {
                    targetSocket.emit("trigger_response" as any, triggerPayload);
                    if (typeof ack === "function") ack({ ok: true });
                } catch {
                    socket.emit("session_message_error", {
                        targetSessionId,
                        error: "Failed to deliver trigger response to target session",
                    });
                    if (typeof ack === "function") ack({ ok: false, error: "Failed to deliver trigger response to target session" });
                }
            } else if (!await emitToRelaySessionVerified(targetSessionId, "trigger_response", triggerPayload)) {
                socket.emit("session_message_error", {
                    targetSessionId,
                    error: `Target session ${targetSessionId} is not connected`,
                });
                if (typeof ack === "function") ack({ ok: false, error: `Target session ${targetSessionId} is not connected` });
            } else {
                if (typeof ack === "function") ack({ ok: true });
            }
        });

        // ── cleanup_child_session — parent requests child teardown on ack ────
        socket.on("cleanup_child_session", async (data, ack) => {
            const sessionId = socket.data.sessionId;
            if (!sessionId || data?.token !== socket.data.token) {
                socket.emit("error", { message: "Invalid token" });
                if (typeof ack === "function") ack({ ok: false, error: "Invalid token" });
                return;
            }

            const childSessionId = data?.childSessionId;
            if (!childSessionId) {
                socket.emit("error", { message: "cleanup_child_session requires childSessionId" });
                if (typeof ack === "function") ack({ ok: false, error: "cleanup_child_session requires childSessionId" });
                return;
            }

            // Validate the sender is the parent of the target child session
            const childSession = await getSharedSession(childSessionId);
            if (!childSession) {
                // Child already gone — nothing to clean up (idempotent)
                if (typeof ack === "function") ack({ ok: true });
                return;
            }

            // Same fallback as trigger_response: when the child's parentSessionId
            // was cleared during a transient-offline reconnect, check set membership.
            const isParentOfChild = childSession.parentSessionId === sessionId
                || await isChildOfParent(sessionId, childSessionId);
            if (!isParentOfChild) {
                socket.emit("error", { message: "Sender is not the parent of the target session" });
                if (typeof ack === "function") ack({ ok: false, error: "Sender is not the parent of the target session" });
                return;
            }

            // Validate same user ownership
            const parentSession = await getSharedSession(sessionId);
            if (!parentSession?.userId || parentSession.userId !== childSession.userId) {
                socket.emit("error", { message: "Target session belongs to a different user" });
                if (typeof ack === "function") ack({ ok: false, error: "Target session belongs to a different user" });
                return;
            }

            console.log(`[sio/relay] cleanup_child_session: parent=${sessionId} child=${childSessionId}`);

            try {
                // Terminate the child process via two complementary paths:
                //
                // 1. kill_session → runner (cluster-wide via emitToRunner):
                //    sends SIGTERM to the OS process.  Reaches runners on any
                //    cluster node through the Redis adapter.
                if (childSession.runnerId) {
                    emitToRunner(childSession.runnerId, "kill_session", { sessionId: childSessionId });
                }

                // 2. exec end_session → child relay socket (cluster-wide via Redis
                //    adapter room broadcast).  Reaches the child on any node and
                //    causes it to clear its follow-up grace timer and shut down
                //    cleanly.  If the runner already sent SIGTERM in step 1 the
                //    exec arrives to an already-exiting worker (benign no-op).
                emitToRelaySession(childSessionId, "exec", {
                    id: `cleanup-${childSessionId}-${Date.now()}`,
                    command: "end_session",
                });

                // ⚡ Bolt: Fast socket presence check via adapter.sockets() avoids expensive cluster-wide network overhead of fetchSockets()
                const relaySockets = await io.of("/relay").adapter.sockets(new Set([`session:${childSessionId}`]));
                const hasRelayRecipient = relaySockets instanceof Set ? relaySockets.size > 0 : (relaySockets as any[]).length > 0;

                // Clean up child-index entry
                void removeChildSession(sessionId, childSessionId);

                if (!hasRelayRecipient) {
                    // No relay socket is currently joined for this child anywhere in
                    // the cluster, so there is no disconnect handler left to finish
                    // cleanup. Complete teardown now so acknowledged children don't
                    // linger in Redis/sidebar until the orphan sweeper runs.
                    await endSharedSession(childSessionId, "Parent acknowledged completion");
                    if (typeof ack === "function") ack({ ok: true });
                    return;
                }

                // Do NOT call endSharedSession here when a relay recipient exists.
                // The child will disconnect momentarily (from the SIGTERM or exec
                // above), and its disconnect handler on whichever node hosts the
                // child's relay socket will call endSharedSession there — where the
                // correct local runner socket is available for adopted-session
                // cleanup. Calling it here first would delete the Redis record
                // before that node can process the disconnect, turning its
                // endSharedSession into a no-op and leaving adopted-session entries
                // stranded in runningSessions on the remote runner.

                if (typeof ack === "function") ack({ ok: true });
            } catch (err: any) {
                console.error(`[sio/relay] cleanup_child_session failed: parent=${sessionId} child=${childSessionId}`, err);
                if (typeof ack === "function") ack({ ok: false, error: err?.message ?? "Internal error" });
            }
        });

        // ── delink_children — parent severs all child links (e.g. on /new) ─
        socket.on("delink_children", async (data, ack?: (result: { ok: boolean; error?: string }) => void) => {
            const sessionId = socket.data.sessionId;
            if (!sessionId || data?.token !== socket.data.token) {
                socket.emit("error", { message: "Invalid token" });
                if (typeof ack === "function") ack({ ok: false, error: "Invalid token" });
                return;
            }

            // Optional epoch (ms): when provided, only delink children whose
            // startedAt is before this timestamp.  Used by deferred delinks
            // (sent on reconnect after /new while disconnected) to avoid
            // inadvertently delinking children spawned during the disconnect
            // window.
            const epoch: number | undefined =
                typeof data.epoch === "number" && data.epoch > 0 ? data.epoch : undefined;

            console.log(`[sio/relay] delink_children: parent=${sessionId}${epoch ? ` epoch=${new Date(epoch).toISOString()}` : ""}`);

            try {
                // Snapshot current children plus any children whose
                // parent_delinked delivery previously timed out. The pending
                // retry set preserves recipients across delink_children retries
                // even after we have already removed them from the membership set.
                const [currentChildIds, pendingRetryChildIds] = await Promise.all([
                    getChildSessions(sessionId),
                    getPendingParentDelinkChildren(sessionId),
                ]);
                let childIds = Array.from(new Set([...currentChildIds, ...pendingRetryChildIds]));

                // If an epoch was provided, filter out children that registered
                // after the epoch — they belong to the new conversation and must
                // not be delinked. However, children with existing delink markers
                // are stale and should be included even if their startedAt > epoch
                // (this handles the case where a stale child reconnected and got a
                // fresh startedAt timestamp).
                if (epoch && childIds.length > 0) {
                    const filtered: string[] = [];
                    for (const childId of childIds) {
                        const childSession = await getSession(childId);
                        if (!childSession?.startedAt) {
                            // No session data — conservative: include it
                            filtered.push(childId);
                            continue;
                        }
                        const startedAtMs = new Date(childSession.startedAt).getTime();
                        if (startedAtMs <= epoch) {
                            filtered.push(childId);
                        } else {
                            // Child started after epoch, but check if it already has a delink marker.
                            // If it does, it's a stale child that reconnected and should be delinked
                            // regardless of its fresh startedAt timestamp.
                            const hasDelinkMarker = await isChildDelinked(childId);
                            if (hasDelinkMarker) {
                                filtered.push(childId);
                                console.log(`[sio/relay] delink_children: including child ${childId} (startedAt > epoch but has delink marker)`);
                            } else {
                                console.log(`[sio/relay] delink_children: skipping child ${childId} (startedAt=${childSession.startedAt} > epoch)`);
                            }
                        }
                    }
                    childIds = filtered;
                }

                // Write delink markers BEFORE clearing the membership set. This
                // closes a race window: if a child reconnects between the snapshot
                // and the clear, registerTuiSession's isChildDelinked() check will
                // already find the marker and refuse to re-link. If we cleared
                // first and wrote markers second, a reconnecting child could slip
                // through before its marker exists.
                for (const childId of childIds) {
                    // Store the parent session ID in the marker so that
                    // addChildSession can scrub the child from this parent's
                    // pending-delink retry set when the child is re-linked elsewhere.
                    await markChildAsDelinked(childId, sessionId);
                }
                await addPendingParentDelinkChildren(sessionId, childIds);

                // Remove only the snapshotted children from the membership set.
                // Using removeChildren() instead of clearAllChildren() avoids a
                // race: if the parent spawns a new child between the snapshot and
                // this removal, the new child's membership is preserved.
                await removeChildren(sessionId, childIds);

                // Notify each connected child that their parent is gone.
                // This lets children cancel any pending triggers awaiting a response.
                //
                // NOTE: We intentionally do NOT clear parentSessionId in Redis here.
                // Doing so races with any in-flight trigger_response(cancel) messages
                // that clearAndCancelPendingTriggers() emitted just before this event.
                // The trigger_response handler checks targetSession.parentSessionId; if
                // we clear it concurrently, the check fails with "Sender is not the
                // parent" and the child is left blocked until its 5-minute timeout.
                //
                // Instead, parentSessionId is cleaned up lazily: registerTuiSession
                // checks isChildDelinked() on reconnect and clears the stale field
                // then (see sio-registry.ts).  For connected children, the parent_delinked
                // event causes rctx.parentSessionId = null so reconnects won't re-link.
                // For offline children (who never received parent_delinked), the marker
                // we just wrote above prevents re-link.
                for (const childId of childIds) {
                    const payload = { parentSessionId: sessionId };
                    const delivery = await emitToRelaySessionAwaitingAck(childId, "parent_delinked", payload);
                    if (delivery.hadListeners && !delivery.acked) {
                        throw new Error(`parent_delinked delivery was not confirmed for child ${childId}`);
                    }
                    // Offline children are safe to clear from the retry set too:
                    // their delink marker will prevent re-linking on reconnect.
                    await removePendingParentDelinkChild(sessionId, childId);
                }

                // Acknowledge that the delink completed only after every
                // connected child has confirmed parent_delinked delivery. The
                // client uses this to clear its pendingDelink retry guard —
                // until the ack arrives, it keeps blocking stale child
                // session_message / session_trigger traffic from reaching the
                // new conversation.
                if (typeof ack === "function") ack({ ok: true });
            } catch (err) {
                console.error(`[sio/relay] delink_children failed for parent=${sessionId}:`, err);
                // Always nack so the client can clear its pendingDelink guard
                // and retry on reconnect rather than latching permanently.
                if (typeof ack === "function") ack({ ok: false, error: String(err) });
            }
        });

        // ── delink_own_parent — child severs its own parent link (e.g. on /new) ─
        // When a child session starts /new, it clears its local parent link
        // but the server still has the association. This event lets the child
        // tell the server to remove itself from the old parent's children set
        // and clear the parentSessionId on its own Redis session hash.
        socket.on("delink_own_parent", async (data, ack: ((result: { ok: boolean; error?: string }) => void) | undefined) => {
            const sessionId = socket.data.sessionId;
            if (!sessionId || data?.token !== socket.data.token) {
                socket.emit("error", { message: "Invalid token" });
                if (typeof ack === "function") ack({ ok: false, error: "Invalid token" });
                return;
            }

            const session = await getSharedSession(sessionId);
            const parentId = session?.parentSessionId;
            if (!parentId) {
                // parentSessionId is already cleared in Redis (e.g. the child
                // ran /new while the relay socket was down, so
                // registerTuiSession wrote null before this event arrived).
                // If the client supplied the old parent ID it captured before
                // clearing rctx.parentSessionId, use it to scrub the stale
                // children-set entry that the disconnect path deliberately
                // left behind to avoid a /new race window.
                const oldParentId = typeof data?.oldParentId === "string" ? data.oldParentId : null;
                if (oldParentId) {
                    console.log(
                        `[sio/relay] delink_own_parent: child=${sessionId} parentSessionId already cleared — removing stale child entry from parent=${oldParentId}`,
                    );
                    try {
                        await removeChildSession(oldParentId, sessionId);
                    } catch (err) {
                        console.error("[sio/relay] delink_own_parent: failed to remove stale child entry:", err);
                        if (typeof ack === "function") ack({ ok: false, error: err instanceof Error ? err.message : String(err) });
                        return;
                    }
                }
                // Already delinked or never linked — confirm success so the
                // client stops retrying.
                if (typeof ack === "function") ack({ ok: true });
                return;
            }

            console.log(`[sio/relay] delink_own_parent: child=${sessionId} parent=${parentId}`);

            // Clear our own parentSessionId FIRST — this closes the race
            // window where a stale ack/followUp/cleanup_child_session from
            // the old parent could still see parentSessionId === oldParent
            // and authorize operations against this now-independent session.
            // Then remove ourselves from the parent's children set.
            // Both writes are atomic enough for our purposes; if either
            // throws, ack failure so the client retries on next reconnect.
            try {
                await clearParentSessionId(sessionId);
                await removeChildSession(parentId, sessionId);
            } catch (err) {
                console.error("[sio/relay] delink_own_parent: Redis write failed:", err);
                if (typeof ack === "function") ack({ ok: false, error: err instanceof Error ? err.message : String(err) });
                return;
            }

            // Acknowledge success so the client can clear its retry flag.
            if (typeof ack === "function") ack({ ok: true });
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
    });
}
