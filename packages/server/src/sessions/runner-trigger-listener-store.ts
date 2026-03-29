/**
 * Runner trigger listener store — persistent auto-spawn subscriptions.
 *
 * A listener links a runner to a trigger type: when a service broadcasts
 * that trigger type, the server auto-spawns a new session on the runner
 * and delivers the trigger into it.
 *
 * Persistence layout:
 *   SQLite: runner_trigger_listener table (durable source of truth)
 *   Redis:  runner-trigger-listeners:{runnerId} hash (read-through cache / legacy support)
 *
 * The SQLite table makes listeners survive both runner and relay restarts.
 * Redis is still maintained for compatibility and fast reads in existing paths.
 */

import { connectRedisClient, type RedisClient } from "../redis-client.js";
import { createLogger } from "@pizzapi/tools";
import { getKysely } from "../auth.js";

const log = createLogger("runner-trigger-listener-store");

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

export function _resetRedisForTesting(): void {
    _redis = null;
    _initPromise = null;
}

const LISTENERS_KEY = (runnerId: string) =>
    `pizzapi:runner-trigger-listeners:${runnerId}`;
const LISTENER_ROW_ID = (runnerId: string, triggerType: string) =>
    JSON.stringify([runnerId, triggerType]);
const LISTENER_TABLE = "runner_trigger_listener" as const;

// ── Types ─────────────────────────────────────────────────────────────────

export interface RunnerTriggerListener {
    triggerType: string;
    /** Optional prompt to seed the spawned session with. */
    prompt?: string;
    /** Optional working directory for the spawned session. */
    cwd?: string;
    /** Optional model override for the spawned session. */
    model?: { provider: string; id: string };
    /** Subscription params — filter which events trigger a spawn. */
    params?: Record<string, string | number | boolean | Array<string | number | boolean>>;
    /** When this listener was created. */
    createdAt: string;
}

interface ListenerRow {
    id: string;
    runnerId: string;
    triggerType: string;
    listenerJson: string;
    updatedAt: string;
}

function parseListenerJson(json: string): RunnerTriggerListener | null {
    try {
        const parsed = JSON.parse(json) as unknown;
        if (!parsed || typeof parsed !== "object") return null;
        const listener = parsed as Partial<RunnerTriggerListener>;
        if (typeof listener.triggerType !== "string" || typeof listener.createdAt !== "string") return null;
        return listener as RunnerTriggerListener;
    } catch {
        return null;
    }
}

function toListenerRow(runnerId: string, listener: RunnerTriggerListener): ListenerRow {
    return {
        id: LISTENER_ROW_ID(runnerId, listener.triggerType),
        runnerId,
        triggerType: listener.triggerType,
        listenerJson: JSON.stringify(listener),
        updatedAt: new Date().toISOString(),
    };
}

async function upsertListenerRow(runnerId: string, listener: RunnerTriggerListener): Promise<void> {
    const row = toListenerRow(runnerId, listener);
    await getKysely()
        .insertInto(LISTENER_TABLE)
        .values(row)
        .onConflict((oc) => oc.column("id").doUpdateSet({
            runnerId: row.runnerId,
            triggerType: row.triggerType,
            listenerJson: row.listenerJson,
            updatedAt: row.updatedAt,
        }))
        .execute();
}

async function deleteListenerRow(runnerId: string, triggerType: string): Promise<number> {
    const result = await getKysely()
        .deleteFrom(LISTENER_TABLE)
        .where("id", "=", LISTENER_ROW_ID(runnerId, triggerType))
        .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n);
}

async function getListenerRow(runnerId: string, triggerType: string): Promise<RunnerTriggerListener | null> {
    const row = await getKysely()
        .selectFrom(LISTENER_TABLE)
        .select(["listenerJson"])
        .where("id", "=", LISTENER_ROW_ID(runnerId, triggerType))
        .executeTakeFirst();
    if (!row) return null;
    return parseListenerJson(row.listenerJson);
}

