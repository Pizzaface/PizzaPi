import { describe, expect, test, beforeEach } from "bun:test";
import { triggerBus, type RegisterTriggerParams } from "./trigger-bus.js";

// Reset the bus state between tests by clearing all callbacks and pending entries.
// Since triggerBus is a singleton we manipulate it directly.
const resetBus = () => {
    triggerBus.setRegisterFn(null);
    triggerBus.setCancelFn(null);
    triggerBus.setListFn(null);
    triggerBus.setEmitFn(null);
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

        test("resolves when onRegistered is called with ack", async () => {
            triggerBus.setRegisterFn(() => true);
            const params: RegisterTriggerParams = {
                type: "session_ended",
                config: { sessionIds: ["sess-1"] },
            };

            const promise = triggerBus.register(params);

            // Simulate server ack
            triggerBus.onRegistered({ triggerId: "trg-abc", type: "session_ended" });

            const result = await promise;
            expect(result).toEqual({ triggerId: "trg-abc", type: "session_ended" });
        });

        test("passes all params to registerFn", async () => {
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
            triggerBus.onRegistered({ triggerId: "trg-xyz", type: "cost_exceeded" });
            await promise;

            expect(calls).toHaveLength(1);
            expect(calls[0]).toEqual(params);
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
    });
});
