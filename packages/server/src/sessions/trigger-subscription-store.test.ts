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
    getSubscriptionParams,
    clearSessionSubscriptions,
    getSubscriptionsForSessionTrigger,
    unsubscribeSessionSubscription,
    getSessionIdsWithSubscriptionsForRunner,
    refreshRunnerSubscriptionTtls,
    sessionHasScheduleSubscription,
    isDurableTriggerType,
    claimFireOnce,
    confirmFireOnce,
    releaseFireOnce,
    _injectRedisForTesting,
    _resetRedisForTesting,
} from "./trigger-subscription-store";

// ── In-memory Redis mock ─────────────────────────────────────────────────────

const hashes = new Map<string, Map<string, string>>();
const sets = new Map<string, Set<string>>();
const expirations = new Map<string, number>();
const strings = new Map<string, string>();

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
        strings.delete(key);
        return Promise.resolve(1);
    }),
    set: mock((key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
        if (opts?.NX && strings.has(key)) return Promise.resolve(null);
        strings.set(key, value);
        if (opts?.EX) expirations.set(key, opts.EX);
        return Promise.resolve("OK");
    }),
    multi: mock(() => {
        const ops: Array<() => Promise<unknown>> = [];
        const pipeline = {
            hSet: (key: string, field: string, value: string) => {
                ops.push(() => mockRedisClient.hSet(key, field, value));
                return pipeline;
            },
            hDel: (key: string, field: string) => {
                ops.push(() => mockRedisClient.hDel(key, field));
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
    strings.clear();
    _injectRedisForTesting(mockRedisClient);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("subscribeSessionToTrigger", () => {
    beforeEach(resetState);

    test("returns a non-empty subscriptionId on success", async () => {
        const id = await subscribeSessionToTrigger("session-1", "runner-A", "svc:event");
        expect(id).toBeTruthy();
        expect(typeof id).toBe("string");
    });

    test("returns null (typed failure) when the Redis write fails", async () => {
        _injectRedisForTesting({
            ...mockRedisClient,
            multi: () => ({
                hSet: function () { return this; },
                sAdd: function () { return this; },
                expire: function () { return this; },
                exec: () => Promise.reject(new Error("redis down")),
            }),
        });
        const id = await subscribeSessionToTrigger("session-1", "runner-A", "svc:event");
        expect(id).toBeNull();
        // Nothing half-written into the visible state.
        const subs = await listSessionSubscriptions("session-1");
        expect(subs).toHaveLength(0);
    });

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

    test("same triggerType can be subscribed on different runners independently", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event");
        await subscribeSessionToTrigger("session-1", "runner-B", "svc:event");

        const subsA = await getSubscribersForTrigger("runner-A", "svc:event");
        expect(subsA).toContain("session-1");

        const subsB = await getSubscribersForTrigger("runner-B", "svc:event");
        expect(subsB).toContain("session-1");

        const subs = await listSessionSubscriptions("session-1");
        expect(subs.filter((s) => s.triggerType === "svc:event")).toHaveLength(2);
        expect(new Set(subs.filter((s) => s.triggerType === "svc:event").map((s) => s.runnerId))).toEqual(new Set(["runner-A", "runner-B"]));
    });
});

describe("unsubscribeSessionFromTrigger", () => {
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
        await expect(unsubscribeSessionFromTrigger("session-1", "svc:other")).resolves.toEqual({ removed: 0, triggerType: "svc:other" });
        const subs = await listSessionSubscriptions("session-1");
        expect(subs).toHaveLength(1);
    });
});

describe("multi-subscription support", () => {
    beforeEach(resetState);

    test("subscribing twice to the same triggerType stores two distinct records with ids", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event", undefined, { first: true });
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event", undefined, { second: true });

        const subs = await listSessionSubscriptions("session-1");
        expect(subs.filter((sub) => sub.triggerType === "svc:event")).toHaveLength(2);
        expect(new Set(subs.map((sub) => sub.subscriptionId)).size).toBe(2);
    });

    test("lookup by session + triggerType returns all matching subscriptions", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event", undefined, { name: "one" });
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event", undefined, { name: "two" });

        const subs = await getSubscriptionsForSessionTrigger("session-1", "svc:event");
        expect(subs).toHaveLength(2);
        expect(subs.map((sub) => sub.params?.name).sort()).toEqual(["one", "two"]);
    });

    test("unsubscribe by subscriptionId removes only the targeted record", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event", undefined, { name: "one" });
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event", undefined, { name: "two" });
        const subs = await getSubscriptionsForSessionTrigger("session-1", "svc:event");

        await unsubscribeSessionSubscription("session-1", subs[0].subscriptionId);

        const remaining = await getSubscriptionsForSessionTrigger("session-1", "svc:event");
        expect(remaining).toHaveLength(1);
        expect(remaining[0].subscriptionId).toBe(subs[1].subscriptionId);
    });

    test("legacy unsubscribe by triggerType removes all subscriptions for that type", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event", undefined, { name: "one" });
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event", undefined, { name: "two" });

        await unsubscribeSessionFromTrigger("session-1", "svc:event");

        expect(await getSubscriptionsForSessionTrigger("session-1", "svc:event")).toEqual([]);
    });

    test("legacy hash data keyed by triggerType still parses and gains generated ids", async () => {
        hashes.set("pizzapi:trigger-subs:session-legacy", new Map([
            ["svc:legacy", JSON.stringify({ runnerId: "runner-A", params: { repo: "PizzaPi" } })],
        ]));

        const subs = await listSessionSubscriptions("session-legacy");
        expect(subs).toHaveLength(1);
        expect(subs[0]).toMatchObject({ triggerType: "svc:legacy", runnerId: "runner-A", params: { repo: "PizzaPi" } });
        expect(subs[0].subscriptionId).toBeString();
    });

    test("delivery lookup returns all subscriptions for same type while reverse index stays session-based", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event", undefined, { name: "one" });
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event", undefined, { name: "two" });

        const subscribers = await getSubscribersForTrigger("runner-A", "svc:event");
        expect(subscribers).toEqual(["session-1"]);

        const subs = await getSubscriptionsForSessionTrigger("session-1", "svc:event");
        expect(subs).toHaveLength(2);
    });
});

