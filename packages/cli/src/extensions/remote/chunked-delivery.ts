/**
 * Chunked session delivery.
 *
 * The server's maxHttpBufferSize is 10 MB. If the serialized session_active
 * event exceeds that, Socket.IO silently kills the WebSocket connection
 * (reason: "transport close") and the client auto-reconnects — causing an
 * infinite boot loop.
 *
 * For large sessions we split the payload: session_active carries metadata
 * only (model, name, cwd, todoList, etc.) with `chunked: true`, then the
 * full message history follows as a series of `session_messages_chunk` events
 * sent through the normal event pipeline. The UI assembles them on arrival.
 *
 * Small sessions (< CHUNK_THRESHOLD) use the original single-event path.
 */

import { randomUUID } from "node:crypto";
import { buildSessionContext } from "@mariozechner/pi-coding-agent";
import { getCurrentTodoList } from "../update-todo.js";
import type { RelayContext } from "../remote-types.js";

/** Estimated payload size (bytes) above which we chunk messages. */
const CHUNK_THRESHOLD = 5 * 1024 * 1024; // 5 MB — safely below 10 MB server limit

/** Maximum messages per chunk — keeps individual Socket.IO frames reasonable. */
const CHUNK_SIZE = 200;

/**
 * Maximum estimated byte size per chunk.  Even if a chunk has fewer than
 * CHUNK_SIZE messages, it will be split if the cumulative byte size exceeds
 * this limit.  This prevents a handful of huge messages (e.g. large tool
 * outputs or inline images) from producing a single oversized frame that
 * exceeds the server's maxHttpBufferSize (10 MB).
 */
const CHUNK_BYTE_LIMIT = 6 * 1024 * 1024; // 6 MB per chunk — leaves margin for Socket.IO framing overhead below 10 MB server limit

/**
 * Hard cap for a single message's serialized size.  Messages exceeding this
 * are truncated before chunking so that no individual chunk frame can exceed
 * the server's maxHttpBufferSize (10 MB).  We set this well below the
 * transport cap to leave room for event wrapper overhead.
 */
const MAX_MESSAGE_SIZE = 5 * 1024 * 1024; // 5 MB

/**
 * Estimate the serialized wire size (in bytes) of a messages array.
 * We stringify each message individually rather than the whole array
 * to avoid allocating a single large string.  Uses Buffer.byteLength
 * for accurate UTF-8 byte counts (JSON.stringify().length counts UTF-16
 * code units, which underestimates multibyte content like emoji/CJK by 2-4x).
 */
export function estimateMessagesSize(messages: unknown[]): number {
    if (messages.length === 0) return 2; // "[]"
    let totalBytes = 0;
    for (const msg of messages) {
        try {
            totalBytes += Buffer.byteLength(JSON.stringify(msg), "utf8");
        } catch {
            totalBytes += 1024; // fallback for unserializable entries
        }
    }
    // Add ~10% overhead for array commas, brackets, and event wrapper fields
    return Math.ceil(totalBytes * 1.10);
}

/**
 * Check whether a messages array needs chunked delivery.
 */
export function needsChunkedDelivery(messages: unknown[]): boolean {
    if (messages.length === 0) return false;
    return estimateMessagesSize(messages) > CHUNK_THRESHOLD;
}

/**
 * Cap any individual message whose serialized size exceeds MAX_MESSAGE_SIZE.
 * Returns a new array (only copies if truncation was needed).  Truncated
 * messages have their `content` replaced with a notice so the viewer knows
 * data was elided.
 */
