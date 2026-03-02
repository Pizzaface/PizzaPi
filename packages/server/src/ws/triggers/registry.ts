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

        try {
            // Enforce per-session limit
            const sessionCount = await redis.sCard(this.bySessionKey(params.ownerSessionId));
            if (sessionCount >= MAX_TRIGGERS_PER_SESSION) {
                return {
                    ok: false,
                    error: `Session trigger limit (${MAX_TRIGGERS_PER_SESSION}) reached`,
                };
            }

            // Enforce per-runner limit
            const runnerCount = await redis.sCard(this.byRunnerKey(params.runnerId));
            if (runnerCount >= MAX_TRIGGERS_PER_RUNNER) {
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

            // Atomically write record + all indices
            const multi = redis.multi();
            multi.set(this.recordKey(params.runnerId, triggerId), JSON.stringify(record));
            multi.set(this.metaKey(triggerId), params.runnerId);
            multi.sAdd(this.byRunnerKey(params.runnerId), triggerId);
            multi.sAdd(this.bySessionKey(params.ownerSessionId), triggerId);
            multi.sAdd(this.byTypeKey(params.runnerId, params.type), triggerId);
            await multi.exec();

            return { ok: true, triggerId };
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

            const exhausted =
                record.maxFirings !== undefined && record.firingCount >= record.maxFirings;

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
