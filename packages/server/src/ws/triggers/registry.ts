// ============================================================================
// TriggerRegistry — Redis-backed CRUD layer for conversation triggers
// ============================================================================

import { createClient } from "redis";
import type { TriggerRecord, TriggerType, TriggerConfig, TriggerDelivery } from "@pizzapi/protocol";

/** Alias matching the redis package's client type. */
type RedisClient = ReturnType<typeof createClient>;

const MAX_TRIGGERS_PER_SESSION = 100;
const MAX_TRIGGERS_PER_RUNNER = 1000;

// ---------------------------------------------------------------------------
// Register params
// ---------------------------------------------------------------------------

export interface RegisterTriggerParams {
    type: TriggerType;
    ownerSessionId: string;
    runnerId: string;
    config: TriggerConfig;
    delivery: TriggerDelivery;
    message: string;
    maxFirings?: number;
    expiresAt?: string;
}

// ---------------------------------------------------------------------------
// TriggerRegistry
// ---------------------------------------------------------------------------

export class TriggerRegistry {
    constructor(private readonly getClient: () => RedisClient | null) {}

    // -------------------------------------------------------------------------
    // Key helpers
    // -------------------------------------------------------------------------

    /** Primary record key. */
    private recordKey(runnerId: string, triggerId: string): string {
        return `triggers:${runnerId}:${triggerId}`;
    }

    /** Lookup key: triggerId → runnerId (needed for cancel/fire without knowing runnerId). */
    private metaKey(triggerId: string): string {
        return `triggers:meta:${triggerId}`;
    }

    /** Set of all triggerIds for a runner. */
    private byRunnerKey(runnerId: string): string {
        return `triggers:by-runner:${runnerId}`;
    }

    /** Set of all triggerIds owned by a session. */
    private bySessionKey(sessionId: string): string {
        return `triggers:by-session:${sessionId}`;
    }

    /** Set of all triggerIds of a given type for a runner. */
    private byTypeKey(runnerId: string, type: TriggerType): string {
        return `triggers:by-type:${runnerId}:${type}`;
    }

    // -------------------------------------------------------------------------
    // registerTrigger
    // -------------------------------------------------------------------------

    async registerTrigger(
        params: RegisterTriggerParams,
    ): Promise<{ ok: true; triggerId: string } | { ok: false; error: string }> {
        const redis = this.getClient();
        if (!redis) return { ok: false, error: "Redis unavailable" };

        const sessionKey = this.bySessionKey(params.ownerSessionId);
        const runnerKey = this.byRunnerKey(params.runnerId);
        const watchableRedis = redis as unknown as {
            watch?: (...keys: string[]) => Promise<void>;
            unwatch?: () => Promise<void>;
        };
        const canWatch = typeof watchableRedis.watch === "function";

        try {
            for (let attempt = 0; attempt < 5; attempt++) {
                if (canWatch) {
                    await watchableRedis.watch!(sessionKey, runnerKey);
                }

                const sessionCount = await redis.sCard(sessionKey);
                if (sessionCount >= MAX_TRIGGERS_PER_SESSION) {
                    if (canWatch && typeof watchableRedis.unwatch === "function") {
                        await watchableRedis.unwatch();
                    }
                    return {
                        ok: false,
                        error: `Session trigger limit (${MAX_TRIGGERS_PER_SESSION}) reached`,
                    };
                }

                const runnerCount = await redis.sCard(runnerKey);
                if (runnerCount >= MAX_TRIGGERS_PER_RUNNER) {
                    if (canWatch && typeof watchableRedis.unwatch === "function") {
                        await watchableRedis.unwatch();
                    }
                    return {
                        ok: false,
                        error: `Runner trigger limit (${MAX_TRIGGERS_PER_RUNNER}) reached`,
                    };
                }

                const triggerId = crypto.randomUUID();
                const record: TriggerRecord = {
                    id: triggerId,
                    type: params.type,
                    ownerSessionId: params.ownerSessionId,
                    runnerId: params.runnerId,
                    config: params.config,
                    delivery: params.delivery,
                    message: params.message,
                    ...(params.maxFirings !== undefined ? { maxFirings: params.maxFirings } : {}),
                    firingCount: 0,
                    ...(params.expiresAt !== undefined ? { expiresAt: params.expiresAt } : {}),
                    createdAt: new Date().toISOString(),
                };

                const multi = redis.multi();
                multi.set(this.recordKey(params.runnerId, triggerId), JSON.stringify(record));
                multi.set(this.metaKey(triggerId), params.runnerId);
                multi.sAdd(runnerKey, triggerId);
                multi.sAdd(sessionKey, triggerId);
                multi.sAdd(this.byTypeKey(params.runnerId, params.type), triggerId);
                const execResult = await multi.exec();

                if (canWatch && execResult === null) {
                    continue;
                }

                return { ok: true, triggerId };
            }

            return { ok: false, error: "Failed to register trigger due to concurrent updates" };
        } catch (error) {
            return { ok: false, error: String(error) };
        }
    }

