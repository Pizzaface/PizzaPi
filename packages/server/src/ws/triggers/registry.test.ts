import { describe, test, expect, beforeEach } from "bun:test";
import { TriggerRegistry } from "./registry.js";
import type { TriggerRecord } from "@pizzapi/protocol";

// ============================================================================
// In-memory Redis mock
// ============================================================================

type MockMultiCommand = { cmd: string; args: unknown[] };

class MockRedisMulti {
    private commands: MockMultiCommand[] = [];
    constructor(private store: MockRedisStore) {}

    set(key: string, value: string) {
        this.commands.push({ cmd: "set", args: [key, value] });
        return this;
    }
    get(key: string) {
        this.commands.push({ cmd: "get", args: [key] });
        return this;
    }
    del(key: string | string[]) {
        this.commands.push({ cmd: "del", args: [key] });
        return this;
    }
    sAdd(key: string, member: string | string[]) {
        this.commands.push({ cmd: "sAdd", args: [key, member] });
        return this;
    }
    sRem(key: string, member: string | string[]) {
        this.commands.push({ cmd: "sRem", args: [key, member] });
        return this;
    }
    async exec() {
        for (const { cmd, args } of this.commands) {
            if (cmd === "set") {
                this.store.strings.set(args[0] as string, args[1] as string);
            } else if (cmd === "del") {
                const key = args[0] as string | string[];
                const keys = Array.isArray(key) ? key : [key];
                for (const k of keys) this.store.strings.delete(k);
            } else if (cmd === "sAdd") {
                const key = args[0] as string;
                const members = Array.isArray(args[1]) ? (args[1] as string[]) : [args[1] as string];
                if (!this.store.sets.has(key)) this.store.sets.set(key, new Set());
                for (const m of members) this.store.sets.get(key)!.add(m);
            } else if (cmd === "sRem") {
                const key = args[0] as string;
                const members = Array.isArray(args[1]) ? (args[1] as string[]) : [args[1] as string];
                const s = this.store.sets.get(key);
                if (s) for (const m of members) s.delete(m);
            }
        }
        return [];
    }
}

class MockRedisStore {
    strings: Map<string, string> = new Map();
    sets: Map<string, Set<string>> = new Map();

    async get(key: string): Promise<string | null> {
        return this.strings.get(key) ?? null;
    }

    async set(key: string, value: string): Promise<void> {
        this.strings.set(key, value);
    }

    async del(key: string | string[]): Promise<void> {
        const keys = Array.isArray(key) ? key : [key];
        for (const k of keys) this.strings.delete(k);
    }

    async sAdd(key: string, member: string | string[]): Promise<void> {
        if (!this.sets.has(key)) this.sets.set(key, new Set());
        const members = Array.isArray(member) ? member : [member];
        for (const m of members) this.sets.get(key)!.add(m);
    }

    async sRem(key: string, member: string | string[]): Promise<void> {
        const s = this.sets.get(key);
        if (!s) return;
        const members = Array.isArray(member) ? member : [member];
        for (const m of members) s.delete(m);
    }

    async sMembers(key: string): Promise<string[]> {
        return Array.from(this.sets.get(key) ?? []);
    }

    async sCard(key: string): Promise<number> {
        return this.sets.get(key)?.size ?? 0;
    }

    multi(): MockRedisMulti {
        return new MockRedisMulti(this);
    }
}

// ============================================================================
// Helpers
// ============================================================================

function makeRegistry(store: MockRedisStore): TriggerRegistry {
    // Cast to any so the mock satisfies the RedisClient type expected by the constructor
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new TriggerRegistry(() => store as any);
}

const BASE_PARAMS = {
    type: "session_ended" as const,
    ownerSessionId: "session-1",
    runnerId: "runner-1",
    config: { sessionIds: ["session-2"] as string[] },
    delivery: { mode: "inject" as const },
    message: "Session ended!",
};

// ============================================================================
// Tests
// ============================================================================

