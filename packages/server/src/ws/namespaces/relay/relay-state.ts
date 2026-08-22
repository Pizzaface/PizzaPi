// ── Per-session relay state (chunk assembly + event serialization) ──────────
// Pure in-memory state keyed by session id, plus the reconnect reset helper.
// Deliberately free of any sio-registry import so that sio-registry/sessions.ts
// can import the reset helper without creating a static import cycle
// (event-pipeline.ts imports the sio-registry barrel, so importing it from
// sessions.ts would form sessions.ts → event-pipeline.ts → sio-registry.js →
// sessions.ts).

import { clearThinkingMaps } from "./thinking-tracker.js";
import { deleteRelayEventCache } from "../../../sessions/redis.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("sio/relay");

export interface ChunkedSessionState {
    snapshotId: string;
    metadata: Record<string, unknown>; // everything except messages
    chunks: unknown[][]; // ordered message slices
    totalChunks: number;
    receivedChunkIndexes: Set<number>;
    finalChunkSeen: boolean;
    /** Recovery nonce echoed by the runner on the chunk-start session_active. */
    recoveryNonce?: string;
    /** Timestamp of the chunk-start SA or the most recent chunk. */
    lastActivityAt: number;
}

/**
 * A chunk stream that has gone this long without a new chunk is dead — the
 * runner hung or lost the worker without its relay socket disconnecting.
 * Left in place, the pending entry makes every viewer hydration skip the
 * snapshot cache (viewer.ts chunkedPending gate) and wait on a runner signal
 * that never comes, which is unrecoverable even across client retries.
 *
 * Healthy streams emit chunks sub-second (setImmediate cadence on the
 * runner), so 10s of silence is unambiguous. Timing alignment matters: the
 * client retries hydration at ~4s and ~12s after its last progress event,
 * then surfaces a terminal error — the threshold must sit BELOW the final
 * retry (12s) or the bypass is never exercised before the client gives up.
 * Both clocks anchor to the same event (a chunk arrival), so 10s here
 * guarantees the ~12s retry sees the stream as stale.
 */
export const CHUNK_STREAM_STALE_MS = 10_000;

export interface PendingChunkUpdate {
    chunkIndex: number;
    chunkMessages: unknown[];
    totalChunks: number;
    isFinalChunk: boolean;
}

export const pendingChunkedStates = new Map<string, ChunkedSessionState>();

export function applyChunkToPendingState(
    pending: ChunkedSessionState,
    update: PendingChunkUpdate,
): boolean {
    const { chunkIndex, chunkMessages, totalChunks, isFinalChunk } = update;

    if (pending.receivedChunkIndexes.has(chunkIndex)) {
        if (isFinalChunk) {
            pending.finalChunkSeen = true;
        }
        return false;
    }

    if (Number.isInteger(totalChunks) && totalChunks > 0) {
        pending.totalChunks = totalChunks;
    }

    if (isFinalChunk) {
        pending.finalChunkSeen = true;
    }

    pending.receivedChunkIndexes.add(chunkIndex);
    pending.chunks[chunkIndex] = chunkMessages;
    pending.lastActivityAt = Date.now();
    return true;
}

export function applySnapshotPatchToPendingState(
    pending: ChunkedSessionState | null | undefined,
    patch: Record<string, unknown>,
): void {
    if (!pending || Object.keys(patch).length === 0) return;
    pending.metadata = { ...pending.metadata, ...patch };
}

export function hasAllChunkIndexes(pending: ChunkedSessionState): boolean {
    if (!Number.isInteger(pending.totalChunks) || pending.totalChunks <= 0) {
        return false;
    }
    for (let i = 0; i < pending.totalChunks; i++) {
        if (!pending.receivedChunkIndexes.has(i)) {
            return false;
        }
    }
    return true;
}

export function canFinalizeChunkedSnapshot(pending: ChunkedSessionState): boolean {
    return pending.finalChunkSeen && hasAllChunkIndexes(pending);
}

