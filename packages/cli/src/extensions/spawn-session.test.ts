import { describe, test, expect, beforeEach, mock } from "bun:test";
import { messageBus, type CompletionResult } from "./session-message-bus.js";

/**
 * Tests for spawn_and_wait and fan_out orchestration logic.
 *
 * Since the actual tools depend on the pi extension framework (registerTool)
 * and network calls (relay spawn endpoint), we test the underlying message bus
 * completion waiting mechanics that power them.
 */

describe("spawn_and_wait completion mechanics", () => {
    beforeEach(() => {
        // Reset message bus state
        messageBus.drain();
        messageBus.drainAutoDeliveryQueue();
        messageBus.setDeliveryMode("blocked");
    });

    test("waitForCompletion resolves on matching session completion", async () => {
        const promise = messageBus.waitForCompletion("spawn-wait-1", 5000);

        // Simulate the relay delivering a completion event
        setTimeout(() => {
            messageBus.resolveCompletion({
                sessionId: "spawn-wait-1",
                result: "Analysis complete. Found 3 issues.",
                tokenUsage: { input: 5000, output: 2000, cost: 0.05 },
            });
        }, 10);

        const result = await promise;
        expect(result.sessionId).toBe("spawn-wait-1");
        expect(result.result).toBe("Analysis complete. Found 3 issues.");
        expect(result.tokenUsage).toEqual({ input: 5000, output: 2000, cost: 0.05 });
        expect(result.error).toBeUndefined();
    });

    test("waitForCompletion returns error field when session errored", async () => {
        const promise = messageBus.waitForCompletion("spawn-err-1", 5000);

        setTimeout(() => {
            messageBus.resolveCompletion({
                sessionId: "spawn-err-1",
                result: "Partial output before crash",
                error: "Uncaught exception: TypeError",
                tokenUsage: { input: 1000, output: 500 },
            });
        }, 10);

        const result = await promise;
        expect(result.sessionId).toBe("spawn-err-1");
        expect(result.error).toBe("Uncaught exception: TypeError");
        expect(result.result).toBe("Partial output before crash");
    });

    test("waitForCompletion times out gracefully", async () => {
        const start = Date.now();
        try {
            await messageBus.waitForCompletion("never-completes", 50);
            expect(true).toBe(false); // Should not reach here
        } catch (err) {
            const elapsed = Date.now() - start;
            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message).toContain("Timed out");
            expect((err as Error).message).toContain("never-completes");
            // Should timeout roughly around 50ms (allow slack for CI)
            expect(elapsed).toBeGreaterThanOrEqual(40);
            expect(elapsed).toBeLessThan(2000);
        }
    });

    test("completion for wrong session does not resolve listener", async () => {
        const promise = messageBus.waitForCompletion("expected-session", 100);

        // Send completion for a different session
        const resolved = messageBus.resolveCompletion({
            sessionId: "different-session",
            result: "Wrong result",
        });
        expect(resolved).toBe(false);

        // Original should still time out
        try {
            await promise;
            expect(true).toBe(false);
        } catch (err) {
            expect((err as Error).message).toContain("Timed out");
        }
    });
});

describe("fan_out completion mechanics", () => {
    beforeEach(() => {
        messageBus.drain();
        messageBus.drainAutoDeliveryQueue();
        messageBus.setDeliveryMode("blocked");
    });

    test("multiple waitForCompletion promises resolve independently", async () => {
        const p1 = messageBus.waitForCompletion("fan-1", 5000);
        const p2 = messageBus.waitForCompletion("fan-2", 5000);
        const p3 = messageBus.waitForCompletion("fan-3", 5000);

        // Complete them in reverse order
        messageBus.resolveCompletion({ sessionId: "fan-3", result: "Result 3" });
        messageBus.resolveCompletion({ sessionId: "fan-1", result: "Result 1" });
        messageBus.resolveCompletion({ sessionId: "fan-2", result: "Result 2" });

        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
        expect(r1.result).toBe("Result 1");
        expect(r2.result).toBe("Result 2");
        expect(r3.result).toBe("Result 3");
    });

    test("partial failure: some complete, some time out", async () => {
        const p1 = messageBus.waitForCompletion("partial-1", 5000);
        const p2 = messageBus.waitForCompletion("partial-2", 50); // Will time out
        const p3 = messageBus.waitForCompletion("partial-3", 5000);

        // Only complete p1 and p3
        messageBus.resolveCompletion({ sessionId: "partial-1", result: "OK 1" });
        messageBus.resolveCompletion({ sessionId: "partial-3", result: "OK 3" });

        const results = await Promise.allSettled([p1, p2, p3]);

        expect(results[0].status).toBe("fulfilled");
        expect((results[0] as PromiseFulfilledResult<CompletionResult>).value.result).toBe("OK 1");

        expect(results[1].status).toBe("rejected");
        expect((results[1] as PromiseRejectedResult).reason.message).toContain("Timed out");

        expect(results[2].status).toBe("fulfilled");
        expect((results[2] as PromiseFulfilledResult<CompletionResult>).value.result).toBe("OK 3");
    });

    test("partial failure: some complete, some error", async () => {
        const p1 = messageBus.waitForCompletion("mix-1", 5000);
        const p2 = messageBus.waitForCompletion("mix-2", 5000);

        messageBus.resolveCompletion({ sessionId: "mix-1", result: "Success!" });
        messageBus.resolveCompletion({
            sessionId: "mix-2",
            result: "Crashed",
            error: "Out of memory",
        });

        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1.error).toBeUndefined();
        expect(r1.result).toBe("Success!");
        expect(r2.error).toBe("Out of memory");
        expect(r2.result).toBe("Crashed");
    });

    test("maxConcurrent simulation: sequential batch processing", async () => {
        // Simulate maxConcurrent=2 with 4 tasks
        // Uses the same pattern as the fan_out tool: wait for batches sequentially
        const completionOrder: string[] = [];

        // Batch 1: spawn tasks 1 & 2
        const p1 = messageBus.waitForCompletion("batch-1", 5000);
        const p2 = messageBus.waitForCompletion("batch-2", 5000);

        // Complete batch 1
        messageBus.resolveCompletion({ sessionId: "batch-1", result: "Done 1" });
        messageBus.resolveCompletion({ sessionId: "batch-2", result: "Done 2" });

        const [r1, r2] = await Promise.all([p1, p2]);
        completionOrder.push(r1.sessionId, r2.sessionId);

        // Batch 2: spawn tasks 3 & 4
        const p3 = messageBus.waitForCompletion("batch-3", 5000);
        const p4 = messageBus.waitForCompletion("batch-4", 5000);

        // Complete batch 2
        messageBus.resolveCompletion({ sessionId: "batch-3", result: "Done 3" });
        messageBus.resolveCompletion({ sessionId: "batch-4", result: "Done 4" });

        const [r3, r4] = await Promise.all([p3, p4]);
        completionOrder.push(r3.sessionId, r4.sessionId);

        expect(completionOrder).toHaveLength(4);
        expect(completionOrder).toContain("batch-1");
        expect(completionOrder).toContain("batch-2");
        expect(completionOrder).toContain("batch-3");
        expect(completionOrder).toContain("batch-4");
    });
});
