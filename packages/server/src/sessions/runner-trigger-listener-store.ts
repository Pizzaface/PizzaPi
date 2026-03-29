/**
 * Runner trigger listener store — Redis-backed auto-spawn subscriptions.
 *
 * A listener links a runner to a trigger type: when a service broadcasts
 * that trigger type, the server auto-spawns a new session on the runner
 * and delivers the trigger into it.
 *
 * Storage layout:
 *   pizzapi:runner-trigger-listeners:{runnerId} → Redis hash: { triggerType → JSON config }
 *
 * Config includes optional prompt template, model, cwd.
 */

import { connectRedisClient, isRedisDisabled, type RedisClient } from "../redis-client.js";
import { createLogger } from "@pizzapi/tools";

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

// ── Public API ────────────────────────────────────────────────────────────

/** Add or update a listener for a trigger type on a runner. */
export async function addRunnerTriggerListener(
    runnerId: string,
    triggerType: string,
    opts?: { prompt?: string; cwd?: string; model?: { provider: string; id: string }; params?: Record<string, unknown> },
): Promise<void> {
    const redis = await getClient();
    if (!redis) return;
    const value: RunnerTriggerListener = {
        triggerType,
        prompt: opts?.prompt,
        cwd: opts?.cwd,
        model: opts?.model,
        params: opts?.params as RunnerTriggerListener["params"],
        createdAt: new Date().toISOString(),
    };
    await redis.hSet(LISTENERS_KEY(runnerId), triggerType, JSON.stringify(value));
    log.info(`Added runner trigger listener: ${runnerId} → ${triggerType}`);
}

/** Remove a listener for a trigger type on a runner. */
export async function removeRunnerTriggerListener(
    runnerId: string,
    triggerType: string,
): Promise<boolean> {
    const redis = await getClient();
    if (!redis) return false;
    const removed = await redis.hDel(LISTENERS_KEY(runnerId), triggerType);
    if (removed > 0) {
        log.info(`Removed runner trigger listener: ${runnerId} → ${triggerType}`);
    }
    return removed > 0;
}

/** List all listeners for a runner. */
export async function listRunnerTriggerListeners(
    runnerId: string,
): Promise<RunnerTriggerListener[]> {
    const redis = await getClient();
    if (!redis) return [];
    const entries = await redis.hGetAll(LISTENERS_KEY(runnerId));
    const listeners: RunnerTriggerListener[] = [];
    for (const [, json] of Object.entries(entries)) {
        try {
            listeners.push(JSON.parse(json) as RunnerTriggerListener);
        } catch {
            // skip malformed
        }
    }
    return listeners;
}

/** Get a specific listener for a runner + trigger type. */
export async function getRunnerTriggerListener(
    runnerId: string,
    triggerType: string,
): Promise<RunnerTriggerListener | null> {
    const redis = await getClient();
    if (!redis) return null;
    const json = await redis.hGet(LISTENERS_KEY(runnerId), triggerType);
    if (!json) return null;
    try {
        return JSON.parse(json) as RunnerTriggerListener;
    } catch {
        return null;
    }
}

/** Get all trigger types that have listeners on a runner. */
export async function getRunnerListenerTypes(
    runnerId: string,
): Promise<string[]> {
    const redis = await getClient();
    if (!redis) return [];
    const keys = await redis.hKeys(LISTENERS_KEY(runnerId));
    return keys;
}
