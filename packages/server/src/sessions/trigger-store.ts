/**
 * Trigger history store — Redis-backed per-session trigger log.
 *
 * Uses the same Redis client as the relay event cache (sessions/redis.ts pattern).
 * Stores recent triggers (inbound and outbound) for observability
 * and the Triggers Panel UI.
 */

import { connectRedisClient, type RedisClient } from "../redis-client.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("trigger-store");

let _redis: RedisClient | null = null;
let _initPromise: Promise<RedisClient | null> | null = null;
let _injected = false;

// A failed connect must not be cached forever (e.g. Redis briefly
// unreachable at startup) — clearing _initPromise once it settles lets the
// next call retry connectRedisClient() instead of permanently returning null.
async function getClient(): Promise<RedisClient | null> {
    if (_injected) return _redis;
    if (_redis?.isOpen) return _redis;
    if (!_initPromise) {
        _initPromise = connectRedisClient().then(c => { _redis = c; return c; });
    }
    try {
        return await _initPromise;
    } finally {
        _initPromise = null;
    }
}

/** Inject a mock client for tests. */
export function _injectRedisForTesting(client: unknown): void {
    _redis = client as RedisClient;
    _initPromise = null;
    _injected = true;
}

/** Reset client state for tests. */
export function _resetRedisForTesting(): void {
    _redis = null;
    _initPromise = null;
    _injected = false;
}

/** A trigger history entry. */
export interface TriggerHistoryEntry {
    triggerId: string;
    type: string;
    source: string;
    summary?: string;
    payload: Record<string, unknown>;
    deliverAs: "steer" | "followUp";
    ts: string;
    direction: "inbound" | "outbound";
    response?: {
        action?: string;
        text?: string;
        ts: string;
    };
    /**
     * Epoch-ms captured by `pushTriggerHistory` the instant it is called,
     * before any Redis I/O. This is what `clearTriggerHistory`'s cutoff is
     * compared against — see that function's doc comment for why. Absent on
     * entries written before this field existed (treated as 0, i.e. always
     * "older" than any real cutoff).
     */
    recordedAt?: number;
}

const TRIGGER_HISTORY_KEY = (sessionId: string) => `pizzapi:triggers:history:${sessionId}`;
const TRIGGER_CLEARED_BEFORE_KEY = (sessionId: string) => `pizzapi:triggers:clearedBefore:${sessionId}`;
const MAX_HISTORY = 200;
const HISTORY_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// Raises the stored cutoff to ARGV[1] unless it's already higher — a clear
// that arrives out of order (e.g. retried, or overtaken by a newer one) must
// never drag the cutoff backward and un-hide history a later clear already hid.
const RAISE_CUTOFF_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1])) or 0
local candidate = tonumber(ARGV[1])
if candidate > current then
    redis.call('SET', KEYS[1], candidate)
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
`;

const RECORD_RESPONSE_SCRIPT = `
local entries = redis.call('LRANGE', KEYS[1], 0, ARGV[2] - 1)
for i, raw in ipairs(entries) do
    local ok, entry = pcall(cjson.decode, raw)
    if ok and type(entry) == 'table' and entry.triggerId == ARGV[1] then
        for arg = 3, #ARGV, 2 do
            if ARGV[arg] == raw then
                redis.call('LSET', KEYS[1], i - 1, ARGV[arg + 1])
                return 1
            end
        end
        return 0
    end
