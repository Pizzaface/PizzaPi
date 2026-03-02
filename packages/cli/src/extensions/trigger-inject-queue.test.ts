import { describe, expect, test, beforeEach } from "bun:test";
import { triggerInjectQueue, formatTriggerNotifications } from "./trigger-inject-queue.js";
import type { TriggerNotification } from "@pizzapi/protocol";

function makeNotification(overrides: Partial<TriggerNotification> = {}): TriggerNotification {
    return {
        triggerId: "trg-1",
        triggerType: "session_ended",
        message: "Session ended",
        firedAt: "2026-03-02T12:00:00Z",
        ...overrides,
    };
}

describe("TriggerInjectQueue", () => {
    beforeEach(() => {
        // Drain to reset singleton state between tests
        triggerInjectQueue.drain();
    });

    test("starts empty", () => {
        expect(triggerInjectQueue.isEmpty()).toBe(true);
        expect(triggerInjectQueue.size()).toBe(0);
    });

    test("enqueue increases size", () => {
        triggerInjectQueue.enqueue(makeNotification());
        expect(triggerInjectQueue.isEmpty()).toBe(false);
        expect(triggerInjectQueue.size()).toBe(1);
    });

    test("drain returns all items and clears queue", () => {
        triggerInjectQueue.enqueue(makeNotification({ triggerId: "a" }));
        triggerInjectQueue.enqueue(makeNotification({ triggerId: "b" }));

        const items = triggerInjectQueue.drain();
        expect(items).toHaveLength(2);
        expect(items[0].triggerId).toBe("a");
        expect(items[1].triggerId).toBe("b");

        expect(triggerInjectQueue.isEmpty()).toBe(true);
        expect(triggerInjectQueue.size()).toBe(0);
    });

    test("drain returns empty array when queue is empty", () => {
        const items = triggerInjectQueue.drain();
        expect(items).toEqual([]);
    });

    test("successive drains return independent arrays", () => {
        triggerInjectQueue.enqueue(makeNotification({ triggerId: "x" }));
        const first = triggerInjectQueue.drain();

        triggerInjectQueue.enqueue(makeNotification({ triggerId: "y" }));
        const second = triggerInjectQueue.drain();

        expect(first).toHaveLength(1);
        expect(first[0].triggerId).toBe("x");
        expect(second).toHaveLength(1);
        expect(second[0].triggerId).toBe("y");
    });

    test("FIFO ordering", () => {
        triggerInjectQueue.enqueue(makeNotification({ message: "first" }));
        triggerInjectQueue.enqueue(makeNotification({ message: "second" }));
        triggerInjectQueue.enqueue(makeNotification({ message: "third" }));

        const items = triggerInjectQueue.drain();
        expect(items.map((n) => n.message)).toEqual(["first", "second", "third"]);
    });
});

describe("formatTriggerNotifications", () => {
    test("formats single notification", () => {
        const result = formatTriggerNotifications([
            makeNotification({ triggerType: "session_ended", message: "Child finished" }),
        ]);
        expect(result).toBe("[Trigger: session_ended] Child finished");
    });

    test("formats multiple notifications with newlines", () => {
        const result = formatTriggerNotifications([
            makeNotification({ triggerType: "session_ended", message: "A done" }),
            makeNotification({ triggerType: "custom_event", message: "Build complete" }),
        ]);
        expect(result).toBe("[Trigger: session_ended] A done\n[Trigger: custom_event] Build complete");
    });

    test("returns empty string for empty array", () => {
        expect(formatTriggerNotifications([])).toBe("");
    });
});
