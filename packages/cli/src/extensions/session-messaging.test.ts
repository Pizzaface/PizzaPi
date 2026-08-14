import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { messageBus } from "./session-message-bus.js";
import { sessionMessagingExtension } from "./session-messaging.js";

function getWaitTool() {
    let waitTool: any;
    sessionMessagingExtension({
        registerTool(tool: any) {
            if (tool.name === "wait_for_message") waitTool = tool;
        },
    } as any);
    return waitTool;
}

describe("wait_for_message", () => {
    beforeEach(() => messageBus.resetForTests());

    test("waits indefinitely by default without scheduling a timeout", async () => {
        const setTimeoutSpy = spyOn(globalThis, "setTimeout");
        try {
            const tool = getWaitTool();
            const pending = tool.execute("call", {}, new AbortController().signal);

            expect(setTimeoutSpy.mock.calls.some(([, delay]) => typeof delay === "number" && delay > 0)).toBe(false);

            messageBus.receive({ fromSessionId: "sender", message: "hello", ts: new Date().toISOString() });
            expect((await pending).content[0].text).toContain("hello");
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    test("returns timedOut for an explicit timeout", async () => {
        const tool = getWaitTool();

        const result = await tool.execute("call", { timeout: 0.02 }, new AbortController().signal);

        expect(result.details).toMatchObject({ received: false, timedOut: true });
    });
});
