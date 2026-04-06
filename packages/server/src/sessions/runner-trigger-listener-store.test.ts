import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    addRunnerTriggerListener,
    removeRunnerTriggerListener,
    listRunnerTriggerListeners,
    updateRunnerTriggerListener,
    getRunnerTriggerListener,
    getRunnerListenerTypes,
    ensureRunnerTriggerListenersTable,
    _injectRedisForTesting,
    _resetRedisForTesting,
} from "./runner-trigger-listener-store.js";
import { createTestDatabase, _setKyselyForTest, getKysely } from "../auth.js";

const tmpDir = mkdtempSync(join(tmpdir(), "pizzapi-runner-trigger-listeners-"));
const dbPath = join(tmpDir, "test.db");
const testDb = createTestDatabase(dbPath);

const hashes = new Map<string, Map<string, string>>();
const mockRedisClient = {
    isOpen: true,
    hSet: mock((key: string, field: string, value: string) => {
        if (!hashes.has(key)) hashes.set(key, new Map());
        hashes.get(key)!.set(field, value);
        return Promise.resolve(1);
    }),
    hGet: mock((key: string, field: string) => Promise.resolve(hashes.get(key)?.get(field) ?? null)),
    hGetAll: mock((key: string) => Promise.resolve(Object.fromEntries(hashes.get(key)?.entries() ?? []))),
    hDel: mock((key: string, field: string) => {
        const existed = hashes.get(key)?.delete(field) ? 1 : 0;
        return Promise.resolve(existed);
    }),
};

function resetState() {
    hashes.clear();
    _injectRedisForTesting(mockRedisClient);
    _setKyselyForTest(testDb);
}

beforeAll(async () => {
    _setKyselyForTest(testDb);
    _injectRedisForTesting(mockRedisClient);
    await ensureRunnerTriggerListenersTable();
});

beforeEach(async () => {
    resetState();
    _setKyselyForTest(testDb);
    await getKysely().deleteFrom("runner_trigger_listener").execute();
});

afterAll(() => {
    _resetRedisForTesting();
    rmSync(tmpDir, { recursive: true, force: true });
});

const isCI = !!process.env.CI;

