// ============================================================================
// sio-state/cleanup.ts — scanExpiredSessions, cleanStaleIndexEntries
// ============================================================================

import { requireRedis } from "./client.js";
import { allSessionsKey, sessionKey, allRunnersKey, runnerKey } from "./keys.js";

// ── Cleanup / scan ──────────────────────────────────────────────────────────

/**
 * Scan for expired session keys (based on expiresAt field) and return their IDs.
 * Redis TTL handles key expiration automatically, but this allows proactive
 * cleanup of sessions whose `expiresAt` has passed even if the Redis TTL
 * hasn't expired yet.
 */
export async function scanExpiredSessions(nowMs: number = Date.now()): Promise<string[]> {
    const r = requireRedis();
    const allIds = await r.sMembers(allSessionsKey());
    const expired: string[] = [];

    if (allIds.length === 0) return expired;

    // ⚡ Bolt: Pipeline the hGet requests to avoid N+1 Redis queries
    const multi = r.multi();
    for (const sessionId of allIds) {
        multi.hGet(sessionKey(sessionId), "expiresAt");
    }
    const results = await multi.exec();

    for (let i = 0; i < allIds.length; i++) {
        const sessionId = allIds[i];
        const expiresAt = results[i] as string | null;

        if (!expiresAt) continue;

        const expiresAtMs = Date.parse(expiresAt);
        if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
            expired.push(sessionId);
        }
    }

    return expired;
}

/**
 * Clean stale entries from index sets whose underlying keys no longer exist.
 * This handles cases where a Redis key expired via TTL but the index set
 * entry was not explicitly removed.
 */
export async function cleanStaleIndexEntries(): Promise<void> {
    const r = requireRedis();

    // Clean stale session IDs from global index
    const sessionIds = await r.sMembers(allSessionsKey());
    if (sessionIds.length > 0) {
        const multi = r.multi();
        for (const id of sessionIds) {
            multi.exists(sessionKey(id));
        }
        const existsResults = await multi.exec();
        const staleIds = sessionIds.filter((_: string, idx: number) => !existsResults[idx]);
        if (staleIds.length > 0) {
            await r.sRem(allSessionsKey(), staleIds);
        }
    }

    // Clean stale runner IDs from global index
    const runnerIds = await r.sMembers(allRunnersKey());
    if (runnerIds.length > 0) {
        const multi = r.multi();
        for (const id of runnerIds) {
            multi.exists(runnerKey(id));
        }
        const existsResults = await multi.exec();
        const staleIds = runnerIds.filter((_: string, idx: number) => !existsResults[idx]);
        if (staleIds.length > 0) {
            await r.sRem(allRunnersKey(), staleIds);
        }
    }
}
