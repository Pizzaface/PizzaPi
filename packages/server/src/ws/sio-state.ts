// ============================================================================
// sio-state.ts — Redis CRUD helpers for Socket.IO registry state
//
// Low-level Redis hash operations for session/runner/terminal metadata.
// This module manages serialized state in Redis hashes with the following
// key patterns:
//
//   pizzapi:sio:session:{sessionId}     — session metadata (hash fields)
//   pizzapi:sio:runner:{runnerId}       — runner metadata (hash fields)
//   pizzapi:sio:terminal:{terminalId}   — terminal metadata (hash fields)
//   pizzapi:sio:seq:{sessionId}         — monotonic event sequence counter (string)
//   pizzapi:sio:runner-link:{sessionId} — pending runner link (string: runnerId)
//
// A separate Redis client is used (not the pub/sub pair used by the
// Socket.IO Redis adapter).
// ============================================================================

import { createClient, type RedisClientType } from "redis";
import { redisKey } from "../redis-prefix.js";

// ── Redis connection ────────────────────────────────────────────────────────

const REDIS_URL = process.env.PIZZAPI_REDIS_URL ?? "redis://localhost:6379";

let redis: RedisClientType | null = null;

/** Initialize a dedicated Redis client for Socket.IO state. */
export async function initStateRedis(): Promise<void> {
    redis = createClient({
        url: REDIS_URL,
        socket: {
            reconnectStrategy: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
        },
    }) as RedisClientType;

    redis.on("error", (err) => {
        console.error("[sio-state] Redis error:", err);
    });

    await redis.connect();
    console.log(`[sio-state] Redis connected at ${REDIS_URL}`);
}

/** Return the state Redis client (or null if not initialized). */
export function getStateRedis(): RedisClientType | null {
    return redis;
}

// ── Key helpers ─────────────────────────────────────────────────────────────

const KEY_BASE = "pizzapi:sio";

function sessionKey(sessionId: string): string {
    return redisKey(`${KEY_BASE}:session:${sessionId}`);
}

function runnerKey(runnerId: string): string {
    return redisKey(`${KEY_BASE}:runner:${runnerId}`);
}

function terminalKey(terminalId: string): string {
    return redisKey(`${KEY_BASE}:terminal:${terminalId}`);
}

function seqKey(sessionId: string): string {
    return redisKey(`${KEY_BASE}:seq:${sessionId}`);
}

function runnerLinkKey(sessionId: string): string {
    return redisKey(`${KEY_BASE}:runner-link:${sessionId}`);
}

/** Index key listing all session IDs for a given user. */
function userSessionsKey(userId: string): string {
    return redisKey(`${KEY_BASE}:user-sessions:${userId}`);
}

/** Global set of all active session IDs. */
function allSessionsKey(): string {
    return redisKey(`${KEY_BASE}:all-sessions`);
}

/** Index key listing all runner IDs for a given user. */
function userRunnersKey(userId: string): string {
    return redisKey(`${KEY_BASE}:user-runners:${userId}`);
}

/** Global set of all active runner IDs. */
function allRunnersKey(): string {
    return redisKey(`${KEY_BASE}:all-runners`);
}

/** Index key listing all terminal IDs for a given runner. */
function runnerTerminalsKey(runnerId: string): string {
    return redisKey(`${KEY_BASE}:runner-terminals:${runnerId}`);
}

// ── TTL constants ───────────────────────────────────────────────────────────

/** Default TTL for session keys (24 hours), refreshed on activity. */
const SESSION_TTL_SECONDS = 24 * 60 * 60;

/** Default TTL for runner keys (2 hours), refreshed on heartbeat. */
const RUNNER_TTL_SECONDS = 2 * 60 * 60;

/** Default TTL for terminal keys (1 hour). */
const TERMINAL_TTL_SECONDS = 60 * 60;

/** TTL for pending runner links (10 minutes). */
const RUNNER_LINK_TTL_SECONDS = 10 * 60;

/** TTL for index sets — slightly longer than the entity they track. */
const INDEX_TTL_SECONDS = 25 * 60 * 60;

// ── Data interfaces ─────────────────────────────────────────────────────────

export interface RedisSessionData {
    sessionId: string;
    token: string;
    collabMode: boolean;
    shareUrl: string;
    cwd: string;
    startedAt: string;
    userId: string | null;
    userName: string | null;
    sessionName: string | null;
    isEphemeral: boolean;
    expiresAt: string | null;
    isActive: boolean;
    lastHeartbeatAt: string | null;
    /** JSON-stringified heartbeat payload */
    lastHeartbeat: string | null;
    /** JSON-stringified session state */
    lastState: string | null;
    runnerId: string | null;
    runnerName: string | null;
    seq: number;
}

export interface RedisRunnerData {
    runnerId: string;
    userId: string | null;
    userName: string | null;
    name: string | null;
    /** JSON-stringified string[] */
    roots: string;
    /** JSON-stringified RunnerSkill[] */
    skills: string;
}

export interface RedisTerminalData {
    terminalId: string;
    runnerId: string;
    userId: string;
    spawned: boolean;
    exited: boolean;
    /** JSON-stringified TerminalSpawnOpts */
    spawnOpts: string;
}

// ── Internal serialization ──────────────────────────────────────────────────