export function capOversizedMessages(messages: unknown[]): unknown[] {
    let copied = false;
    let result = messages;

    for (let i = 0; i < messages.length; i++) {
        const size = Buffer.byteLength(JSON.stringify(messages[i]), "utf8");
        if (size > MAX_MESSAGE_SIZE) {
            if (!copied) {
                result = [...messages];
                copied = true;
            }
            const msg = messages[i] as Record<string, unknown>;
            const truncationNotice = `[Content truncated: original message was ~${(size / 1024 / 1024).toFixed(0)} MB, exceeding the ${(MAX_MESSAGE_SIZE / 1024 / 1024).toFixed(0)} MB transport safety limit]`;

            // First pass: replace content
            let capped: Record<string, unknown> = { ...msg, content: truncationNotice };

            // If the message is still oversized after replacing content, the
            // bulk is in other fields (e.g. subagent `details` carrying full
            // child results[].messages arrays).  Strip large non-essential
            // fields until we're under the cap.
            const largeFieldCandidates = ["details", "toolResult", "metadata"];
            for (const field of largeFieldCandidates) {
                const cappedSize = Buffer.byteLength(JSON.stringify(capped), "utf8");
                if (cappedSize <= MAX_MESSAGE_SIZE) break;
                if (field in capped && capped[field] != null) {
                    const fieldSize = Buffer.byteLength(JSON.stringify(capped[field]), "utf8");
                    if (fieldSize > 1024) { // only strip fields > 1 KB
                        capped = {
                            ...capped,
                            [field]: `[${field} truncated: ~${(fieldSize / 1024 / 1024).toFixed(1)} MB]`,
                        };
                    }
                }
            }

            result[i] = capped;
            console.warn(
                `pizzapi: message ${i} truncated (~${(size / 1024 / 1024).toFixed(0)} MB exceeds ${(MAX_MESSAGE_SIZE / 1024 / 1024).toFixed(0)} MB cap).`,
            );
        }
    }

    return result;
}

/**
 * Pre-compute chunk boundaries using both message count and byte size limits.
 * Returns an array of [start, end) index pairs.
 */
export function computeChunkBoundaries(messages: unknown[]): Array<[number, number]> {
    const boundaries: Array<[number, number]> = [];
    let start = 0;

    while (start < messages.length) {
        let end = start;
        let chunkBytes = 0;

        while (end < messages.length && (end - start) < CHUNK_SIZE) {
            const msgSize = Buffer.byteLength(JSON.stringify(messages[end]), "utf8");
            // If adding this message would exceed the byte limit AND we already
            // have at least one message in the chunk, break here.
            if (chunkBytes + msgSize > CHUNK_BYTE_LIMIT && end > start) {
                break;
            }
            chunkBytes += msgSize;
            end++;
        }

        // Safety: always advance by at least 1 to avoid infinite loop on a
        // single message larger than the byte limit.
        if (end === start) end = start + 1;

        boundaries.push([start, end]);
        start = end;
    }

    return boundaries;
}

/**
 * Send messages in chunks via the relay event pipeline.
 * Each chunk is a `session_messages_chunk` event with a slice of messages,
 * a chunk index, and total chunk count. The final chunk has `final: true`.
 *
 * Uses setImmediate between chunks to yield the event loop so Socket.IO
 * pings can be answered, preventing transport-close disconnects.
 *
 * Each chunk carries a `snapshotId` that matches the session_active event,
 * so the UI can discard stale chunks from a previous snapshot stream.
 */
function sendChunkedMessages(rctx: RelayContext, rawMessages: unknown[], snapshotId: string): void {
    const messages = capOversizedMessages(rawMessages);
    const chunks = computeChunkBoundaries(messages);
    const totalChunks = chunks.length;

    console.log(
        `pizzapi: session is large (${messages.length} messages, ~${(estimateMessagesSize(messages) / 1024 / 1024).toFixed(0)} MB). ` +
        `Sending in ${totalChunks} chunks (snapshot=${snapshotId.slice(0, 8)}).`,
    );

    let chunkIndex = 0;

    function sendNextChunk() {
        if (!rctx.relay || !rctx.sioSocket?.connected) return; // disconnected mid-stream
        if (chunkIndex >= totalChunks) return;
        // A newer emitSessionActive() superseded this sender — stop.
        if (activeChunkedSnapshotId !== snapshotId) return;

        const [start, end] = chunks[chunkIndex];
        const isFinal = chunkIndex === totalChunks - 1;

        rctx.forwardEvent({
            type: "session_messages_chunk",
            snapshotId,
            chunkIndex,
            totalChunks,
            totalMessages: messages.length,
            messages: messages.slice(start, end),
            final: isFinal,
        });

        chunkIndex++;

        if (chunkIndex < totalChunks) {
            // Yield the event loop so Socket.IO can process pings/acks between chunks
            setImmediate(sendNextChunk);
        }
    }

    // Start the first chunk on the next tick so the session_active event
    // (with chunked: true) is flushed to the socket first.
    setImmediate(sendNextChunk);
}

/**
 * Tracks the snapshotId of the currently active chunked sender so that
 * `sendChunkedMessages` can bail out if a newer emitSessionActive() fires
 * before the previous one finishes draining.
 */
let activeChunkedSnapshotId: string | null = null;

