// ============================================================================
// sio-state/sessions.ts — Session CRUD + sequence counter
// ============================================================================

import { requireRedis } from "./client.js";
import {
    sessionKey,
    seqKey,
    allSessionsKey,
    userSessionsKey,
} from "./keys.js";
import {
    SESSION_TTL_SECONDS,
    INDEX_TTL_SECONDS,
    type RedisSessionData,
    type RedisSessionSummaryData,
} from "./types.js";
import {
    toHashFields,
    parseSessionFromHash,
    parseSessionSummaryFromHash,
    rowToSummaryHash,
    SESSION_SUMMARY_FIELDS,
} from "./serialization.js";

// ── Session CRUD ────────────────────────────────────────────────────────────

export async function setSession(sessionId: string, data: RedisSessionData): Promise<void> {
    const r = requireRedis();
    const key = sessionKey(sessionId);
    const fields = toHashFields(data as unknown as Record<string, unknown>);

    const multi = r.multi();
    multi.hSet(key, fields);
    multi.expire(key, SESSION_TTL_SECONDS);

    // Add to global index
    multi.sAdd(allSessionsKey(), sessionId);
    multi.expire(allSessionsKey(), INDEX_TTL_SECONDS);

    // Add to per-user index if userId is present
    if (data.userId) {
        const uKey = userSessionsKey(data.userId);
        multi.sAdd(uKey, sessionId);
        multi.expire(uKey, INDEX_TTL_SECONDS);
    }

    await multi.exec();
}

export async function getSession(sessionId: string): Promise<RedisSessionData | null> {
    const r = requireRedis();
    const hash = await r.hGetAll(sessionKey(sessionId));
    if (!hash || Object.keys(hash).length === 0) return null;
    return parseSessionFromHash(hash);
}

/**
 * Fetch only the lightweight session summary fields for a single session.
 * Avoids pulling large lastState blobs from Redis on hot paths that only
 * need identity/liveness metadata.
 */
export async function getSessionSummary(sessionId: string): Promise<RedisSessionSummaryData | null> {
    const r = requireRedis();
    const key = sessionKey(sessionId);

    if (typeof (r as unknown as { hmGet?: unknown }).hmGet === "function") {
        const row = await (
            r as unknown as { hmGet: (key: string, fields: readonly string[]) => Promise<unknown> }
        ).hmGet(key, SESSION_SUMMARY_FIELDS);

        const hash = rowToSummaryHash(row);
        if (!hash || Object.keys(hash).length === 0) return null;
        return parseSessionSummaryFromHash(hash);
    }

    // Fallback for clients/mocks that do not expose hmGet.
    const hash = await r.hGetAll(key);
    if (!hash || Object.keys(hash).length === 0) return null;
    return parseSessionSummaryFromHash(hash);
}

export async function updateSessionFields(
    sessionId: string,
    fields: Partial<RedisSessionData>,
): Promise<void> {
    const r = requireRedis();
    const key = sessionKey(sessionId);
    const exists = await r.exists(key);
    if (!exists) return;

    const hashFields = toHashFields(fields as unknown as Record<string, unknown>);
    const multi = r.multi();
    multi.hSet(key, hashFields);
    multi.expire(key, SESSION_TTL_SECONDS); // refresh TTL on update
    await multi.exec();
}

/**
 * Like updateSessionFields but creates the hash if it doesn't exist yet.
 * Used when the session record may not have been registered by the TUI socket.
 */
export async function upsertSessionFields(
    sessionId: string,
    fields: Partial<RedisSessionData>,
): Promise<void> {
    const r = requireRedis();
    const key = sessionKey(sessionId);
    const hashFields = toHashFields(fields as unknown as Record<string, unknown>);
    const multi = r.multi();
    multi.hSet(key, hashFields);
    multi.expire(key, SESSION_TTL_SECONDS);
    await multi.exec();
}

export async function deleteSession(sessionId: string): Promise<void> {
    const r = requireRedis();
    const session = await getSession(sessionId);

    const multi = r.multi();
    multi.del(sessionKey(sessionId));
    multi.del(seqKey(sessionId));
    multi.sRem(allSessionsKey(), sessionId);

    if (session?.userId) {
        multi.sRem(userSessionsKey(session.userId), sessionId);
    }

    await multi.exec();
}

export async function getAllSessionSummaries(filterUserId?: string): Promise<RedisSessionSummaryData[]> {
    const r = requireRedis();

    let sessionIds: string[];
    if (filterUserId) {
        sessionIds = await r.sMembers(userSessionsKey(filterUserId));
    } else {
        sessionIds = await r.sMembers(allSessionsKey());
    }

    if (sessionIds.length === 0) return [];

    const results: RedisSessionSummaryData[] = [];
    const multi = r.multi();
    const supportsHmGet = typeof (multi as unknown as { hmGet?: unknown }).hmGet === "function";

    for (const id of sessionIds) {
        if (supportsHmGet) {
            // hmGet fetches only the requested fields, avoiding large lastState blobs.
            (multi as unknown as { hmGet: (key: string, fields: readonly string[]) => unknown }).hmGet(
                sessionKey(id),
                SESSION_SUMMARY_FIELDS,
            );
        } else {
            // Fallback for older/test clients that don't expose hmGet.
            multi.hGetAll(sessionKey(id));
        }
    }

    const responses = await multi.exec();

    for (const resp of responses) {
        const hash = rowToSummaryHash(resp);
        if (!hash || Object.keys(hash).length === 0) continue;

        const parsed = parseSessionSummaryFromHash(hash);
        if (!parsed) continue;
        if (filterUserId && parsed.userId !== filterUserId) continue;

        results.push(parsed);
    }

    return results;
}

export async function getAllSessions(filterUserId?: string): Promise<RedisSessionData[]> {
    const r = requireRedis();

    let sessionIds: string[];
    if (filterUserId) {
        sessionIds = await r.sMembers(userSessionsKey(filterUserId));
    } else {
        sessionIds = await r.sMembers(allSessionsKey());
    }

    if (sessionIds.length === 0) return [];

    const results: RedisSessionData[] = [];
    // Use pipeline for bulk fetch
    const multi = r.multi();
    for (const id of sessionIds) {
        multi.hGetAll(sessionKey(id));
    }
    const responses = await multi.exec();

    for (const resp of responses) {
        const hash = resp as Record<string, string> | null;
        if (hash && typeof hash === "object" && Object.keys(hash).length > 0) {
            const parsed = parseSessionFromHash(hash);
            if (parsed) {
                if (filterUserId && parsed.userId !== filterUserId) continue;
                results.push(parsed);
            }
        }
    }

    return results;
}

export async function refreshSessionTTL(sessionId: string): Promise<void> {
    const r = requireRedis();
    await r.expire(sessionKey(sessionId), SESSION_TTL_SECONDS);
}

// ── Sequence counter ────────────────────────────────────────────────────────

export async function incrementSeq(sessionId: string): Promise<number> {
    const r = requireRedis();
    const key = seqKey(sessionId);
    const seq = await r.incr(key);
    await r.expire(key, SESSION_TTL_SECONDS);
    return seq;
}

export async function getSeq(sessionId: string): Promise<number> {
    const r = requireRedis();
    const val = await r.get(seqKey(sessionId));
    return val ? parseInt(val, 10) : 0;
}