/** Convert a data object to a flat Record<string, string> for Redis HSET. */
function toHashFields(data: Record<string, unknown>): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
        if (value === null || value === undefined) {
            fields[key] = "";
        } else if (typeof value === "boolean") {
            fields[key] = value ? "1" : "0";
        } else if (typeof value === "number") {
            fields[key] = String(value);
        } else {
            fields[key] = String(value);
        }
    }
    return fields;
}

function parseSessionFromHash(hash: Record<string, string>): RedisSessionData | null {
    if (!hash.sessionId) return null;
    return {
        sessionId: hash.sessionId,
        token: hash.token ?? "",
        collabMode: hash.collabMode === "1",
        shareUrl: hash.shareUrl ?? "",
        cwd: hash.cwd ?? "",
        startedAt: hash.startedAt ?? "",
        userId: hash.userId || null,
        userName: hash.userName || null,
        sessionName: hash.sessionName || null,
        isEphemeral: hash.isEphemeral === "1",
        expiresAt: hash.expiresAt || null,
        isActive: hash.isActive === "1",
        lastHeartbeatAt: hash.lastHeartbeatAt || null,
        lastHeartbeat: hash.lastHeartbeat || null,
        lastState: hash.lastState || null,
        runnerId: hash.runnerId || null,
        runnerName: hash.runnerName || null,
        seq: parseInt(hash.seq ?? "0", 10) || 0,
    };
}

function parseRunnerFromHash(hash: Record<string, string>): RedisRunnerData | null {
    if (!hash.runnerId) return null;
    return {
        runnerId: hash.runnerId,
        userId: hash.userId || null,
        userName: hash.userName || null,
        name: hash.name || null,
        roots: hash.roots || "[]",
        skills: hash.skills || "[]",
    };
}

function parseTerminalFromHash(hash: Record<string, string>): RedisTerminalData | null {
    if (!hash.terminalId) return null;
    return {
        terminalId: hash.terminalId,
        runnerId: hash.runnerId ?? "",
        userId: hash.userId ?? "",
        spawned: hash.spawned === "1",
        exited: hash.exited === "1",
        spawnOpts: hash.spawnOpts || "{}",
    };
}

// ── Ensure connected ────────────────────────────────────────────────────────

function requireRedis(): RedisClientType {
    if (!redis || !redis.isOpen) {
        throw new Error("[sio-state] Redis client not initialized or disconnected");
    }
    return redis;
}

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

// ── Terminal CRUD ───────────────────────────────────────────────────────────

export async function setTerminal(terminalId: string, data: RedisTerminalData): Promise<void> {
    const r = requireRedis();
    const key = terminalKey(terminalId);
    const fields = toHashFields(data as unknown as Record<string, unknown>);

    const multi = r.multi();
    multi.hSet(key, fields);
    multi.expire(key, TERMINAL_TTL_SECONDS);

    // Add to per-runner index
    multi.sAdd(runnerTerminalsKey(data.runnerId), terminalId);
    multi.expire(runnerTerminalsKey(data.runnerId), TERMINAL_TTL_SECONDS);

    await multi.exec();
}

export async function getTerminal(terminalId: string): Promise<RedisTerminalData | null> {
    const r = requireRedis();
    const hash = await r.hGetAll(terminalKey(terminalId));
    if (!hash || Object.keys(hash).length === 0) return null;
    return parseTerminalFromHash(hash);
}

export async function updateTerminalFields(
    terminalId: string,
    fields: Partial<RedisTerminalData>,
): Promise<void> {
    const r = requireRedis();
    const key = terminalKey(terminalId);
    const exists = await r.exists(key);
    if (!exists) return;

    const hashFields = toHashFields(fields as unknown as Record<string, unknown>);
    const multi = r.multi();
    multi.hSet(key, hashFields);
    multi.expire(key, TERMINAL_TTL_SECONDS);
    await multi.exec();
}

export async function deleteTerminal(terminalId: string): Promise<void> {
    const r = requireRedis();
    const terminal = await getTerminal(terminalId);

    const multi = r.multi();
    multi.del(terminalKey(terminalId));

    if (terminal?.runnerId) {
        multi.sRem(runnerTerminalsKey(terminal.runnerId), terminalId);
    }

    await multi.exec();
}

export async function getTerminalsForRunner(runnerId: string): Promise<RedisTerminalData[]> {
    const r = requireRedis();
    const terminalIds = await r.sMembers(runnerTerminalsKey(runnerId));
    if (terminalIds.length === 0) return [];

    const results: RedisTerminalData[] = [];
    const multi = r.multi();
    for (const id of terminalIds) {
        multi.hGetAll(terminalKey(id));
    }
    const responses = await multi.exec();

    for (const resp of responses) {
        const hash = resp as Record<string, string> | null;
        if (hash && typeof hash === "object" && Object.keys(hash).length > 0) {
            const parsed = parseTerminalFromHash(hash);
            if (parsed) results.push(parsed);
        }
    }

    return results;
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

    for (const sessionId of allIds) {
        const expiresAt = await r.hGet(sessionKey(sessionId), "expiresAt");
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
    for (const id of sessionIds) {
        const exists = await r.exists(sessionKey(id));
        if (!exists) {
            await r.sRem(allSessionsKey(), id);
        }
    }

    // Clean stale runner IDs from global index
    const runnerIds = await r.sMembers(allRunnersKey());
    for (const id of runnerIds) {
        const exists = await r.exists(runnerKey(id));
        if (!exists) {
            await r.sRem(allRunnersKey(), id);
        }
    }
}
