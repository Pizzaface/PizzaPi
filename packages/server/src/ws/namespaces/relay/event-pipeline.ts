// ── Chunked session_active assembly + event serialization ────────────────────
// When a worker sends session_active with chunked:true, messages follow as
// session_messages_chunk events.  We buffer them here and assemble the full
// lastState after the final chunk so reconnecting viewers get complete data.

import {
    updateSessionState,
    patchSessionSnapshotState,
    touchSessionActivity,
    updateSessionHeartbeat,
    getSharedSession,
    broadcastSessionEventToViewers,
    publishSessionEvent,
    consumePendingRecovery,
} from "../../sio-registry.js";
import { appendRelayEventToCache } from "../../../sessions/redis.js";
import { storeAndReplaceImagesInEvent, stripImagesFromPipelineEvent } from "../../strip-images.js";
import { updateSessionMetaState, broadcastToSessionMeta, getSessionMetaState } from "../../sio-registry/meta.js";
import { buildSnapshotPatchFromCapabilities, buildSnapshotPatchFromMetadata } from "../../sio-registry/snapshot-state.js";
import { isMetaRelayEvent, metaEventToPatch, type MetaRelayEvent, type SessionMetaState } from "@pizzapi/protocol";
import { updateSessionFields } from "../../sio-state/index.js";
import { updateRelaySessionName } from "../../../sessions/store.js";
import {
    trackThinkingDeltas,
    augmentMessageThinkingDurations,
    clearThinkingMaps,
    thinkingDurations,
} from "./thinking-tracker.js";
import { sendCumulativeEventAck } from "./ack-tracker.js";
import { trackPushPendingState, checkPushNotifications } from "./push-tracker.js";
import type { RelaySocket } from "./types.js";

export interface ChunkedSessionState {
    snapshotId: string;
    metadata: Record<string, unknown>; // everything except messages
    chunks: unknown[][]; // ordered message slices
    totalChunks: number;
    receivedChunkIndexes: Set<number>;
    finalChunkSeen: boolean;
}

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

export interface FinalizeChunkedSnapshotDeps {
    consumePendingRecovery: typeof consumePendingRecovery;
    updateSessionState: typeof updateSessionState;
    getSharedSession: typeof getSharedSession;
    storeAndReplaceImagesInEvent: typeof storeAndReplaceImagesInEvent;
    appendRelayEventToCache: typeof appendRelayEventToCache;
}

const defaultFinalizeChunkedSnapshotDeps: FinalizeChunkedSnapshotDeps = {
    consumePendingRecovery,
    updateSessionState,
    getSharedSession,
    storeAndReplaceImagesInEvent,
    appendRelayEventToCache,
};

export async function finalizeChunkedSnapshot(
    sessionId: string,
    pending: ChunkedSessionState,
    deps: FinalizeChunkedSnapshotDeps = defaultFinalizeChunkedSnapshotDeps,
): Promise<Record<string, unknown>> {
    const allMessages = pending.chunks.flat();
    const fullState = { ...pending.metadata, messages: allMessages };
    const isRecovery = deps.consumePendingRecovery(sessionId);
    await deps.updateSessionState(sessionId, fullState, { isRecovery });

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
    const session = await deps.getSharedSession(sessionId);
    const userId = session?.userId ?? "unknown";
    const snapshotEvent = { type: "session_active" as const, state: fullState };
    let eventToCache: unknown = snapshotEvent;
    try {
        eventToCache = await deps.storeAndReplaceImagesInEvent(
            snapshotEvent, sessionId, userId,
        );
    } catch {
        // Fall back to original if image stripping fails
    }
    // Do NOT call incrementSeq() here — this entry is never
    // broadcast to viewers.  Advancing the shared counter
    // would create a seq gap that triggers unnecessary
    // viewer resyncs (viewers would expect seq N but the
    // next broadcast would be N+1).
    await deps.appendRelayEventToCache(sessionId, eventToCache, {
        isEphemeral: session?.isEphemeral,
    });

    return fullState;
}

