import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { enqueueSessionEvent, sessionEventQueues } from "./event-pipeline.js";

async function flushQueue(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

describe("enqueueSessionEvent", () => {
    afterEach(() => {
        sessionEventQueues.clear();
    });

    test("logs a failed task and continues processing later tasks", async () => {
        const errorSpy = spyOn(console, "error").mockImplementation(() => {});
        let ranSecond = false;

        enqueueSessionEvent("session-1", async () => {
            throw new Error("boom");
        });
        enqueueSessionEvent("session-1", async () => {
            ranSecond = true;
        });

        await flushQueue();
        await sessionEventQueues.get("session-1");
        await flushQueue();

        expect(ranSecond).toBe(true);
        expect(errorSpy).toHaveBeenCalled();
        expect(sessionEventQueues.has("session-1")).toBe(false);

        errorSpy.mockRestore();
    });
});