describe("runner trigger listener store", () => {
    (isCI ? test.skip : test)("persists listeners in SQLite so they survive Redis reset", async () => {
        await addRunnerTriggerListener("runner-1", "svc:event", {
            cwd: "/code",
            prompt: "spawn it",
            params: { repo: "pizzapi" },
            model: { provider: "anthropic", id: "claude-sonnet-4" },
        });

        // Simulate a Redis restart / cache loss.
        hashes.clear();

        const listeners = await listRunnerTriggerListeners("runner-1");
        expect(listeners).toHaveLength(1);
        expect(listeners[0]).toMatchObject({
            triggerType: "svc:event",
            cwd: "/code",
            prompt: "spawn it",
            params: { repo: "pizzapi" },
            model: { provider: "anthropic", id: "claude-sonnet-4" },
        });

        const direct = await getRunnerTriggerListener("runner-1", "svc:event");
        expect(direct).toMatchObject({ triggerType: "svc:event" });

        const dbRow = await getKysely()
            .selectFrom("runner_trigger_listener")
            .select(["runnerId", "triggerType"])
            .where("runnerId", "=", "runner-1")
            .where("triggerType", "=", "svc:event")
            .executeTakeFirst();
        expect(dbRow).toBeTruthy();
    });

    (isCI ? test.skip : test)("updates persisted listeners without losing createdAt", async () => {
        await addRunnerTriggerListener("runner-1", "svc:event", {
            prompt: "initial",
        });
        const initial = await getRunnerTriggerListener("runner-1", "svc:event");
        expect(initial).toBeTruthy();

        await updateRunnerTriggerListener("runner-1", "svc:event", {
            cwd: "/workspace",
            params: { project: "PizzaPi" },
        });

        hashes.clear();
        const updated = await getRunnerTriggerListener("runner-1", "svc:event");
        expect(updated).toBeTruthy();
        expect(updated).toMatchObject({
            triggerType: "svc:event",
            prompt: "initial",
            cwd: "/workspace",
            params: { project: "PizzaPi" },
        });
        expect(updated?.createdAt).toBe(initial?.createdAt);
    });

    (isCI ? test.skip : test)("removes listeners from both SQLite and Redis", async () => {
        await addRunnerTriggerListener("runner-1", "svc:event", { prompt: "spawn it" });
        const removed = await removeRunnerTriggerListener("runner-1", "svc:event");
        expect(removed).toBe(true);

        hashes.clear();
        const listeners = await listRunnerTriggerListeners("runner-1");
        expect(listeners).toEqual([]);

        const dbRow = await getKysely()
            .selectFrom("runner_trigger_listener")
            .select(["id"])
            .where("runnerId", "=", "runner-1")
            .where("triggerType", "=", "svc:event")
            .executeTakeFirst();
        expect(dbRow).toBeUndefined();
    });

    (isCI ? test.skip : test)("supports multiple listeners for the same trigger type with distinct listener ids", async () => {
        const first = await addRunnerTriggerListener("runner-1", "svc:event", { prompt: "first" });
        const second = await addRunnerTriggerListener("runner-1", "svc:event", { prompt: "second", cwd: "/workspace" });

        const listeners = await listRunnerTriggerListeners("runner-1");
        expect(listeners.filter((listener) => listener.triggerType === "svc:event")).toHaveLength(2);
        expect(new Set(listeners.map((listener) => listener.listenerId)).size).toBe(2);
        expect(first).toBeString();
        expect(second).toBeString();
    });

    (isCI ? test.skip : test)("updates and removes a listener by listenerId without affecting siblings", async () => {
        const first = await addRunnerTriggerListener("runner-1", "svc:event", { prompt: "first" });
        const second = await addRunnerTriggerListener("runner-1", "svc:event", { prompt: "second" });

        const updated = await updateRunnerTriggerListener("runner-1", first, { cwd: "/tmp/first" });
        expect(updated).toBe(true);

        let listeners = await listRunnerTriggerListeners("runner-1");
        expect(listeners.find((listener) => listener.listenerId === first)).toMatchObject({ cwd: "/tmp/first", prompt: "first" });
        expect(listeners.find((listener) => listener.listenerId === second)).toMatchObject({ prompt: "second" });

        const removed = await removeRunnerTriggerListener("runner-1", first);
        expect(removed).toBe(true);

        listeners = await listRunnerTriggerListeners("runner-1");
        expect(listeners).toHaveLength(1);
        expect(listeners[0].listenerId).toBe(second);
    });

    (isCI ? test.skip : test)("legacy remove by triggerType removes all listeners for that type", async () => {
        await addRunnerTriggerListener("runner-1", "svc:event", { prompt: "first" });
        await addRunnerTriggerListener("runner-1", "svc:event", { prompt: "second" });

        const removed = await removeRunnerTriggerListener("runner-1", "svc:event");
        expect(removed).toBe(true);
        expect(await listRunnerTriggerListeners("runner-1")).toEqual([]);
    });

    (isCI ? test.skip : test)("backfills legacy Redis-only listeners into SQLite on read", async () => {
        const legacyListener = {
            triggerType: "svc:legacy",
            prompt: "legacy prompt",
            createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        };
        await mockRedisClient.hSet("pizzapi:runner-trigger-listeners:runner-1", "svc:legacy", JSON.stringify(legacyListener));

        const listeners = await listRunnerTriggerListeners("runner-1");
        expect(listeners).toHaveLength(1);
        expect(listeners[0]).toMatchObject(legacyListener);
        expect(listeners[0].listenerId).toBeString();

        const dbRow = await getKysely()
            .selectFrom("runner_trigger_listener")
            .select(["runnerId", "triggerType"])
            .where("runnerId", "=", "runner-1")
            .where("triggerType", "=", "svc:legacy")
            .executeTakeFirst();
        expect(dbRow).toBeTruthy();
    });

    (isCI ? test.skip : test)("removes legacy rows with JSON-array composite key IDs", async () => {
        // Simulate a legacy row: id is a JSON array like '["runnerId","triggerType"]'
        const legacyId = JSON.stringify(["runner-1", "svc:legacy-del"]);
        const listenerJson = JSON.stringify({
            triggerType: "svc:legacy-del",
            prompt: "old prompt",
            createdAt: new Date().toISOString(),
            // Note: no listenerId field — this is what makes it legacy
        });
        await getKysely()
            .insertInto("runner_trigger_listener")
            .values({
                id: legacyId,
                runnerId: "runner-1",
                triggerType: "svc:legacy-del",
                listenerJson,
                updatedAt: new Date().toISOString(),
            })
            .execute();

        // Listing should return the listener with the DB row id as listenerId
        const listeners = await listRunnerTriggerListeners("runner-1");
        const legacy = listeners.find((l) => l.triggerType === "svc:legacy-del");
        expect(legacy).toBeTruthy();
        expect(legacy!.listenerId).toBe(legacyId);

        // Removing by the listenerId (which is the DB row id) should work
        const removed = await removeRunnerTriggerListener("runner-1", legacy!.listenerId);
        expect(removed).toBe(true);

        // Verify it's gone
        const after = await listRunnerTriggerListeners("runner-1");
        expect(after.find((l) => l.triggerType === "svc:legacy-del")).toBeUndefined();
    });

    (isCI ? test.skip : test)("returns trigger types for listener lookup", async () => {
        await addRunnerTriggerListener("runner-1", "svc:one", { prompt: "one" });
        await addRunnerTriggerListener("runner-1", "svc:two", { prompt: "two" });
        const types = await getRunnerListenerTypes("runner-1");
        expect(types.sort()).toEqual(["svc:one", "svc:two"]);
    });
});
