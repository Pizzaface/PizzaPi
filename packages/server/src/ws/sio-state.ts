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

// ── Redis connection ────────────────────────────────────────────────────────

// Read lazily so the value is resolved at connect-time, not module-load time.
function getRedisUrl(): string { return process.env.PIZZAPI_REDIS_URL ?? "redis://localhost:6379"; }

let redis: RedisClientType | null = null;

/**
 * Initialize a dedicated Redis client for Socket.IO state.
 *
 * @param createClientOverride — Optional override for `createClient`.  The test
 *   harness passes the real function captured at preload time so that
 *   `initStateRedis()` is immune to `mock.module("redis", …)` contamination
 *   from other test files in the same Bun worker.
 */
export async function initStateRedis(createClientOverride?: typeof createClient): Promise<void> {
    const factory = createClientOverride ?? createClient;
    redis = factory({
        url: getRedisUrl(),
        socket: {
            reconnectStrategy: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
        },
    }) as RedisClientType;

    redis.on("error", (err) => {
        console.error("[sio-state] Redis error:", err);
    });

    await redis.connect();
    console.log(`[sio-state] Redis connected at ${getRedisUrl()}`);
}

/** Return the state Redis client (or null if not initialized). */
export function getStateRedis(): RedisClientType | null {
    return redis;
}

/**
 * Close the dedicated state Redis client and reset the module-level reference.
 * Safe to call even if no client was initialized (no-op in that case).
 */
export async function closeStateRedis(): Promise<void> {
    if (redis) {
        await redis.quit();
        redis = null;
    }
}

// ── Key helpers ─────────────────────────────────────────────────────────────

const KEY_PREFIX = "pizzapi:sio";

function sessionKey(sessionId: string): string {
    return `${KEY_PREFIX}:session:${sessionId}`;
}

function runnerKey(runnerId: string): string {
    return `${KEY_PREFIX}:runner:${runnerId}`;
}

function terminalKey(terminalId: string): string {
    return `${KEY_PREFIX}:terminal:${terminalId}`;
}

function seqKey(sessionId: string): string {
    return `${KEY_PREFIX}:seq:${sessionId}`;
}

function runnerLinkKey(sessionId: string): string {
    return `${KEY_PREFIX}:runner-link:${sessionId}`;
}

/** Index key listing all session IDs for a given user. */
function userSessionsKey(userId: string): string {
    return `${KEY_PREFIX}:user-sessions:${userId}`;
}

/** Global set of all active session IDs. */
function allSessionsKey(): string {
    return `${KEY_PREFIX}:all-sessions`;
}

/** Index key listing all runner IDs for a given user. */
function userRunnersKey(userId: string): string {
    return `${KEY_PREFIX}:user-runners:${userId}`;
}

/** Global set of all active runner IDs. */
function allRunnersKey(): string {
    return `${KEY_PREFIX}:all-runners`;
}

