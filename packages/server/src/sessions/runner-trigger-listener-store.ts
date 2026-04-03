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
const LISTENER_TABLE = "runner_trigger_listener" as const;

export interface RunnerTriggerListener {
    listenerId: string;
    triggerType: string;
    prompt?: string;
    cwd?: string;
    model?: { provider: string; id: string };
    params?: Record<string, string | number | boolean | Array<string | number | boolean>>;
    createdAt: string;
}

interface ListenerRow {
    id: string;
    runnerId: string;
    triggerType: string;
    listenerJson: string;
    updatedAt: string;
}

function generateListenerId(runnerId: string, triggerType: string): string {
    return `listener:${runnerId}:${triggerType}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function parseListenerJson(json: string): RunnerTriggerListener | null {
    try {
        const parsed = JSON.parse(json) as unknown;
        if (!parsed || typeof parsed !== "object") return null;
        const listener = parsed as Partial<RunnerTriggerListener>;
        if (typeof listener.triggerType !== "string" || typeof listener.createdAt !== "string") return null;
        return {
            ...listener,
            listenerId: typeof listener.listenerId === "string"
                ? listener.listenerId
                : generateListenerId("legacy", listener.triggerType),
        } as RunnerTriggerListener;
    } catch {
        return null;
    }
}

function toListenerRow(runnerId: string, listener: RunnerTriggerListener): ListenerRow {
    return {
        id: listener.listenerId,
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

async function deleteListenerRowById(listenerId: string): Promise<number> {
    const result = await getKysely()
        .deleteFrom(LISTENER_TABLE)
        .where("id", "=", listenerId)
        .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n);
}

async function deleteListenerRowsByTriggerType(runnerId: string, triggerType: string): Promise<number> {
    const result = await getKysely()
        .deleteFrom(LISTENER_TABLE)
        .where("runnerId", "=", runnerId)
        .where("triggerType", "=", triggerType)
        .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n);
}

async function getListenerRow(runnerId: string, listenerIdOrTriggerType: string): Promise<RunnerTriggerListener | null> {
    const row = await getKysely()
        .selectFrom(LISTENER_TABLE)
        .select(["listenerJson"])
        .where((eb) => eb.or([
            eb("id", "=", listenerIdOrTriggerType),
            eb.and([eb("runnerId", "=", runnerId), eb("triggerType", "=", listenerIdOrTriggerType)]),
        ]))
        .orderBy("updatedAt", "desc")
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

async function readRedisListener(runnerId: string, listenerIdOrTriggerType: string): Promise<RunnerTriggerListener | null> {
    const redis = await getClient();
    if (!redis) return null;
    const direct = await redis.hGet(LISTENERS_KEY(runnerId), listenerIdOrTriggerType);
    if (direct) return parseListenerJson(direct);
    const all = await redis.hGetAll(LISTENERS_KEY(runnerId));
    for (const json of Object.values(all)) {
        const parsed = parseListenerJson(json);
        if (!parsed) continue;
        if (parsed.listenerId === listenerIdOrTriggerType || parsed.triggerType === listenerIdOrTriggerType) {
            return parsed;
        }
    }
    return null;
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
    await redis.hSet(LISTENERS_KEY(runnerId), listener.listenerId, JSON.stringify(listener));
}

async function removeRedisListener(runnerId: string, listenerIdOrTriggerType: string): Promise<number> {
    const redis = await getClient();
    if (!redis) return 0;
    const directRemoved = await redis.hDel(LISTENERS_KEY(runnerId), listenerIdOrTriggerType);
    if (directRemoved > 0) return directRemoved;

    const entries = await redis.hGetAll(LISTENERS_KEY(runnerId));
    let removed = 0;
    for (const [field, json] of Object.entries(entries)) {
        const parsed = parseListenerJson(json);
        if (!parsed) continue;
        if (parsed.triggerType === listenerIdOrTriggerType) {
            removed += await redis.hDel(LISTENERS_KEY(runnerId), field);
        }
    }
    return removed;
}

function mergeListeners(primary: RunnerTriggerListener[], secondary: RunnerTriggerListener[]): RunnerTriggerListener[] {
    const byId = new Map<string, RunnerTriggerListener>();
    for (const listener of primary) {
        byId.set(listener.listenerId, listener);
    }
    for (const listener of secondary) {
        if (!byId.has(listener.listenerId)) {
            byId.set(listener.listenerId, listener);
        }
    }
    return Array.from(byId.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function loadListener(runnerId: string, listenerIdOrTriggerType: string): Promise<RunnerTriggerListener | null> {
    const fromDb = await getListenerRow(runnerId, listenerIdOrTriggerType);
    if (fromDb) return fromDb;

    const fromRedis = await readRedisListener(runnerId, listenerIdOrTriggerType);
    if (!fromRedis) return null;

    await upsertListenerRow(runnerId, fromRedis).catch((err) => {
        log.warn("Failed to backfill runner trigger listener into SQLite:", err);
    });
    return fromRedis;
}

export async function addRunnerTriggerListener(
    runnerId: string,
    triggerType: string,
    opts?: { prompt?: string; cwd?: string; model?: { provider: string; id: string }; params?: Record<string, unknown> },
): Promise<string> {
    const listenerId = generateListenerId(runnerId, triggerType);
    const listener = {
        listenerId,
        triggerType,
        prompt: opts?.prompt,
        cwd: opts?.cwd,
        model: opts?.model,
        params: opts?.params as RunnerTriggerListener["params"],
        createdAt: new Date().toISOString(),
    } satisfies RunnerTriggerListener;

    try {
        await upsertListenerRow(runnerId, listener);
        await persistRedisListener(runnerId, listener);
        log.info(`Added runner trigger listener: ${runnerId} → ${triggerType}`);
        return listenerId;
    } catch (err) {
        log.warn("Failed to add runner trigger listener:", err);
        return "";
    }
}

export async function removeRunnerTriggerListener(
    runnerId: string,
    listenerIdOrTriggerType: string,
): Promise<boolean> {
    let removed = false;
    try {
        removed = (await deleteListenerRowById(listenerIdOrTriggerType)) > 0;
        if (!removed) {
            removed = (await deleteListenerRowsByTriggerType(runnerId, listenerIdOrTriggerType)) > 0;
        }
        const redisRemoved = await removeRedisListener(runnerId, listenerIdOrTriggerType);
        removed = removed || redisRemoved > 0;
        if (removed) {
            log.info(`Removed runner trigger listener: ${runnerId} → ${listenerIdOrTriggerType}`);
        }
    } catch (err) {
        log.warn("Failed to remove runner trigger listener:", err);
    }
    return removed;
}

export async function listRunnerTriggerListeners(
    runnerId: string,
): Promise<RunnerTriggerListener[]> {
    try {
        const [dbListeners, redisListeners] = await Promise.all([
            listListenerRows(runnerId),
            listRedisListeners(runnerId),
        ]);
        const merged = mergeListeners(dbListeners, redisListeners);

        const dbIds = new Set(dbListeners.map((l) => l.listenerId));
        await Promise.all(
            redisListeners
                .filter((listener) => !dbIds.has(listener.listenerId))
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

export async function updateRunnerTriggerListener(
    runnerId: string,
    listenerIdOrTriggerType: string,
    updates: { prompt?: string; cwd?: string; model?: { provider: string; id: string }; params?: Record<string, unknown> },
): Promise<boolean> {
    try {
        const existing = await loadListener(runnerId, listenerIdOrTriggerType);
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
        log.info(`Updated runner trigger listener: ${runnerId} → ${listenerIdOrTriggerType}`);
        return true;
    } catch (err) {
        log.warn("Failed to update runner trigger listener:", err);
        return false;
    }
}

export async function getRunnerTriggerListener(
    runnerId: string,
    listenerIdOrTriggerType: string,
): Promise<RunnerTriggerListener | null> {
    try {
        const listener = await loadListener(runnerId, listenerIdOrTriggerType);
        if (listener) return listener;
        return null;
    } catch (err) {
        log.warn("Failed to get runner trigger listener:", err);
        return null;
    }
}

export async function getRunnerListenerTypes(
    runnerId: string,
): Promise<string[]> {
    try {
        const listeners = await listRunnerTriggerListeners(runnerId);
        return Array.from(new Set(listeners.map((listener) => listener.triggerType)));
    } catch (err) {
        log.warn("Failed to list runner trigger listener types:", err);
        return [];
    }
}

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