    // -------------------------------------------------------------------------
    // cancelTrigger
    // -------------------------------------------------------------------------

    async cancelTrigger(
        triggerId: string,
        sessionId: string,
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        const redis = this.getClient();
        if (!redis) return { ok: false, error: "Redis unavailable" };

        try {
            // Resolve runnerId from meta lookup
            const runnerId = await redis.get(this.metaKey(triggerId));
            if (!runnerId) {
                return { ok: false, error: `Trigger ${triggerId} not found` };
            }

            // Load record to verify ownership
            const raw = await redis.get(this.recordKey(runnerId, triggerId));
            if (!raw) {
                return { ok: false, error: `Trigger ${triggerId} not found` };
            }

            let record: TriggerRecord;
            try {
                record = JSON.parse(raw) as TriggerRecord;
            } catch {
                return { ok: false, error: `Trigger ${triggerId} data is corrupted` };
            }

            if (record.ownerSessionId !== sessionId) {
                return {
                    ok: false,
                    error: `Trigger ${triggerId} is not owned by session ${sessionId}`,
                };
            }

            // Atomically remove record + all indices
            const multi = redis.multi();
            multi.del(this.recordKey(runnerId, triggerId));
            multi.del(this.metaKey(triggerId));
            multi.sRem(this.byRunnerKey(runnerId), triggerId);
            multi.sRem(this.bySessionKey(sessionId), triggerId);
            multi.sRem(this.byTypeKey(runnerId, record.type), triggerId);
            await multi.exec();

            return { ok: true };
        } catch (error) {
            return { ok: false, error: String(error) };
        }
    }

    // -------------------------------------------------------------------------
    // listTriggers
    // -------------------------------------------------------------------------

    async listTriggers(sessionId: string): Promise<TriggerRecord[]> {
        const redis = this.getClient();
        if (!redis) return [];

        try {
            const triggerIds = await redis.sMembers(this.bySessionKey(sessionId));
            const records: TriggerRecord[] = [];

            for (const triggerId of triggerIds) {
                const runnerId = await redis.get(this.metaKey(triggerId));
                if (!runnerId) continue;

                const raw = await redis.get(this.recordKey(runnerId, triggerId));
                if (!raw) continue;

                try {
                    records.push(JSON.parse(raw) as TriggerRecord);
                } catch {
                    // Skip malformed records
                }
            }

            return records;
        } catch {
            return [];
        }
    }

    // -------------------------------------------------------------------------
    // getTriggersByType
    // -------------------------------------------------------------------------

    async getTriggersByType(runnerId: string, type: TriggerType): Promise<TriggerRecord[]> {
        const redis = this.getClient();
        if (!redis) return [];

        try {
            const triggerIds = await redis.sMembers(this.byTypeKey(runnerId, type));
            const records: TriggerRecord[] = [];

            for (const triggerId of triggerIds) {
                const raw = await redis.get(this.recordKey(runnerId, triggerId));
                if (!raw) continue;

                try {
                    records.push(JSON.parse(raw) as TriggerRecord);
                } catch {
                    // Skip malformed records
                }
            }

            return records;
        } catch {
            return [];
        }
    }

