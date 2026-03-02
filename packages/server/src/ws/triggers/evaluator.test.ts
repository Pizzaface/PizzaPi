import { describe, expect, test, beforeEach, mock } from "bun:test";
import { TriggerEvaluator, interpolateMessage, type NotificationDeliveryFn } from "./evaluator.js";
import type { TriggerRecord, TriggerNotification, TriggerDelivery } from "@pizzapi/protocol";

// ---------------------------------------------------------------------------
// Mock registry
// ---------------------------------------------------------------------------

function makeMockRegistry() {
    const triggers = new Map<string, TriggerRecord>();

    return {
        triggers,
        addTrigger(t: TriggerRecord) {
            triggers.set(t.id, t);
        },
        async getTriggersByType(_runnerId: string, type: string): Promise<TriggerRecord[]> {
            return [...triggers.values()].filter((t) => t.type === type);
        },
        async fireTrigger(triggerId: string): Promise<TriggerRecord | null> {
            const t = triggers.get(triggerId);
            if (!t) return null;
            t.firingCount++;
            t.lastFiredAt = new Date().toISOString();
            if (t.maxFirings !== undefined && t.firingCount >= t.maxFirings) {
                triggers.delete(triggerId);
            }
            return { ...t };
        },
        // stubs for unused methods
        async registerTrigger() { return { ok: true as const, triggerId: "" }; },
        async cancelTrigger() { return { ok: true as const }; },
        async listTriggers() { return []; },
        async cleanupSessionTriggers() { return 0; },
        async rehydrateTriggers() { return []; },
    };
}

