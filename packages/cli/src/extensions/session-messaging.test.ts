import { beforeEach, describe, expect, test } from "bun:test";
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

    test("waits indefinitely by default", async () => {
        const tool = getWaitTool();
        const pending = tool.execute("call", {}, new AbortController().signal);

        await Bun.sleep(25);
        expect(await Promise.race([pending.then(() => true), Bun.sleep(0).then(() => false)])).toBe(false);

        messageBus.receive({ fromSessionId: "sender", message: "hello", ts: new Date().toISOString() });
        expect((await pending).content[0].text).toContain("hello");
    });
});
