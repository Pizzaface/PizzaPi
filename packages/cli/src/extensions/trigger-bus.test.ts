import { describe, expect, test, beforeEach } from "bun:test";
import { triggerBus, type RegisterTriggerParams } from "./trigger-bus.js";

// Reset the bus state between tests by clearing all callbacks and pending entries.
// Since triggerBus is a singleton we manipulate it directly.
const resetBus = () => {
    triggerBus.setRegisterFn(null);
    triggerBus.setCancelFn(null);
    triggerBus.setListFn(null);
    triggerBus.setEmitFn(null);
    // Drain any leftover pending entries from previous tests by resolving stale
    // promises (they'll be GC'd). Use onRegistered/onCancelled/onList with dummy
    // data — the resolved values are not consumed anywhere.
    for (let i = 0; i < 20; i++) {
        triggerBus.onRegistered({ triggerId: "__drain__", type: "timer", requestId: `__drain_${i}__` });
        triggerBus.onCancelled({ triggerId: "__drain__" });
        triggerBus.onList({ triggers: [] });
    }
};

describe("TriggerBus", () => {
    beforeEach(() => {
        resetBus();
    });

    // ── emit (fire-and-forget) ────────────────────────────────────────────

    describe("emit", () => {
        test("returns false when emitFn is not set", () => {
            expect(triggerBus.emit("my-event")).toBe(false);
        });

        test("returns true when emitFn is set and succeeds", () => {
            triggerBus.setEmitFn(() => true);
            expect(triggerBus.emit("my-event", { foo: "bar" })).toBe(true);
        });

        test("returns false when emitFn returns false", () => {
            triggerBus.setEmitFn(() => false);
            expect(triggerBus.emit("my-event")).toBe(false);
        });

        test("passes eventName and payload to emitFn", () => {
            const captured: { eventName?: string; payload?: unknown } = {};
            triggerBus.setEmitFn((eventName, payload) => {
                captured.eventName = eventName;
                captured.payload = payload;
                return true;
            });
            triggerBus.emit("test-event", { x: 1 });
            expect(captured.eventName).toBe("test-event");
            expect(captured.payload).toEqual({ x: 1 });
        });
    });

    // ── register ──────────────────────────────────────────────────────────

    describe("register", () => {
        test("rejects immediately when registerFn is not set", async () => {
            const params: RegisterTriggerParams = {
                type: "session_ended",
                config: { sessionIds: "*" },
            };
            await expect(triggerBus.register(params)).rejects.toThrow("Not connected to relay");
        });

        test("rejects when registerFn returns false", async () => {
            triggerBus.setRegisterFn(() => false);
            const params: RegisterTriggerParams = {
                type: "timer",
                config: { delaySec: 60 },
            };
            await expect(triggerBus.register(params)).rejects.toThrow("Failed to send register_trigger");
        });

        test("resolves when onRegistered is called with matching requestId", async () => {
            let capturedRequestId: string | undefined;
            triggerBus.setRegisterFn((p) => { capturedRequestId = p.requestId; return true; });
            const params: RegisterTriggerParams = {
                type: "session_ended",
                config: { sessionIds: ["sess-1"] },
            };

            const promise = triggerBus.register(params);

            // Simulate server ack with the requestId that was sent
            triggerBus.onRegistered({ triggerId: "trg-abc", type: "session_ended", requestId: capturedRequestId });

            const result = await promise;
            expect(result.triggerId).toBe("trg-abc");
            expect(result.type).toBe("session_ended");
        });

        test("generates a requestId and passes it to registerFn", async () => {
            const calls: RegisterTriggerParams[] = [];
            triggerBus.setRegisterFn((p) => { calls.push(p); return true; });

            const params: RegisterTriggerParams = {
                type: "cost_exceeded",
                config: { sessionIds: "*", threshold: 5 },
                delivery: { mode: "queue" },
                message: "Cost too high",
                maxFirings: 3,
                expiresAt: "2027-01-01T00:00:00Z",
            };

            const promise = triggerBus.register(params);
            const sentRequestId = calls[0]?.requestId;
            expect(sentRequestId).toBeString();
            expect(sentRequestId!.length).toBeGreaterThan(0);

            triggerBus.onRegistered({ triggerId: "trg-xyz", type: "cost_exceeded", requestId: sentRequestId });
            await promise;

            expect(calls).toHaveLength(1);
        });

        test("concurrent registrations resolve to the correct ack via requestId", async () => {
            const sentParams: RegisterTriggerParams[] = [];
            triggerBus.setRegisterFn((p) => { sentParams.push({ ...p }); return true; });

            const p1 = triggerBus.register({ type: "session_ended", config: { sessionIds: "*" } });
            const p2 = triggerBus.register({ type: "timer", config: { delaySec: 60 } });
            const p3 = triggerBus.register({ type: "cost_exceeded", config: { sessionIds: "*", threshold: 10 } });

            expect(sentParams).toHaveLength(3);
            const reqId1 = sentParams[0].requestId!;
            const reqId2 = sentParams[1].requestId!;
            const reqId3 = sentParams[2].requestId!;

            // Respond out of order: p3, p1, p2
            triggerBus.onRegistered({ triggerId: "trg-3", type: "cost_exceeded", requestId: reqId3 });
            triggerBus.onRegistered({ triggerId: "trg-1", type: "session_ended", requestId: reqId1 });
            triggerBus.onRegistered({ triggerId: "trg-2", type: "timer", requestId: reqId2 });

            const r1 = await p1;
            const r2 = await p2;
            const r3 = await p3;

            expect(r1.triggerId).toBe("trg-1");
            expect(r1.type).toBe("session_ended");
            expect(r2.triggerId).toBe("trg-2");
            expect(r2.type).toBe("timer");
            expect(r3.triggerId).toBe("trg-3");
            expect(r3.type).toBe("cost_exceeded");
        });

        test("falls back to FIFO when onRegistered has no requestId (compat)", async () => {
            triggerBus.setRegisterFn(() => true);
            const promise = triggerBus.register({ type: "session_ended", config: { sessionIds: "*" } });

            // Server response without requestId (old server)
            triggerBus.onRegistered({ triggerId: "trg-old", type: "session_ended" });

            const result = await promise;
            expect(result.triggerId).toBe("trg-old");
        });
    });

    // ── cancel ────────────────────────────────────────────────────────────

    describe("cancel", () => {
        test("rejects immediately when cancelFn is not set", async () => {
            await expect(triggerBus.cancel("trg-123")).rejects.toThrow("Not connected to relay");
        });

        test("rejects when cancelFn returns false", async () => {
            triggerBus.setCancelFn(() => false);
            await expect(triggerBus.cancel("trg-123")).rejects.toThrow("Failed to send cancel_trigger");
        });

        test("resolves when onCancelled is called with matching triggerId", async () => {
            triggerBus.setCancelFn(() => true);

            const promise = triggerBus.cancel("trg-cancel-me");
            triggerBus.onCancelled({ triggerId: "trg-cancel-me" });

            const result = await promise;
            expect(result).toEqual({ triggerId: "trg-cancel-me" });
        });
    });

    // ── list ──────────────────────────────────────────────────────────────

    describe("list", () => {
        test("rejects immediately when listFn is not set", async () => {
            await expect(triggerBus.list()).rejects.toThrow("Not connected to relay");
        });

        test("rejects when listFn returns false", async () => {
            triggerBus.setListFn(() => false);
            await expect(triggerBus.list()).rejects.toThrow("Failed to send list_triggers");
        });

        test("resolves with trigger list when onList is called", async () => {
            triggerBus.setListFn(() => true);

            const promise = triggerBus.list();

            const mockTriggers = [
                {
                    id: "trg-1",
                    type: "timer" as const,
                    ownerSessionId: "sess-a",
                    runnerId: "runner-1",
                    config: { delaySec: 30 },
                    delivery: { mode: "inject" as const },
                    message: "Timer fired",
                    firingCount: 0,
                    createdAt: "2026-01-01T00:00:00Z",
                },
            ];

            triggerBus.onList({ triggers: mockTriggers });

            const result = await promise;
            expect(result.triggers).toEqual(mockTriggers);
        });

        test("resolves with empty list", async () => {
            triggerBus.setListFn(() => true);
            const promise = triggerBus.list();
            triggerBus.onList({ triggers: [] });
            const result = await promise;
            expect(result.triggers).toEqual([]);
        });
    });

    // ── onError ───────────────────────────────────────────────────────────

    describe("onError", () => {
        test("rejects pending register when no triggerId specified", async () => {
            triggerBus.setRegisterFn(() => true);
            const promise = triggerBus.register({ type: "session_ended", config: { sessionIds: "*" } });

            triggerBus.onError({ message: "server error" });

            await expect(promise).rejects.toThrow("server error");
        });

        test("rejects pending cancel matching triggerId", async () => {
            triggerBus.setCancelFn(() => true);
            const promise = triggerBus.cancel("trg-bad");

            triggerBus.onError({ message: "trigger not found", triggerId: "trg-bad" });

            await expect(promise).rejects.toThrow("trigger not found");
        });

        test("rejects correct pending register when requestId is provided", async () => {
            const sentParams: RegisterTriggerParams[] = [];
            triggerBus.setRegisterFn((p) => { sentParams.push({ ...p }); return true; });

            const p1 = triggerBus.register({ type: "session_ended", config: { sessionIds: "*" } });
            const p2 = triggerBus.register({ type: "timer", config: { delaySec: 30 } });

            const reqId1 = sentParams[0].requestId!;
            const reqId2 = sentParams[1].requestId!;

            // Error targets p2 specifically
            triggerBus.onError({ message: "bad timer config", requestId: reqId2 });

            await expect(p2).rejects.toThrow("bad timer config");

            // p1 should still resolve normally
            triggerBus.onRegistered({ triggerId: "trg-ok", type: "session_ended", requestId: reqId1 });
            const r1 = await p1;
            expect(r1.triggerId).toBe("trg-ok");
        });
    });
});
