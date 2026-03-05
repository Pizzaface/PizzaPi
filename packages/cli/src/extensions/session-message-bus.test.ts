import { describe, test, expect, beforeEach } from "bun:test";
import { formatAgentMessage } from "./session-message-bus.js";

// We can't import the singleton directly for isolated tests — instead we
// re-create the class by importing the module fresh. However, since the module
// exports a singleton, we test the public API of that singleton and reset
// state between tests by draining queues.

// For unit-testable pieces (formatAgentMessage, delivery mode logic), we test directly.

describe("formatAgentMessage", () => {
    test("formats completion message with correct prefix", () => {
        const result = formatAgentMessage("session-123", "completion", "Task done successfully");
        expect(result).toBe("[AGENT_MESSAGE from=session-123 type=completion]\nTask done successfully");
    });

    test("formats regular message with correct prefix", () => {
        const result = formatAgentMessage("session-456", "message", "Hello from child");
        expect(result).toBe("[AGENT_MESSAGE from=session-456 type=message]\nHello from child");
    });

    test("handles multiline content", () => {
        const content = "Line 1\nLine 2\nLine 3";
        const result = formatAgentMessage("sess-1", "completion", content);
        expect(result).toBe("[AGENT_MESSAGE from=sess-1 type=completion]\nLine 1\nLine 2\nLine 3");
    });

    test("handles empty content", () => {
        const result = formatAgentMessage("sess-1", "message", "");
        expect(result).toBe("[AGENT_MESSAGE from=sess-1 type=message]\n");
    });
});

