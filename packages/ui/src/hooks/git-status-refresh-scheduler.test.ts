import { describe, expect, test } from "bun:test";
import { createPostMutationRefreshScheduler } from "./git-status-refresh-scheduler";

type TimerId = ReturnType<typeof setTimeout>;

function createFakeTimers() {
    let nextId = 1;
    const callbacks = new Map<number, () => void>();

    const setTimer = (callback: () => void) => {
        const id = nextId++;
        callbacks.set(id, callback);
        return id as TimerId;
    };

    const clearTimer = (timerId: TimerId) => {
        callbacks.delete(timerId as unknown as number);
    };

    const runAll = () => {
        const pending = Array.from(callbacks.entries());
        callbacks.clear();
        for (const [, callback] of pending) callback();
    };

    const pendingCount = () => callbacks.size;

    return { setTimer, clearTimer, runAll, pendingCount };
}

describe("createPostMutationRefreshScheduler", () => {
    test("coalesces rapid schedules into one trailing refresh", () => {
        const fakeTimers = createFakeTimers();
        let refreshCount = 0;
        const scheduler = createPostMutationRefreshScheduler({
            debounceMs: 100,
            getGeneration: () => 1,
            isStatusRequestInFlight: () => false,
            triggerRefresh: () => {
                refreshCount += 1;
            },
            setTimer: fakeTimers.setTimer,
            clearTimer: fakeTimers.clearTimer,
        });

        scheduler.schedule();
        scheduler.schedule();
        scheduler.schedule();

        expect(fakeTimers.pendingCount()).toBe(1);
        fakeTimers.runAll();
        expect(refreshCount).toBe(1);
    });

    test("keeps a pending refresh while status is in flight and runs trailing refresh after settle", () => {
        const fakeTimers = createFakeTimers();
        let inFlight = true;
        let refreshCount = 0;
        const scheduler = createPostMutationRefreshScheduler({
            debounceMs: 100,
            getGeneration: () => 1,
            isStatusRequestInFlight: () => inFlight,
            triggerRefresh: () => {
                refreshCount += 1;
            },
            setTimer: fakeTimers.setTimer,
            clearTimer: fakeTimers.clearTimer,
        });

        scheduler.schedule();
        expect(fakeTimers.pendingCount()).toBe(1);

        // First tick sees in-flight and reschedules.
        fakeTimers.runAll();
        expect(refreshCount).toBe(0);
        expect(fakeTimers.pendingCount()).toBe(1);

        // Once settled, next tick triggers the trailing refresh.
        inFlight = false;
        fakeTimers.runAll();
        expect(refreshCount).toBe(1);
        expect(fakeTimers.pendingCount()).toBe(0);
    });

    test("retries later when a request becomes in flight before timer fires", () => {
        const fakeTimers = createFakeTimers();
        let inFlight = false;
        let refreshCount = 0;
        const scheduler = createPostMutationRefreshScheduler({
            debounceMs: 100,
            getGeneration: () => 1,
            isStatusRequestInFlight: () => inFlight,
            triggerRefresh: () => {
                refreshCount += 1;
            },
            setTimer: fakeTimers.setTimer,
            clearTimer: fakeTimers.clearTimer,
        });

        scheduler.schedule();
        inFlight = true;
        fakeTimers.runAll();

        expect(refreshCount).toBe(0);
        expect(fakeTimers.pendingCount()).toBe(1);

        inFlight = false;
        fakeTimers.runAll();
        expect(refreshCount).toBe(1);
    });

    test("drops scheduled refresh when generation changes", () => {
        const fakeTimers = createFakeTimers();
        let generation = 1;
        let refreshCount = 0;
        const scheduler = createPostMutationRefreshScheduler({
            debounceMs: 100,
            getGeneration: () => generation,
            isStatusRequestInFlight: () => false,
            triggerRefresh: () => {
                refreshCount += 1;
            },
            setTimer: fakeTimers.setTimer,
            clearTimer: fakeTimers.clearTimer,
        });

        scheduler.schedule();
        generation = 2;
        fakeTimers.runAll();

        expect(refreshCount).toBe(0);
    });

    test("dispose cancels pending timers and future schedules", () => {
        const fakeTimers = createFakeTimers();
        let refreshCount = 0;
        const scheduler = createPostMutationRefreshScheduler({
            debounceMs: 100,
            getGeneration: () => 1,
            isStatusRequestInFlight: () => false,
            triggerRefresh: () => {
                refreshCount += 1;
            },
            setTimer: fakeTimers.setTimer,
            clearTimer: fakeTimers.clearTimer,
        });

        scheduler.schedule();
        expect(fakeTimers.pendingCount()).toBe(1);

        scheduler.dispose();
        expect(fakeTimers.pendingCount()).toBe(0);

        scheduler.schedule();
        expect(fakeTimers.pendingCount()).toBe(0);

        fakeTimers.runAll();
        expect(refreshCount).toBe(0);
    });
});
