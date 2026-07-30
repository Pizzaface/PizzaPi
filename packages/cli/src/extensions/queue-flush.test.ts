import { describe, test, expect } from "bun:test";
import { queueFlushExtension } from "./queue-flush.js";

function mockPi(pending: () => boolean) {
    const messages: any[] = [];
    let settled: any;
    return {
        messages,
        settle: () => settled({}, { hasPendingMessages: pending }),
        on(event: string, handler: any) { if (event === "agent_settled") settled = handler; },
        sendMessage(msg: any, opts: any) { messages.push({ msg, opts }); },
    };
}

const tick = () => Bun.sleep(5);

describe("queue-flush", () => {
    test("kicks a turn when the session settles with messages still queued", async () => {
        const pi = mockPi(() => true);
        queueFlushExtension(pi as any);
        pi.settle();
        await tick();
        expect(pi.messages.length).toBe(1);
        expect(pi.messages[0].opts.triggerTurn).toBe(true);
        expect(pi.messages[0].msg.display).toBe(false);
    });

    test("does nothing when the queue is empty", async () => {
        const pi = mockPi(() => false);
        queueFlushExtension(pi as any);
        pi.settle();
        await tick();
        expect(pi.messages.length).toBe(0);
    });

    test("stops kicking after 3 consecutive attempts, resets once drained", async () => {
        let pending = true;
        const pi = mockPi(() => pending);
        queueFlushExtension(pi as any);
        for (let i = 0; i < 5; i++) pi.settle();
        await tick();
        expect(pi.messages.length).toBe(3);

        pending = false;
        pi.settle();
        pending = true;
        pi.settle();
        await tick();
        expect(pi.messages.length).toBe(4);
    });
});