end
return 0
`;

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Push a trigger entry to the session's history list.
 * Trims to MAX_HISTORY and refreshes TTL.
 */
export async function pushTriggerHistory(
    sessionId: string,
    entry: TriggerHistoryEntry,
): Promise<void> {
    // Captured synchronously, before any Redis I/O (including the connect-on-
    // first-use await inside getClient()) — this must reflect the instant this
    // push was initiated, not whenever its write happens to land.
    const recordedAt = Date.now();
    const redis = await getClient();
    if (!redis) return;
    const key = TRIGGER_HISTORY_KEY(sessionId);
    const cutoffKey = TRIGGER_CLEARED_BEFORE_KEY(sessionId);
    try {
        await redis.lPush(key, JSON.stringify({ ...entry, recordedAt }));
        await redis.lTrim(key, 0, MAX_HISTORY - 1);
        await redis.expire(key, HISTORY_TTL_SECONDS);
        // Refresh the clear-cutoff marker's TTL in lockstep with the list's,
        // on every single push — a no-op if no clear has ever run (EXPIRE on
        // a missing key is a safe no-op). Without this, the marker (stamped
        // with its own fixed TTL once, by clearTriggerHistory) and the list
        // (whose TTL keeps getting pushed out by ongoing activity) can drift
        // apart: the marker lapses on its original timer while the list is
        // still very much alive, and any pre-clear entries that are still
        // physically present in the list reappear the moment the marker is
        // gone (see GM a8yAXXwa round 2). Tying both TTLs to "every push"
        // means they can only ever expire together.
        await redis.expire(cutoffKey, HISTORY_TTL_SECONDS);
    } catch (err) {
        log.warn("Failed to push trigger history:", err);
    }
}

/**
 * Get recent trigger history for a session.
 * Returns most recent first. Entries at or before the session's current
 * clear cutoff (set by `clearTriggerHistory`) are filtered out even though
 * they may still be physically present in the list — see that function for
 * why clearing doesn't delete them outright.
 */
export async function getTriggerHistory(
    sessionId: string,
    limit = 50,
): Promise<TriggerHistoryEntry[]> {
    const redis = await getClient();
    if (!redis) return [];
    const key = TRIGGER_HISTORY_KEY(sessionId);
    const cutoffKey = TRIGGER_CLEARED_BEFORE_KEY(sessionId);
    try {
        const [raw, cutoffRaw] = await Promise.all([
            redis.lRange(key, 0, limit - 1),
            redis.get(cutoffKey),
        ]);
        // `null` (no clear has ever run for this session) means "don't
        // filter by recordedAt at all" — entries written before this field
        // existed must keep showing up normally until an actual clear happens.
        const cutoff = cutoffRaw !== null ? Number(cutoffRaw) : null;
        return raw.map((s) => {
            try {
                return JSON.parse(s) as TriggerHistoryEntry;
            } catch {
                return null;
            }
        }).filter((e): e is TriggerHistoryEntry => e !== null && (cutoff === null || (e.recordedAt ?? 0) > cutoff));
    } catch (err) {
        log.warn("Failed to get trigger history:", err);
        return [];
    }
}

/**
 * Record a trigger response in the history.
 * Finds the matching entry by triggerId and updates it in place.
 */
export async function recordTriggerResponse(
    sessionId: string,
    triggerId: string,
    response: { action?: string; text?: string },
): Promise<void> {
    const redis = await getClient();
    if (!redis) return;
    const key = TRIGGER_HISTORY_KEY(sessionId);
    try {
        const updates = [triggerId, String(MAX_HISTORY)];
        const responseWithTimestamp = { ...response, ts: new Date().toISOString() };
        const raw = await redis.lRange(key, 0, MAX_HISTORY - 1);
        for (const serialized of raw) {
            try {
                const entry = JSON.parse(serialized) as TriggerHistoryEntry;
                if (entry.triggerId === triggerId) {
                    entry.response = responseWithTimestamp;
                    updates.push(serialized, JSON.stringify(entry));
                }
            } catch {
                // skip malformed entries
            }
        }
        await redis.eval(RECORD_RESPONSE_SCRIPT, {
            keys: [key],
            arguments: updates,
        });
    } catch (err) {
        log.warn("Failed to record trigger response:", err);
    }
}

/**
 * Clear trigger history for a session — called on a /new, /resume, or /fork
 * transition so the Triggers panel starts fresh for the new generation.
 *
 * `before` (epoch ms) is a cutoff supplied by the caller — the CLI captures
 * it synchronously at the moment it decides to transition, *before* firing
 * the (unawaited) DELETE request. Only entries recorded at-or-before that
 * instant are hidden; anything recorded after it survives no matter how long
 * the request itself took to arrive here. This is what closes the original
 * race: a blind delete, run whenever this function happened to finally be
 * invoked, could wipe out a new generation's history that had already landed
 * *before* this invocation but *after* the cutoff the caller actually meant
 * (see GM a8yAXXwa).
 *
 * `before` MUST already be expressed in the *relay's* clock, not the caller's
 * raw local clock — it is compared directly against `recordedAt`, which is
 * stamped by `pushTriggerHistory` using the relay's own `Date.now()`. A CLI
 * and the relay it talks to are different hosts with independently drifting
 * clocks; comparing a CLI-local timestamp against a relay-local one doesn't
 * establish real ordering (a CLI clock 10s behind lets recent pre-clear
 * entries survive the clear; a CLI clock 10s ahead combined with transit
 * delay can hide genuinely-new post-clear entries once the clamp below pulls
 * the cutoff back to receipt time). The fix is on the *caller's* side: it
 * must correct its local timestamp with the same relay-clock-offset tracking
 * already used for delink epoch filtering (see `serverClockOffset` /
 * `remote/connection.ts`'s `setServerClockOffset`, and how
 * `delink-management.ts` adds it to a raw local epoch before sending) before
 * calling this function — see `performSessionTransitionCleanup` in
 * `remote/lifecycle-handlers.ts` (see GM a8yAXXwa round 2). Once `before` is
 * in the relay's clock space, the clamp below is just a defensive guard
 * against a bogus/stale offset pushing the cutoff into the future, not the
 * primary ordering mechanism.
 *
 * `before` is optional for callers that predate this cutoff (and for any
 * other direct caller that doesn't track one) — omitting it falls back to
 * the original unconditional delete.
 */
export async function clearTriggerHistory(sessionId: string, before?: number): Promise<void> {
    const redis = await getClient();
    if (!redis) return;
    if (before === undefined || !Number.isFinite(before)) {
        const key = TRIGGER_HISTORY_KEY(sessionId);
        try {
            await redis.del(key);
        } catch (err) {
            log.warn("Failed to clear trigger history:", err);
        }
        return;
    }
    const clamped = Math.min(before, Date.now());
    const cutoffKey = TRIGGER_CLEARED_BEFORE_KEY(sessionId);
    try {
        await redis.eval(RAISE_CUTOFF_SCRIPT, {
            keys: [cutoffKey],
            arguments: [String(clamped), String(HISTORY_TTL_SECONDS)],
        });
    } catch (err) {
        log.warn("Failed to clear trigger history:", err);
    }
}

/** @deprecated Use `_resetRedisForTesting` instead. */
export function _resetTriggerStoreForTesting(): void {
    _resetRedisForTesting();
}
