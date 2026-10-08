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
    /**
     * Transcript events that arrived after the chunk-start SA. They are newer
     * than the snapshot, so they are published to viewers only after the
     * assembled snapshot is, or they'd be overwritten by it.
     */
    deferredEvents?: unknown[];
    /** Messages accepted so far across unique chunks (bounded by snapshot limits). */
    receivedMessages?: number;
    /** Serialized size (JSON string length) of accepted chunks so far. */
    receivedBytes?: number;
}

// ── Chunked snapshot resource limits ─────────────────────────────────────────
// The runner splits a snapshot into chunks of at most 200 messages / ~6 MB
// (packages/cli/src/extensions/remote/chunked-delivery.ts), so legitimate
// streams stay far below these defaults. They exist so a relay client cannot
// use chunkIndex/totalChunks/messages to make the relay allocate or iterate
// attacker-sized structures. Each is overridable with a positive integer env
// var; invalid values fall back to the default.

export const DEFAULT_SNAPSHOT_MAX_CHUNKS = 10_000;
export const DEFAULT_SNAPSHOT_MAX_MESSAGES = 1_000_000;
export const DEFAULT_SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_MAX_DEFERRED_EVENTS = 10_000;

export interface ChunkedSnapshotLimits {
    /** Upper bound (exclusive for indexes, inclusive for totalChunks). */
    maxChunks: number;
    maxMessages: number;
    /** Aggregate serialized size of all chunks (JSON string length). */
    maxBytes: number;
    /** Events deferred behind an in-flight snapshot. */
    maxDeferredEvents: number;
}

function positiveIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function getChunkedSnapshotLimits(): ChunkedSnapshotLimits {
    return {
        maxChunks: positiveIntEnv("PIZZAPI_RELAY_SNAPSHOT_MAX_CHUNKS", DEFAULT_SNAPSHOT_MAX_CHUNKS),
        maxMessages: positiveIntEnv("PIZZAPI_RELAY_SNAPSHOT_MAX_MESSAGES", DEFAULT_SNAPSHOT_MAX_MESSAGES),
        maxBytes: positiveIntEnv("PIZZAPI_RELAY_SNAPSHOT_MAX_BYTES", DEFAULT_SNAPSHOT_MAX_BYTES),
        maxDeferredEvents: positiveIntEnv("PIZZAPI_RELAY_SNAPSHOT_MAX_DEFERRED_EVENTS", DEFAULT_SNAPSHOT_MAX_DEFERRED_EVENTS),
    };
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

export type ChunkApplyResult =
    | { status: "applied" }
    | { status: "duplicate" }
    /** The chunk is malformed or over budget; the caller must abort the snapshot. */
    | { status: "rejected"; reason: string };

function serializedLength(value: unknown): number | null {
    try {
        const json = JSON.stringify(value);
        return typeof json === "string" ? json.length : 0;
    } catch {
        return null;
    }
}

/**
 * Validate and apply one chunk. Every check runs before any mutation, so a
 * rejected chunk leaves `pending` untouched.
 */
export function applyChunkToPendingState(
    pending: ChunkedSessionState,
    update: PendingChunkUpdate,
    limits: ChunkedSnapshotLimits = getChunkedSnapshotLimits(),
): ChunkApplyResult {
    const { chunkIndex, chunkMessages, totalChunks, isFinalChunk } = update;

    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= limits.maxChunks) {
        return { status: "rejected", reason: `invalid chunkIndex ${String(chunkIndex)}` };
    }

    if (pending.receivedChunkIndexes.has(chunkIndex)) {
        if (isFinalChunk) {
            pending.finalChunkSeen = true;
        }
        return { status: "duplicate" };
    }

    if (!Number.isSafeInteger(totalChunks) || totalChunks <= 0 || totalChunks > limits.maxChunks) {
        return { status: "rejected", reason: `invalid totalChunks ${String(totalChunks)}` };
    }
    if (chunkIndex >= totalChunks) {
        return { status: "rejected", reason: `chunkIndex ${chunkIndex} >= totalChunks ${totalChunks}` };
    }
    if (pending.totalChunks > 0 && totalChunks !== pending.totalChunks) {
        return { status: "rejected", reason: `totalChunks changed from ${pending.totalChunks} to ${totalChunks}` };
    }
    if (!Array.isArray(chunkMessages)) {
        return { status: "rejected", reason: "chunk messages are not an array" };
    }
    const nextMessages = (pending.receivedMessages ?? 0) + chunkMessages.length;
    if (nextMessages > limits.maxMessages) {
        return { status: "rejected", reason: `snapshot exceeds ${limits.maxMessages} messages` };
    }
    const chunkBytes = serializedLength(chunkMessages);
    if (chunkBytes === null) {
        return { status: "rejected", reason: "chunk messages are not serializable" };
    }
    const nextBytes = (pending.receivedBytes ?? 0) + chunkBytes;
    if (nextBytes > limits.maxBytes) {
        return { status: "rejected", reason: `snapshot exceeds ${limits.maxBytes} bytes` };
    }

    pending.totalChunks = totalChunks;
    if (isFinalChunk) {
        pending.finalChunkSeen = true;
    }

    pending.receivedChunkIndexes.add(chunkIndex);
    pending.chunks[chunkIndex] = chunkMessages;
    pending.receivedMessages = nextMessages;
    pending.receivedBytes = nextBytes;
    pending.lastActivityAt = Date.now();
    return { status: "applied" };
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

/**
 * Sessions whose queue is being drained by resetPerSessionRelayState. That
 * drain runs inside registerTuiSession while it HOLDS the session ownership
 * lock, and every queued event handler acquires that same lock — so letting
 * queued work run would make each item wait out the 5s lock timeout (and the
 * registration hold the lock for 5s × backlog). Everything queued before the
 * reset belongs to the replaced generation and must be discarded anyway, so
 * it is skipped instead. (2026-10-08 relay crash loop, GM GIo4GsJ9.)
 */
const resettingSessions = new Set<string>();

export function enqueueSessionEvent(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const run = () => (resettingSessions.has(sessionId) ? undefined : fn());
    return chainSessionEvent(sessionId, run);
}

function chainSessionEvent(sessionId: string, fn: () => Promise<void> | undefined): Promise<void> {
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
    resettingSessions.add(sessionId);
    try {
        await chainSessionEvent(sessionId, async () => {
            pendingChunkedStates.delete(sessionId);
        });
    } finally {
        resettingSessions.delete(sessionId);
    }
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