describe("idempotent subscribe (duplicate prevention)", () => {
    beforeEach(resetState);

    test("re-subscribing with identical params reuses the subscriptionId instead of duplicating", async () => {
        const first = await subscribeSessionToTrigger("session-1", "runner-A", "time:cron", undefined, { cron: "0 9 * * *", message: "standup" });
        const second = await subscribeSessionToTrigger("session-1", "runner-A", "time:cron", undefined, { cron: "0 9 * * *", message: "standup" });
        expect(second).toBe(first);
        const subs = await listSessionSubscriptions("session-1");
        expect(subs.filter((s) => s.triggerType === "time:cron")).toHaveLength(1);
    });

    test("same triggerType with different params still creates a second subscription", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "time:cron", undefined, { cron: "0 9 * * *" });
        await subscribeSessionToTrigger("session-1", "runner-A", "time:cron", undefined, { cron: "0 12 * * *" });
        const subs = await listSessionSubscriptions("session-1");
        expect(subs.filter((s) => s.triggerType === "time:cron")).toHaveLength(2);
    });

    test("pre-existing identical duplicate rows are pruned on re-subscribe", async () => {
        const seedId = "sub:session-1:time:cron:seed1";
        const dupId = "sub:session-1:time:cron:dup1";
        const seedValue = JSON.stringify({ subscriptionId: seedId, triggerType: "time:cron", runnerId: "runner-A", params: { cron: "0 9 * * *" }, filters: [] });
        hashes.set("pizzapi:trigger-subs:session-1", new Map([
            [seedId, seedValue],
            [dupId, JSON.stringify({ subscriptionId: dupId, triggerType: "time:cron", runnerId: "runner-A", params: { cron: "0 9 * * *" }, filters: [] })],
        ]));
        const id = await subscribeSessionToTrigger("session-1", "runner-A", "time:cron", undefined, { cron: "0 9 * * *" });
        expect(id).toBe(seedId);
        const subs = await listSessionSubscriptions("session-1");
        expect(subs.filter((s) => s.triggerType === "time:cron")).toHaveLength(1);
        expect(subs[0]!.subscriptionId).toBe(seedId);
    });

    test("identical params on a different runner are separate subscriptions", async () => {
        const first = await subscribeSessionToTrigger("session-1", "runner-A", "time:cron", undefined, { cron: "0 9 * * *" });
        const second = await subscribeSessionToTrigger("session-1", "runner-B", "time:cron", undefined, { cron: "0 9 * * *" });
        expect(second).not.toBe(first);
        const subs = await listSessionSubscriptions("session-1");
        expect(subs.filter((s) => s.triggerType === "time:cron")).toHaveLength(2);
    });

    test("param key order does not defeat dedup (canonical identity)", async () => {
        const first = await subscribeSessionToTrigger("session-1", "runner-A", "time:cron", undefined, { cron: "0 9 * * *", _cwd: "/tmp/x" });
        const second = await subscribeSessionToTrigger("session-1", "runner-A", "time:cron", undefined, { _cwd: "/tmp/x", cron: "0 9 * * *" });
        expect(second).toBe(first);
        const subs = await listSessionSubscriptions("session-1");
        expect(subs.filter((s) => s.triggerType === "time:cron")).toHaveLength(1);
    });
});