// ── Per-session event serialization ──────────────────────────────────────────
// The async event handler must process events in arrival order per session.
// Without serialization, concurrent async handlers (e.g. chunk 0 hitting a
// Redis round-trip while chunk 1 skips it) can publish chunks out of order,
// scrambling the viewer's message assembly.
export const sessionEventQueues = new Map<string, Promise<void>>();

export function enqueueSessionEvent(sessionId: string, fn: () => Promise<void>): void {
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
} | null {
    const pending = pendingChunkedStates.get(sessionId);
    if (!pending) return null;
    const messages = pending.chunks.flat();
    return {
        metadata: pending.metadata,
        messages,
        snapshotId: pending.snapshotId,
        totalMessages: (pending.metadata as any).totalMessages ?? messages.length,
        receivedChunks: pending.receivedChunkIndexes.size,
        totalChunks: pending.totalChunks,
    };
}

/** Register the main event pipeline handler on the given socket. */
export function registerEventHandler(socket: RelaySocket): void {
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

        // ── Single-pass image stripping ──────────────────────────────────
        // Strip inline base64 images ONCE at ingestion so all downstream
        // consumers (state storage, Redis cache, viewer broadcast) see
        // already-stripped payloads. The _imagesStripped flag causes
        // storeAndReplaceImages / storeAndReplaceImagesInEvent to skip.
        const session = await getSharedSession(sessionId);
        const userId = session?.userId ?? "unknown";
        try {
            const stripped = await stripImagesFromPipelineEvent(event, sessionId, userId);
            if (stripped !== event) {
                // Mutate `event` reference used by all downstream code.
                // We copy all properties from the stripped event back onto the
                // original reference so existing closures over `event` see the
                // stripped data without needing to rebind every downstream use.
                Object.assign(event, stripped);
            }
        } catch (err) {
            // Non-fatal: downstream stripping will still catch images
            console.error(`[sio/relay] Pipeline image stripping failed for ${sessionId}:`, err);
        }

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
                    receivedChunkIndexes: new Set<number>(),
                    finalChunkSeen: false,
                });
                // Touch activity but DON'T update lastState yet
                await touchSessionActivity(sessionId);
            } else {
                // Non-chunked: persist immediately (original path).
                // Check if this session_active was triggered by a viewer
                // reconnect (cold-start fallback) — if so, skip the SQLite
                // write since it's redundant recovery data.
                const isRecovery = consumePendingRecovery(sessionId);
                pendingChunkedStates.delete(sessionId);
                await updateSessionState(sessionId, event.state, { isRecovery });
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
                applyChunkToPendingState(pending, {
                    chunkIndex,
                    chunkMessages,
                    totalChunks,
                    isFinalChunk: isFinal,
                });

                if (canFinalizeChunkedSnapshot(pending)) {
                    // All chunks received — assemble and persist the full state.
                    // Only clear the pending entry after finalization succeeds
                    // so a transient failure can still be retried by later
                    // chunk retransmits.
                    await finalizeChunkedSnapshot(sessionId, pending);
                    pendingChunkedStates.delete(sessionId);
                } else {
                    await touchSessionActivity(sessionId);
                }
            } else {
                // Stale or unmatched chunk — just touch activity
                await touchSessionActivity(sessionId);
            }
        } else if (event.type === "heartbeat") {
            await updateSessionHeartbeat(sessionId, event);
        } else if (event.type === "session_metadata_update") {
            // Lightweight metadata-only heartbeat: touch activity but do NOT
            // append to the Redis event cache. The full message history hasn't
            // changed, but we still merge reconnect-relevant metadata into the
            // durable snapshot so late viewers don't stay stuck on a stale
            // pre-MCP `session_active` until a manual session switch.
            await touchSessionActivity(sessionId);
            const meta = (event as any).metadata;
            if (meta && typeof meta === "object") {
                const patch: Partial<SessionMetaState> = {};
                let mergedModel: SessionMetaState["model"] | undefined;
                if (meta.model && typeof meta.model === "object") {
                    // Merge with existing model to preserve fields (like contextWindow)
                    // that the lightweight metadata update may not include.
                    const existing = await getSessionMetaState(sessionId);
                    mergedModel = existing?.model
                        ? { ...existing.model, ...meta.model }
                        : meta.model;
                    patch.model = mergedModel;
                }
                if (Object.prototype.hasOwnProperty.call(meta, "thinkingLevel")) {
                    patch.thinkingLevel = typeof meta.thinkingLevel === "string" ? meta.thinkingLevel : null;
                }
                if (Array.isArray(meta.todoList)) patch.todoList = meta.todoList;
                if (Object.keys(patch).length > 0) {
                    await updateSessionMetaState(sessionId, patch);
                }

                const snapshotPatch = buildSnapshotPatchFromMetadata(meta as Record<string, unknown>);
                if (mergedModel) {
                    snapshotPatch.model = mergedModel;
                }
                if (Object.keys(snapshotPatch).length > 0) {
                    applySnapshotPatchToPendingState(pendingChunkedStates.get(sessionId), snapshotPatch);
                    await patchSessionSnapshotState(sessionId, snapshotPatch);
                }

                // sessionName lives in the session hash (not metaState).
                if (Object.prototype.hasOwnProperty.call(meta, "sessionName")) {
                    const normalizedSessionName = typeof meta.sessionName === "string" && meta.sessionName.trim()
                        ? meta.sessionName.trim()
                        : null;
                    await updateSessionFields(sessionId, { sessionName: normalizedSessionName });
                    // Also persist to SQLite so historical session listings show names.
                    void updateRelaySessionName(sessionId, normalizedSessionName).catch(() => {});
                }
            }
        } else if (event.type === "capabilities") {
            await touchSessionActivity(sessionId);
            const snapshotPatch = buildSnapshotPatchFromCapabilities(event as Record<string, unknown>);
            if (Object.keys(snapshotPatch).length > 0) {
                applySnapshotPatchToPendingState(pendingChunkedStates.get(sessionId), snapshotPatch);
                await patchSessionSnapshotState(sessionId, snapshotPatch);
            }
        } else if (isMetaRelayEvent(event as { type?: unknown }) &&
                   // Old CLI emits mcp_startup_report in a flat format without
                   // a nested `report` field. Only intercept the new nested format;
                   // pass flat old-CLI events through the normal relay viewer path
                   // so MCP diagnostics reach viewers without corrupting Redis.
                   !(event.type === "mcp_startup_report" && !(event as any).report)) {
            // Discrete meta event: update Redis + broadcast via hub session meta room.
            // Meta events do NOT flow through to relay viewers — hub is the channel.
            const metaEvent = event as MetaRelayEvent;
            const patch = metaEventToPatch(metaEvent);
            const version = await updateSessionMetaState(sessionId, patch);
            await broadcastToSessionMeta(
              sessionId,
              metaEvent,
              version,
              socket.data.userId ?? undefined,
            );
            await touchSessionActivity(sessionId);
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

        // Meta events are routed exclusively via hub session meta rooms — they
        // must NOT flow through to relay viewers or be cached in the event
        // store.  Skip the entire viewer publish path for them.
        // Exception: old-CLI flat mcp_startup_report (no .report field) is not
        // handled by the meta path above and must reach relay viewers.
        const isOldCliMcpReport =
            event.type === "mcp_startup_report" && !(event as any).report;
        if (!isMetaRelayEvent(event as { type?: unknown }) || isOldCliMcpReport) {
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
            // session_metadata_update is a lightweight heartbeat-only event:
            // broadcast to currently-connected viewers but do NOT cache in Redis.
            // Reconnecting viewers will get the full lastState snapshot instead.
            const isMetadataOnlyUpdate = event.type === "session_metadata_update";
            if (event.type === "session_messages_chunk" || isChunkedSessionActive || isMetadataOnlyUpdate) {
                await broadcastSessionEventToViewers(sessionId, eventToPublish);
            } else {
                // Publish to viewers via Redis cache + Socket.IO rooms
                await publishSessionEvent(sessionId, eventToPublish);
            }
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
}
