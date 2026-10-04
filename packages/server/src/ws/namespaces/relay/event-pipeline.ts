// ── Chunked session_active assembly + event serialization ────────────────────
// When a worker sends session_active with chunked:true, messages follow as
// session_messages_chunk events.  Chunking only exists to fit runner→relay
// frames under Socket.IO's size cap: the relay assembles the full state here,
// and viewers get a tail-truncated session_active on finalize (older pages via
// load_messages), exactly like non-chunked sessions. While assembling, viewers
// only see message-less progress chunks.

import {
    updateSessionState,
    patchSessionSnapshotState,
    touchSessionActivity,
    updateSessionHeartbeat,
    getSharedSessionSummary,
    broadcastSessionEventToViewers,
    publishSessionEvent,
    consumePendingRecovery,
    getSessionOwnerToken,
} from "../../sio-registry.js";
import { isDeltaEvent, shouldPublishDelta } from "./viewer-gate.js";
import { stripImagesFromPipelineEvent } from "../../strip-images.js";
import { updateSessionMetaState, broadcastToSessionMeta, getSessionMetaState } from "../../sio-registry/meta.js";
import { buildSnapshotPatchFromCapabilities, buildSnapshotPatchFromMetadata } from "../../sio-registry/snapshot-state.js";
import { isMetaRelayEvent, metaEventToPatch, type MetaRelayEvent, type SessionMetaState } from "@pizzapi/protocol";
import {
    acquireSessionOwnershipLock,
    releaseSessionOwnershipLock,
    updateSessionFields,
} from "../../sio-state/index.js";
import { randomUUID } from "node:crypto";
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
import { createLogger } from "@pizzapi/tools";
import {
    type ChunkedSessionState,
    pendingChunkedStates,
    applyChunkToPendingState,
    applySnapshotPatchToPendingState,
    canFinalizeChunkedSnapshot,
    enqueueSessionEvent,
    CHUNK_STREAM_STALE_MS,
} from "./relay-state.js";

export {
    type ChunkedSessionState,
    CHUNK_STREAM_STALE_MS,
    type PendingChunkUpdate,
    pendingChunkedStates,
    applyChunkToPendingState,
    applySnapshotPatchToPendingState,
    hasAllChunkIndexes,
    canFinalizeChunkedSnapshot,
    sessionEventQueues,
    enqueueSessionEvent,
    resetPerSessionRelayState,
    getPendingChunkedSnapshot,
} from "./relay-state.js";

const log = createLogger("sio/relay");

export interface FinalizeChunkedSnapshotDeps {
    consumePendingRecovery: typeof consumePendingRecovery;
    updateSessionState: typeof updateSessionState;
    publishSessionEvent: typeof publishSessionEvent;
}

const defaultFinalizeChunkedSnapshotDeps: FinalizeChunkedSnapshotDeps = {
    consumePendingRecovery,
    updateSessionState,
    publishSessionEvent,
};

/**
 * Transcript events that must not reach viewers ahead of an in-flight chunked
 * snapshot: they are newer than it and the snapshot would overwrite them.
 * Pure deltas (viewer-gate DELTA_EVENTS) are dropped instead — each one is
 * cumulative, so the next delta after the snapshot repairs the viewer.
 */
const DEFERRED_DURING_CHUNKING = new Set([
    "message_start",
    "message_end",
    "turn_end",
    "tool_execution_start",
    "tool_execution_end",
]);