describe("SessionMessageBus", () => {
    // We import the singleton — tests must be careful about shared state.
    // Each test drains all queues to start clean.

    let messageBus: typeof import("./session-message-bus.js")["messageBus"];

    beforeEach(async () => {
        // Re-import to get the singleton (same instance each time)
        const mod = await import("./session-message-bus.js");
        messageBus = mod.messageBus;
        // Drain all queues to reset state
        messageBus.drain();
        messageBus.drainAutoDeliveryQueue();
        messageBus.setDeliveryMode("blocked");
        messageBus.onMessageReady(null);
    });

    describe("delivery modes", () => {
        test("default delivery mode is blocked", async () => {
            const mod = await import("./session-message-bus.js");
            // After our beforeEach resets it to "blocked"
            expect(mod.messageBus.getDeliveryMode()).toBe("blocked");
        });

        test("setDeliveryMode changes the mode", () => {
            messageBus.setDeliveryMode("immediate");
            expect(messageBus.getDeliveryMode()).toBe("immediate");

            messageBus.setDeliveryMode("queued");
            expect(messageBus.getDeliveryMode()).toBe("queued");

            messageBus.setDeliveryMode("blocked");
            expect(messageBus.getDeliveryMode()).toBe("blocked");
        });
    });

    describe("completion queue", () => {
        test("queueCompletion adds to completion queue", () => {
            messageBus.queueCompletion({
                fromSessionId: "child-1",
                message: "Result A",
                ts: "2026-01-01T00:00:00Z",
            });
            expect(messageBus.hasQueuedAutoDelivery()).toBe(true);
        });

        test("drainAutoDeliveryQueue returns completions before regular messages", () => {
            // Queue a regular message first
            messageBus.queueAutoDelivery({
                fromSessionId: "peer-1",
                message: "Regular message",
                ts: "2026-01-01T00:00:01Z",
            });
            // Then a completion
            messageBus.queueCompletion({
                fromSessionId: "child-1",
                message: "Completion result",
                ts: "2026-01-01T00:00:02Z",
            });

            const drained = messageBus.drainAutoDeliveryQueue();
            expect(drained).toHaveLength(2);
            // Completion should come first (higher priority)
            expect(drained[0]).toContain("type=completion");
            expect(drained[0]).toContain("Completion result");
            // Regular message second
            expect(drained[1]).toContain("type=message");
            expect(drained[1]).toContain("Regular message");
        });

        test("drainAutoDeliveryQueue clears queues", () => {
            messageBus.queueCompletion({
                fromSessionId: "child-1",
                message: "Result",
                ts: "2026-01-01T00:00:00Z",
            });
            messageBus.drainAutoDeliveryQueue();
            expect(messageBus.hasQueuedAutoDelivery()).toBe(false);
            expect(messageBus.drainAutoDeliveryQueue()).toHaveLength(0);
        });
    });

    describe("tryImmediateDelivery", () => {
        test("returns false when no callback is set", () => {
            const result = messageBus.tryImmediateDelivery("test message");
            expect(result).toBe(false);
        });

        test("returns true when callback accepts message", () => {
            messageBus.onMessageReady(() => true);
            const result = messageBus.tryImmediateDelivery("test message");
            expect(result).toBe(true);
        });

        test("returns false when callback rejects message", () => {
            messageBus.onMessageReady(() => false);
            const result = messageBus.tryImmediateDelivery("test message");
            expect(result).toBe(false);
        });

        test("passes formatted message to callback", () => {
            let received = "";
            messageBus.onMessageReady((msg) => {
                received = msg;
                return true;
            });
            messageBus.tryImmediateDelivery("hello agent");
            expect(received).toBe("hello agent");
        });
    });

    describe("backward compatibility", () => {
        test("receive() still works for wait_for_message", async () => {
            const promise = messageBus.waitForMessage(null);
            messageBus.receive({
                fromSessionId: "sender-1",
                message: "hello",
                ts: "2026-01-01T00:00:00Z",
            });
            const msg = await promise;
            expect(msg).not.toBeNull();
            expect(msg!.message).toBe("hello");
            expect(msg!.fromSessionId).toBe("sender-1");
        });

        test("receive() still queues when no waiter", () => {
            messageBus.receive({
                fromSessionId: "sender-1",
                message: "queued msg",
                ts: "2026-01-01T00:00:00Z",
            });
            expect(messageBus.pendingCount()).toBe(1);
        });

        test("drain() still works for check_messages", () => {
            messageBus.receive({
                fromSessionId: "s1",
                message: "msg1",
                ts: "2026-01-01T00:00:00Z",
            });
            messageBus.receive({
                fromSessionId: "s2",
                message: "msg2",
                ts: "2026-01-01T00:00:01Z",
            });
            const msgs = messageBus.drain();
            expect(msgs).toHaveLength(2);
            expect(messageBus.pendingCount()).toBe(0);
        });
    });

    describe("hasQueuedAutoDelivery", () => {
        test("returns false when both queues are empty", () => {
            expect(messageBus.hasQueuedAutoDelivery()).toBe(false);
        });

        test("returns true when completion queue has items", () => {
            messageBus.queueCompletion({
                fromSessionId: "c1",
                message: "done",
                ts: new Date().toISOString(),
            });
            expect(messageBus.hasQueuedAutoDelivery()).toBe(true);
        });

        test("returns true when auto-delivery queue has items", () => {
            messageBus.queueAutoDelivery({
                fromSessionId: "p1",
                message: "hi",
                ts: new Date().toISOString(),
            });
            expect(messageBus.hasQueuedAutoDelivery()).toBe(true);
        });
    });

    // ── waitForCompletion (PizzaPi-7x0.7) ─────────────────────────────────

    describe("waitForCompletion", () => {
        test("resolves when resolveCompletion is called for matching sessionId", async () => {
            const promise = messageBus.waitForCompletion("child-session-1", 5000);

            // Simulate completion arriving
            messageBus.resolveCompletion({
                sessionId: "child-session-1",
                result: "Task completed successfully",
                tokenUsage: { input: 100, output: 50 },
            });

            const result = await promise;
            expect(result.sessionId).toBe("child-session-1");
            expect(result.result).toBe("Task completed successfully");
            expect(result.tokenUsage).toEqual({ input: 100, output: 50 });
            expect(result.error).toBeUndefined();
        });

        test("resolves with error field when completion has error", async () => {
            const promise = messageBus.waitForCompletion("child-err", 5000);

            messageBus.resolveCompletion({
                sessionId: "child-err",
                result: "Partial output",
                error: "Process crashed",
            });

            const result = await promise;
            expect(result.sessionId).toBe("child-err");
            expect(result.result).toBe("Partial output");
            expect(result.error).toBe("Process crashed");
        });

        test("times out with rejection when no completion arrives", async () => {
            const promise = messageBus.waitForCompletion("slow-session", 50); // 50ms timeout

            try {
                await promise;
                // Should not reach here
                expect(true).toBe(false);
            } catch (err) {
                expect(err).toBeInstanceOf(Error);
                expect((err as Error).message).toContain("Timed out");
                expect((err as Error).message).toContain("slow-session");
            }
        });

        test("does not resolve for wrong sessionId", async () => {
            const promise = messageBus.waitForCompletion("target-session", 100);

            // Resolve a different session — should not match
            const resolved = messageBus.resolveCompletion({
                sessionId: "wrong-session",
                result: "Wrong result",
            });
            expect(resolved).toBe(false);

            // The original promise should time out
            try {
                await promise;
                expect(true).toBe(false);
            } catch (err) {
                expect((err as Error).message).toContain("Timed out");
            }
        });

        test("resolveCompletion returns true when listener exists", () => {
            // Register a listener
            messageBus.waitForCompletion("my-session", 5000);

            const resolved = messageBus.resolveCompletion({
                sessionId: "my-session",
                result: "done",
            });
            expect(resolved).toBe(true);
        });

        test("resolveCompletion returns false when no listener exists", () => {
            const resolved = messageBus.resolveCompletion({
                sessionId: "nonexistent",
                result: "done",
            });
            expect(resolved).toBe(false);
        });

        test("cancelCompletionWait removes the listener", async () => {
            const promise = messageBus.waitForCompletion("cancel-me", 100);

            // Cancel it
            messageBus.cancelCompletionWait("cancel-me");

            // Resolving should now return false (no listener)
            const resolved = messageBus.resolveCompletion({
                sessionId: "cancel-me",
                result: "too late",
            });
            expect(resolved).toBe(false);

            // The promise should still time out since the listener was removed
            try {
                await promise;
                expect(true).toBe(false);
            } catch (err) {
                expect((err as Error).message).toContain("Timed out");
            }
        });
    });

    // ── Channel message support (PizzaPi-7x0.7) ──────────────────────────

    describe("channel messages", () => {
        test("onChannelMessage callback receives channel messages", () => {
            let received: { channelId: string; fromSessionId: string; message: string } | null = null;
            messageBus.onChannelMessage((data) => {
                received = data;
            });

            messageBus.receiveChannelMessage({
                channelId: "test-channel",
                fromSessionId: "sender-1",
                message: "Hello channel",
            });

            expect(received).not.toBeNull();
            expect(received!.channelId).toBe("test-channel");
            expect(received!.fromSessionId).toBe("sender-1");
            expect(received!.message).toBe("Hello channel");

            // Cleanup
            messageBus.onChannelMessage(null);
        });

        test("receiveChannelMessage is no-op when no callback is set", () => {
            messageBus.onChannelMessage(null);

            // Should not throw
            messageBus.receiveChannelMessage({
                channelId: "ch",
                fromSessionId: "s1",
                message: "msg",
            });
        });
    });

    // ── Channel emit methods (PizzaPi-7x0.7) ────────────────────────────

    describe("channel emit", () => {
        test("emitChannelJoin returns false when no emit function set", () => {
            messageBus.setChannelEmitFn(null);
            expect(messageBus.emitChannelJoin("ch1")).toBe(false);
        });

        test("emitChannelJoin sends correct event and tracks channel", () => {
            const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
            messageBus.setChannelEmitFn((event, data) => {
                emitted.push({ event, data });
                return true;
            });

            const result = messageBus.emitChannelJoin("my-channel");
            expect(result).toBe(true);
            expect(emitted).toHaveLength(1);
            expect(emitted[0].event).toBe("channel_join");
            expect(emitted[0].data).toEqual({ channelId: "my-channel" });
            expect(messageBus.getJoinedChannels().has("my-channel")).toBe(true);

            // Cleanup
            messageBus.setChannelEmitFn(null);
        });

        test("emitChannelLeave removes channel from tracked set", () => {
            messageBus.setChannelEmitFn((_e, _d) => true);
            messageBus.emitChannelJoin("ch-leave");
            expect(messageBus.getJoinedChannels().has("ch-leave")).toBe(true);

            messageBus.emitChannelLeave("ch-leave");
            expect(messageBus.getJoinedChannels().has("ch-leave")).toBe(false);

            messageBus.setChannelEmitFn(null);
        });

        test("emitChannelMessage sends correct data", () => {
            const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
            messageBus.setChannelEmitFn((event, data) => {
                emitted.push({ event, data });
                return true;
            });

            const result = messageBus.emitChannelMessage("broadcast-ch", "Hello everyone!");
            expect(result).toBe(true);
            expect(emitted).toHaveLength(1);
            expect(emitted[0].event).toBe("channel_message");
            expect(emitted[0].data).toEqual({ channelId: "broadcast-ch", message: "Hello everyone!" });

            messageBus.setChannelEmitFn(null);
        });

        test("emitChannelMessage returns false when no emit function set", () => {
            messageBus.setChannelEmitFn(null);
            expect(messageBus.emitChannelMessage("ch", "msg")).toBe(false);
        });
    });
});
