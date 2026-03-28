/**
 * Tests for the trigger subscription store.
 * Uses direct DI (_injectRedisForTesting) — no mock.module at all.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
    subscribeSessionToTrigger,
    unsubscribeSessionFromTrigger,
    listSessionSubscriptions,
    getSubscribersForTrigger,
    clearSessionSubscriptions,
    _injectRedisForTesting,
    _resetRedisForTesting,
} from "./trigger-subscription-store";

// ── In-memory Redis mock ─────────────────────────────────────────────────────

const hashes = new Map<string, Map<string, string>>();
const sets = new Map<string, Set<string>>();
const expirations = new Map<string, number>();

const mockRedisClient = {
    isOpen: true,

    hSet: mock((key: string, field: string, value: string) => {
        if (!hashes.has(key)) hashes.set(key, new Map());
        hashes.get(key)!.set(field, value);
        return Promise.resolve(1);
    }),
    hGet: mock((key: string, field: string) => {
        return Promise.resolve(hashes.get(key)?.get(field) ?? null);
    }),
    hGetAll: mock((key: string) => {
        const map = hashes.get(key);
        if (!map) return Promise.resolve({});
        return Promise.resolve(Object.fromEntries(map.entries()));
    }),
    hDel: mock((key: string, field: string) => {
        hashes.get(key)?.delete(field);
        return Promise.resolve(1);
    }),
    sAdd: mock((key: string, member: string) => {
        if (!sets.has(key)) sets.set(key, new Set());
        sets.get(key)!.add(member);
        return Promise.resolve(1);
    }),
    sRem: mock((key: string, member: string) => {
        sets.get(key)?.delete(member);
        return Promise.resolve(1);
    }),
    sMembers: mock((key: string) => {
        return Promise.resolve([...(sets.get(key) ?? [])]);
    }),
    expire: mock((key: string, ttl: number) => {
        expirations.set(key, ttl);
        return Promise.resolve(1);
    }),
    del: mock((key: string) => {
        hashes.delete(key);
        sets.delete(key);
        return Promise.resolve(1);
    }),
    multi: mock(() => {
        const ops: Array<() => Promise<unknown>> = [];
        const pipeline = {
            hSet: (key: string, field: string, value: string) => {
                ops.push(() => mockRedisClient.hSet(key, field, value));
                return pipeline;
            },
            sAdd: (key: string, member: string) => {
                ops.push(() => mockRedisClient.sAdd(key, member));
                return pipeline;
            },
            sRem: (key: string, member: string) => {
                ops.push(() => mockRedisClient.sRem(key, member));
                return pipeline;
            },
            expire: (key: string, ttl: number) => {
                ops.push(() => mockRedisClient.expire(key, ttl));
                return pipeline;
            },
            del: (key: string) => {
                ops.push(() => mockRedisClient.del(key));
                return pipeline;
            },
            exec: () => Promise.all(ops.map((op) => op())),
        };
        return pipeline;
    }),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function resetState() {
    hashes.clear();
    sets.clear();
    expirations.clear();
    _injectRedisForTesting(mockRedisClient);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.todo("subscribeSessionToTrigger", () => {
    beforeEach(resetState);

    test("adds triggerType → runnerId to session hash", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "godmother:idea_moved");
        const subs = await listSessionSubscriptions("session-1");
        expect(subs).toHaveLength(1);
        expect(subs[0].triggerType).toBe("godmother:idea_moved");
        expect(subs[0].runnerId).toBe("runner-A");
    });

    test("adds sessionId to the runner+type reverse index", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "godmother:idea_moved");
        const subscribers = await getSubscribersForTrigger("runner-A", "godmother:idea_moved");
        expect(subscribers).toContain("session-1");
    });

    test("sets TTL on both keys", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event", 3600);
        expect(expirations.get("pizzapi:trigger-subs:session-1")).toBe(3600);
        expect(expirations.get("pizzapi:trigger-subs:runner:runner-A:svc:event")).toBe(3600);
    });

    test("multiple sessions can subscribe to the same trigger type", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event");
        await subscribeSessionToTrigger("session-2", "runner-A", "svc:event");
        const subscribers = await getSubscribersForTrigger("runner-A", "svc:event");
        expect(subscribers.sort()).toEqual(["session-1", "session-2"]);
    });

    test("one session can subscribe to multiple trigger types", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event-a");
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event-b");
        const subs = await listSessionSubscriptions("session-1");
        expect(subs).toHaveLength(2);
        const types = subs.map((s) => s.triggerType).sort();
        expect(types).toEqual(["svc:event-a", "svc:event-b"]);
    });

    test("rebinding to a different runner removes stale reverse-index from old runner", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event");
        let subsA = await getSubscribersForTrigger("runner-A", "svc:event");
        expect(subsA).toContain("session-1");

        await subscribeSessionToTrigger("session-1", "runner-B", "svc:event");

        subsA = await getSubscribersForTrigger("runner-A", "svc:event");
        expect(subsA).not.toContain("session-1");

        const subsB = await getSubscribersForTrigger("runner-B", "svc:event");
        expect(subsB).toContain("session-1");

        const subs = await listSessionSubscriptions("session-1");
        const match = subs.find((s) => s.triggerType === "svc:event");
        expect(match?.runnerId).toBe("runner-B");
    });
});

describe.todo("unsubscribeSessionFromTrigger", () => {
    beforeEach(resetState);

    test("removes triggerType from session hash", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "godmother:idea_moved");
        await unsubscribeSessionFromTrigger("session-1", "godmother:idea_moved");
        const subs = await listSessionSubscriptions("session-1");
        expect(subs).toHaveLength(0);
    });

    test("removes sessionId from runner+type index", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "godmother:idea_moved");
        await subscribeSessionToTrigger("session-2", "runner-A", "godmother:idea_moved");
        await unsubscribeSessionFromTrigger("session-1", "godmother:idea_moved");
        const subscribers = await getSubscribersForTrigger("runner-A", "godmother:idea_moved");
        expect(subscribers).not.toContain("session-1");
        expect(subscribers).toContain("session-2");
    });

    test("is a no-op for a type the session isn't subscribed to", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event");
        await expect(unsubscribeSessionFromTrigger("session-1", "svc:other")).resolves.toBeUndefined();
        const subs = await listSessionSubscriptions("session-1");
        expect(subs).toHaveLength(1);
    });
});

describe.todo("listSessionSubscriptions", () => {
    beforeEach(resetState);

    test("returns empty array when session has no subscriptions", async () => {
        const subs = await listSessionSubscriptions("session-no-subs");
        expect(subs).toEqual([]);
    });

    test("returns all subscriptions with their runnerIds", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:alpha");
        await subscribeSessionToTrigger("session-1", "runner-B", "svc:beta");
        const subs = await listSessionSubscriptions("session-1");
        expect(subs).toHaveLength(2);
        const alpha = subs.find((s) => s.triggerType === "svc:alpha");
        const beta = subs.find((s) => s.triggerType === "svc:beta");
        expect(alpha?.runnerId).toBe("runner-A");
        expect(beta?.runnerId).toBe("runner-B");
    });
});

describe.todo("getSubscribersForTrigger", () => {
    beforeEach(resetState);

    test("returns empty array when no sessions subscribed", async () => {
        const subs = await getSubscribersForTrigger("runner-A", "svc:event");
        expect(subs).toEqual([]);
    });

    test("returns only sessions subscribed to the given runner+type combo", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event");
        await subscribeSessionToTrigger("session-2", "runner-A", "svc:event");
        await subscribeSessionToTrigger("session-3", "runner-B", "svc:event");
        await subscribeSessionToTrigger("session-4", "runner-A", "svc:other");

        const subscribers = await getSubscribersForTrigger("runner-A", "svc:event");
        expect(subscribers.sort()).toEqual(["session-1", "session-2"]);
    });
});

describe.todo("clearSessionSubscriptions", () => {
    beforeEach(resetState);

    test("removes all subscriptions for a session", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:alpha");
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:beta");
        await clearSessionSubscriptions("session-1");
        const subs = await listSessionSubscriptions("session-1");
        expect(subs).toHaveLength(0);
    });

    test("removes session from all reverse indexes", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:alpha");
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:beta");
        await clearSessionSubscriptions("session-1");
        const alphaSubscribers = await getSubscribersForTrigger("runner-A", "svc:alpha");
        const betaSubscribers = await getSubscribersForTrigger("runner-A", "svc:beta");
        expect(alphaSubscribers).not.toContain("session-1");
        expect(betaSubscribers).not.toContain("session-1");
    });

    test("does not affect subscriptions of other sessions", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event");
        await subscribeSessionToTrigger("session-2", "runner-A", "svc:event");
        await clearSessionSubscriptions("session-1");
        const subscribers = await getSubscribersForTrigger("runner-A", "svc:event");
        expect(subscribers).toContain("session-2");
        expect(subscribers).not.toContain("session-1");
    });

    test("is a no-op for a session with no subscriptions", async () => {
        await expect(clearSessionSubscriptions("session-no-subs")).resolves.toBeUndefined();
    });
});
