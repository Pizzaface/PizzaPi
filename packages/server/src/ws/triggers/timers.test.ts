import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TimerScheduler } from "./timers.js";
import type { TriggerRecord } from "@pizzapi/protocol";
import type { TriggerRegistry } from "./registry.js";

// ============================================================================
// Helpers
// ============================================================================

function makeTimerTrigger(overrides: Partial<TriggerRecord> = {}): TriggerRecord {
    return {
        id: "trigger-1",
        type: "timer",
        ownerSessionId: "session-1",
        runnerId: "runner-1",
        config: { delaySec: 0.02 }, // 20ms for fast tests
        delivery: { mode: "inject" },
        message: "Timer fired!",
        firingCount: 0,
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

function makeMockRegistry(triggers: TriggerRecord[] = []): TriggerRegistry {
    return {
        getTriggersByType: async (_runnerId: string, _type: string) => triggers,
        registerTrigger: async () => ({ ok: true as const, triggerId: "fake" }),
        cancelTrigger: async () => ({ ok: true as const }),
        listTriggers: async () => [],
        fireTrigger: async () => null,
        hasTrigger: async () => true,
        cleanupSessionTriggers: async () => 0,
        rehydrateTriggers: async () => [],
    } as unknown as TriggerRegistry;
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Tests
// ============================================================================

describe("TimerScheduler", () => {
    let firedIds: string[];
    let onFire: (id: string) => Promise<void>;
    let scheduler: TimerScheduler;

    beforeEach(() => {
        firedIds = [];
        onFire = async (id: string) => {
            firedIds.push(id);
        };
        scheduler = new TimerScheduler(makeMockRegistry(), onFire);
    });

    afterEach(() => {
        // Cancel any lingering timers to prevent cross-test interference
        for (const id of ["t1", "t2", "t3"]) {
            scheduler.cancelTimer(id);
        }
    });

    // -------------------------------------------------------------------------
    // scheduleTimer
    // -------------------------------------------------------------------------

    describe("scheduleTimer", () => {
        test("one-shot: fires once after delay", async () => {
            const trigger = makeTimerTrigger({ id: "t1", config: { delaySec: 0.02 } });
            scheduler.scheduleTimer(trigger);

            expect(scheduler.isActive("t1")).toBe(true);
            await wait(80);

            expect(firedIds).toContain("t1");
            // One-shot removes itself from active map after firing
            expect(scheduler.isActive("t1")).toBe(false);
        });

        test("one-shot: fires exactly once", async () => {
            const trigger = makeTimerTrigger({ id: "t1", config: { delaySec: 0.02 } });
            scheduler.scheduleTimer(trigger);

            await wait(120);
            const fireCount = firedIds.filter((id) => id === "t1").length;
            expect(fireCount).toBe(1);
        });

        test("recurring: fires multiple times", async () => {
            const trigger = makeTimerTrigger({
                id: "t1",
                config: { delaySec: 0.02, recurring: true },
            });
            scheduler.scheduleTimer(trigger);

            await wait(120);
            scheduler.cancelTimer("t1");

            const fireCount = firedIds.filter((id) => id === "t1").length;
            // With a 20ms interval over 120ms, expect at least 3 fires
            expect(fireCount).toBeGreaterThanOrEqual(3);
        });

        test("recurring: stays active until cancelled", async () => {
            const trigger = makeTimerTrigger({
                id: "t1",
                config: { delaySec: 0.02, recurring: true },
            });
            scheduler.scheduleTimer(trigger);

            expect(scheduler.isActive("t1")).toBe(true);
            await wait(40);
            // Still active — recurring timers persist
            expect(scheduler.isActive("t1")).toBe(true);
            scheduler.cancelTimer("t1");
        });

        test("recurring: auto-cancels when trigger is removed", async () => {
            let exists = true;
            const registry = {
                ...makeMockRegistry(),
                hasTrigger: async () => exists,
            } as unknown as TriggerRegistry;
            scheduler = new TimerScheduler(registry, async (id) => {
                firedIds.push(id);
                exists = false;
            });

            scheduler.scheduleTimer(makeTimerTrigger({ id: "t1", config: { delaySec: 0.02, recurring: true } }));
            await wait(90);

            expect(scheduler.isActive("t1")).toBe(false);
        });

        test("ignores timers with invalid delay", async () => {
            scheduler.scheduleTimer(makeTimerTrigger({ id: "t1", config: { delaySec: 0, recurring: true } }));
            await wait(40);
            expect(scheduler.isActive("t1")).toBe(false);
            expect(firedIds).toEqual([]);
        });

        test("adds to activeTimers on schedule", () => {
            expect(scheduler.activeCount).toBe(0);
            const trigger = makeTimerTrigger({ id: "t1" });
            scheduler.scheduleTimer(trigger);
            expect(scheduler.activeCount).toBe(1);
            expect(scheduler.isActive("t1")).toBe(true);
        });

        test("multiple triggers tracked independently", () => {
            scheduler.scheduleTimer(makeTimerTrigger({ id: "t1" }));
            scheduler.scheduleTimer(makeTimerTrigger({ id: "t2" }));
            scheduler.scheduleTimer(makeTimerTrigger({ id: "t3" }));
            expect(scheduler.activeCount).toBe(3);
        });

        test("rescheduling same trigger replaces prior timer", async () => {
            scheduler.scheduleTimer(makeTimerTrigger({ id: "t1", config: { delaySec: 0.1 } }));
            scheduler.scheduleTimer(makeTimerTrigger({ id: "t1", config: { delaySec: 0.02 } }));

            await wait(160);

            const fireCount = firedIds.filter((id) => id === "t1").length;
            expect(fireCount).toBe(1);
        });
    });

    // -------------------------------------------------------------------------
    // cancelTimer
    // -------------------------------------------------------------------------

    describe("cancelTimer", () => {
        test("prevents a one-shot from firing", async () => {
            const trigger = makeTimerTrigger({ id: "t1", config: { delaySec: 0.1 } });
            scheduler.scheduleTimer(trigger);
            scheduler.cancelTimer("t1");

            await wait(200);
            expect(firedIds).not.toContain("t1");
        });

        test("stops a recurring timer from firing further", async () => {
            const trigger = makeTimerTrigger({
                id: "t1",
                config: { delaySec: 0.02, recurring: true },
            });
            scheduler.scheduleTimer(trigger);

            await wait(50);
            scheduler.cancelTimer("t1");
            const countAtCancel = firedIds.filter((id) => id === "t1").length;

            await wait(80);
            // No additional fires after cancel
            const countAfterWait = firedIds.filter((id) => id === "t1").length;
            expect(countAfterWait).toBe(countAtCancel);
        });

        test("removes trigger from activeTimers", () => {
            scheduler.scheduleTimer(makeTimerTrigger({ id: "t1" }));
            expect(scheduler.isActive("t1")).toBe(true);

            scheduler.cancelTimer("t1");
            expect(scheduler.isActive("t1")).toBe(false);
            expect(scheduler.activeCount).toBe(0);
        });

        test("is a no-op for a non-existent trigger", () => {
            // Should not throw
            expect(() => scheduler.cancelTimer("nonexistent-id")).not.toThrow();
        });

        test("cancelling one timer does not affect others", () => {
            scheduler.scheduleTimer(makeTimerTrigger({ id: "t1" }));
            scheduler.scheduleTimer(makeTimerTrigger({ id: "t2" }));

            scheduler.cancelTimer("t1");
            expect(scheduler.isActive("t1")).toBe(false);
            expect(scheduler.isActive("t2")).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // rehydrateTimers
    // -------------------------------------------------------------------------

    describe("rehydrateTimers", () => {
        test("fires overdue one-shot immediately (no timer scheduled)", async () => {
            const trigger = makeTimerTrigger({
                id: "t1",
                config: { delaySec: 60 },
                // Created 2 minutes ago — well overdue
                createdAt: new Date(Date.now() - 120_000).toISOString(),
            });

            scheduler = new TimerScheduler(makeMockRegistry([trigger]), onFire);
            await scheduler.rehydrateTimers("runner-1");

            // Fired immediately (synchronously during rehydrate)
            expect(firedIds).toContain("t1");
            // No active timer needed for a one-shot that already fired
            expect(scheduler.isActive("t1")).toBe(false);
        });

        test("schedules remaining time for non-overdue one-shot", async () => {
            const trigger = makeTimerTrigger({
                id: "t1",
                // 50ms delay, created 20ms ago → ~30ms remaining
                config: { delaySec: 0.05 },
                createdAt: new Date(Date.now() - 20).toISOString(),
            });

            scheduler = new TimerScheduler(makeMockRegistry([trigger]), onFire);
            await scheduler.rehydrateTimers("runner-1");

            // Not fired immediately
            expect(firedIds).not.toContain("t1");
            // Has a scheduled timer
            expect(scheduler.isActive("t1")).toBe(true);

            // Fires after the remaining delay
            await wait(120);
            expect(firedIds).toContain("t1");
        });

        test("fires overdue recurring immediately and schedules interval", async () => {
            const trigger = makeTimerTrigger({
                id: "t1",
                // 30ms interval, last fired 100ms ago → overdue
                config: { delaySec: 0.03, recurring: true },
                createdAt: new Date(Date.now() - 200).toISOString(),
            });

            scheduler = new TimerScheduler(makeMockRegistry([trigger]), onFire);
            await scheduler.rehydrateTimers("runner-1");

            // Fired immediately during rehydrate
            expect(firedIds.filter((id) => id === "t1").length).toBeGreaterThanOrEqual(1);
            // Interval should be scheduled for future fires
            expect(scheduler.isActive("t1")).toBe(true);

            // Wait for the interval to fire more
            await wait(120);
            scheduler.cancelTimer("t1");
            expect(firedIds.filter((id) => id === "t1").length).toBeGreaterThanOrEqual(2);
        });

        test("schedules remaining time for non-overdue recurring", async () => {
            const trigger = makeTimerTrigger({
                id: "t1",
                // 50ms interval, created 20ms ago → 30ms remaining
                config: { delaySec: 0.05, recurring: true },
                createdAt: new Date(Date.now() - 20).toISOString(),
            });

            scheduler = new TimerScheduler(makeMockRegistry([trigger]), onFire);
            await scheduler.rehydrateTimers("runner-1");

            // Not fired yet
            expect(firedIds).not.toContain("t1");
            // Has a timer scheduled
            expect(scheduler.isActive("t1")).toBe(true);

            // Should fire after the remaining delay, then continue recurring
            await wait(200);
            scheduler.cancelTimer("t1");
            expect(firedIds.filter((id) => id === "t1").length).toBeGreaterThanOrEqual(1);
        });

        test("uses lastFiredAt instead of createdAt for recurring rehydration", async () => {
            const trigger = makeTimerTrigger({
                id: "t1",
                // delaySec = 60s, but lastFiredAt was only 5s ago → 55s remaining
                config: { delaySec: 60, recurring: true },
                createdAt: new Date(Date.now() - 300_000).toISOString(), // 5 min ago
                lastFiredAt: new Date(Date.now() - 5_000).toISOString(), // 5 sec ago
            });

            scheduler = new TimerScheduler(makeMockRegistry([trigger]), onFire);
            await scheduler.rehydrateTimers("runner-1");

            // Not overdue (based on lastFiredAt, only 5s elapsed of 60s)
            expect(firedIds).not.toContain("t1");
            // Scheduled for ~55s from now
            expect(scheduler.isActive("t1")).toBe(true);
            // Clean up the long-lived timer
            scheduler.cancelTimer("t1");
        });

        test("skips rehydration for invalid delay timers", async () => {
            const trigger = makeTimerTrigger({
                id: "t1",
                config: { delaySec: -1, recurring: true },
            });
            scheduler = new TimerScheduler(makeMockRegistry([trigger]), onFire);
            await scheduler.rehydrateTimers("runner-1");

            expect(scheduler.activeCount).toBe(0);
            expect(firedIds).toEqual([]);
        });

        test("handles empty trigger list gracefully", async () => {
            scheduler = new TimerScheduler(makeMockRegistry([]), onFire);
            await scheduler.rehydrateTimers("runner-1");

            expect(scheduler.activeCount).toBe(0);
            expect(firedIds).toHaveLength(0);
        });

        test("rehydrates multiple triggers independently", async () => {
            const triggers = [
                makeTimerTrigger({
                    id: "t1",
                    config: { delaySec: 60 },
                    // Overdue
                    createdAt: new Date(Date.now() - 120_000).toISOString(),
                }),
                makeTimerTrigger({
                    id: "t2",
                    config: { delaySec: 0.05 },
                    // Not overdue
                    createdAt: new Date(Date.now() - 20).toISOString(),
                }),
            ];

            scheduler = new TimerScheduler(makeMockRegistry(triggers), onFire);
            await scheduler.rehydrateTimers("runner-1");

            // t1 overdue — fired immediately
            expect(firedIds).toContain("t1");
            expect(scheduler.isActive("t1")).toBe(false);

            // t2 not overdue — scheduled
            expect(firedIds).not.toContain("t2");
            expect(scheduler.isActive("t2")).toBe(true);

            // Cleanup
            await wait(120);
            expect(firedIds).toContain("t2");
        });
    });

    // -------------------------------------------------------------------------
    // cleanupSessionTimers
    // -------------------------------------------------------------------------

    describe("cleanupSessionTimers", () => {
        test("cancels all timers owned by the session", () => {
            const triggers = [
                makeTimerTrigger({ id: "t1", ownerSessionId: "session-1" }),
                makeTimerTrigger({ id: "t2", ownerSessionId: "session-1" }),
                makeTimerTrigger({ id: "t3", ownerSessionId: "session-2" }),
            ];
            for (const t of triggers) scheduler.scheduleTimer(t);
            expect(scheduler.activeCount).toBe(3);

            scheduler.cleanupSessionTimers("session-1", triggers);

            expect(scheduler.isActive("t1")).toBe(false);
            expect(scheduler.isActive("t2")).toBe(false);
            // session-2's timer is unaffected
            expect(scheduler.isActive("t3")).toBe(true);
        });

        test("does not cancel timers for other sessions", () => {
            const triggers = [
                makeTimerTrigger({ id: "t1", ownerSessionId: "session-A" }),
                makeTimerTrigger({ id: "t2", ownerSessionId: "session-B" }),
            ];
            for (const t of triggers) scheduler.scheduleTimer(t);

            scheduler.cleanupSessionTimers("session-A", triggers);

            expect(scheduler.isActive("t1")).toBe(false);
            expect(scheduler.isActive("t2")).toBe(true);
        });

        test("is a no-op when session has no timers", () => {
            const other = makeTimerTrigger({ id: "t1", ownerSessionId: "session-X" });
            scheduler.scheduleTimer(other);

            // Cleanup for a different session — should not affect t1
            scheduler.cleanupSessionTimers("session-nobody", [other]);
            expect(scheduler.isActive("t1")).toBe(true);
        });

        test("is a no-op with empty triggers list", () => {
            scheduler.scheduleTimer(makeTimerTrigger({ id: "t1" }));
            expect(scheduler.activeCount).toBe(1);

            scheduler.cleanupSessionTimers("session-1", []);
            expect(scheduler.activeCount).toBe(1);
        });
    });

    // -------------------------------------------------------------------------
    // isActive / activeCount
    // -------------------------------------------------------------------------

    describe("isActive / activeCount", () => {
        test("isActive returns false for a non-scheduled trigger", () => {
            expect(scheduler.isActive("non-existent")).toBe(false);
        });

        test("activeCount starts at 0", () => {
            expect(scheduler.activeCount).toBe(0);
        });

        test("activeCount increments on schedule and decrements on cancel", () => {
            scheduler.scheduleTimer(makeTimerTrigger({ id: "t1" }));
            expect(scheduler.activeCount).toBe(1);

            scheduler.scheduleTimer(makeTimerTrigger({ id: "t2" }));
            expect(scheduler.activeCount).toBe(2);

            scheduler.cancelTimer("t1");
            expect(scheduler.activeCount).toBe(1);

            scheduler.cancelTimer("t2");
            expect(scheduler.activeCount).toBe(0);
        });

        test("activeCount decrements automatically after one-shot fires", async () => {
            scheduler.scheduleTimer(makeTimerTrigger({ id: "t1", config: { delaySec: 0.02 } }));
            expect(scheduler.activeCount).toBe(1);

            await wait(80);
            // One-shot removes itself on fire
            expect(scheduler.activeCount).toBe(0);
        });
    });
});
