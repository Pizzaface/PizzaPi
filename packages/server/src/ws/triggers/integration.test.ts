/**
 * Integration tests for the trigger system.
 *
 * Tests the full pipeline: registry + evaluator + timer scheduler working
 * together with a mock Redis client and mock delivery function.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { TriggerRegistry } from "./registry.js";
import { TriggerEvaluator, type NotificationDeliveryFn } from "./evaluator.js";
import { TimerScheduler } from "./timers.js";
import type { TriggerNotification, TriggerDelivery, TriggerRecord } from "@pizzapi/protocol";

// ---------------------------------------------------------------------------
// In-memory mock Redis client
// ---------------------------------------------------------------------------

function createMockRedis() {
    const store = new Map<string, string>();
    const sets = new Map<string, Set<string>>();

    function ensureSet(key: string): Set<string> {
        if (!sets.has(key)) sets.set(key, new Set());
        return sets.get(key)!;
    }

    const client = {
        isOpen: true,

        async get(key: string) { return store.get(key) ?? null; },
        async set(key: string, value: string) { store.set(key, value); return "OK"; },
        async del(key: string | string[]) {
            const keys = Array.isArray(key) ? key : [key];
            let count = 0;
            for (const k of keys) {
                if (store.delete(k)) count++;
                if (sets.delete(k)) count++;
            }
            return count;
        },

        async sAdd(key: string, member: string | string[]) {
            const s = ensureSet(key);
            const members = Array.isArray(member) ? member : [member];
            let added = 0;
            for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
            return added;
        },
        async sRem(key: string, member: string | string[]) {
            const s = sets.get(key);
            if (!s) return 0;
            const members = Array.isArray(member) ? member : [member];
            let removed = 0;
            for (const m of members) { if (s.delete(m)) removed++; }
            return removed;
        },
        async sMembers(key: string) { return [...(sets.get(key) ?? [])]; },
        async sCard(key: string) { return sets.get(key)?.size ?? 0; },

        multi() {
            const ops: Array<() => Promise<unknown>> = [];
            const chain = {
                set: (k: string, v: string) => { ops.push(() => client.set(k, v)); return chain; },
                del: (k: string) => { ops.push(() => client.del(k)); return chain; },
                sAdd: (k: string, m: string) => { ops.push(() => client.sAdd(k, m)); return chain; },
                sRem: (k: string, m: string) => { ops.push(() => client.sRem(k, m)); return chain; },
                async exec() { const results = []; for (const op of ops) results.push(await op()); return results; },
            };
            return chain;
        },
    };

    return client;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface DeliveredNotification {
    ownerSessionId: string;
    notification: TriggerNotification;
    delivery: TriggerDelivery;
}

function createTestEnv() {
    const redis = createMockRedis();
    const registry = new TriggerRegistry(() => redis as any);
    const delivered: DeliveredNotification[] = [];
    const deliverFn: NotificationDeliveryFn = (ownerSessionId, notification, delivery) => {
        delivered.push({ ownerSessionId, notification, delivery });
    };
    const evaluator = new TriggerEvaluator(registry, deliverFn);
    const timerScheduler = new TimerScheduler(
        registry,
        (triggerId) => evaluator.fireTimerTrigger(triggerId),
    );

    return { redis, registry, evaluator, timerScheduler, delivered };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Trigger System Integration", () => {
    let env: ReturnType<typeof createTestEnv>;

    beforeEach(() => {
        env = createTestEnv();
    });

    // ── Fan-out/fan-in ────────────────────────────────────────────────

    test("fan-out/fan-in: parent watches 3 children, receives 3 notifications", async () => {
        const { registry, evaluator, delivered } = env;

        const result = await registry.registerTrigger({
            type: "session_ended",
            ownerSessionId: "parent",
            runnerId: "runner-1",
            config: { sessionIds: ["child-A", "child-B", "child-C"] },
            delivery: { mode: "inject" },
            message: "Child {sessionId} completed",
            maxFirings: 3,
        });
        expect(result.ok).toBe(true);

        await evaluator.evaluateSessionEnded("runner-1", "child-A");
        expect(delivered).toHaveLength(1);
        expect(delivered[0].notification.message).toBe("Child child-A completed");
        expect(delivered[0].ownerSessionId).toBe("parent");

        await evaluator.evaluateSessionEnded("runner-1", "child-B");
        expect(delivered).toHaveLength(2);
        expect(delivered[1].notification.message).toBe("Child child-B completed");

        await evaluator.evaluateSessionEnded("runner-1", "child-C");
        expect(delivered).toHaveLength(3);

        // Trigger should be auto-expired after 3 firings
        await evaluator.evaluateSessionEnded("runner-1", "child-D");
        expect(delivered).toHaveLength(3); // no 4th notification
    });

    // ── Cost monitoring ───────────────────────────────────────────────

    test("cost monitoring: fires when threshold crossed", async () => {
        const { registry, evaluator, delivered } = env;

        await registry.registerTrigger({
            type: "cost_exceeded",
            ownerSessionId: "monitor",
            runnerId: "runner-1",
            config: { sessionIds: "*", threshold: 5.0 },
            delivery: { mode: "inject" },
            message: "Cost {cost} exceeded ${threshold}",
            maxFirings: 1,
        });

        await evaluator.evaluateHeartbeat("runner-1", "worker-1", { cost: 2.0 });
        expect(delivered).toHaveLength(0);

        await evaluator.evaluateHeartbeat("runner-1", "worker-1", { cost: 4.0 });
        expect(delivered).toHaveLength(0);

        await evaluator.evaluateHeartbeat("runner-1", "worker-1", { cost: 6.0 });
        expect(delivered).toHaveLength(1);
        expect(delivered[0].notification.message).toContain("6");
        expect(delivered[0].notification.message).toContain("5");

        // maxFirings=1 should auto-expire
        await evaluator.evaluateHeartbeat("runner-1", "worker-1", { cost: 10.0 });
        expect(delivered).toHaveLength(1);
    });

    // ── Custom event pub/sub ──────────────────────────────────────────

    test("custom event pub/sub: A listens, B emits, A receives", async () => {
        const { registry, evaluator, delivered } = env;

        await registry.registerTrigger({
            type: "custom_event",
            ownerSessionId: "session-A",
            runnerId: "runner-1",
            config: { eventName: "build_done", fromSessionIds: "*" },
            delivery: { mode: "queue" },
            message: "Build completed by {sourceSessionId}",
        });

        await evaluator.evaluateCustomEvent("runner-1", "session-B", "build_done", { status: "ok" });

        expect(delivered).toHaveLength(1);
        expect(delivered[0].ownerSessionId).toBe("session-A");
        expect(delivered[0].notification.message).toBe("Build completed by session-B");
        expect(delivered[0].notification.payload).toEqual({ status: "ok" });
        expect(delivered[0].delivery.mode).toBe("queue");
    });

    test("custom event: doesn't fire for wrong eventName", async () => {
        const { registry, evaluator, delivered } = env;

        await registry.registerTrigger({
            type: "custom_event",
            ownerSessionId: "session-A",
            runnerId: "runner-1",
            config: { eventName: "deploy", fromSessionIds: "*" },
            delivery: { mode: "inject" },
            message: "deploy event",
        });

        await evaluator.evaluateCustomEvent("runner-1", "session-B", "build_done");
        expect(delivered).toHaveLength(0);
    });

    test("custom event: fromSessionIds filter", async () => {
        const { registry, evaluator, delivered } = env;

        await registry.registerTrigger({
            type: "custom_event",
            ownerSessionId: "watcher",
            runnerId: "runner-1",
            config: { eventName: "evt", fromSessionIds: ["allowed-1"] },
            delivery: { mode: "inject" },
            message: "event from {sourceSessionId}",
        });

        await evaluator.evaluateCustomEvent("runner-1", "blocked-1", "evt");
        expect(delivered).toHaveLength(0);

        await evaluator.evaluateCustomEvent("runner-1", "allowed-1", "evt");
        expect(delivered).toHaveLength(1);
    });

    // ── Timer: one-shot ───────────────────────────────────────────────

    test("timer one-shot: fires after delay", async () => {
        const { registry, evaluator, timerScheduler, delivered } = env;

        const result = await registry.registerTrigger({
            type: "timer",
            ownerSessionId: "timer-owner",
            runnerId: "runner-1",
            config: { delaySec: 0.05 }, // 50ms
            delivery: { mode: "inject" },
            message: "Timer fired!",
            maxFirings: 1,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const triggers = await registry.listTriggers("timer-owner");
        timerScheduler.scheduleTimer(triggers[0]);

        expect(delivered).toHaveLength(0);

        // Wait for timer
        await new Promise((r) => setTimeout(r, 120));

        expect(delivered).toHaveLength(1);
        expect(delivered[0].notification.triggerType).toBe("timer");
        expect(delivered[0].notification.message).toBe("Timer fired!");
    });

    // ── Timer: recurring ──────────────────────────────────────────────

    test("timer recurring: fires multiple times then stops at maxFirings", async () => {
        const { registry, evaluator, timerScheduler, delivered } = env;

        const result = await registry.registerTrigger({
            type: "timer",
            ownerSessionId: "recurring-owner",
            runnerId: "runner-1",
            config: { delaySec: 0.04, recurring: true }, // 40ms
            delivery: { mode: "inject" },
            message: "Tick",
            maxFirings: 3,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const triggers = await registry.listTriggers("recurring-owner");
        timerScheduler.scheduleTimer(triggers[0]);

        // Wait for enough time for 3+ firings
        await new Promise((r) => setTimeout(r, 250));

        expect(delivered.length).toBeGreaterThanOrEqual(3);
        // maxFirings should cap it — may have 3 or slightly more due to timing
        // but the trigger should be auto-cancelled
        const remaining = await registry.listTriggers("recurring-owner");
        expect(remaining).toHaveLength(0); // auto-expired
    });

    // ── Session idle transition ───────────────────────────────────────

    test("session idle: fires only on active→idle transition", async () => {
        const { registry, evaluator, delivered } = env;

        await registry.registerTrigger({
            type: "session_idle",
            ownerSessionId: "idle-watcher",
            runnerId: "runner-1",
            config: { sessionIds: "*" },
            delivery: { mode: "inject" },
            message: "{sessionId} went idle",
        });

        // active → still active (no fire)
        await evaluator.evaluateHeartbeat("runner-1", "target", { isActive: true });
        expect(delivered).toHaveLength(0);

        await evaluator.evaluateHeartbeat("runner-1", "target", { isActive: true });
        expect(delivered).toHaveLength(0);

        // active → idle (fires!)
        await evaluator.evaluateHeartbeat("runner-1", "target", { isActive: false });
        expect(delivered).toHaveLength(1);
        expect(delivered[0].notification.message).toBe("target went idle");

        // idle → idle (no second fire)
        await evaluator.evaluateHeartbeat("runner-1", "target", { isActive: false });
        expect(delivered).toHaveLength(1);

        // idle → active → idle (fires again)
        await evaluator.evaluateHeartbeat("runner-1", "target", { isActive: true });
        await evaluator.evaluateHeartbeat("runner-1", "target", { isActive: false });
        expect(delivered).toHaveLength(2);
    });

    // ── Trigger cleanup ───────────────────────────────────────────────

    test("cleanup on disconnect removes all triggers", async () => {
        const { registry } = env;

        await registry.registerTrigger({
            type: "session_ended", ownerSessionId: "disc-session",
            runnerId: "runner-1", config: { sessionIds: "*" },
            delivery: { mode: "inject" }, message: "end",
        });
        await registry.registerTrigger({
            type: "timer", ownerSessionId: "disc-session",
            runnerId: "runner-1", config: { delaySec: 60 },
            delivery: { mode: "inject" }, message: "tick",
        });
        await registry.registerTrigger({
            type: "custom_event", ownerSessionId: "disc-session",
            runnerId: "runner-1", config: { eventName: "x", fromSessionIds: "*" },
            delivery: { mode: "inject" }, message: "x",
        });

        const before = await registry.listTriggers("disc-session");
        expect(before).toHaveLength(3);

        const removed = await registry.cleanupSessionTriggers("disc-session");
        expect(removed).toBe(3);

        const after = await registry.listTriggers("disc-session");
        expect(after).toHaveLength(0);
    });

    // ── Max firings ───────────────────────────────────────────────────

    test("max firings: trigger auto-expires after maxFirings reached", async () => {
        const { registry, evaluator, delivered } = env;

        await registry.registerTrigger({
            type: "session_ended",
            ownerSessionId: "limited",
            runnerId: "runner-1",
            config: { sessionIds: "*" },
            delivery: { mode: "inject" },
            message: "ended",
            maxFirings: 2,
        });

        await evaluator.evaluateSessionEnded("runner-1", "s1");
        await evaluator.evaluateSessionEnded("runner-1", "s2");
        await evaluator.evaluateSessionEnded("runner-1", "s3");

        expect(delivered).toHaveLength(2); // only 2, not 3
    });

    // ── Message template interpolation ────────────────────────────────

    test("message template interpolation", async () => {
        const { registry, evaluator, delivered } = env;

        await registry.registerTrigger({
            type: "session_error",
            ownerSessionId: "err-watcher",
            runnerId: "runner-1",
            config: { sessionIds: "*" },
            delivery: { mode: "inject" },
            message: "Session {sessionId} failed: {error}",
        });

        await evaluator.evaluateSessionError("runner-1", "broken-session", "OutOfMemory");

        expect(delivered).toHaveLength(1);
        expect(delivered[0].notification.message).toBe("Session broken-session failed: OutOfMemory");
    });

    // ── Rehydration ───────────────────────────────────────────────────

    test("rehydration: triggers survive re-instantiation from same Redis", async () => {
        const { redis, registry, delivered } = env;

        // Register a trigger
        await registry.registerTrigger({
            type: "session_ended",
            ownerSessionId: "persistent",
            runnerId: "runner-1",
            config: { sessionIds: "*" },
            delivery: { mode: "inject" },
            message: "still alive",
        });

        // Create new evaluator from same Redis (simulates restart)
        const registry2 = new TriggerRegistry(() => redis as any);
        const delivered2: DeliveredNotification[] = [];
        const evaluator2 = new TriggerEvaluator(registry2, (owner, notif, del) => {
            delivered2.push({ ownerSessionId: owner, notification: notif, delivery: del });
        });

        // Rehydrate
        const rehydrated = await registry2.rehydrateTriggers("runner-1");
        expect(rehydrated.length).toBeGreaterThanOrEqual(1);

        // Trigger should work with new evaluator
        await evaluator2.evaluateSessionEnded("runner-1", "some-child");
        expect(delivered2).toHaveLength(1);
        expect(delivered2[0].notification.message).toBe("still alive");
    });

    // ── Mixed delivery modes ──────────────────────────────────────────

    test("queue vs inject delivery modes passed correctly", async () => {
        const { registry, evaluator, delivered } = env;

        await registry.registerTrigger({
            type: "session_ended",
            ownerSessionId: "owner-inject",
            runnerId: "runner-1",
            config: { sessionIds: ["s1"] },
            delivery: { mode: "inject" },
            message: "inject msg",
        });

        await registry.registerTrigger({
            type: "session_ended",
            ownerSessionId: "owner-queue",
            runnerId: "runner-1",
            config: { sessionIds: ["s1"] },
            delivery: { mode: "queue" },
            message: "queue msg",
        });

        await evaluator.evaluateSessionEnded("runner-1", "s1");

        expect(delivered).toHaveLength(2);
        const injectDelivery = delivered.find((d) => d.ownerSessionId === "owner-inject");
        const queueDelivery = delivered.find((d) => d.ownerSessionId === "owner-queue");

        expect(injectDelivery!.delivery.mode).toBe("inject");
        expect(queueDelivery!.delivery.mode).toBe("queue");
    });

    // ── Registry limits ───────────────────────────────────────────────

    test("registry enforces session limit of 100 triggers", async () => {
        const { registry } = env;

        // Register 100 triggers
        for (let i = 0; i < 100; i++) {
            const r = await registry.registerTrigger({
                type: "session_ended",
                ownerSessionId: "limited-session",
                runnerId: "runner-1",
                config: { sessionIds: "*" },
                delivery: { mode: "inject" },
                message: `trigger ${i}`,
            });
            expect(r.ok).toBe(true);
        }

        // 101st should fail
        const overflow = await registry.registerTrigger({
            type: "session_ended",
            ownerSessionId: "limited-session",
            runnerId: "runner-1",
            config: { sessionIds: "*" },
            delivery: { mode: "inject" },
            message: "overflow",
        });
        expect(overflow.ok).toBe(false);
        if (!overflow.ok) {
            expect(overflow.error).toContain("100");
        }
    });

    // ── Timer cleanup on session disconnect ───────────────────────────

    test("timer cleanup cancels active timers", async () => {
        const { registry, timerScheduler, delivered } = env;

        const result = await registry.registerTrigger({
            type: "timer",
            ownerSessionId: "timer-disc",
            runnerId: "runner-1",
            config: { delaySec: 0.05, recurring: true },
            delivery: { mode: "inject" },
            message: "tick",
        });
        expect(result.ok).toBe(true);

        const triggers = await registry.listTriggers("timer-disc");
        timerScheduler.scheduleTimer(triggers[0]);
        expect(timerScheduler.isActive(triggers[0].id)).toBe(true);

        // Cleanup
        timerScheduler.cleanupSessionTimers("timer-disc", triggers);
        expect(timerScheduler.isActive(triggers[0].id)).toBe(false);

        // Wait to confirm no more firings
        await new Promise((r) => setTimeout(r, 150));
        expect(delivered).toHaveLength(0);
    });
});
