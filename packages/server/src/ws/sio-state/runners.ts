// ============================================================================
// sio-state/runners.ts — Runner CRUD + runner association functions
// ============================================================================

import { requireRedis } from "./client.js";
import {
    runnerKey,
    runnerLinkKey,
    allRunnersKey,
    userRunnersKey,
    runnerAssocKey,
} from "./keys.js";
import {
    RUNNER_TTL_SECONDS,
    INDEX_TTL_SECONDS,
    RUNNER_LINK_TTL_SECONDS,
    RUNNER_ASSOC_TTL_SECONDS,
    type RedisRunnerData,
} from "./types.js";
import { toHashFields, parseRunnerFromHash } from "./serialization.js";

// ── Runner CRUD ─────────────────────────────────────────────────────────────

export async function setRunner(runnerId: string, data: RedisRunnerData): Promise<void> {
    const r = requireRedis();
    const key = runnerKey(runnerId);
    const fields = toHashFields(data as unknown as Record<string, unknown>);

    const multi = r.multi();
    multi.hSet(key, fields);
    multi.expire(key, RUNNER_TTL_SECONDS);

    // Add to global index
    multi.sAdd(allRunnersKey(), runnerId);
    multi.expire(allRunnersKey(), INDEX_TTL_SECONDS);

    // Add to per-user index if userId is present
    if (data.userId) {
        const uKey = userRunnersKey(data.userId);
        multi.sAdd(uKey, runnerId);
        multi.expire(uKey, INDEX_TTL_SECONDS);
    }

    await multi.exec();
}

export async function getRunner(runnerId: string): Promise<RedisRunnerData | null> {
    const r = requireRedis();
    const hash = await r.hGetAll(runnerKey(runnerId));
    if (!hash || Object.keys(hash).length === 0) return null;
    return parseRunnerFromHash(hash);
}

export async function updateRunnerFields(
    runnerId: string,
    fields: Partial<RedisRunnerData>,
): Promise<void> {
    const r = requireRedis();
    const key = runnerKey(runnerId);
    const exists = await r.exists(key);
    if (!exists) return;

    const hashFields = toHashFields(fields as unknown as Record<string, unknown>);
    const multi = r.multi();
    multi.hSet(key, hashFields);
    multi.expire(key, RUNNER_TTL_SECONDS);
    await multi.exec();
}

export async function deleteRunner(runnerId: string): Promise<void> {
    const r = requireRedis();
    const runner = await getRunner(runnerId);

    const multi = r.multi();
    multi.del(runnerKey(runnerId));
    multi.sRem(allRunnersKey(), runnerId);

    if (runner?.userId) {
        multi.sRem(userRunnersKey(runner.userId), runnerId);
    }

    await multi.exec();
}

export async function getAllRunners(filterUserId?: string): Promise<RedisRunnerData[]> {
    const r = requireRedis();

    let runnerIds: string[];
    if (filterUserId) {
        runnerIds = await r.sMembers(userRunnersKey(filterUserId));
    } else {
        runnerIds = await r.sMembers(allRunnersKey());
    }

    if (runnerIds.length === 0) return [];

    const results: RedisRunnerData[] = [];
    const multi = r.multi();
    for (const id of runnerIds) {
        multi.hGetAll(runnerKey(id));
    }
    const responses = await multi.exec();

    for (const resp of responses) {
        const hash = resp as Record<string, string> | null;
        if (hash && typeof hash === "object" && Object.keys(hash).length > 0) {
            const parsed = parseRunnerFromHash(hash);
            if (parsed) {
                if (filterUserId && parsed.userId !== filterUserId) continue;
                results.push(parsed);
            }
        }
    }

    return results;
}

export async function refreshRunnerTTL(runnerId: string): Promise<void> {
    const r = requireRedis();
    await r.expire(runnerKey(runnerId), RUNNER_TTL_SECONDS);
}

// ── Pending runner links ────────────────────────────────────────────────────

export async function setPendingRunnerLink(sessionId: string, runnerId: string): Promise<void> {
    const r = requireRedis();
    await r.set(runnerLinkKey(sessionId), runnerId, { EX: RUNNER_LINK_TTL_SECONDS });
}

export async function getPendingRunnerLink(sessionId: string): Promise<string | null> {
    const r = requireRedis();
    return await r.get(runnerLinkKey(sessionId));
}

export async function deletePendingRunnerLink(sessionId: string): Promise<void> {
    const r = requireRedis();
    await r.del(runnerLinkKey(sessionId));
}

// ── Runner association (survives server restart) ────────────────────────────
// Durable Redis key that records which runner a session belongs to.
// Unlike the session hash (which is deleted on relay disconnect), this key
// persists across server restarts so that reconnecting TUI agents can
// restore their runner association.  Deleted explicitly on graceful
// session_end or when a session is unlinked from its runner.

/** Store the runner association for a session. */
export async function setRunnerAssociation(
    sessionId: string,
    runnerId: string,
    runnerName: string | null,
): Promise<void> {
    const r = requireRedis();
    const value = JSON.stringify({ runnerId, runnerName });
    await r.set(runnerAssocKey(sessionId), value, { EX: RUNNER_ASSOC_TTL_SECONDS });
}

/** Get the runner association for a session, if it exists. */
export async function getRunnerAssociation(
    sessionId: string,
): Promise<{ runnerId: string; runnerName: string | null } | null> {
    const r = requireRedis();
    const value = await r.get(runnerAssocKey(sessionId));
    if (!value) return null;
    try {
        const parsed = JSON.parse(value);
        if (typeof parsed.runnerId === "string") {
            return {
                runnerId: parsed.runnerId,
                runnerName: typeof parsed.runnerName === "string" ? parsed.runnerName : null,
            };
        }
        return null;
    } catch {
        return null;
    }
}

/** Delete the runner association for a session. */
export async function deleteRunnerAssociation(sessionId: string): Promise<void> {
    const r = requireRedis();
    await r.del(runnerAssocKey(sessionId));
}

/** Refresh the TTL on an existing runner association key. */
export async function refreshRunnerAssociationTTL(sessionId: string): Promise<void> {
    const r = requireRedis();
    await r.expire(runnerAssocKey(sessionId), RUNNER_ASSOC_TTL_SECONDS);
}