/** Index key listing all terminal IDs for a given runner. */
function runnerTerminalsKey(runnerId: string): string {
    return `${KEY_PREFIX}:runner-terminals:${runnerId}`;
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
    /** ID of the parent session that spawned this one, or null for top-level. */
    parentSessionId: string | null;
    /**
     * Durable "is this a linked child?" signal.
     *
     * Set to the parent session ID when the child first links to a parent.
     * Unlike `parentSessionId`, this is NOT cleared when the parent is
     * transiently offline during a child reconnect — it is only cleared on an
     * explicit delink (delink_children / delink_own_parent) or a cross-user
     * link attempt. Absent on sessions created before this field was added;
     * callers fall back to `parentSessionId` in that case.
     */
    linkedParentId?: string | null;
    /** JSON-stringified SessionMetaState. Written by updateSessionMetaState.
     *  Absent for sessions created before this feature; callers must use
     *  defaultMetaState() as fallback. */
    metaState?: string | null;
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
    /** JSON-stringified RunnerAgent[] */
    agents?: string;
    /** JSON-stringified PluginInfo[] — discovered Claude Code plugins */
    plugins?: string;
    /** JSON-stringified RunnerHook[] — active hooks configured on the runner */
    hooks?: string;
    /** Runner CLI version (e.g. "0.1.30") */
    version: string | null;
    /** Node.js process.platform value (e.g. "darwin", "linux", "win32") */
    platform?: string | null;
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
        parentSessionId: hash.parentSessionId || null,
        linkedParentId: hash.linkedParentId || null,
        metaState: hash.metaState || null,
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
        agents: hash.agents || "[]",
        plugins: hash.plugins || "[]",
        hooks: hash.hooks || "[]",
        version: hash.version || null,
        platform: hash.platform || null,
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

// ── Runner association (survives server restart) ────────────────────────────
// Durable Redis key that records which runner a session belongs to.
// Unlike the session hash (which is deleted on relay disconnect), this key
// persists across server restarts so that reconnecting TUI agents can
// restore their runner association.  Deleted explicitly on graceful
// session_end or when a session is unlinked from its runner.

/** TTL for runner association keys — matches session TTL (24 hours). */
const RUNNER_ASSOC_TTL_SECONDS = 24 * 60 * 60;

function runnerAssocKey(sessionId: string): string {
    return `${KEY_PREFIX}:runner-assoc:${sessionId}`;
}

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

// ── Child session index ─────────────────────────────────────────────────────
// Tracks which child sessions belong to a parent session.

/** Set of child session IDs for a parent session. */
function childrenKey(parentSessionId: string): string {
    return `${KEY_PREFIX}:children:${parentSessionId}`;
}

/** Record a child session under its parent. */
export async function addChildSession(parentSessionId: string, childSessionId: string): Promise<void> {
    const r = requireRedis();
    // Read the delink marker value BEFORE the transaction — if the marker stores
    // the former parent's session ID, we can scrub the child from that parent's
    // pending-delink retry set in the same atomic multi.  This prevents a child
    // that was delinked from P1 and is now being (re)linked to P2 from being
    // severed again when P1 next runs /new and re-processes its retry set.
    const formerParentId = await r.get(delinkMarkerKey(childSessionId));
    const multi = r.multi();
    multi.sAdd(childrenKey(parentSessionId), childSessionId);
    multi.expire(childrenKey(parentSessionId), SESSION_TTL_SECONDS);
    // Clear any stale delink marker — a new legitimate parent link supersedes
    // any previous delink.  The marker is kept alive in registerTuiSession
    // (not consumed on first check) so that reconnect races are idempotent;
    // clearing it here when a new link is explicitly created is the safe place.
    multi.del(delinkMarkerKey(childSessionId));
    // If the former parent's ID was stored in the marker value (non-empty, non-"1"),
    // remove the child from that parent's pending-delink retry set atomically.
    if (formerParentId && formerParentId !== "1") {
        multi.sRem(pendingDelinkChildrenKey(formerParentId), childSessionId);
    }
    await multi.exec();
}

/**
 * Add a child to the parent's membership set WITHOUT clearing any delink marker.
 *
 * Used when the parent is transiently offline during the child's reconnect —
 * we still want future `delink_children` snapshots to include this child, but
 * we must not clear the delink marker (which could have been set by a previous
 * /new and should still take effect when the parent reconnects).
 */
export async function addChildSessionMembership(parentSessionId: string, childSessionId: string): Promise<void> {
    const r = requireRedis();
    const multi = r.multi();
    multi.sAdd(childrenKey(parentSessionId), childSessionId);
    multi.expire(childrenKey(parentSessionId), SESSION_TTL_SECONDS);
    await multi.exec();
}

/** Get all child session IDs for a parent. */
export async function getChildSessions(parentSessionId: string): Promise<string[]> {
    const r = requireRedis();
    return r.sMembers(childrenKey(parentSessionId));
}

/** Check whether a session is still listed as a child of the given parent.
 *  Returns false if delink_children was called (which clears the set).
 *
 *  Fallback: if the Redis children set has expired (24 h TTL) but the child's
 *  session hash still records `parentSessionId` pointing at this parent, the
 *  relationship is still live.  We re-hydrate the set in that case so that
 *  subsequent calls are fast again (self-healing after TTL expiry). */
export async function isChildOfParent(parentSessionId: string, childSessionId: string): Promise<boolean> {
    const r = requireRedis();
    const inSet = await r.sIsMember(childrenKey(parentSessionId), childSessionId);
    if (inSet) return true;

    // If the parent explicitly delinked this child (via /new), we may have
    // already cleared the children set while the child's session hash still
    // temporarily carries parentSessionId. In that window we must NOT fall
    // back to the hash, otherwise we'd re-hydrate the set and re-authorize
    // stale parent/child traffic.
    if (await isChildDelinked(childSessionId)) return false;

    // Fallback: the Redis children set may have expired without an explicit
    // delink.  Verify via the child's durable session hash.
    const childSession = await getSession(childSessionId);
    if (childSession?.parentSessionId === parentSessionId) {
        // Re-hydrate the children set and reset its TTL so future checks are
        // fast and the delink guard (clearAllChildren / clearParentSessionId)
        // still works correctly.
        const multi = r.multi();
        multi.sAdd(childrenKey(parentSessionId), childSessionId);
        multi.expire(childrenKey(parentSessionId), SESSION_TTL_SECONDS);
        await multi.exec();
        return true;
    }

    return false;
}

/**
 * Liveness check for push-notification suppression.
 *
 * Unlike `isChildOfParent` (which is an authorization helper with TTL-recovery
 * semantics), this function is designed specifically for suppression decisions:
 *
 *   1. Explicitly delinked → false (suppress stops immediately).
 *   2. Child is in the parent's membership set → true (parent online OR
 *      temporarily offline with membership preserved via addChildSessionMembership).
 *   3. Set miss: fall back to parent-key existence in Redis.  This covers the
 *      case where the membership set has expired but the parent hasn't crashed
 *      (same SESSION_TTL_SECONDS bound).  Once the parent key expires, this
 *      returns false and suppression stops.
 *
 * `linkedParentId` is used as the parent reference so the check is durable
 * through parent-offline reconnects where `parentSessionId` is cleared to null.
 */
export async function isLinkedChildForSuppression(parentSessionId: string, childSessionId: string): Promise<boolean> {
    if (await isChildDelinked(childSessionId)) return false;

    const r = requireRedis();

    // Fast path: membership set is the primary liveness signal.
    const inSet = await r.sIsMember(childrenKey(parentSessionId), childSessionId);
    if (inSet) return true;

    // Membership set expired — fall back to parent-key existence.
    // If the parent's Redis key is still present, the session either recently
    // disconnected or is still active; continue suppressing.
    // If the key is gone (crashed without delink_children, TTL expired), stop.
    return (await r.exists(sessionKey(parentSessionId))) > 0;
}

/** Refresh the TTL on an existing parent→children membership set. */
export async function refreshChildSessionsTTL(parentSessionId: string): Promise<void> {
    const r = requireRedis();
    await r.expire(childrenKey(parentSessionId), SESSION_TTL_SECONDS);
}

/** Children that still need a parent_delinked notification retry for a parent. */
function pendingDelinkChildrenKey(parentSessionId: string): string {
    return `${KEY_PREFIX}:pending-delink-children:${parentSessionId}`;
}

export async function addPendingParentDelinkChildren(parentSessionId: string, childIds: string[]): Promise<void> {
    if (childIds.length === 0) return;
    const r = requireRedis();
    const multi = r.multi();
    multi.sAdd(pendingDelinkChildrenKey(parentSessionId), childIds);
    multi.expire(pendingDelinkChildrenKey(parentSessionId), SESSION_TTL_SECONDS);
    await multi.exec();
}

export async function getPendingParentDelinkChildren(parentSessionId: string): Promise<string[]> {
    const r = requireRedis();
    return r.sMembers(pendingDelinkChildrenKey(parentSessionId));
}

export async function removePendingParentDelinkChild(parentSessionId: string, childSessionId: string): Promise<void> {
    const r = requireRedis();
    await r.sRem(pendingDelinkChildrenKey(parentSessionId), childSessionId);
}

export async function isPendingParentDelinkChild(parentSessionId: string, childSessionId: string): Promise<boolean> {
    const r = requireRedis();
    const member = await r.sIsMember(pendingDelinkChildrenKey(parentSessionId), childSessionId);
    return Boolean(member);
}

// ── Per-child delink markers ─────────────────────────────────────────────────
// When delink_children fires (e.g. parent ran /new), we write a TTL'd marker
// for each child.  registerTuiSession checks this on the child's next reconnect
// and refuses to restore the link, even if the child is still carrying the old
// parentSessionId in memory (e.g. it was offline during the delink and never
// received parent_delinked). The marker is NOT consumed on first reconnect —
// it persists so that reconnect races are idempotent (if the socket drops
// after the check but before the child receives `registered`, the next
// reconnect will still see the marker). The marker is cleared when a new
// legitimate parent link is established via addChildSession(), or expires
// via TTL for children that are never re-linked.

const DELINK_MARKER_TTL_SECONDS = 30 * 24 * 3600; // 30 days — cleared by addChildSession or TTL expiry

function delinkMarkerKey(childSessionId: string): string {
    return `${KEY_PREFIX}:delinked:${childSessionId}`;
}

/**
 * Mark a child as explicitly delinked by the given parent.
 *
 * The parent session ID is stored as the marker value so that
 * `addChildSession` can atomically remove the child from the former
 * parent's `pending-delink-children` set when the child is re-linked to
 * a new parent.  Consumers that only need the boolean check can continue
 * to use `isChildDelinked()`.
 */
export async function markChildAsDelinked(childSessionId: string, byParentSessionId: string): Promise<void> {
    const r = requireRedis();
    await r.set(delinkMarkerKey(childSessionId), byParentSessionId, { EX: DELINK_MARKER_TTL_SECONDS });
}

/** Check if a child has a pending delink marker. */
export async function isChildDelinked(childSessionId: string): Promise<boolean> {
    const r = requireRedis();
    return (await r.exists(delinkMarkerKey(childSessionId))) > 0;
}

/** Consume (delete) the delink marker for a child. */
export async function clearDelinkedMark(childSessionId: string): Promise<void> {
    const r = requireRedis();
    await r.del(delinkMarkerKey(childSessionId));
}

/** Remove a child from its parent's children set. */
export async function removeChildSession(parentSessionId: string, childSessionId: string): Promise<void> {
    const r = requireRedis();
    await r.sRem(childrenKey(parentSessionId), childSessionId);
}

/** Remove all children from a parent's children set. Returns the removed child IDs. */
export async function clearAllChildren(parentSessionId: string): Promise<string[]> {
    const r = requireRedis();
    const children = await r.sMembers(childrenKey(parentSessionId));
    if (children.length > 0) {
        await r.del(childrenKey(parentSessionId));
    }
    return children;
}

/**
 * Remove only the specified children from a parent's children set.
 * Unlike clearAllChildren(), this is safe against races where a new child
 * is added between snapshot and removal — the new child stays in the set.
 */
export async function removeChildren(parentSessionId: string, childIds: string[]): Promise<void> {
    if (childIds.length === 0) return;
    const r = requireRedis();
    await r.sRem(childrenKey(parentSessionId), childIds);
}

/** Clear the parentSessionId and linkedParentId fields on a child session's Redis hash. */
export async function clearParentSessionId(childSessionId: string): Promise<void> {
    const r = requireRedis();
    // Clear both the active link (parentSessionId) and the durable linked-child
    // signal (linkedParentId) so that push-notification suppression correctly
    // stops for sessions that have been explicitly delinked.
    await r.hSet(sessionKey(childSessionId), { parentSessionId: "", linkedParentId: "" });
}

// ── Push pending question tracking ──────────────────────────────────────────
// Short-lived Redis key set when a push notification is sent for an
// AskUserQuestion, cleared when the tool execution ends. Used by
// /api/push/answer to reject stale or mismatched push replies.

function pushPendingKey(sessionId: string): string {
    return `pizzapi:push-pending:${sessionId}`;
}

/** Record the toolCallId of the currently pending push-notified question. */
export async function setPushPendingQuestion(sessionId: string, toolCallId: string): Promise<void> {
    const r = requireRedis();
    // Auto-expire after 24 hours (safety net — cleared explicitly on tool end,
    // session end, and disconnect). Long TTL accommodates users who are away
    // and respond to the push notification much later.
    await r.set(pushPendingKey(sessionId), toolCallId, { EX: 86400 });
}

/** Get the currently pending push-notified toolCallId, or null. */
export async function getPushPendingQuestion(sessionId: string): Promise<string | null> {
    const r = requireRedis();
    return r.get(pushPendingKey(sessionId));
}

/**
 * Atomically consume the pending push-notified toolCallId **only if it
 * matches the expected value**. Returns true if consumed, false otherwise.
 * Uses a Lua script for atomic compare-and-delete — prevents:
 * - Replay/duplicate submissions (single-use)
 * - Stale requests from burning the real pending key (compare before delete)
 */
export async function consumePushPendingQuestionIfMatches(
    sessionId: string,
    expectedToolCallId: string,
): Promise<boolean> {
    const r = requireRedis();
    const script = `
        local val = redis.call('GET', KEYS[1])
        if val == ARGV[1] then
            redis.call('DEL', KEYS[1])
            return 1
        end
        return 0
    `;
    const result = await r.eval(script, {
        keys: [pushPendingKey(sessionId)],
        arguments: [expectedToolCallId],
    });
    return result === 1;
}

/**
 * Clear the push-pending question (tool execution ended).
 * When `toolCallId` is provided, only clears if it matches the stored value —
 * prevents a cancelled/overlapping AskUserQuestion from clearing the active one's key.
 */
export async function clearPushPendingQuestion(sessionId: string, toolCallId?: string): Promise<void> {
    const r = requireRedis();
    if (toolCallId) {
        // Atomic compare-and-delete: only clear if the stored value matches
        const script = `
            if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('DEL', KEYS[1])
            end
            return 0
        `;
        await r.eval(script, { keys: [pushPendingKey(sessionId)], arguments: [toolCallId] });
    } else {
        // Unconditional clear (session teardown paths)
        await r.del(pushPendingKey(sessionId));
    }
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
        const staleIds = sessionIds.filter((_, idx) => !existsResults[idx]);
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
        const staleIds = runnerIds.filter((_, idx) => !existsResults[idx]);
        if (staleIds.length > 0) {
            await r.sRem(allRunnersKey(), staleIds);
        }
    }
}
