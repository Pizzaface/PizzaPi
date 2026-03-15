import { describe, test, expect, beforeEach } from "bun:test";

// The message bus is a singleton, so we need to re-import a fresh module for
// each test. Instead, we test the exported singleton directly and accept that
// state accumulates — tests are ordered to account for this, or we drain
// between tests.

// We can't easily reset the singleton, so we'll test the public API in a way
// that doesn't depend on prior state by using unique session IDs per test.

import { messageBus } from "./session-message-bus.js";

function makeMsg(fromSessionId: string, message: string, ts?: string) {
    return { fromSessionId, message, ts: ts ?? new Date().toISOString() };
}

describe("SessionMessageBus.hasConsumedMessagesFrom", () => {
    test("returns false for unknown session", () => {
        expect(messageBus.hasConsumedMessagesFrom("never-seen-session")).toBe(false);
    });

    test("returns true after waitForMessage resolves from queue", async () => {
        const sid = `queue-consume-${Date.now()}`;
        // Queue a message first, then consume it
        messageBus.receive(makeMsg(sid, "hello"));
        const msg = await messageBus.waitForMessage(sid);
        expect(msg).not.toBeNull();
        expect(msg!.message).toBe("hello");
        expect(messageBus.hasConsumedMessagesFrom(sid)).toBe(true);
    });

    test("returns true after waitForMessage resolves from waiter", async () => {
        const sid = `waiter-consume-${Date.now()}`;
        // Start waiting before the message arrives
        const promise = messageBus.waitForMessage(sid);
        // Deliver the message (resolves the waiter)
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
        expect(drained.length).toBeGreaterThanOrEqual(2);
        expect(messageBus.hasConsumedMessagesFrom(sid1)).toBe(true);
        expect(messageBus.hasConsumedMessagesFrom(sid2)).toBe(true);
    });

    test("returns false when messages were received but not consumed", () => {
        const sid = `received-not-consumed-${Date.now()}`;
        messageBus.receive(makeMsg(sid, "pending"));
        expect(messageBus.hasConsumedMessagesFrom(sid)).toBe(false);
        // Clean up
        messageBus.drain(sid);
    });
});