describe("claimFireOnce (delivery fire dedup)", () => {
    beforeEach(resetState);

    test("claims once, blocks replays, releases on failure", async () => {
        await expect(claimFireOnce("session-1", "fire-1")).resolves.toBe(true);
        await expect(claimFireOnce("session-1", "fire-1")).resolves.toBe(false);
        await releaseFireOnce("session-1", "fire-1");
        await expect(claimFireOnce("session-1", "fire-1")).resolves.toBe(true);
    });

    test("different fireIds and sessions do not collide", async () => {
        await expect(claimFireOnce("session-1", "a")).resolves.toBe(true);
        await expect(claimFireOnce("session-1", "b")).resolves.toBe(true);
        await expect(claimFireOnce("session-2", "a")).resolves.toBe(true);
    });

    test("confirm extends the TTL without releasing the claim", async () => {
        await expect(claimFireOnce("session-1", "fire-1")).resolves.toBe(true);
        await expect(confirmFireOnce("session-1", "fire-1")).resolves.toBeUndefined();
        await expect(claimFireOnce("session-1", "fire-1")).resolves.toBe(false);
    });
});

describe("listSessionSubscriptions", () => {
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

describe("getSubscribersForTrigger", () => {
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

describe("clearSessionSubscriptions", () => {
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

// ── Subscription params ──────────────────────────────────────────────────────

describe("subscription params", () => {
    beforeEach(resetState);

    test("subscribe with params stores them and lists them", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "github:pr_comment", undefined, { prNumber: 42 });
        const subs = await listSessionSubscriptions("session-1");
        expect(subs).toHaveLength(1);
        expect(subs[0].triggerType).toBe("github:pr_comment");
        expect(subs[0].runnerId).toBe("runner-A");
        expect(subs[0].params).toEqual({ prNumber: 42 });
    });

    test("getSubscriptionParams returns params for subscribed session", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "github:pr_comment", undefined, { prNumber: 42, repo: "pizzapi" });
        const params = await getSubscriptionParams("session-1", "github:pr_comment");
        expect(params).toEqual({ prNumber: 42, repo: "pizzapi" });
    });

    test("getSubscriptionParams returns undefined when no params stored", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event");
        const params = await getSubscriptionParams("session-1", "svc:event");
        expect(params).toBeUndefined();
    });

    test("getSubscriptionParams returns undefined for unsubscribed type", async () => {
        const params = await getSubscriptionParams("session-1", "nonexistent:type");
        expect(params).toBeUndefined();
    });

    test("subscribe without params does not include params in listing", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "svc:event");
        const subs = await listSessionSubscriptions("session-1");
        expect(subs[0].params).toBeUndefined();
    });

    test("multiple subscriptions of same triggerType preserve the earliest params for legacy lookup", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "github:pr_comment", undefined, { prNumber: 42 });
        await subscribeSessionToTrigger("session-1", "runner-A", "github:pr_comment", undefined, { prNumber: 99 });
        const params = await getSubscriptionParams("session-1", "github:pr_comment");
        expect(params).toEqual({ prNumber: 42 });
    });

    test("unsubscribe clears params", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "github:pr_comment", undefined, { prNumber: 42 });
        await unsubscribeSessionFromTrigger("session-1", "github:pr_comment");
        const params = await getSubscriptionParams("session-1", "github:pr_comment");
        expect(params).toBeUndefined();
    });

    test("clearSessionSubscriptions clears params for all types", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "type:a", undefined, { key: "val1" });
        await subscribeSessionToTrigger("session-1", "runner-A", "type:b", undefined, { key: "val2" });
        await clearSessionSubscriptions("session-1");
        const paramsA = await getSubscriptionParams("session-1", "type:a");
        const paramsB = await getSubscriptionParams("session-1", "type:b");
        expect(paramsA).toBeUndefined();
        expect(paramsB).toBeUndefined();
    });

    test("params support multiple value types: string, number, boolean", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "test:event", undefined, {
            name: "test",
            count: 5,
            active: true,
        });
        const params = await getSubscriptionParams("session-1", "test:event");
        expect(params).toEqual({ name: "test", count: 5, active: true });
    });
});