function makeTrigger(overrides: Partial<TriggerRecord> & { id: string; type: TriggerRecord["type"] }): TriggerRecord {
    return {
        ownerSessionId: "owner-1",
        runnerId: "runner-1",
        config: { sessionIds: "*" },
        delivery: { mode: "inject" },
        message: "Trigger fired",
        firingCount: 0,
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// interpolateMessage
// ---------------------------------------------------------------------------

describe("interpolateMessage", () => {
    test("replaces known placeholders", () => {
        const result = interpolateMessage("Session {sessionId} ended with cost {cost}", {
            sessionId: "abc-123",
            cost: 1.5,
        });
        expect(result).toBe("Session abc-123 ended with cost 1.5");
    });

    test("leaves unknown placeholders unchanged", () => {
        expect(interpolateMessage("Hello {unknown}", {})).toBe("Hello {unknown}");
    });

    test("handles null/undefined values", () => {
        expect(interpolateMessage("{a} {b}", { a: null, b: undefined })).toBe("{a} {b}");
    });

    test("serializes object values as JSON", () => {
        const result = interpolateMessage("Payload: {payload}", { payload: { x: 1 } });
        expect(result).toBe('Payload: {"x":1}');
    });

    test("handles template with no placeholders", () => {
        expect(interpolateMessage("No placeholders here", { foo: "bar" })).toBe("No placeholders here");
    });

    test("replaces multiple occurrences", () => {
        expect(interpolateMessage("{x} and {x}", { x: "hi" })).toBe("hi and hi");
    });
});

// ---------------------------------------------------------------------------
// TriggerEvaluator
// ---------------------------------------------------------------------------

describe("TriggerEvaluator", () => {
    let registry: ReturnType<typeof makeMockRegistry>;
    let delivered: Array<{ ownerSessionId: string; notification: TriggerNotification; delivery: TriggerDelivery }>;
    let deliverFn: NotificationDeliveryFn;
    let evaluator: TriggerEvaluator;

    beforeEach(() => {
        registry = makeMockRegistry();
        delivered = [];
        deliverFn = (ownerSessionId, notification, delivery) => {
            delivered.push({ ownerSessionId, notification, delivery });
        };
        evaluator = new TriggerEvaluator(registry as any, deliverFn);
    });

    // ── session_ended ─────────────────────────────────────────────────

    describe("evaluateSessionEnded", () => {
        test("fires trigger when sessionId matches wildcard", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "session_ended",
                config: { sessionIds: "*" },
                message: "Session {sessionId} ended",
            }));

            await evaluator.evaluateSessionEnded("runner-1", "child-1");

            expect(delivered).toHaveLength(1);
            expect(delivered[0].ownerSessionId).toBe("owner-1");
            expect(delivered[0].notification.triggerType).toBe("session_ended");
            expect(delivered[0].notification.message).toBe("Session child-1 ended");
        });

        test("fires trigger when sessionId is in the list", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "session_ended",
                config: { sessionIds: ["child-A", "child-B"] },
                message: "Done: {sessionId}",
            }));

            await evaluator.evaluateSessionEnded("runner-1", "child-A");
            expect(delivered).toHaveLength(1);
        });

        test("does not fire when sessionId is not in list", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "session_ended",
                config: { sessionIds: ["child-A"] },
            }));

            await evaluator.evaluateSessionEnded("runner-1", "child-X");
            expect(delivered).toHaveLength(0);
        });

        test("fires multiple matching triggers", async () => {
            registry.addTrigger(makeTrigger({ id: "t1", type: "session_ended", config: { sessionIds: "*" } }));
            registry.addTrigger(makeTrigger({ id: "t2", type: "session_ended", config: { sessionIds: ["s1"] } }));

            await evaluator.evaluateSessionEnded("runner-1", "s1");
            expect(delivered).toHaveLength(2);
        });
    });

    // ── session_error ─────────────────────────────────────────────────

    describe("evaluateSessionError", () => {
        test("fires trigger with error in message", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "session_error",
                config: { sessionIds: "*" },
                message: "Error in {sessionId}: {error}",
            }));

            await evaluator.evaluateSessionError("runner-1", "sess-1", "OOM");

            expect(delivered).toHaveLength(1);
            expect(delivered[0].notification.message).toBe("Error in sess-1: OOM");
        });

        test("does not fire when sessionId doesn't match", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "session_error",
                config: { sessionIds: ["only-this"] },
            }));

            await evaluator.evaluateSessionError("runner-1", "other", "err");
            expect(delivered).toHaveLength(0);
        });
    });

    // ── heartbeat: cost_exceeded ──────────────────────────────────────

    describe("evaluateHeartbeat — cost_exceeded", () => {
        test("fires when cost exceeds threshold", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "cost_exceeded",
                config: { sessionIds: "*", threshold: 5.0 },
                message: "Cost {cost} exceeded threshold {threshold}",
            }));

            await evaluator.evaluateHeartbeat("runner-1", "sess-1", { cost: 7.5 });

            expect(delivered).toHaveLength(1);
            expect(delivered[0].notification.message).toBe("Cost 7.5 exceeded threshold 5");
        });

        test("does not fire when cost is below threshold", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "cost_exceeded",
                config: { sessionIds: "*", threshold: 10.0 },
            }));

            await evaluator.evaluateHeartbeat("runner-1", "sess-1", { cost: 3.0 });
            expect(delivered).toHaveLength(0);
        });

        test("does not fire when sessionId doesn't match", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "cost_exceeded",
                config: { sessionIds: ["other"], threshold: 1.0 },
            }));

            await evaluator.evaluateHeartbeat("runner-1", "sess-1", { cost: 50.0 });
            expect(delivered).toHaveLength(0);
        });

        test("fires at exact threshold", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "cost_exceeded",
                config: { sessionIds: "*", threshold: 5.0 },
            }));

            await evaluator.evaluateHeartbeat("runner-1", "sess-1", { cost: 5.0 });
            expect(delivered).toHaveLength(1);
        });
    });

    // ── heartbeat: session_idle ───────────────────────────────────────

    describe("evaluateHeartbeat — session_idle", () => {
        test("fires on active → idle transition", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "session_idle",
                config: { sessionIds: "*" },
                message: "{sessionId} went idle",
            }));

            // First heartbeat: active
            await evaluator.evaluateHeartbeat("runner-1", "sess-1", { isActive: true });
            expect(delivered).toHaveLength(0);

            // Second heartbeat: idle — transition fires
            await evaluator.evaluateHeartbeat("runner-1", "sess-1", { isActive: false });
            expect(delivered).toHaveLength(1);
            expect(delivered[0].notification.message).toBe("sess-1 went idle");
        });

        test("does not fire on idle → idle (no transition)", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "session_idle",
                config: { sessionIds: "*" },
            }));

            evaluator.setSessionActive("sess-1", false);
            await evaluator.evaluateHeartbeat("runner-1", "sess-1", { isActive: false });
            expect(delivered).toHaveLength(0);
        });

        test("does not fire on first heartbeat being idle (no prior state)", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "session_idle",
                config: { sessionIds: "*" },
            }));

            await evaluator.evaluateHeartbeat("runner-1", "sess-1", { isActive: false });
            expect(delivered).toHaveLength(0);
        });

        test("fires again after active → idle → active → idle", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "session_idle",
                config: { sessionIds: "*" },
            }));

            await evaluator.evaluateHeartbeat("runner-1", "sess-1", { isActive: true });
            await evaluator.evaluateHeartbeat("runner-1", "sess-1", { isActive: false }); // fires
            await evaluator.evaluateHeartbeat("runner-1", "sess-1", { isActive: true });
            await evaluator.evaluateHeartbeat("runner-1", "sess-1", { isActive: false }); // fires again

            expect(delivered).toHaveLength(2);
        });
    });

    // ── custom_event ──────────────────────────────────────────────────

    describe("evaluateCustomEvent", () => {
        test("fires when eventName and fromSessionIds match", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "custom_event",
                config: { eventName: "build_done", fromSessionIds: "*" },
                message: "Build done from {sourceSessionId}: {payload}",
            }));

            await evaluator.evaluateCustomEvent("runner-1", "builder-1", "build_done", { ok: true });

            expect(delivered).toHaveLength(1);
            expect(delivered[0].notification.message).toContain("builder-1");
            expect(delivered[0].notification.payload).toEqual({ ok: true });
        });

        test("does not fire when eventName doesn't match", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "custom_event",
                config: { eventName: "deploy", fromSessionIds: "*" },
            }));

            await evaluator.evaluateCustomEvent("runner-1", "s1", "build_done");
            expect(delivered).toHaveLength(0);
        });

        test("does not fire when sourceSessionId not in fromSessionIds", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "custom_event",
                config: { eventName: "evt", fromSessionIds: ["allowed-1"] },
            }));

            await evaluator.evaluateCustomEvent("runner-1", "not-allowed", "evt");
            expect(delivered).toHaveLength(0);
        });

        test("fires when sourceSessionId is in fromSessionIds list", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "custom_event",
                config: { eventName: "evt", fromSessionIds: ["a", "b"] },
            }));

            await evaluator.evaluateCustomEvent("runner-1", "b", "evt");
            expect(delivered).toHaveLength(1);
        });

        test("ignores malformed fromSessionIds config", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "custom_event",
                config: { eventName: "evt" } as any,
            }));

            await evaluator.evaluateCustomEvent("runner-1", "b", "evt");
            expect(delivered).toHaveLength(0);
        });
    });

    // ── fireTimerTrigger ──────────────────────────────────────────────

    describe("fireTimerTrigger", () => {
        test("fires and delivers timer trigger", async () => {
            registry.addTrigger(makeTrigger({
                id: "timer-1",
                type: "timer",
                config: { delaySec: 60 },
                message: "Timer fired after {delaySec}s",
            }));

            await evaluator.fireTimerTrigger("timer-1");

            expect(delivered).toHaveLength(1);
            expect(delivered[0].notification.triggerType).toBe("timer");
            expect(delivered[0].notification.message).toBe("Timer fired after 60s");
        });

        test("does nothing for unknown trigger", async () => {
            await evaluator.fireTimerTrigger("nonexistent");
            expect(delivered).toHaveLength(0);
        });
    });

    // ── maxFirings ────────────────────────────────────────────────────

    describe("maxFirings auto-expiry", () => {
        test("trigger stops firing after maxFirings reached", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "session_ended",
                config: { sessionIds: "*" },
                maxFirings: 2,
            }));

            await evaluator.evaluateSessionEnded("runner-1", "s1"); // fire 1
            await evaluator.evaluateSessionEnded("runner-1", "s2"); // fire 2 (auto-cancel)
            await evaluator.evaluateSessionEnded("runner-1", "s3"); // should not fire

            expect(delivered).toHaveLength(2);
        });
    });

    // ── delivery modes ────────────────────────────────────────────────

    describe("delivery modes", () => {
        test("passes inject delivery to deliver fn", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "session_ended",
                config: { sessionIds: "*" },
                delivery: { mode: "inject" },
            }));

            await evaluator.evaluateSessionEnded("runner-1", "s1");
            expect(delivered[0].delivery.mode).toBe("inject");
        });

        test("passes queue delivery to deliver fn", async () => {
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "session_ended",
                config: { sessionIds: "*" },
                delivery: { mode: "queue" },
            }));

            await evaluator.evaluateSessionEnded("runner-1", "s1");
            expect(delivered[0].delivery.mode).toBe("queue");
        });
    });

    // ── state management ──────────────────────────────────────────────

    describe("state management", () => {
        test("evaluateSessionEnded cleans up idle tracking", async () => {
            evaluator.setSessionActive("sess-1", true);
            await evaluator.evaluateSessionEnded("runner-1", "sess-1");

            // Now if we try idle transition, it shouldn't fire because state was cleared
            registry.addTrigger(makeTrigger({
                id: "t1",
                type: "session_idle",
                config: { sessionIds: "*" },
            }));

            await evaluator.evaluateHeartbeat("runner-1", "sess-1", { isActive: false });
            expect(delivered).toHaveLength(0); // no prior active state
        });

        test("removeSessionState clears tracking", () => {
            evaluator.setSessionActive("sess-1", true);
            evaluator.removeSessionState("sess-1");
            // No way to inspect directly, but this shouldn't throw
        });
    });
});
