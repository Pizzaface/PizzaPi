/**
 * Dead-runner detection for the unified trigger system (ADR-0002).
 *
 * A runner whose durable lastSeenAt is older than 7 days AND that has no live
 * socket on any relay node is dead. Its pending wake deliveries can never
 * drain (nothing will ever resume those sessions), so the sweep expires them
 * and sets a Redis marker so route listings can flag the runner. Routes are
 * NOT deleted — schedules are the user's; DELETE /api/runners/:id/routes is
 * the explicit bulk cleanup.
 */

import { createLogger } from "@pizzapi/tools";
import { countSocketsInRoomCluster, getIo, runnerRoom } from "../ws/sio-registry.js";
import { listRunnerOwners } from "../runner-owner.js";
import { listPendingWakeDeliveries, listRoutes, updateDelivery } from "./store.js";
import { getEventsRedis } from "./redis.js";

const log = createLogger("runner-liveness");

export const DEAD_RUNNER_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function deadMarkerKey(runnerId: string): string {
    return `pizzapi:runner:dead:${runnerId}`;
}

/** True only when the room is CONFIRMED empty (unknown = assume alive). */
async function runnerHasNoLiveSocket(runnerId: string): Promise<boolean> {
    const io = getIo();
    if (!io) return false;
    const presence = await countSocketsInRoomCluster(io.of("/runner"), runnerRoom(runnerId));
    return presence.kind === "count" && presence.count === 0;
}

/** Marker + no live presence. Returns the lastSeenAt stored in the marker. */
export async function runnerDeadSince(runnerId: string): Promise<string | null> {
    const redis = await getEventsRedis().catch(() => null);
    if (!redis) return null;
    let marker: string | null = null;
    try {
        marker = await redis.get(deadMarkerKey(runnerId));
    } catch (err) {
        log.warn(`dead-runner marker read failed for ${runnerId}:`, err);
        return null;
    }
    if (!marker) return null;
    // A runner that came back clears itself: live presence beats the marker.
    return (await runnerHasNoLiveSocket(runnerId)) ? marker : null;
}

/**
 * Sweep dead runners: expire their pending wake deliveries (guarded) and set
 * the marker. Re-runs are idempotent (nothing pending, marker re-set).
 * ponytail: the marker has no TTL and is never deleted — the conjunction
 * with live presence makes a stale marker harmless once the runner returns.
 */
export async function sweepDeadRunners(now = Date.now()): Promise<number> {
    const cutoff = new Date(now - DEAD_RUNNER_AFTER_MS).toISOString();
    const stale = (await listRunnerOwners()).filter((r) => r.lastSeenAt !== null && r.lastSeenAt < cutoff);
    if (stale.length === 0) return 0;
    const routes = await listRoutes();
    const redis = await getEventsRedis().catch(() => null);
    let dead = 0;
    for (const runner of stale) {
        if (!(await runnerHasNoLiveSocket(runner.runnerId))) continue;
        const sessionIds = routes
            .filter((r) => r.target.kind === "session" && r.target.runnerId === runner.runnerId)
            .map((r) => (r.target as { sessionId: string }).sessionId);
        let expired = 0;
        for (const d of await listPendingWakeDeliveries({ sessionIds })) {
            if (await updateDelivery(d.deliveryId, { status: "expired" }, { guard: ["pending"] })) expired++;
        }
        if (redis) {
            try {
                await redis.set(deadMarkerKey(runner.runnerId), runner.lastSeenAt ?? new Date(now).toISOString());
            } catch (err) {
                log.warn(`dead-runner marker write failed for ${runner.runnerId}:`, err);
            }
        }
        log.warn(
            `Runner ${runner.runnerId} is dead (last seen ${runner.lastSeenAt}, no live socket) — `
            + `expired ${expired} pending wake delivery(ies); its routes are kept and flagged`,
        );
        dead++;
    }
    return dead;
}
