// ============================================================================
// viewer-cache.ts — cache-first viewer hydration helpers
//
// Pure-ish helpers extracted from viewer.ts so they can be tested without
// loading the full namespace module or relying on global mock.module state.
// ============================================================================

import {
    getCachedRelayEventsAfterSeq,
    getLatestCachedRelayEventSeq,
    getLatestCachedSnapshotEvent,
    type LatestCachedSnapshot,
} from "../../sessions/redis.js";

type ViewerEventEmitter = {
    emit: any;
};

export type CachedRelayEvent = {
    seq?: number;
    event: unknown;
};

export interface ViewerCacheDeps {
    getCachedRelayEventsAfterSeq: (sessionId: string, afterSeq: number) => Promise<CachedRelayEvent[]>;
    getLatestCachedRelayEventSeq: (sessionId: string) => Promise<number | null>;
    getLatestCachedSnapshotEvent: (sessionId: string) => Promise<LatestCachedSnapshot | null>;
}

const defaultViewerCacheDeps: ViewerCacheDeps = {
    getCachedRelayEventsAfterSeq,
    getLatestCachedRelayEventSeq,
    getLatestCachedSnapshotEvent,
};

/**
 * Highest seq a cached snapshot + its trailing deltas can reconstruct, or null
 * if that cannot be established.
 *
 * A snapshot replaces the viewer's transcript wholesale, so replaying it is only
 * safe when the result lands the viewer at or ahead of where it already was.
 * That reach is not the snapshot's own seq: the trailing deltas extend it. A
 * snapshot at seq 480 followed by cached deltas 481..500 reconstructs seq 500
 * exactly, which is why refusing to send it whenever `snapshotSeq < lastSeq`
 * would strand viewers that are only a few deltas ahead of the last checkpoint.
 *
 * Returns null when the snapshot itself is unsequenced (finalizeChunkedSnapshot
 * writes one deliberately without a seq) or when the trailing deltas are not a
 * contiguous run from `snapshotSeq + 1` — a hole means replacing the transcript
 * would silently drop whatever fell in it.
 */
export function snapshotCoverageSeq(cached: LatestCachedSnapshot): number | null {
    const snapshotSeq = cached.snapshotSeq;
    if (snapshotSeq === undefined || !Number.isFinite(snapshotSeq)) return null;

    let coverage = snapshotSeq;
    for (const record of cached.eventsAfter) {
        if (typeof record.seq !== "number" || !Number.isFinite(record.seq)) continue;
        if (record.seq !== coverage + 1) return null;
        coverage = record.seq;
    }
    return coverage;
}

/**
 * True when replaying this cached snapshot (plus trailing deltas) would not
 * rewind a viewer that has already rendered up to `lastSeq`.
 */
export function snapshotCoversCursor(cached: LatestCachedSnapshot, lastSeq: number): boolean {
    const coverage = snapshotCoverageSeq(cached);
    return coverage !== null && coverage >= lastSeq;
}

/** Emit a cached snapshot followed by every delta cached after it. */
function emitSnapshotWithTrailingDeltas(
    socket: ViewerEventEmitter,
    cached: LatestCachedSnapshot,
    generation: number | undefined,
): void {
    socket.emit("event", { event: cached.event, replay: true, generation });
    // Replay deltas cached after the snapshot so the viewer isn't left stale
    // between the snapshot and the seq advertised in "connected".
    sendCachedDeltaReplayEvents(socket, cached.eventsAfter, generation);
}

export async function sendLatestSnapshotFromCache(
    socket: ViewerEventEmitter,
    sessionId: string,
    generation: number | undefined,
    deps: ViewerCacheDeps = defaultViewerCacheDeps,
): Promise<boolean> {
    const cached = await deps.getLatestCachedSnapshotEvent(sessionId);
    if (!cached) return false;

    emitSnapshotWithTrailingDeltas(socket, cached, generation);
    return true;
}

export function sendCachedDeltaReplayEvents(
    socket: ViewerEventEmitter,
    cachedEvents: CachedRelayEvent[],
    generation?: number,
): boolean {
    let sentAny = false;

    for (const cachedEvent of cachedEvents) {
        if (typeof cachedEvent.seq !== "number" || !Number.isFinite(cachedEvent.seq)) {
            continue;
        }
        sentAny = true;
        socket.emit("event", {
            event: cachedEvent.event,
            seq: cachedEvent.seq,
            replay: true,
            deltaReplay: true,
            generation,
        });
    }

    return sentAny;
}

async function sendDeltaReplayFromCache(
    socket: ViewerEventEmitter,
    sessionId: string,
    afterSeq: number,
    generation: number | undefined,
    deps: ViewerCacheDeps,
): Promise<boolean> {
    const cachedEvents = await deps.getCachedRelayEventsAfterSeq(sessionId, afterSeq);
    return sendCachedDeltaReplayEvents(socket, cachedEvents, generation);
}

/**
 * Try to hydrate a single viewer socket from the server-side Redis cache,
 * avoiding the expensive runner round-trip.
 */
export async function hydrateViewerFromCache(
    socket: ViewerEventEmitter,
    sessionId: string,
    opts: {
        lastSeq?: number;
        generation?: number;
    } = {},
    deps: ViewerCacheDeps = defaultViewerCacheDeps,
): Promise<boolean> {
    try {
        if (opts.lastSeq !== undefined) {
            const deltaOk = await sendDeltaReplayFromCache(
                socket,
                sessionId,
                opts.lastSeq,
                opts.generation,
                deps,
            );
            if (deltaOk) return true;

            // No usable deltas. A full snapshot is still safe when we can prove
            // it reconstructs at least what the viewer already has:
            // publishSessionEvent() seq-stamps every cached snapshot, so that
            // reach is decidable. Refusing outright left resyncing viewers blank.
            const cached = await deps.getLatestCachedSnapshotEvent(sessionId);
            if (cached && snapshotCoversCursor(cached, opts.lastSeq)) {
                emitSnapshotWithTrailingDeltas(socket, cached, opts.generation);
                return true;
            }

            // An empty replay is safe only when the cache confirms the client
            // already has the newest stored event. Otherwise this is a real
            // gap (or an unavailable cache), so runner recovery is required.
            const latestSeq = await deps.getLatestCachedRelayEventSeq(sessionId);
            if (latestSeq === opts.lastSeq) return true;

            // Either a genuine gap, or the only snapshot we have is the
            // unsequenced one finalizeChunkedSnapshot() writes — whose position
            // in the stream is unknown, so sending it could rewind the client.
            return false;
        }

        return sendLatestSnapshotFromCache(socket, sessionId, opts.generation, deps);
    } catch (err) {
        // Log and fall through to runner-driven recovery
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(
            `[viewer-cache] hydrateViewerFromCache failed for ${sessionId}, falling back to runner recovery: ${errMsg}`,
        );
        return false;
    }
}
