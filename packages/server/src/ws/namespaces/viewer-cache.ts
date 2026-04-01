// ============================================================================
// viewer-cache.ts — cache-first viewer hydration helpers
//
// Pure-ish helpers extracted from viewer.ts so they can be tested without
// loading the full namespace module or relying on global mock.module state.
// ============================================================================

import { getCachedRelayEventsAfterSeq, getLatestCachedSnapshotEvent } from "../../sessions/redis.js";

type ViewerEventEmitter = {
    emit: any;
};

export type CachedRelayEvent = {
    seq?: number;
    event: unknown;
};

export interface ViewerCacheDeps {
    getCachedRelayEventsAfterSeq: (sessionId: string, afterSeq: number) => Promise<CachedRelayEvent[]>;
    getLatestCachedSnapshotEvent: (sessionId: string) => Promise<Record<string, unknown> | null>;
}

const defaultViewerCacheDeps: ViewerCacheDeps = {
    getCachedRelayEventsAfterSeq,
    getLatestCachedSnapshotEvent,
};

export async function sendLatestSnapshotFromCache(
    socket: ViewerEventEmitter,
    sessionId: string,
    generation: number | undefined,
    deps: ViewerCacheDeps = defaultViewerCacheDeps,
): Promise<boolean> {
    const snapshotEvent = await deps.getLatestCachedSnapshotEvent(sessionId);
    if (!snapshotEvent) return false;

    socket.emit("event", { event: snapshotEvent, replay: true, generation });
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
    if (opts.lastSeq !== undefined) {
        const deltaOk = await sendDeltaReplayFromCache(
            socket,
            sessionId,
            opts.lastSeq,
            opts.generation,
            deps,
        );
        if (deltaOk) return true;
    }

    return sendLatestSnapshotFromCache(socket, sessionId, opts.generation, deps);
}