    /** Returns true when a trigger record still exists. */
    async hasTrigger(triggerId: string): Promise<boolean> {
        const redis = this.getClient();
        if (!redis) return false;

        try {
            const runnerId = await redis.get(this.metaKey(triggerId));
            if (!runnerId) return false;
            const raw = await redis.get(this.recordKey(runnerId, triggerId));
            return raw !== null;
        } catch {
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // fireTrigger
    // -------------------------------------------------------------------------

    /** Fire a trigger: increments firingCount, sets lastFiredAt, and auto-cancels when maxFirings is reached.
     *  Returns the updated record, or null if the trigger is expired/removed. */
    async fireTrigger(triggerId: string): Promise<TriggerRecord | null> {
        const redis = this.getClient();
        if (!redis) return null;

        try {
            // Resolve runnerId
            const runnerId = await redis.get(this.metaKey(triggerId));
            if (!runnerId) return null;

            const raw = await redis.get(this.recordKey(runnerId, triggerId));
            if (!raw) return null;

            let record: TriggerRecord;
            try {
                record = JSON.parse(raw) as TriggerRecord;
            } catch {
                return null;
            }

            // Check expiry
            if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
                // Expired — clean up and return null
                const multi = redis.multi();
                multi.del(this.recordKey(runnerId, triggerId));
                multi.del(this.metaKey(triggerId));
                multi.sRem(this.byRunnerKey(runnerId), triggerId);
                multi.sRem(this.bySessionKey(record.ownerSessionId), triggerId);
                multi.sRem(this.byTypeKey(runnerId, record.type), triggerId);
                await multi.exec();
                return null;
            }

            // Update firing metadata
            record.firingCount += 1;
            record.lastFiredAt = new Date().toISOString();

            const timerConfig = record.type === "timer" ? (record.config as { recurring?: unknown }) : null;
            const oneShotTimer = record.type === "timer" && timerConfig?.recurring !== true;
            const exhausted =
                (record.maxFirings !== undefined && record.firingCount >= record.maxFirings) || oneShotTimer;

            if (exhausted) {
                // Auto-cancel: remove all keys and return the final updated record
                const multi = redis.multi();
                multi.del(this.recordKey(runnerId, triggerId));
                multi.del(this.metaKey(triggerId));
                multi.sRem(this.byRunnerKey(runnerId), triggerId);
                multi.sRem(this.bySessionKey(record.ownerSessionId), triggerId);
                multi.sRem(this.byTypeKey(runnerId, record.type), triggerId);
                await multi.exec();
            } else {
                // Persist updated record
                await redis.set(this.recordKey(runnerId, triggerId), JSON.stringify(record));
            }

            return record;
        } catch {
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // cleanupSessionTriggers
    // -------------------------------------------------------------------------

    /** Remove all triggers owned by a session. Returns the number removed. */
    async cleanupSessionTriggers(sessionId: string): Promise<number> {
        const redis = this.getClient();
        if (!redis) return 0;

        try {
            // Snapshot the set before iterating (cancelTrigger modifies the set)
            const triggerIds = await redis.sMembers(this.bySessionKey(sessionId));
            let count = 0;

            for (const triggerId of triggerIds) {
                const result = await this.cancelTrigger(triggerId, sessionId);
                if (result.ok) count++;
            }

            return count;
        } catch {
            return 0;
        }
    }

    // -------------------------------------------------------------------------
    // rehydrateTriggers
    // -------------------------------------------------------------------------

    /** Load all triggers for a runner from Redis, removing orphans (missing records or expired). */
    async rehydrateTriggers(runnerId: string): Promise<TriggerRecord[]> {
        const redis = this.getClient();
        if (!redis) return [];

        try {
            const triggerIds = await redis.sMembers(this.byRunnerKey(runnerId));
            const records: TriggerRecord[] = [];
            const now = new Date();

            for (const triggerId of triggerIds) {
                const raw = await redis.get(this.recordKey(runnerId, triggerId));

                if (!raw) {
                    // Orphan: index entry exists but no record — clean up index entries
                    const multi = redis.multi();
                    multi.del(this.metaKey(triggerId));
                    multi.sRem(this.byRunnerKey(runnerId), triggerId);
                    await multi.exec();
                    continue;
                }

                let record: TriggerRecord;
                try {
                    record = JSON.parse(raw) as TriggerRecord;
                } catch {
                    // Corrupted record — remove it
                    const multi = redis.multi();
                    multi.del(this.recordKey(runnerId, triggerId));
                    multi.del(this.metaKey(triggerId));
                    multi.sRem(this.byRunnerKey(runnerId), triggerId);
                    multi.sRem(this.bySessionKey(""), triggerId); // best-effort, unknown sessionId
                    await multi.exec();
                    continue;
                }

                // Remove expired triggers
                if (record.expiresAt && new Date(record.expiresAt) < now) {
                    const multi = redis.multi();
                    multi.del(this.recordKey(runnerId, triggerId));
                    multi.del(this.metaKey(triggerId));
                    multi.sRem(this.byRunnerKey(runnerId), triggerId);
                    multi.sRem(this.bySessionKey(record.ownerSessionId), triggerId);
                    multi.sRem(this.byTypeKey(runnerId, record.type), triggerId);
                    await multi.exec();
                    continue;
                }

                records.push(record);
            }

            return records;
        } catch {
            return [];
        }
    }
}
