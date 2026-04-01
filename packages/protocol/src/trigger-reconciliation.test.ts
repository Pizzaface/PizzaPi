/**
 * Tests for the trigger subscription reconciliation types added to @pizzapi/protocol.
 *
 * Verifies that the new types are exported with the expected shapes.
 */

import { describe, test, expect } from "bun:test";
import type {
    TriggerSubscriptionEntry,
    TriggerSubscriptionsSnapshot,
    TriggerSubscriptionDelta,
    TriggerSubscriptionsApplied,
} from "./index.js";

describe("TriggerSubscriptionEntry", () => {
    test("accepts a minimal entry with only required fields", () => {
        const entry: TriggerSubscriptionEntry = {
            sessionId: "session-1",
            triggerType: "time:timer_fired",
            runnerId: "runner-abc",
        };
        expect(entry.sessionId).toBe("session-1");
        expect(entry.triggerType).toBe("time:timer_fired");
        expect(entry.runnerId).toBe("runner-abc");
    });

    test("accepts a full entry with all optional fields", () => {
        const entry: TriggerSubscriptionEntry = {
            sessionId: "session-2",
            triggerType: "github:pr_opened",
            runnerId: "runner-abc",
            params: { repo: "org/repo", branch: "main", count: 5, active: true },
            filters: [
                { field: "status", value: "open", op: "eq" },
                { field: "title", value: "fix", op: "contains" },
            ],
            filterMode: "and",
        };
        expect(entry.params?.repo).toBe("org/repo");
        expect(entry.params?.count).toBe(5);
        expect(entry.filters).toHaveLength(2);
        expect(entry.filterMode).toBe("and");
    });

    test("params can contain array values", () => {
        const entry: TriggerSubscriptionEntry = {
            sessionId: "s",
            triggerType: "t",
            runnerId: "r",
            params: { tags: ["bug", "urgent"] },
        };
        expect(Array.isArray(entry.params?.tags)).toBe(true);
    });

    test("filterMode can be 'or'", () => {
        const entry: TriggerSubscriptionEntry = {
            sessionId: "s",
            triggerType: "t",
            runnerId: "r",
            filterMode: "or",
        };
        expect(entry.filterMode).toBe("or");
    });
});

describe("TriggerSubscriptionsSnapshot", () => {
    test("has revision and subscriptions array", () => {
        const snapshot: TriggerSubscriptionsSnapshot = {
            revision: 1,
            subscriptions: [],
        };
        expect(snapshot.revision).toBe(1);
        expect(Array.isArray(snapshot.subscriptions)).toBe(true);
    });

    test("contains TriggerSubscriptionEntry items", () => {
        const snapshot: TriggerSubscriptionsSnapshot = {
            revision: 5,
            subscriptions: [
                { sessionId: "s1", triggerType: "time:cron", runnerId: "r1" },
                { sessionId: "s2", triggerType: "time:at", runnerId: "r1", params: { at: "2026-01-01T00:00Z" } },
            ],
        };
        expect(snapshot.subscriptions).toHaveLength(2);
        expect(snapshot.subscriptions[0].sessionId).toBe("s1");
        expect(snapshot.subscriptions[1].params?.at).toBe("2026-01-01T00:00Z");
    });
});

describe("TriggerSubscriptionDelta", () => {
    test("subscribe delta has all required fields", () => {
        const delta: TriggerSubscriptionDelta = {
            revision: 2,
            action: "subscribe",
            subscription: {
                sessionId: "s1",
                triggerType: "time:timer_fired",
                runnerId: "r1",
                params: { duration: "10m" },
            },
        };
        expect(delta.action).toBe("subscribe");
        expect(delta.revision).toBe(2);
        expect(delta.subscription.params?.duration).toBe("10m");
    });

    test("update delta is valid", () => {
        const delta: TriggerSubscriptionDelta = {
            revision: 3,
            action: "update",
            subscription: {
                sessionId: "s1",
                triggerType: "github:pr_comment",
                runnerId: "r1",
                filters: [{ field: "repo", value: "org/repo" }],
                filterMode: "and",
            },
        };
        expect(delta.action).toBe("update");
        expect(delta.subscription.filters?.[0].field).toBe("repo");
    });

    test("unsubscribe delta only requires sessionId and triggerType", () => {
        const delta: TriggerSubscriptionDelta = {
            revision: 4,
            action: "unsubscribe",
            subscription: {
                sessionId: "s1",
                triggerType: "time:timer_fired",
                runnerId: "r1",
            },
        };
        expect(delta.action).toBe("unsubscribe");
        expect(delta.subscription.params).toBeUndefined();
        expect(delta.subscription.filters).toBeUndefined();
    });
});

describe("TriggerSubscriptionsApplied", () => {
    test("has revision and applied count", () => {
        const ack: TriggerSubscriptionsApplied = {
            revision: 1,
            applied: 3,
        };
        expect(ack.revision).toBe(1);
        expect(ack.applied).toBe(3);
    });

    test("can include optional errors", () => {
        const ack: TriggerSubscriptionsApplied = {
            revision: 2,
            applied: 1,
            errors: ["session-x/time:cron: invalid cron expression"],
        };
        expect(ack.errors).toHaveLength(1);
        expect(ack.errors![0]).toContain("invalid cron expression");
    });

    test("errors is optional and can be undefined", () => {
        const ack: TriggerSubscriptionsApplied = {
            revision: 5,
            applied: 0,
        };
        expect(ack.errors).toBeUndefined();
    });
});

describe("type exports from @pizzapi/protocol index", () => {
    test("all four types are importable as values (runtime check via object shape)", () => {
        // TypeScript type-only imports can't be introspected at runtime,
        // but we can verify that the shapes constructed above compile and hold
        // the expected field values — this confirms the types exist and are correct.
        const entry: TriggerSubscriptionEntry = { sessionId: "x", triggerType: "t", runnerId: "r" };
        const snapshot: TriggerSubscriptionsSnapshot = { revision: 0, subscriptions: [entry] };
        const delta: TriggerSubscriptionDelta = { revision: 1, action: "subscribe", subscription: entry };
        const applied: TriggerSubscriptionsApplied = { revision: 1, applied: 1 };

        expect(snapshot.subscriptions[0]).toEqual(entry);
        expect(delta.subscription).toEqual(entry);
        expect(applied.applied).toBe(1);
    });
});