// ── Runner-sessions index (offline schedule persistence) ───────────────────

describe("getSessionIdsWithSubscriptionsForRunner", () => {
    beforeEach(resetState);

    test("subscribe adds the session to the runner-sessions index", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "time:cron");
        expect(await getSessionIdsWithSubscriptionsForRunner("runner-A")).toEqual(["session-1"]);
    });

    test("index is per-runner", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "time:cron");
        await subscribeSessionToTrigger("session-2", "runner-B", "time:at");
        expect(await getSessionIdsWithSubscriptionsForRunner("runner-A")).toEqual(["session-1"]);
        expect(await getSessionIdsWithSubscriptionsForRunner("runner-B")).toEqual(["session-2"]);
    });

    test("unsubscribe by trigger type removes the session once no subs remain on that runner", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "time:cron");
        await unsubscribeSessionFromTrigger("session-1", "time:cron");
        expect(await getSessionIdsWithSubscriptionsForRunner("runner-A")).toEqual([]);
    });

    test("unsubscribe keeps the session while another sub on the same runner remains", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "time:cron");
        await subscribeSessionToTrigger("session-1", "runner-A", "time:at");
        await unsubscribeSessionFromTrigger("session-1", "time:cron");
        expect(await getSessionIdsWithSubscriptionsForRunner("runner-A")).toEqual(["session-1"]);
    });

    test("unsubscribeSessionSubscription removes the session only when its last sub goes", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "time:cron");
        await subscribeSessionToTrigger("session-1", "runner-A", "time:at");
        const subs = await listSessionSubscriptions("session-1");

        await unsubscribeSessionSubscription("session-1", subs[0].subscriptionId);
        expect(await getSessionIdsWithSubscriptionsForRunner("runner-A")).toEqual(["session-1"]);

        await unsubscribeSessionSubscription("session-1", subs[1].subscriptionId);
        expect(await getSessionIdsWithSubscriptionsForRunner("runner-A")).toEqual([]);
    });

    test("clearSessionSubscriptions removes the session from every runner index", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "time:cron");
        await subscribeSessionToTrigger("session-1", "runner-B", "svc:event");
        await clearSessionSubscriptions("session-1");
        expect(await getSessionIdsWithSubscriptionsForRunner("runner-A")).toEqual([]);
        expect(await getSessionIdsWithSubscriptionsForRunner("runner-B")).toEqual([]);
    });

    test("returns empty for a runner with no subscribed sessions", async () => {
        expect(await getSessionIdsWithSubscriptionsForRunner("runner-none")).toEqual([]);
    });
});

