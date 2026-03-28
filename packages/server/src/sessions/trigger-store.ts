/**
 * Trigger history store — Redis-backed per-session trigger log.
 *
 * Uses the same Redis client as the relay event cache (sessions/redis.ts pattern).
 * Stores recent triggers (inbound and outbound) for observability
 * and the Triggers Panel UI.
 */

import { connectRedisClient, isRedisDisabled, type RedisClient } from "../redis-client.js";
import { createLogger } from "@pizzapi/tools";

const log = createLogger("trigger-store");

let _redis: RedisClient | null = null;
let _initPromise: Promise<void> | null = null;

async function getClient(): Promise<RedisClient | null> {
    if (_redis?.isOpen) return _redis;
    if (_initPromise) { await _initPromise; return _redis; }
    _initPromise = connectRedisClient().then(c => { _redis = c; });
    await _initPromise;
    return _redis;
}

/** Inject a mock client for tests. */
export function _injectRedisForTesting(client: unknown): void {
    _redis = client as RedisClient;
    _initPromise = Promise.resolve();
}

/** Reset client state for tests. */
export function _resetRedisForTesting(): void {
    _redis = null;
    _initPromise = null;
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
}

const TRIGGER_HISTORY_KEY = (sessionId: string) => `pizzapi:triggers:history:${sessionId}`;
const MAX_HISTORY = 200;
const HISTORY_TTL_SECONDS = 24 * 60 * 60; // 24 hours

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

/**
 * Clear all trigger history for a session.
 * Called on /new so the Triggers panel starts fresh.
 */
export async function clearTriggerHistory(sessionId: string): Promise<void> {
    const redis = await getClient();
    if (!redis) return;
    const key = TRIGGER_HISTORY_KEY(sessionId);
    try {
        await redis.del(key);
    } catch (err) {
        log.warn("Failed to clear trigger history:", err);
    }
}

/** @deprecated Use `_resetRedisForTesting` instead. */
export function _resetTriggerStoreForTesting(): void {
    _resetRedisForTesting();
}