async function listListenerRows(runnerId: string): Promise<RunnerTriggerListener[]> {
    const rows = await getKysely()
        .selectFrom(LISTENER_TABLE)
        .select(["listenerJson"])
        .where("runnerId", "=", runnerId)
        .orderBy("updatedAt", "desc")
        .execute();

    return rows
        .map((row) => parseListenerJson(row.listenerJson))
        .filter((listener): listener is RunnerTriggerListener => listener !== null);
}

async function readRedisListener(runnerId: string, triggerType: string): Promise<RunnerTriggerListener | null> {
    const redis = await getClient();
    if (!redis) return null;
    const json = await redis.hGet(LISTENERS_KEY(runnerId), triggerType);
    if (!json) return null;
    return parseListenerJson(json);
}

async function listRedisListeners(runnerId: string): Promise<RunnerTriggerListener[]> {
    const redis = await getClient();
    if (!redis) return [];
    const entries = await redis.hGetAll(LISTENERS_KEY(runnerId));
    const listeners: RunnerTriggerListener[] = [];
    for (const json of Object.values(entries)) {
        const parsed = parseListenerJson(json);
        if (parsed) listeners.push(parsed);
    }
    return listeners;
}

async function persistRedisListener(runnerId: string, listener: RunnerTriggerListener): Promise<void> {
    const redis = await getClient();
    if (!redis) return;
    await redis.hSet(LISTENERS_KEY(runnerId), listener.triggerType, JSON.stringify(listener));
}

async function removeRedisListener(runnerId: string, triggerType: string): Promise<number> {
    const redis = await getClient();
    if (!redis) return 0;
    return redis.hDel(LISTENERS_KEY(runnerId), triggerType);
}