describe("clearSessionSubscriptions({ preserveDurable })", () => {
    beforeEach(resetState);

    test("keeps schedules and removes everything else", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "time:cron", undefined, { cron: "0 9 * * *" });
        await subscribeSessionToTrigger("session-1", "runner-A", "github:pr_comment");

        await clearSessionSubscriptions("session-1", { preserveDurable: true });

        const subs = await listSessionSubscriptions("session-1");
        expect(subs).toHaveLength(1);
        expect(subs[0].triggerType).toBe("time:cron");
        expect(subs[0].params).toEqual({ cron: "0 9 * * *" });
    });

    test("keeps the runner-sessions index entry so the reconnect snapshot still finds the schedule", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "time:cron");
        await subscribeSessionToTrigger("session-1", "runner-A", "github:pr_comment");

        await clearSessionSubscriptions("session-1", { preserveDurable: true });

        expect(await getSessionIdsWithSubscriptionsForRunner("runner-A")).toEqual(["session-1"]);
        expect(await getSubscribersForTrigger("runner-A", "time:cron")).toContain("session-1");
        expect(await getSubscribersForTrigger("runner-A", "github:pr_comment")).not.toContain("session-1");
    });

    test("drops the session from runners where nothing durable survives", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "time:cron");
        await subscribeSessionToTrigger("session-1", "runner-B", "github:pr_comment");

        await clearSessionSubscriptions("session-1", { preserveDurable: true });

        expect(await getSessionIdsWithSubscriptionsForRunner("runner-A")).toEqual(["session-1"]);
        expect(await getSessionIdsWithSubscriptionsForRunner("runner-B")).toEqual([]);
    });

    test("without the option it still clears everything (default unchanged)", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "time:cron");
        await subscribeSessionToTrigger("session-1", "runner-A", "github:pr_comment");

        await clearSessionSubscriptions("session-1");

        expect(await listSessionSubscriptions("session-1")).toHaveLength(0);
        expect(await getSessionIdsWithSubscriptionsForRunner("runner-A")).toEqual([]);
    });

    test("sessionHasScheduleSubscription reflects surviving schedules", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "time:at", undefined, { at: "14:30UTC" });
        await subscribeSessionToTrigger("session-2", "runner-A", "github:pr_comment");

        expect(await sessionHasScheduleSubscription("session-1")).toBe(true);
        expect(await sessionHasScheduleSubscription("session-2")).toBe(false);

        await clearSessionSubscriptions("session-1", { preserveDurable: true });
        expect(await sessionHasScheduleSubscription("session-1")).toBe(true);
    });

    test("isDurableTriggerType covers the time trigger family only", () => {
        expect(isDurableTriggerType("time:cron")).toBe(true);
        expect(isDurableTriggerType("time:at")).toBe(true);
        expect(isDurableTriggerType("time:timer_fired")).toBe(true);
        expect(isDurableTriggerType("github:pr_comment")).toBe(false);
    });
});

describe("refreshRunnerSubscriptionTtls", () => {
    beforeEach(resetState);

    test("refreshes session hash, runner-sessions index, and reverse-index TTLs", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "time:cron");
        expirations.clear();

        await refreshRunnerSubscriptionTtls("runner-A", ["session-1"], 999);

        expect(expirations.get("pizzapi:trigger-subs:session-1")).toBe(999);
        expect(expirations.get("pizzapi:trigger-subs:runner-sessions:runner-A")).toBe(999);
        expect(expirations.get("pizzapi:trigger-subs:runner:runner-A:time:cron")).toBe(999);
    });

    test("does not refresh reverse indexes belonging to other runners", async () => {
        await subscribeSessionToTrigger("session-1", "runner-A", "time:cron");
        await subscribeSessionToTrigger("session-1", "runner-B", "svc:event");
        expirations.clear();

        await refreshRunnerSubscriptionTtls("runner-A", ["session-1"], 999);

        expect(expirations.get("pizzapi:trigger-subs:runner:runner-A:time:cron")).toBe(999);
        expect(expirations.get("pizzapi:trigger-subs:runner:runner-B:svc:event")).toBeUndefined();
    });
});