// ── Per-session event serialization ──────────────────────────────────────────
// The async event handler must process events in arrival order per session.
// Without serialization, concurrent async handlers (e.g. chunk 0 hitting a
// Redis round-trip while chunk 1 skips it) can publish chunks out of order,
// scrambling the viewer's message assembly.
export const sessionEventQueues = new Map<string, Promise<void>>();

export function enqueueSessionEvent(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = sessionEventQueues.get(sessionId) ?? Promise.resolve();
    const next = prev
        .then(fn, fn) // always chain, even on prior rejection
        .catch((error) => {
            console.error(`[sio/relay] Session event pipeline failed for ${sessionId}:`, error);
        });
    sessionEventQueues.set(sessionId, next);
    // Clean up the map entry when the chain settles to avoid unbounded growth.
    // Use .finally() so cleanup runs even if fn rejects (otherwise the map
    // entry leaks indefinitely on error, causing unbounded memory growth).
    next.finally(() => {
        if (sessionEventQueues.get(sessionId) === next) {
            sessionEventQueues.delete(sessionId);
        }
    });
    return next;
}

/**
 * Reset all per-session relay state for a session that is being replaced by a
 * reconnect (same session ID, new TUI socket).  Drains the event pipeline
 * queue, discards any half-assembled chunked snapshot, clears thinking-block
 * maps, and deletes the Redis relay event cache so stale queued work and
 * half-assembled chunk state cannot leak into the new session generation.
 *
 * Unlike terminal session ends (which preserve the relay event cache for
 * ended-session replay), a reconnect starts a fresh event stream under the
 * same session ID — old cached events would race with the new sequence.
 */
export async function resetPerSessionRelayState(sessionId: string): Promise<void> {
    clearThinkingMaps(sessionId);
    // Drain the queue before discarding chunk state: a queued chunk handler
    // that wakes up after we delete pendingChunkedStates would otherwise skip
    // final assembly, or worse, apply an old chunk to the new session's
    // pending state (same sessionId).
    await enqueueSessionEvent(sessionId, async () => {
        pendingChunkedStates.delete(sessionId);
    });
    // Clear the relay event cache AFTER draining so any cache writes from
    // in-flight handlers are also removed.
    await deleteRelayEventCache(sessionId);
}

/**
 * Get the partially assembled snapshot for a session that's mid-chunked-delivery.
 * Returns metadata + chunks received so far, or null if no chunked delivery is active.
 */
export function getPendingChunkedSnapshot(sessionId: string): {
    metadata: Record<string, unknown>;
    messages: unknown[];
    snapshotId: string;
    totalMessages: number;
    receivedChunks: number;
    totalChunks: number;
    /**
     * True when the stream has gone CHUNK_STREAM_STALE_MS without a chunk.
     * Callers should stop gating hydration on it (serve the cache) AND request
     * a fresh runner snapshot instead of suppressing recovery — but the entry
     * is deliberately NOT deleted: a hung runner that resumes sending refreshes
     * lastActivityAt and the stream can still finalize normally, and deleting
     * it would silently discard chunks the runner still believes it delivered.
     */
    stale: boolean;
} | null {
    const pending = pendingChunkedStates.get(sessionId);
    if (!pending) return null;
    const stale = Date.now() - pending.lastActivityAt > CHUNK_STREAM_STALE_MS;
    if (stale) {
        log.warn(`Chunked snapshot for ${sessionId} is stale (no chunk for ${CHUNK_STREAM_STALE_MS}ms) — bypassing hydration gate`);
    }
    const messages = pending.chunks.flat();
    return {
        metadata: pending.metadata,
        messages,
        snapshotId: pending.snapshotId,
        totalMessages: (pending.metadata as any).totalMessages ?? messages.length,
        receivedChunks: pending.receivedChunkIndexes.size,
        totalChunks: pending.totalChunks,
        stale,
    };
}
