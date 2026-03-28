/**
 * Trigger history store — Redis-backed per-session trigger log.
 *
 * Uses the same Redis client as the relay event cache (sessions/redis.ts pattern).
 * Stores recent triggers (inbound and outbound) for observability
 * and the Triggers Panel UI.
 */

import { createClient } from "redis";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("trigger-store");

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
}

const TRIGGER_HISTORY_KEY = (sessionId: string) => `pizzapi:triggers:history:${sessionId}`;
const MAX_HISTORY = 200;
const HISTORY_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// ── Redis client (lazy, shared with relay cache) ─────────────────────────

type RedisClient = ReturnType<typeof createClient>;
let client: RedisClient | null = null;
let initPromise: Promise<void> | null = null;

function redisUrl(): string {
    const configured = process.env.PIZZAPI_REDIS_URL?.trim();
    return configured && configured.length > 0 ? configured : "redis://127.0.0.1:6379";
}

function isRedisDisabled(): boolean {
    const configured = process.env.PIZZAPI_REDIS_URL?.trim().toLowerCase();
    return configured === "off" || configured === "disabled" || configured === "none";
}

async function getClient(): Promise<RedisClient | null> {
    if (isRedisDisabled()) return null;
    if (client?.isOpen) return client;
    if (initPromise) {
        await initPromise;
        return client?.isOpen ? client : null;
    }
    initPromise = (async () => {
        try {
            client = createClient({ url: redisUrl() });
            client.on("error", (err) => log.warn("Redis error:", err));
            await client.connect();
        } catch (err) {
            log.warn("Failed to connect trigger store Redis:", err);
            client = null;
            // Reset initPromise so the next call can retry the connection
            // rather than staying permanently disabled after a transient failure.
            initPromise = null;
        }
    })();
    await initPromise;
    return client?.isOpen ? client : null;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Push a trigger entry to the session's history list.
 * Trims to MAX_HISTORY and refreshes TTL.
 */
export async function pushTriggerHistory(
    sessionId: string,
    entry: TriggerHistoryEntry,
): Promise<void> {
    const redis = await getClient();
    if (!redis) return;
    const key = TRIGGER_HISTORY_KEY(sessionId);
    try {
        await redis.lPush(key, JSON.stringify(entry));
        await redis.lTrim(key, 0, MAX_HISTORY - 1);
        await redis.expire(key, HISTORY_TTL_SECONDS);
    } catch (err) {
        log.warn("Failed to push trigger history:", err);
    }
}

/**
 * Get recent trigger history for a session.
 * Returns most recent first.
 */
export async function getTriggerHistory(
    sessionId: string,
    limit = 50,
): Promise<TriggerHistoryEntry[]> {
    const redis = await getClient();
    if (!redis) return [];
    const key = TRIGGER_HISTORY_KEY(sessionId);
    try {
        const raw = await redis.lRange(key, 0, limit - 1);
        return raw.map((s) => {
            try {
                return JSON.parse(s) as TriggerHistoryEntry;
            } catch {
                return null;
            }
        }).filter((e): e is TriggerHistoryEntry => e !== null);
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
        const raw = await redis.lRange(key, 0, MAX_HISTORY - 1);
        for (let i = 0; i < raw.length; i++) {
            try {
                const entry = JSON.parse(raw[i]) as TriggerHistoryEntry;
                if (entry.triggerId === triggerId) {
                    entry.response = {
                        ...response,
                        ts: new Date().toISOString(),
                    };
                    await redis.lSet(key, i, JSON.stringify(entry));
                    return;
                }
            } catch {
                // skip malformed entries
            }
        }
    } catch (err) {
        log.warn("Failed to record trigger response:", err);
    }
}

/** Reset for testing. */
export function _resetTriggerStoreForTesting(): void {
    if (client?.isOpen) {
        client.disconnect().catch(() => {});
    }
    client = null;
    initPromise = null;
}