function mergeListeners(primary: RunnerTriggerListener[], secondary: RunnerTriggerListener[]): RunnerTriggerListener[] {
    const byType = new Map<string, RunnerTriggerListener>();
    for (const listener of primary) {
        byType.set(listener.triggerType, listener);
    }
    for (const listener of secondary) {
        if (!byType.has(listener.triggerType)) {
            byType.set(listener.triggerType, listener);
        }
    }
    return Array.from(byType.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function loadListener(runnerId: string, triggerType: string): Promise<RunnerTriggerListener | null> {
    const fromDb = await getListenerRow(runnerId, triggerType);
    if (fromDb) return fromDb;

    const fromRedis = await readRedisListener(runnerId, triggerType);
    if (!fromRedis) return null;

    // Backfill the durable store from legacy / cache-only data.
    await upsertListenerRow(runnerId, fromRedis).catch((err) => {
        log.warn("Failed to backfill runner trigger listener into SQLite:", err);
    });
    return fromRedis;
}

// ── Public API ────────────────────────────────────────────────────────────

/** Add or update a listener for a trigger type on a runner. */
export async function addRunnerTriggerListener(
    runnerId: string,
    triggerType: string,
    opts?: { prompt?: string; cwd?: string; model?: { provider: string; id: string }; params?: Record<string, unknown> },
): Promise<void> {
    const listener = {
        triggerType,
        prompt: opts?.prompt,
        cwd: opts?.cwd,
        model: opts?.model,
        params: opts?.params as RunnerTriggerListener["params"],
        createdAt: new Date().toISOString(),
    } satisfies RunnerTriggerListener;

    const existing = await loadListener(runnerId, triggerType);
    const persisted = existing
        ? { ...listener, createdAt: existing.createdAt }
        : listener;

    try {
        await upsertListenerRow(runnerId, persisted);
        await persistRedisListener(runnerId, persisted);
        log.info(`Added runner trigger listener: ${runnerId} → ${triggerType}`);
    } catch (err) {
        log.warn("Failed to add runner trigger listener:", err);
    }
}

/** Remove a listener for a trigger type on a runner. */
export async function removeRunnerTriggerListener(
    runnerId: string,
    triggerType: string,
): Promise<boolean> {
    let removed = false;
    try {
        removed = (await deleteListenerRow(runnerId, triggerType)) > 0;
        const redisRemoved = await removeRedisListener(runnerId, triggerType);
        removed = removed || redisRemoved > 0;
        if (removed) {
            log.info(`Removed runner trigger listener: ${runnerId} → ${triggerType}`);
        }
    } catch (err) {
        log.warn("Failed to remove runner trigger listener:", err);
    }
    return removed;
}

/** List all listeners for a runner. */
export async function listRunnerTriggerListeners(
    runnerId: string,
): Promise<RunnerTriggerListener[]> {
    try {
        const [dbListeners, redisListeners] = await Promise.all([
            listListenerRows(runnerId),
            listRedisListeners(runnerId),
        ]);
        const merged = mergeListeners(dbListeners, redisListeners);

        // Backfill any Redis-only listeners so the durable store becomes the
        // source of truth after the first read on an upgraded server.
        const dbTypes = new Set(dbListeners.map((l) => l.triggerType));
        await Promise.all(
            redisListeners
                .filter((listener) => !dbTypes.has(listener.triggerType))
                .map((listener) => upsertListenerRow(runnerId, listener).catch((err) => {
                    log.warn("Failed to backfill runner trigger listener into SQLite:", err);
                })),
        );

        return merged;
    } catch (err) {
        log.warn("Failed to list runner trigger listeners:", err);
        return [];
    }
}

/** Update an existing listener's config. Returns false if the listener doesn't exist. */
export async function updateRunnerTriggerListener(
    runnerId: string,
    triggerType: string,
    updates: { prompt?: string; cwd?: string; model?: { provider: string; id: string }; params?: Record<string, unknown> },
): Promise<boolean> {
    try {
        const existing = await loadListener(runnerId, triggerType);
        if (!existing) return false;

        const updated: RunnerTriggerListener = {
            ...existing,
            ...(updates.prompt !== undefined ? { prompt: updates.prompt } : {}),
            ...(updates.cwd !== undefined ? { cwd: updates.cwd } : {}),
            ...(updates.model !== undefined ? { model: updates.model } : {}),
            ...(updates.params !== undefined ? { params: updates.params as RunnerTriggerListener["params"] } : {}),
        };
        await upsertListenerRow(runnerId, updated);
        await persistRedisListener(runnerId, updated);
        log.info(`Updated runner trigger listener: ${runnerId} → ${triggerType}`);
        return true;
    } catch (err) {
        log.warn("Failed to update runner trigger listener:", err);
        return false;
    }
}

/** Get a specific listener for a runner + trigger type. */
export async function getRunnerTriggerListener(
    runnerId: string,
    triggerType: string,
): Promise<RunnerTriggerListener | null> {
    try {
        const listener = await loadListener(runnerId, triggerType);
        if (listener) return listener;
        return null;
    } catch (err) {
        log.warn("Failed to get runner trigger listener:", err);
        return null;
    }
}

/** Get all trigger types that have listeners on a runner. */
export async function getRunnerListenerTypes(
    runnerId: string,
): Promise<string[]> {
    try {
        const listeners = await listRunnerTriggerListeners(runnerId);
        return listeners.map((listener) => listener.triggerType);
    } catch (err) {
        log.warn("Failed to list runner trigger listener types:", err);
        return [];
    }
}

/** Ensure the durable listener table exists. */
export async function ensureRunnerTriggerListenersTable(): Promise<void> {
    await getKysely().schema
        .createTable(LISTENER_TABLE)
        .ifNotExists()
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("runnerId", "text", (col) => col.notNull())
        .addColumn("triggerType", "text", (col) => col.notNull())
        .addColumn("listenerJson", "text", (col) => col.notNull())
        .addColumn("updatedAt", "text", (col) => col.notNull())
        .execute();

    await getKysely().schema
        .createIndex("runner_trigger_listener_runner_idx")
        .ifNotExists()
        .on(LISTENER_TABLE)
        .columns(["runnerId", "updatedAt"])
        .execute();
}
