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

    test("removes listeners from both SQLite and Redis", async () => {
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

    test("backfills legacy Redis-only listeners into SQLite on read", async () => {
        const legacyListener = {
            triggerType: "svc:legacy",
            prompt: "legacy prompt",
            createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        };
        await mockRedisClient.hSet("pizzapi:runner-trigger-listeners:runner-1", "svc:legacy", JSON.stringify(legacyListener));

        const listeners = await listRunnerTriggerListeners("runner-1");
        expect(listeners).toHaveLength(1);
        expect(listeners[0]).toMatchObject(legacyListener);

        const dbRow = await getKysely()
            .selectFrom("runner_trigger_listener")
            .select(["runnerId", "triggerType"])
            .where("runnerId", "=", "runner-1")
            .where("triggerType", "=", "svc:legacy")
            .executeTakeFirst();
        expect(dbRow).toBeTruthy();
    });

    (isCI ? test.skip : test)("returns trigger types for listener lookup", async () => {
        await addRunnerTriggerListener("runner-1", "svc:one", { prompt: "one" });
        await addRunnerTriggerListener("runner-1", "svc:two", { prompt: "two" });
        const types = await getRunnerListenerTypes("runner-1");
        expect(types.sort()).toEqual(["svc:one", "svc:two"]);
    });
});
