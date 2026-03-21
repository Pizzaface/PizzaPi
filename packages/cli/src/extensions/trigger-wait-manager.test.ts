import { describe, expect, it } from "bun:test";
import { createTriggerWaitManager } from "./trigger-wait-manager.js";

describe("createTriggerWaitManager", () => {
    it("cancels all pending waits with the provided message", () => {
        const manager = createTriggerWaitManager();
        const results: Array<{ id: string; response: string; cancelled?: boolean }> = [];

        manager.register("t1", (result) => results.push({ id: "t1", ...result }));
        manager.register("t2", (result) => results.push({ id: "t2", ...result }));

        expect(manager.size()).toBe(2);
        expect(manager.cancelAll("Parent started a new session — trigger cancelled.")).toBe(2);
        expect(manager.size()).toBe(0);
        expect(results).toEqual([
            { id: "t1", response: "Parent started a new session — trigger cancelled.", cancelled: true },
            { id: "t2", response: "Parent started a new session — trigger cancelled.", cancelled: true },
        ]);
    });

    it("unregisters individual waits", () => {
        const manager = createTriggerWaitManager();
        const results: Array<string> = [];

        const unregister = manager.register("t1", () => results.push("t1"));
        unregister();

        expect(manager.size()).toBe(0);
        expect(manager.cancelAll("ignored")).toBe(0);
        expect(results).toEqual([]);
    });
});
