import { describe, test, expect, beforeEach } from "bun:test";
import { messageBus } from "./session-message-bus.js";

function makeMsg(fromSessionId: string, message: string, ts?: string) {
    return { fromSessionId, message, ts: ts ?? new Date().toISOString() };
}

describe("SessionMessageBus", () => {
    beforeEach(() => {
        messageBus.resetForTests();
    });

    test("returns false for unknown session", () => {
        expect(messageBus.hasConsumedMessagesFrom("never-seen-session")).toBe(false);
    });

    test("returns true after waitForMessage resolves from queue", async () => {
        const sid = `queue-consume-${Date.now()}`;
        messageBus.receive(makeMsg(sid, "hello"));
        const msg = await messageBus.waitForMessage(sid);
        expect(msg).not.toBeNull();
        expect(msg!.message).toBe("hello");
        expect(messageBus.hasConsumedMessagesFrom(sid)).toBe(true);
    });

    test("returns true after waitForMessage resolves from waiter", async () => {
        const sid = `waiter-consume-${Date.now()}`;
        const promise = messageBus.waitForMessage(sid);
        messageBus.receive(makeMsg(sid, "world"));
        const msg = await promise;
        expect(msg).not.toBeNull();
        expect(msg!.message).toBe("world");
        expect(messageBus.hasConsumedMessagesFrom(sid)).toBe(true);
    });

    test("returns true after waitForMessage with null filter (any sender)", async () => {
        const sid = `any-consume-${Date.now()}`;
        messageBus.receive(makeMsg(sid, "from-any"));
        const msg = await messageBus.waitForMessage(null);
        expect(msg).not.toBeNull();
        expect(msg!.fromSessionId).toBe(sid);
        expect(messageBus.hasConsumedMessagesFrom(sid)).toBe(true);
    });

    test("returns true after drain with specific sender", () => {
        const sid = `drain-specific-${Date.now()}`;
        messageBus.receive(makeMsg(sid, "msg1"));
        messageBus.receive(makeMsg(sid, "msg2"));
        const drained = messageBus.drain(sid);
        expect(drained).toHaveLength(2);
        expect(messageBus.hasConsumedMessagesFrom(sid)).toBe(true);
    });

    test("returns true after drain all", () => {
        const sid1 = `drain-all-a-${Date.now()}`;
        const sid2 = `drain-all-b-${Date.now()}`;
        messageBus.receive(makeMsg(sid1, "a"));
        messageBus.receive(makeMsg(sid2, "b"));
        const drained = messageBus.drain();
        expect(drained).toHaveLength(2);
        expect(messageBus.hasConsumedMessagesFrom(sid1)).toBe(true);
        expect(messageBus.hasConsumedMessagesFrom(sid2)).toBe(true);
    });

    test("returns false when messages were received but not consumed", () => {
        const sid = `received-not-consumed-${Date.now()}`;
        messageBus.receive(makeMsg(sid, "pending"));
        expect(messageBus.hasConsumedMessagesFrom(sid)).toBe(false);
    });

    test("caps queued messages per sender to prevent unbounded growth", () => {
        const sid = `queue-cap-${Date.now()}`;
        for (let i = 0; i < 150; i++) {
            messageBus.receive(makeMsg(sid, `msg-${i}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`));
        }

        expect(messageBus.pendingCount(sid)).toBe(100);

        const drained = messageBus.drain(sid);
        expect(drained).toHaveLength(100);
        expect(drained[0]?.message).toBe("msg-50");
        expect(drained[99]?.message).toBe("msg-149");
    });

    test("clears stale queued, waiter, and consumed state when the session id changes", async () => {
        const consumedSid = `consumed-child-${Date.now()}`;
        messageBus.receive(makeMsg(consumedSid, "before-switch"));
        await messageBus.waitForMessage(consumedSid);
        expect(messageBus.hasConsumedMessagesFrom(consumedSid)).toBe(true);

        const queuedSid = `queued-child-${Date.now()}`;
        messageBus.receive(makeMsg(queuedSid, "queued-before-switch"));
        expect(messageBus.pendingCount(queuedSid)).toBe(1);

        const waitingSid = `waiting-child-${Date.now()}`;
        const waiter = messageBus.waitForMessage(waitingSid);

        messageBus.setOwnSessionId("session-a");
        messageBus.setOwnSessionId("session-b");

        expect(await waiter).toBeNull();
        expect(messageBus.hasConsumedMessagesFrom(consumedSid)).toBe(false);
        expect(messageBus.pendingCount(queuedSid)).toBe(0);
    });
});