// ── Message-state tracking for lightweight heartbeat emissions ────────────────
// We compare the current messages array length and leaf ID against the last
// emitted snapshot to decide whether to send a full session_active or a
// cheaper session_metadata_update.
interface LastEmittedMessageState {
    length: number;
    leafId: string | null;
}
let lastEmittedMessageState: LastEmittedMessageState | null = null;

/** Record the current message state as "last emitted" after a full session_active. */
function recordEmittedMessageState(rctx: RelayContext, messages: unknown[]): void {
    lastEmittedMessageState = {
        length: messages.length,
        leafId: rctx.latestCtx?.sessionManager.getLeafId() ?? null,
    };
}

/**
 * Returns true when the messages array has changed since the last full
 * session_active emission (or when no emission has been recorded yet).
 */
function messagesChangedSinceLastEmit(rctx: RelayContext, messages: unknown[]): boolean {
    if (!lastEmittedMessageState) return true; // no baseline yet
    const currentLeafId = rctx.latestCtx?.sessionManager.getLeafId() ?? null;
    return (
        messages.length !== lastEmittedMessageState.length ||
        currentLeafId !== lastEmittedMessageState.leafId
    );
}

/**
 * Emit session_active — either as a single event (small sessions) or as
 * metadata-only + chunked messages (large sessions).
 */
export function emitSessionActive(rctx: RelayContext): void {
    if (!rctx.latestCtx) return;

    const { messages, model } = buildSessionContext(
        rctx.latestCtx.sessionManager.getEntries(),
        rctx.latestCtx.sessionManager.getLeafId(),
    );

    const metadata = {
        model,
        thinkingLevel: rctx.getCurrentThinkingLevel(),
        sessionName: rctx.getCurrentSessionName(),
        cwd: rctx.latestCtx.cwd,
        availableModels: rctx.getConfiguredModels(),
        todoList: getCurrentTodoList(),
    };

    if (needsChunkedDelivery(messages)) {
        // Large session — send metadata-only session_active, then stream chunks.
        // The snapshotId ties the metadata event to its chunk stream so the UI
        // can discard stale chunks and the server can assemble the full state.
        const snapshotId = randomUUID();
        // Cancel any in-flight chunked sender from a previous call.
        activeChunkedSnapshotId = snapshotId;
        rctx.forwardEvent({
            type: "session_active",
            state: {
                ...metadata,
                messages: [], // placeholder — real messages follow as chunks
                chunked: true,
                snapshotId,
                totalMessages: messages.length,
            },
        });
        recordEmittedMessageState(rctx, messages);
        sendChunkedMessages(rctx, messages, snapshotId);
    } else {
        // Small session — single event (original path).
        // Cancel any in-flight chunked sender since we're replacing with a full snapshot.
        // Still cap individual oversized messages to avoid transport failures.
        activeChunkedSnapshotId = null;
        rctx.forwardEvent({
            type: "session_active",
            state: {
                ...metadata,
                messages: capOversizedMessages(messages),
            },
        });
        recordEmittedMessageState(rctx, messages);
    }
}

/**
 * Emit either a full session_active or a lightweight session_metadata_update,
 * depending on whether the messages array has changed since the last emission.
 *
 * Call this from the heartbeat interval instead of emitSessionActive() to
 * avoid re-serializing the full message history when nothing changed.
 *
 * - Messages unchanged → session_metadata_update (metadata only, ~80% smaller)
 * - Messages changed   → emitSessionActive() as usual
 */
export function emitSessionMetadataUpdate(rctx: RelayContext): void {
    if (!rctx.latestCtx) return;

    const { messages, model } = buildSessionContext(
        rctx.latestCtx.sessionManager.getEntries(),
        rctx.latestCtx.sessionManager.getLeafId(),
    );

    if (messagesChangedSinceLastEmit(rctx, messages)) {
        // Messages changed since last full snapshot — send a complete session_active.
        emitSessionActive(rctx);
        return;
    }

    // Messages unchanged — send lightweight metadata-only update.
    rctx.forwardEvent({
        type: "session_metadata_update",
        metadata: {
            model,
            thinkingLevel: rctx.getCurrentThinkingLevel(),
            sessionName: rctx.getCurrentSessionName(),
            cwd: rctx.latestCtx.cwd,
            availableModels: rctx.getConfiguredModels(),
            todoList: getCurrentTodoList(),
        },
    });
}
