import { Buffer } from "node:buffer";
import { connectRedisClient, isRedisDisabled, redisUrl, type RedisClient } from "../redis-client.js";
import { getEphemeralTtlMs } from "./store.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("redis");

const DEFAULT_EVENT_BUFFER_SIZE = 1000;
const DEFAULT_EVENT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SNAPSHOT_SCAN_CHUNK_SIZE = 64;
const GAP_MARKER = "oversize";

export interface CachedRelayEventRecord {
    seq?: number;
    event: unknown;
}

interface ParsedCachedRelayEventRecord {
    seq?: number;
    event?: unknown;
    gap?: typeof GAP_MARKER;
}

function isSnapshotEvent(event: unknown): event is Record<string, unknown> {
    if (!event || typeof event !== "object") return false;
    const evt = event as Record<string, unknown>;
    if (evt.type === "agent_end") {
        return Array.isArray(evt.messages);
    }
    if (evt.type === "session_active") {
        return Object.prototype.hasOwnProperty.call(evt, "state") && evt.state !== undefined;
    }
    return false;
}

function isFullSnapshotEvent(event: unknown): boolean {
    if (!event || typeof event !== "object") return false;
    const evt = event as Record<string, unknown>;
    if (evt.type === "agent_end") return Array.isArray(evt.messages);
    if (evt.type !== "session_active") return false;
    const state = evt.state;
    if (!state || typeof state !== "object" || Array.isArray(state)) return false;
    const snapshot = state as Record<string, unknown>;
    return snapshot.chunked !== true && Array.isArray(snapshot.messages);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function eventBufferSize(): number {
    return parsePositiveInt(process.env.PIZZAPI_RELAY_EVENT_BUFFER_SIZE, DEFAULT_EVENT_BUFFER_SIZE);
}

function eventCacheMaxBytes(): number {
    return parsePositiveInt(process.env.PIZZAPI_RELAY_EVENT_CACHE_MAX_BYTES, DEFAULT_EVENT_CACHE_MAX_BYTES);
}

function nonEphemeralEventTtlMs(): number {
    return parsePositiveInt(process.env.PIZZAPI_RELAY_EVENT_TTL_MS, DEFAULT_EVENT_TTL_MS);
}

function ttlMsForSession(isEphemeral: boolean | undefined): number {
    return isEphemeral === false ? nonEphemeralEventTtlMs() : getEphemeralTtlMs();
}

function snapshotScanChunkSize(): number {
    return parsePositiveInt(process.env.PIZZAPI_RELAY_SNAPSHOT_SCAN_CHUNK_SIZE, DEFAULT_SNAPSHOT_SCAN_CHUNK_SIZE);
}

function eventsKey(sessionId: string): string {
    return `pizzapi:relay:session:${sessionId}:events`;
}

function eventsBytesKey(sessionId: string): string {
    return `${eventsKey(sessionId)}:bytes`;
}

function stringifyCachedPayload(payload: ParsedCachedRelayEventRecord): { json: string; bytes: number } {
    const json = JSON.stringify(payload);
    return { json, bytes: Buffer.byteLength(json, "utf8") };
}

const APPEND_AND_TRIM_SCRIPT = `
local listKey = KEYS[1]
local bytesKey = KEYS[2]
local payload = ARGV[1]
local payloadBytes = tonumber(ARGV[2]) or string.len(payload)
local maxCount = tonumber(ARGV[3]) or 1000
local maxBytes = tonumber(ARGV[4]) or 8388608
local ttlMs = tonumber(ARGV[5]) or 600000
local compactSnapshot = ARGV[6] == "1"

-- Superseded snapshots and legacy caches have no history worth retaining.
-- Delete the list directly rather than materializing every old row in Lua.
if compactSnapshot or redis.call("EXISTS", bytesKey) == 0 or redis.call("EXISTS", listKey) == 0 then
  redis.call("DEL", listKey, bytesKey)
end

redis.call("RPUSH", listKey, payload)
local total = redis.call("INCRBY", bytesKey, payloadBytes)

while redis.call("LLEN", listKey) > maxCount do
  local row = redis.call("LPOP", listKey)
  if row then total = total - string.len(row) end
end

while total > maxBytes and redis.call("LLEN", listKey) > 1 do
  local row = redis.call("LPOP", listKey)
  if row then total = total - string.len(row) else break end
end

if total < 0 then total = 0 end
redis.call("SET", bytesKey, total)
redis.call("PEXPIRE", listKey, ttlMs)
redis.call("PEXPIRE", bytesKey, ttlMs)
return total
`;

let _redis: RedisClient | null = null;
let _initPromise: Promise<RedisClient | null> | null = null;

// A failed connect must not be cached forever (e.g. Redis briefly
// unreachable at startup) — clearing _initPromise once it settles lets the
// next call retry connectRedisClient() instead of permanently returning null.
async function getClient(): Promise<RedisClient | null> {
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
}

/** Reset client state for tests. */
export function _resetRedisForTesting(): void {
    _redis = null;
    _initPromise = null;
}

let unavailableLogged = false;

function logUnavailableOnce(message: string, error?: unknown) {
    if (unavailableLogged) return;
    unavailableLogged = true;
    if (error) {
        log.warn(`${message}:`, error);
    } else {
        log.warn(message);
    }
}

export async function initializeRelayRedisCache(): Promise<void> {
    if (isRedisDisabled()) {
        log.info("Relay Redis cache disabled (PIZZAPI_REDIS_URL=off).");
        return;
    }

    const redis = await getClient();
    if (redis) {
        unavailableLogged = false;
        log.info(`Relay Redis cache connected at ${redisUrl()}.`);
    } else {
        logUnavailableOnce("Relay Redis cache unavailable; continuing without event replay");
    }
}

export async function appendRelayEventToCache(
    sessionId: string,
    event: unknown,
    opts: { isEphemeral?: boolean; seq?: number } = {},
): Promise<void> {
    if (isRedisDisabled()) return;

    const redis = await getClient();
    if (!redis) return;

    const maxBytes = eventCacheMaxBytes();
    const compactSnapshot = isFullSnapshotEvent(event);
    let payload: ParsedCachedRelayEventRecord = { event };
    if (typeof opts.seq === "number" && Number.isFinite(opts.seq)) {
        payload.seq = opts.seq;
    }

    let serialized = stringifyCachedPayload(payload);
    // Oversized snapshots use the same gap/fresh-runner-snapshot path as other
    // oversized events; retaining them here would defeat the memory budget.
    if (serialized.bytes > maxBytes) {
        payload = { gap: GAP_MARKER };
        if (typeof opts.seq === "number" && Number.isFinite(opts.seq)) {
            payload.seq = opts.seq;
        }
        serialized = stringifyCachedPayload(payload);
    }

    const ttlMs = ttlMsForSession(opts.isEphemeral);

    try {
        await redis.eval(APPEND_AND_TRIM_SCRIPT, {
            keys: [eventsKey(sessionId), eventsBytesKey(sessionId)],
            arguments: [
                serialized.json,
                String(serialized.bytes),
                String(eventBufferSize()),
                String(maxBytes),
                String(ttlMs),
                compactSnapshot ? "1" : "0",
            ],
        });
    } catch (error) {
        logUnavailableOnce("Failed to append relay event to Redis cache", error);
    }
}

function parseCachedRelayEventRow(row: string): ParsedCachedRelayEventRecord | null {
    try {
        const parsed = JSON.parse(row) as unknown;
        if (!parsed || typeof parsed !== "object") {
            return { event: parsed };
        }

        const record = parsed as Record<string, unknown>;
        const seq = typeof record.seq === "number" && Number.isFinite(record.seq) ? record.seq : undefined;
        if (record.gap === GAP_MARKER) {
            return { seq, gap: GAP_MARKER };
        }
        if (Object.prototype.hasOwnProperty.call(record, "event")) {
            return { seq, event: record.event };
        }

        return { event: parsed };
    } catch {
        return null;
    }
}

function isGapRecord(record: ParsedCachedRelayEventRecord): boolean {
    return record.gap === GAP_MARKER;
}

function hasCachedEvent(record: ParsedCachedRelayEventRecord): record is CachedRelayEventRecord {
    return Object.prototype.hasOwnProperty.call(record, "event");
}

function isSequencedCachedRelayEvent(record: ParsedCachedRelayEventRecord): record is CachedRelayEventRecord & { seq: number } {
    return hasCachedEvent(record) && typeof record.seq === "number" && Number.isFinite(record.seq);
}

function isSequencedGapRecord(record: ParsedCachedRelayEventRecord): record is ParsedCachedRelayEventRecord & { seq: number } {
    return isGapRecord(record) && typeof record.seq === "number" && Number.isFinite(record.seq);
}

export async function getCachedRelayEvents(sessionId: string): Promise<CachedRelayEventRecord[]> {
    if (isRedisDisabled()) return [];

    const redis = await getClient();
    if (!redis) return [];

    try {
        const rows = await redis.lRange(eventsKey(sessionId), 0, -1);
        const events: CachedRelayEventRecord[] = [];
        for (const row of rows) {
            const parsed = parseCachedRelayEventRow(row);
            if (parsed && hasCachedEvent(parsed)) {
                events.push(parsed);
            }
        }
        return events;
    } catch (error) {
        logUnavailableOnce("Failed to read relay event cache from Redis", error);
        return [];
    }
}

/**
 * Read only the newest portion(s) of the relay cache and return the latest
 * sequenced event.
 *
 * This avoids parsing the entire event list on each viewer switch when the
 * newest snapshot is near the tail (common case).
 */
export async function getLatestCachedRelayEventSeq(sessionId: string): Promise<number | null> {
    if (isRedisDisabled()) return null;

    const redis = await getClient();
    if (!redis) return null;

    try {
        const key = eventsKey(sessionId);
        const length = await redis.lLen(key);
        if (!Number.isFinite(length) || length <= 0) return null;

        const chunkSize = snapshotScanChunkSize();
        for (let end = length - 1; end >= 0; end -= chunkSize) {
            const start = Math.max(0, end - chunkSize + 1);
            const rows = await redis.lRange(key, start, end);
            for (let i = rows.length - 1; i >= 0; i--) {
                const parsed = parseCachedRelayEventRow(rows[i]);
                if (parsed && (isSequencedCachedRelayEvent(parsed) || isSequencedGapRecord(parsed))) return parsed.seq;
            }
        }
        return null;
    } catch (error) {
        logUnavailableOnce("Failed to read latest relay event sequence from Redis", error);
        return null;
    }
}

export async function getCachedRelayEventsAfterSeq(
    sessionId: string,
    afterSeq: number,
): Promise<CachedRelayEventRecord[]> {
    if (isRedisDisabled()) return [];

    const redis = await getClient();
    if (!redis) return [];

    try {
        const key = eventsKey(sessionId);
        const length = await redis.lLen(key);
        if (!Number.isFinite(length) || length <= 0) return [];

        type SequencedRecord = CachedRelayEventRecord & { seq: number };
        const collected: SequencedRecord[] = [];
        let sawLegacyRow = false;
        let sawGap = false;
        const chunkSize = snapshotScanChunkSize();

        // Events are rPush'd: newest at the tail. Scan backwards in chunks
        // until we reach a sequenced event with seq <= afterSeq; everything
        // older than that is irrelevant.
        let stopped = false;
        for (let end = length - 1; end >= 0; end -= chunkSize) {
            const start = Math.max(0, end - chunkSize + 1);
            const rows = await redis.lRange(key, start, end);
            for (let i = rows.length - 1; i >= 0; i--) {
                const parsed = parseCachedRelayEventRow(rows[i]);
                if (!parsed) continue;
                if (isGapRecord(parsed)) {
                    if (isSequencedGapRecord(parsed) && parsed.seq <= afterSeq) {
                        stopped = true;
                        break;
                    }
                    sawGap = true;
                    continue;
                }
                if (!isSequencedCachedRelayEvent(parsed)) {
                    sawLegacyRow = true;
                    continue;
                }
                if (parsed.seq <= afterSeq) {
                    stopped = true;
                    break;
                }
                collected.push(parsed);
            }
            if (stopped) break;
        }

        if (sawGap || (afterSeq > 0 && sawLegacyRow)) {
            return [];
        }

        collected.reverse();

        // Verify contiguity: the first event must be afterSeq+1 and all
        // subsequent seqs must be consecutive.  If the cache was trimmed
        // (lTrim), earlier events may be missing — return empty so the
        // caller falls back to a full snapshot/resync instead of silently
        // skipping events.
        if (collected.length > 0) {
            const first = collected[0];
            if (!first || first.seq !== afterSeq + 1) {
                return [];
            }
            for (let i = 1; i < collected.length; i++) {
                const curr = collected[i];
                const prev = collected[i - 1];
                if (!curr || !prev || curr.seq !== prev.seq + 1) {
                    return [];
                }
            }
        }

        return collected;
    } catch (error) {
        logUnavailableOnce("Failed to read relay event cache from Redis", error);
        return [];
    }
}

export interface LatestCachedSnapshot {
    event: Record<string, unknown>;
    /**
     * Seq the snapshot event was published at, when known.
     *
     * publishSessionEvent() seq-stamps every broadcast event before caching it,
     * so any snapshot that went out over the wire has one. The lone exception is
     * the assembled session_active written by finalizeChunkedSnapshot(), which
     * deliberately skips incrementSeq() because it is never broadcast.
     *
     * Knowing this lets a caller prove a snapshot is not a rewind before sending
     * it to a viewer that already holds a cursor. Without it, the only safe move
     * was to send nothing — which left reconnecting viewers permanently blank.
     */
    snapshotSeq?: number;
    /**
     * Cached events appended after the snapshot, in chronological order.
     * Replaying these after the snapshot brings a viewer up to the current
     * seq — without them, deltas published between the snapshot and "now"
     * would be silently skipped (the viewer cursor is advanced to freshSeq
     * before hydration).
     */
    eventsAfter: CachedRelayEventRecord[];
}

export async function getLatestCachedSnapshotEvent(sessionId: string): Promise<LatestCachedSnapshot | null> {
    if (isRedisDisabled()) return null;

    const redis = await getClient();
    if (!redis) return null;

    try {
        const key = eventsKey(sessionId);
        const length = await redis.lLen(key);
        if (!Number.isFinite(length) || length <= 0) return null;

        // Events encountered while scanning backward toward the snapshot —
        // i.e. events appended after it — in reverse-chronological order.
        const trailingReversed: CachedRelayEventRecord[] = [];
        const chunkSize = snapshotScanChunkSize();
        for (let end = length - 1; end >= 0; end -= chunkSize) {
            const start = Math.max(0, end - chunkSize + 1);
            const rows = await redis.lRange(key, start, end);
            for (let i = rows.length - 1; i >= 0; i--) {
                const row = rows[i];
                const parsed = parseCachedRelayEventRow(row);
                if (!parsed) continue;
                if (isGapRecord(parsed)) return null;
                if (!hasCachedEvent(parsed)) continue;
                if (isSnapshotEvent(parsed.event)) {
                    return {
                        event: parsed.event as Record<string, unknown>,
                        snapshotSeq: parsed.seq,
                        eventsAfter: trailingReversed.reverse(),
                    };
                }
                trailingReversed.push(parsed);
            }
        }

        return null;
    } catch (error) {
        logUnavailableOnce("Failed to read latest snapshot from Redis cache", error);
        return null;
    }
}

export async function deleteRelayEventCache(sessionId: string): Promise<void> {
    if (isRedisDisabled()) return;
    const redis = await getClient();
    if (!redis) return;

    try {
        await redis.del([eventsKey(sessionId), eventsBytesKey(sessionId)]);
    } catch (error) {
        logUnavailableOnce("Failed to delete relay event cache from Redis", error);
    }
}

export async function deleteRelayEventCaches(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    if (isRedisDisabled()) return;
    const redis = await getClient();
    if (!redis) return;

    try {
        const keys = sessionIds.flatMap((sessionId) => [eventsKey(sessionId), eventsBytesKey(sessionId)]);
        await redis.del(keys);
    } catch (error) {
        logUnavailableOnce("Failed to delete relay event caches from Redis", error);
    }
}

/**
 * Reset all module-level state so that the next call to
 * `initializeRelayRedisCache()` starts fresh with the current module
 * mock environment.  Intended for use in test hooks only.
 */
export function _resetRelayRedisCacheForTesting(): void {
    _resetRedisForTesting();
    unavailableLogged = false;
}