describe("TriggerRegistry", () => {
    let store: MockRedisStore;
    let registry: TriggerRegistry;

    beforeEach(() => {
        store = new MockRedisStore();
        registry = makeRegistry(store);
    });

    // -------------------------------------------------------------------------
    // registerTrigger
    // -------------------------------------------------------------------------

    describe("registerTrigger", () => {
        test("registers a trigger and returns triggerId", async () => {
            const result = await registry.registerTrigger(BASE_PARAMS);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(typeof result.triggerId).toBe("string");
            expect(result.triggerId.length).toBeGreaterThan(0);
        });

        test("stores the record in Redis with correct fields", async () => {
            const result = await registry.registerTrigger({
                ...BASE_PARAMS,
                maxFirings: 3,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            const { triggerId } = result;

            // Record key should exist
            const rawRecord = store.strings.get(`triggers:${BASE_PARAMS.runnerId}:${triggerId}`);
            expect(rawRecord).toBeDefined();
            const record: TriggerRecord = JSON.parse(rawRecord!);
            expect(record.id).toBe(triggerId);
            expect(record.type).toBe("session_ended");
            expect(record.ownerSessionId).toBe("session-1");
            expect(record.runnerId).toBe("runner-1");
            expect(record.firingCount).toBe(0);
            expect(record.maxFirings).toBe(3);
            expect(typeof record.createdAt).toBe("string");

            // Meta key
            expect(store.strings.get(`triggers:meta:${triggerId}`)).toBe("runner-1");

            // Index keys
            expect(store.sets.get("triggers:by-runner:runner-1")?.has(triggerId)).toBe(true);
            expect(store.sets.get("triggers:by-session:session-1")?.has(triggerId)).toBe(true);
            expect(store.sets.get("triggers:by-type:runner-1:session_ended")?.has(triggerId)).toBe(true);
        });

        test("returns error when Redis is unavailable", async () => {
            const nullRegistry = new TriggerRegistry(() => null);
            const result = await nullRegistry.registerTrigger(BASE_PARAMS);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toContain("Redis unavailable");
        });

        test("enforces per-session limit of 100", async () => {
            // Pre-populate the by-session set to simulate 100 existing triggers
            for (let i = 0; i < 100; i++) {
                store.sets.set("triggers:by-session:session-1", new Set(Array.from({ length: 100 }, (_, j) => `fake-${j}`)));
            }
            const result = await registry.registerTrigger(BASE_PARAMS);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toContain("Session trigger limit");
        });

        test("enforces per-runner limit of 1000", async () => {
            // Simulate empty session set but full runner set
            store.sets.set("triggers:by-runner:runner-1", new Set(Array.from({ length: 1000 }, (_, i) => `fake-${i}`)));
            const result = await registry.registerTrigger(BASE_PARAMS);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toContain("Runner trigger limit");
        });

        test("optional fields (maxFirings, expiresAt) are included when provided", async () => {
            const expiresAt = new Date(Date.now() + 60_000).toISOString();
            const result = await registry.registerTrigger({
                ...BASE_PARAMS,
                maxFirings: 5,
                expiresAt,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const raw = store.strings.get(`triggers:runner-1:${result.triggerId}`);
            const record: TriggerRecord = JSON.parse(raw!);
            expect(record.maxFirings).toBe(5);
            expect(record.expiresAt).toBe(expiresAt);
        });

        test("optional fields are omitted when not provided", async () => {
            const result = await registry.registerTrigger(BASE_PARAMS);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const raw = store.strings.get(`triggers:runner-1:${result.triggerId}`);
            const record: TriggerRecord = JSON.parse(raw!);
            expect(record.maxFirings).toBeUndefined();
            expect(record.expiresAt).toBeUndefined();
        });
    });

    // -------------------------------------------------------------------------
    // cancelTrigger
    // -------------------------------------------------------------------------

    describe("cancelTrigger", () => {
        test("cancels an existing trigger and removes all indices", async () => {
            const reg = await registry.registerTrigger(BASE_PARAMS);
            expect(reg.ok).toBe(true);
            if (!reg.ok) return;
            const { triggerId } = reg;

            const cancel = await registry.cancelTrigger(triggerId, "session-1");
            expect(cancel.ok).toBe(true);

            // Record and meta gone
            expect(store.strings.has(`triggers:runner-1:${triggerId}`)).toBe(false);
            expect(store.strings.has(`triggers:meta:${triggerId}`)).toBe(false);

            // All index sets are empty
            expect(store.sets.get("triggers:by-runner:runner-1")?.has(triggerId)).toBeFalsy();
            expect(store.sets.get("triggers:by-session:session-1")?.has(triggerId)).toBeFalsy();
            expect(store.sets.get("triggers:by-type:runner-1:session_ended")?.has(triggerId)).toBeFalsy();
        });

        test("returns error when trigger does not exist", async () => {
            const result = await registry.cancelTrigger("non-existent-id", "session-1");
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toContain("not found");
        });

        test("returns error when sessionId does not match owner", async () => {
            const reg = await registry.registerTrigger(BASE_PARAMS);
            if (!reg.ok) return;

            const result = await registry.cancelTrigger(reg.triggerId, "wrong-session");
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toContain("not owned by");
        });

        test("returns error when Redis is unavailable", async () => {
            const nullRegistry = new TriggerRegistry(() => null);
            const result = await nullRegistry.cancelTrigger("any-id", "session-1");
            expect(result.ok).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // listTriggers
    // -------------------------------------------------------------------------

    describe("listTriggers", () => {
        test("returns all triggers for a session", async () => {
            await registry.registerTrigger({ ...BASE_PARAMS, type: "session_ended" });
            await registry.registerTrigger({ ...BASE_PARAMS, type: "session_idle" });
            await registry.registerTrigger({ ...BASE_PARAMS, ownerSessionId: "other-session" });

            const list = await registry.listTriggers("session-1");
            expect(list.length).toBe(2);
            expect(list.every((r) => r.ownerSessionId === "session-1")).toBe(true);
        });

        test("returns empty array when session has no triggers", async () => {
            const list = await registry.listTriggers("no-such-session");
            expect(list).toEqual([]);
        });

        test("returns empty array when Redis is unavailable", async () => {
            const nullRegistry = new TriggerRegistry(() => null);
            const list = await nullRegistry.listTriggers("session-1");
            expect(list).toEqual([]);
        });
    });

    // -------------------------------------------------------------------------
    // getTriggersByType
    // -------------------------------------------------------------------------

    describe("getTriggersByType", () => {
        test("returns triggers of the specified type for a runner", async () => {
            await registry.registerTrigger({ ...BASE_PARAMS, type: "session_ended" });
            await registry.registerTrigger({ ...BASE_PARAMS, type: "session_ended" });
            await registry.registerTrigger({ ...BASE_PARAMS, type: "timer", config: { delaySec: 60 } });

            const ended = await registry.getTriggersByType("runner-1", "session_ended");
            expect(ended.length).toBe(2);
            expect(ended.every((r) => r.type === "session_ended")).toBe(true);

            const timer = await registry.getTriggersByType("runner-1", "timer");
            expect(timer.length).toBe(1);
            expect(timer[0].type).toBe("timer");
        });

        test("returns empty array for unknown type", async () => {
            const result = await registry.getTriggersByType("runner-1", "cost_exceeded");
            expect(result).toEqual([]);
        });

        test("returns empty array when Redis is unavailable", async () => {
            const nullRegistry = new TriggerRegistry(() => null);
            const result = await nullRegistry.getTriggersByType("runner-1", "session_ended");
            expect(result).toEqual([]);
        });
    });

    // -------------------------------------------------------------------------
    // hasTrigger
    // -------------------------------------------------------------------------

    describe("hasTrigger", () => {
        test("returns true when a trigger exists", async () => {
            const reg = await registry.registerTrigger(BASE_PARAMS);
            if (!reg.ok) return;
            expect(await registry.hasTrigger(reg.triggerId)).toBe(true);
        });

        test("returns false when a trigger is missing", async () => {
            expect(await registry.hasTrigger("no-such-trigger")).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // fireTrigger
    // -------------------------------------------------------------------------

    describe("fireTrigger", () => {
        test("increments firingCount and sets lastFiredAt", async () => {
            const reg = await registry.registerTrigger(BASE_PARAMS);
            expect(reg.ok).toBe(true);
            if (!reg.ok) return;

            const fired = await registry.fireTrigger(reg.triggerId);
            expect(fired).not.toBeNull();
            expect(fired!.firingCount).toBe(1);
            expect(typeof fired!.lastFiredAt).toBe("string");
        });

        test("persists updated record after firing", async () => {
            const reg = await registry.registerTrigger(BASE_PARAMS);
            if (!reg.ok) return;

            await registry.fireTrigger(reg.triggerId);

            // Load directly from store
            const raw = store.strings.get(`triggers:runner-1:${reg.triggerId}`);
            const record: TriggerRecord = JSON.parse(raw!);
            expect(record.firingCount).toBe(1);
        });

        test("auto-cancels when maxFirings is reached", async () => {
            const reg = await registry.registerTrigger({ ...BASE_PARAMS, maxFirings: 2 });
            if (!reg.ok) return;

            // Fire once — should still be alive
            const fired1 = await registry.fireTrigger(reg.triggerId);
            expect(fired1).not.toBeNull();
            expect(fired1!.firingCount).toBe(1);
            expect(store.strings.has(`triggers:runner-1:${reg.triggerId}`)).toBe(true);

            // Fire second time — should reach maxFirings and be removed
            const fired2 = await registry.fireTrigger(reg.triggerId);
            expect(fired2).not.toBeNull();
            expect(fired2!.firingCount).toBe(2);

            // Record should be gone
            expect(store.strings.has(`triggers:runner-1:${reg.triggerId}`)).toBe(false);
            expect(store.strings.has(`triggers:meta:${reg.triggerId}`)).toBe(false);
        });

        test("auto-cancels one-shot timer trigger after first fire", async () => {
            const reg = await registry.registerTrigger({
                ...BASE_PARAMS,
                type: "timer",
                config: { delaySec: 30, recurring: false },
            });
            if (!reg.ok) return;

            const fired = await registry.fireTrigger(reg.triggerId);
            expect(fired).not.toBeNull();
            expect(fired!.firingCount).toBe(1);

            expect(store.strings.has(`triggers:runner-1:${reg.triggerId}`)).toBe(false);
            expect(store.strings.has(`triggers:meta:${reg.triggerId}`)).toBe(false);
        });

        test("returns null and removes trigger when expired", async () => {
            const expiresAt = new Date(Date.now() - 1000).toISOString(); // already expired
            const reg = await registry.registerTrigger({ ...BASE_PARAMS, expiresAt });
            if (!reg.ok) return;

            const fired = await registry.fireTrigger(reg.triggerId);
            expect(fired).toBeNull();

            // Record should be cleaned up
            expect(store.strings.has(`triggers:runner-1:${reg.triggerId}`)).toBe(false);
        });

        test("returns null for non-existent trigger", async () => {
            const result = await registry.fireTrigger("no-such-trigger");
            expect(result).toBeNull();
        });

        test("returns null when Redis is unavailable", async () => {
            const nullRegistry = new TriggerRegistry(() => null);
            const result = await nullRegistry.fireTrigger("any-id");
            expect(result).toBeNull();
        });

        test("fire multiple times without maxFirings keeps incrementing", async () => {
            const reg = await registry.registerTrigger(BASE_PARAMS);
            if (!reg.ok) return;

            await registry.fireTrigger(reg.triggerId);
            await registry.fireTrigger(reg.triggerId);
            const fired3 = await registry.fireTrigger(reg.triggerId);

            expect(fired3!.firingCount).toBe(3);
            // Still exists
            expect(store.strings.has(`triggers:runner-1:${reg.triggerId}`)).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // cleanupSessionTriggers
    // -------------------------------------------------------------------------

    describe("cleanupSessionTriggers", () => {
        test("removes all triggers for a session and returns count", async () => {
            await registry.registerTrigger({ ...BASE_PARAMS, type: "session_ended" });
            await registry.registerTrigger({ ...BASE_PARAMS, type: "session_idle" });
            await registry.registerTrigger({ ...BASE_PARAMS, type: "timer", config: { delaySec: 10 } });

            const count = await registry.cleanupSessionTriggers("session-1");
            expect(count).toBe(3);

            // Session index should be empty
            expect((store.sets.get("triggers:by-session:session-1")?.size ?? 0)).toBe(0);
        });

        test("returns 0 when session has no triggers", async () => {
            const count = await registry.cleanupSessionTriggers("no-such-session");
            expect(count).toBe(0);
        });

        test("does not remove triggers from other sessions", async () => {
            await registry.registerTrigger({ ...BASE_PARAMS, ownerSessionId: "session-A" });
            await registry.registerTrigger({ ...BASE_PARAMS, ownerSessionId: "session-B" });

            await registry.cleanupSessionTriggers("session-A");

            const listB = await registry.listTriggers("session-B");
            expect(listB.length).toBe(1);
        });

        test("returns 0 when Redis is unavailable", async () => {
            const nullRegistry = new TriggerRegistry(() => null);
            const count = await nullRegistry.cleanupSessionTriggers("session-1");
            expect(count).toBe(0);
        });
    });

    // -------------------------------------------------------------------------
    // rehydrateTriggers
    // -------------------------------------------------------------------------

    describe("rehydrateTriggers", () => {
        test("returns all active triggers for a runner", async () => {
            await registry.registerTrigger({ ...BASE_PARAMS, ownerSessionId: "session-1" });
            await registry.registerTrigger({ ...BASE_PARAMS, ownerSessionId: "session-2" });

            const records = await registry.rehydrateTriggers("runner-1");
            expect(records.length).toBe(2);
        });

        test("removes and ignores orphan index entries (no matching record)", async () => {
            const reg = await registry.registerTrigger(BASE_PARAMS);
            if (!reg.ok) return;

            // Manually delete the record but leave the index entry
            store.strings.delete(`triggers:runner-1:${reg.triggerId}`);

            const records = await registry.rehydrateTriggers("runner-1");
            expect(records.length).toBe(0);

            // Index entry should be cleaned up
            expect(store.sets.get("triggers:by-runner:runner-1")?.has(reg.triggerId)).toBeFalsy();
        });

        test("removes and ignores expired triggers", async () => {
            const expiresAt = new Date(Date.now() - 5000).toISOString();
            const reg = await registry.registerTrigger({ ...BASE_PARAMS, expiresAt });
            if (!reg.ok) return;

            const records = await registry.rehydrateTriggers("runner-1");
            expect(records.length).toBe(0);

            // Record should be cleaned up
            expect(store.strings.has(`triggers:runner-1:${reg.triggerId}`)).toBe(false);
        });

        test("returns only non-expired triggers when mix exists", async () => {
            const expired = new Date(Date.now() - 5000).toISOString();
            const valid = new Date(Date.now() + 60_000).toISOString();

            await registry.registerTrigger({ ...BASE_PARAMS, expiresAt: expired });
            await registry.registerTrigger({ ...BASE_PARAMS, expiresAt: valid });
            await registry.registerTrigger(BASE_PARAMS); // no expiry

            const records = await registry.rehydrateTriggers("runner-1");
            expect(records.length).toBe(2);
        });

        test("returns empty array when runner has no triggers", async () => {
            const records = await registry.rehydrateTriggers("unknown-runner");
            expect(records).toEqual([]);
        });

        test("returns empty array when Redis is unavailable", async () => {
            const nullRegistry = new TriggerRegistry(() => null);
            const records = await nullRegistry.rehydrateTriggers("runner-1");
            expect(records).toEqual([]);
        });
    });
});
