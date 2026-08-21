/**
 * Viewer-presence gate for pure streaming deltas.
 *
 * `message_update` / `tool_execution_update` are the only relay events that
 * exist purely to animate a watching UI. Every other event type feeds durable
 * state, push notifications, or meta rooms, so those always publish.
 *
 * Why this is worth gating: each delta carries the CUMULATIVE in-progress
 * message (`AssistantMessageEvent.partial` is a full `AssistantMessage`, not
 * just the new characters). `publishSessionEvent` rPushes every one of them
 * into a 1000-entry Redis list and PUBLISHes it through the cluster adapter —
 * so a single long reply costs O(n²) bytes of cache writes and fan-out, even
 * when the room is empty. Night Shift does this all night to nobody.
 *
 * Why dropping them is safe: because each delta is cumulative, a viewer that
 * attaches mid-generation is repaired by the very next delta — it carries the
 * whole message so far, not a fragment. Skipping the publish also skips
 * `incrementSeq`, so no sequence gap is created and viewers never see a hole
 * that would trigger a resync. Session liveness is unaffected: the pipeline
 * already called `touchSessionActivity` (which extends ephemeral expiry and
 * refreshes the session TTL) before reaching the publish branch.
 *
 * Deliberately NOT gated: `trackThinkingDeltas` consumes `message_update`
 * server-side to bake thinking durations into the later `message_end`. It runs
 * before this gate and must keep seeing every delta, or unwatched sessions
 * would lose thinking times permanently in the cached transcript.
 */

import { getIo, viewerSessionRoom } from "../../sio-registry/context.js";
import { getViewerCount } from "../../sio-registry/sessions.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("viewer-gate");

/** Events that exist only to animate a live viewer. */
const DELTA_EVENTS = new Set(["message_update", "tool_execution_update"]);

/** How long a cluster-wide viewer count is trusted before re-querying. */
const CLUSTER_CACHE_TTL_MS = 2_000;

interface ClusterEntry {
    count: number;
    at: number;
    refreshing: boolean;
}

const clusterViewers = new Map<string, ClusterEntry>();

export function isDeltaEvent(type: unknown): boolean {
    return typeof type === "string" && DELTA_EVENTS.has(type);
}

/** Local (this-server-only) viewer sockets in a session's room. */
function localViewerCount(sessionId: string): number {
    try {
        const io = getIo();
        if (!io) return 0;
        return io.of("/viewer").adapter.rooms.get(viewerSessionRoom(sessionId))?.size ?? 0;
    } catch {
        return 0;
    }
}

/**
 * Refresh the cached cluster-wide count in the background.
 *
 * ponytail: fire-and-forget with a TTL rather than a maintained counter — the
 * only cost of a stale "0" is that a viewer on ANOTHER server misses up to
 * CLUSTER_CACHE_TTL_MS of deltas, which the next cumulative delta repairs.
 * Swap for adapter join/leave bookkeeping only if that window ever matters.
 */
function refreshClusterCount(sessionId: string, entry: ClusterEntry | undefined): void {
    if (entry?.refreshing) return;
    const next: ClusterEntry = entry ?? { count: -1, at: 0, refreshing: false };
    next.refreshing = true;
    clusterViewers.set(sessionId, next);
    void getViewerCount(sessionId)
        .then((presence) => {
            next.count = presence.kind === "count" ? presence.count : -1;
            next.at = presence.kind === "count" ? Date.now() : 0;
        })
        .catch((err) => {
            // Fail open: leave the count unknown so deltas keep flowing.
            next.count = -1;
            next.at = 0;
            log.warn(`viewer count refresh failed for ${sessionId}:`, err);
        })
        .finally(() => {
            next.refreshing = false;
        });
}

/**
 * True when a streaming delta should be published.
 *
 * Fail-open by design: anything unknown (io missing, count never resolved,
 * adapter error) publishes. Guessing "nobody is watching" wrong means a
 * visibly frozen session, which is far worse than a wasted write.
 */
export function shouldPublishDelta(sessionId: string): boolean {
    // Fast path: someone is attached to this server. No await, no Redis.
    if (localViewerCount(sessionId) > 0) return true;

    const entry = clusterViewers.get(sessionId);
    const fresh = entry && entry.at > 0 && Date.now() - entry.at < CLUSTER_CACHE_TTL_MS;
    if (!fresh) refreshClusterCount(sessionId, entry);

    // Only a confirmed, fresh zero suppresses. Unknown (-1) publishes.
    if (fresh && entry!.count === 0) return false;
    return true;
}

/** Drop cached presence for a session that has ended. */
export function forgetViewerGate(sessionId: string): void {
    clusterViewers.delete(sessionId);
}

/** Test seam. */
export function resetViewerGate(): void {
    clusterViewers.clear();
}