export async function finalizeChunkedSnapshot(
    sessionId: string,
    pending: ChunkedSessionState,
    deps: FinalizeChunkedSnapshotDeps = defaultFinalizeChunkedSnapshotDeps,
): Promise<Record<string, unknown>> {
    const allMessages = pending.chunks.flat();
    const fullState = { ...pending.metadata, messages: allMessages };
    const isRecovery = deps.consumePendingRecovery(sessionId, pending.recoveryNonce);
    await deps.updateSessionState(sessionId, fullState, { isRecovery });

    // Cache the FULL assembled state (sequenced, so replay/coverage logic can
    // use it and findLatestSnapshotEvent / load_messages see every message),
    // but broadcast only the tail to viewers — pushing the whole thing is the
    // oversized frame chunking exists to avoid.
    await deps.publishSessionEvent(
        sessionId,
        { type: "session_active", state: fullState },
        { truncateForViewers: true },
    );

    // Events that arrived during assembly are newer than the snapshot.
    for (const deferred of pending.deferredEvents ?? []) {
        await deps.publishSessionEvent(sessionId, deferred);
    }
    pending.deferredEvents = [];

    return fullState;
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

        const incomingEvent = data.event as Record<string, unknown> | undefined;
        if (!incomingEvent) return;
        // Older workers forward Pi's full-history boundary context. Strip it
        // before queueing, caching or broadcasting, without mutating the input.
        const event = incomingEvent.type === "turn_end" ? { ...incomingEvent } : incomingEvent;
        if (event.type === "turn_end") delete event.context;

        // Serialize async processing per session to guarantee chunk order.
        enqueueSessionEvent(sessionId, async () => {
        // Registration and teardown use this same distributed lock. Holding it
        // across the full event prevents a replacement from rotating ownership
        // after the check while this event is still mutating shared state.
        const lockOwner = randomUUID();
        try {
            await acquireSessionOwnershipLock(sessionId, lockOwner);
        } catch (err) {
            log.warn(`Could not acquire ownership lock for event on ${sessionId}; dropping event:`, err);
            return;
        }
        try {

        // ── Cross-node stale socket guard ────────────────────────────────
        // A replacement session may have registered on a different relay node.
        // Compare this socket's captured token against the current shared
        // (Redis) owner token.  If they differ, this socket is stale and
        // superseded — reject the event silently (do not update any state or
        // broadcast to viewers).
        let sharedOwnerToken: string | null;
        try {
            sharedOwnerToken = await getSessionOwnerToken(sessionId);
        } catch {
            console.warn(`[sio/relay] Redis ownership lookup failed for ${sessionId}; dropping event`);
            return;
        }
        if (sharedOwnerToken !== socket.data.token) {
            return; // stale or unknown owner; never process sensitive events
        }

        // ── Single-pass image stripping ──────────────────────────────────
        // Strip inline base64 images ONCE at ingestion so all downstream
        // consumers (state storage, Redis cache, viewer broadcast) see
        // already-stripped payloads. The _imagesStripped flag causes
        // storeAndReplaceImages / storeAndReplaceImagesInEvent to skip.
        // Only fetch the lightweight session summary for event types that
        // actually carry images; all others skip the Redis round-trip.
        const needsImageStrip =
            event.type === "session_active" ||
            event.type === "agent_end" ||
            event.type === "session_messages_chunk";
        const userId = needsImageStrip
            ? (await getSharedSessionSummary(sessionId))?.userId ?? "unknown"
            : "unknown";
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
            if (typeof state?.sessionFile === "string" && state.sessionFile) {
                socket.data.sessionFile = state.sessionFile;
            }
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
                    recoveryNonce: typeof event.recoveryNonce === "string" ? event.recoveryNonce : undefined,
                    lastActivityAt: Date.now(),
                });
                // Touch activity but DON'T update lastState yet
                await touchSessionActivity(sessionId);
            } else {
                // Non-chunked: persist immediately (original path).
                // Check if this session_active was triggered by a viewer
                // reconnect (cold-start fallback) — if so, skip the SQLite
                // write since it's redundant recovery data. Only a matching
                // recovery nonce consumes the flag; real updates racing in
                // must still be persisted.
                const isRecovery = consumePendingRecovery(
                    sessionId,
                    typeof event.recoveryNonce === "string" ? event.recoveryNonce : undefined,
                );
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
                    // All chunks received — assemble, persist, and publish the
                    // tail to viewers. Only clear the pending entry after
                    // finalization succeeds so a transient failure can still be
                    // retried by later chunk retransmits.
                    await finalizeChunkedSnapshot(sessionId, pending);
                    pendingChunkedStates.delete(sessionId);
                } else {
                    await touchSessionActivity(sessionId);
                    // Message-less progress for hydrating viewers: drives the
                    // "Loading session (x of y)" status and keeps the UI's
                    // hydration-stall watchdog from restarting the transfer.
                    let loadedMessages = 0;
                    for (const c of pending.chunks) loadedMessages += c?.length ?? 0;
                    await publishSessionEvent(sessionId, {
                        type: "session_messages_chunk",
                        snapshotId: chunkSnapshotId,
                        chunkIndex,
                        totalChunks,
                        totalMessages: event.totalMessages,
                        loadedMessages,
                    });
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
                if (typeof meta.sessionFile === "string" && meta.sessionFile) {
                    socket.data.sessionFile = meta.sessionFile;
                }
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
                if (Object.prototype.hasOwnProperty.call(meta, "goal")) {
                    patch.goal = meta.goal && typeof meta.goal === "object" ? meta.goal : null;
                }
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
                    await updateRelaySessionName(sessionId, normalizedSessionName).catch(() => {});
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
        let eventToPublish: unknown = event;
        if (event.type === "message_end" || event.type === "turn_end") {
            const durations = thinkingDurations.get(sessionId);
            if (durations?.size) {
                eventToPublish = augmentMessageThinkingDurations(eventToPublish as Record<string, unknown>, durations);
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
            // The chunk header and chunks never reach viewers or the cache:
            // finalizeChunkedSnapshot publishes the assembled snapshot (and the
            // branch above sends message-less progress). Caching the empty
            // header would make an interrupted stream replay a blank transcript.
            const isChunkedSessionActive =
                event.type === "session_active" &&
                !!(event.state as Record<string, unknown> | undefined)?.chunked;
            const pending = pendingChunkedStates.get(sessionId);
            const assembling = !!pending && Date.now() - pending.lastActivityAt <= CHUNK_STREAM_STALE_MS;
            if (event.type === "session_messages_chunk" || isChunkedSessionActive) {
                // handled above
            } else if (event.type === "session_metadata_update") {
                // Lightweight heartbeat-only event: broadcast to connected
                // viewers but do NOT cache. Reconnecting viewers get lastState.
                await broadcastSessionEventToViewers(sessionId, eventToPublish);
            } else if (assembling && DEFERRED_DURING_CHUNKING.has(event.type as string)) {
                (pending!.deferredEvents ??= []).push(eventToPublish);
            } else if (assembling && isDeltaEvent(event.type)) {
                // Cumulative delta; the next one after the snapshot repairs viewers.
            } else if (isDeltaEvent(event.type) && !shouldPublishDelta(sessionId)) {
                // Nobody is watching: drop the delta instead of rPushing a
                // cumulative partial into the event cache and PUBLISHing it to
                // an empty room. Skipping publish also skips incrementSeq, so
                // no seq gap is created, and the next delta after a viewer
                // attaches carries the whole message so far. See viewer-gate.ts.
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
        // Keep event-derived side effects inside the ownership critical section
        // so a replacement cannot become current while stale notification work
        // is still running.
        await checkPushNotifications(sessionId, event).catch((err) => {
            log.error(`push notification check failed for session ${sessionId} (event=${event.type}):`, err);
        });

        } finally {
            await releaseSessionOwnershipLock(sessionId, lockOwner).catch((err) => {
                log.error(`Failed to release ownership lock for event on ${sessionId}:`, err);
            });
        }
        }); // end enqueueSessionEvent
    });
}
