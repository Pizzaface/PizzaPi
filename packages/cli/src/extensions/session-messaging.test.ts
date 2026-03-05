import { describe, test, expect, beforeEach } from "bun:test";
import { messageBus } from "./session-message-bus.js";

/**
 * Tests for session messaging bus internals.
 *
 * The agent-facing messaging tools have been removed (agents now use
 * spawn_and_wait / fan_out exclusively), but the underlying message bus
 * is still used internally by the relay and completion system. These
 * tests verify the bus mechanics: channel join/leave/emit, family
 * channels, and message delivery.
 */

describe("channel_join tool mechanics", () => {
    beforeEach(() => {
        messageBus.setChannelEmitFn(null);
    });

    test("join emits channel_join event with correct channelId", () => {
        const events: Array<{ event: string; data: Record<string, unknown> }> = [];
        messageBus.setChannelEmitFn((event, data) => {
            events.push({ event, data });
            return true;
        });

        const result = messageBus.emitChannelJoin("review-team");
        expect(result).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0].event).toBe("channel_join");
        expect(events[0].data.channelId).toBe("review-team");
    });

    test("join tracks channel in joined set", () => {
        messageBus.setChannelEmitFn(() => true);
        messageBus.emitChannelJoin("tracked-ch");
        expect(messageBus.getJoinedChannels().has("tracked-ch")).toBe(true);

        // Cleanup
        messageBus.emitChannelLeave("tracked-ch");
    });

    test("join fails when not connected (no emit fn)", () => {
        messageBus.setChannelEmitFn(null);
        const result = messageBus.emitChannelJoin("offline-ch");
        expect(result).toBe(false);
        expect(messageBus.getJoinedChannels().has("offline-ch")).toBe(false);
    });

    test("multiple joins to different channels", () => {
        const events: string[] = [];
        messageBus.setChannelEmitFn((event, data) => {
            events.push((data as any).channelId);
            return true;
        });

        messageBus.emitChannelJoin("ch-a");
        messageBus.emitChannelJoin("ch-b");
        messageBus.emitChannelJoin("ch-c");

        expect(events).toEqual(["ch-a", "ch-b", "ch-c"]);
        expect(messageBus.getJoinedChannels().size).toBeGreaterThanOrEqual(3);

        // Cleanup
        messageBus.emitChannelLeave("ch-a");
        messageBus.emitChannelLeave("ch-b");
        messageBus.emitChannelLeave("ch-c");
    });
});

describe("channel_leave tool mechanics", () => {
    beforeEach(() => {
        messageBus.setChannelEmitFn(null);
    });

    test("leave emits channel_leave event", () => {
        const events: Array<{ event: string; data: Record<string, unknown> }> = [];
        messageBus.setChannelEmitFn((event, data) => {
            events.push({ event, data });
            return true;
        });

        messageBus.emitChannelJoin("leave-me");
        messageBus.emitChannelLeave("leave-me");

        expect(events).toHaveLength(2);
        expect(events[1].event).toBe("channel_leave");
        expect(events[1].data.channelId).toBe("leave-me");
    });

    test("leave removes channel from joined set", () => {
        messageBus.setChannelEmitFn(() => true);
        messageBus.emitChannelJoin("temp-ch");
        expect(messageBus.getJoinedChannels().has("temp-ch")).toBe(true);

        messageBus.emitChannelLeave("temp-ch");
        expect(messageBus.getJoinedChannels().has("temp-ch")).toBe(false);
    });

    test("leave fails when not connected", () => {
        messageBus.setChannelEmitFn(null);
        expect(messageBus.emitChannelLeave("offline-ch")).toBe(false);
    });
});

describe("channel_broadcast tool mechanics", () => {
    beforeEach(() => {
        messageBus.setChannelEmitFn(null);
    });

    test("broadcast emits channel_message with correct data", () => {
        const events: Array<{ event: string; data: Record<string, unknown> }> = [];
        messageBus.setChannelEmitFn((event, data) => {
            events.push({ event, data });
            return true;
        });

        const result = messageBus.emitChannelMessage("team-ch", "Status: all tests passing");
        expect(result).toBe(true);
        expect(events).toHaveLength(1);
        expect(events[0].event).toBe("channel_message");
        expect(events[0].data.channelId).toBe("team-ch");
        expect(events[0].data.message).toBe("Status: all tests passing");
    });

    test("broadcast fails when not connected", () => {
        messageBus.setChannelEmitFn(null);
        expect(messageBus.emitChannelMessage("ch", "msg")).toBe(false);
    });

    test("broadcast with multiline message", () => {
        const events: Array<{ event: string; data: Record<string, unknown> }> = [];
        messageBus.setChannelEmitFn((event, data) => {
            events.push({ event, data });
            return true;
        });

        const multiline = "Line 1\nLine 2\nLine 3";
        messageBus.emitChannelMessage("ch", multiline);
        expect(events[0].data.message).toBe(multiline);
    });
});

describe("incoming channel messages", () => {
    beforeEach(() => {
        messageBus.onChannelMessage(null);
        messageBus.drain();
        messageBus.drainAutoDeliveryQueue();
        messageBus.setDeliveryMode("blocked");
    });

    test("receiveChannelMessage invokes callback with correct data", () => {
        const received: Array<{ channelId: string; fromSessionId: string; message: string }> = [];
        messageBus.onChannelMessage((data) => {
            received.push(data);
        });

        messageBus.receiveChannelMessage({
            channelId: "updates",
            fromSessionId: "agent-42",
            message: "Build succeeded",
        });

        expect(received).toHaveLength(1);
        expect(received[0].channelId).toBe("updates");
        expect(received[0].fromSessionId).toBe("agent-42");
        expect(received[0].message).toBe("Build succeeded");
    });

    test("multiple channel messages delivered in order", () => {
        const received: string[] = [];
        messageBus.onChannelMessage((data) => {
            received.push(data.message);
        });

        messageBus.receiveChannelMessage({ channelId: "ch", fromSessionId: "s1", message: "First" });
        messageBus.receiveChannelMessage({ channelId: "ch", fromSessionId: "s2", message: "Second" });
        messageBus.receiveChannelMessage({ channelId: "ch", fromSessionId: "s1", message: "Third" });

        expect(received).toEqual(["First", "Second", "Third"]);

        messageBus.onChannelMessage(null);
    });

    test("channel messages from different channels", () => {
        const received: Array<{ channelId: string; message: string }> = [];
        messageBus.onChannelMessage((data) => {
            received.push({ channelId: data.channelId, message: data.message });
        });

        messageBus.receiveChannelMessage({ channelId: "ch-a", fromSessionId: "s1", message: "From A" });
        messageBus.receiveChannelMessage({ channelId: "ch-b", fromSessionId: "s1", message: "From B" });

        expect(received).toHaveLength(2);
        expect(received[0].channelId).toBe("ch-a");
        expect(received[1].channelId).toBe("ch-b");

        messageBus.onChannelMessage(null);
    });
});

// ── emit tool mechanics (innate family channels) ────────────────────────────

describe("emit tool mechanics", () => {
    beforeEach(() => {
        messageBus.setChannelEmitFn(null);
        // Clear any family channels from prior tests
        for (const ch of messageBus.getFamilyChannels()) {
            messageBus.removeFamilyChannel(ch);
        }
    });

    test("emitToFamily sends to all family channels", () => {
        const events: Array<{ event: string; data: Record<string, unknown> }> = [];
        messageBus.setChannelEmitFn((event, data) => {
            events.push({ event, data });
            return true;
        });

        // Simulate being a child of parent-1 and a parent of own children
        messageBus.addFamilyChannel("family:parent-1");
        messageBus.addFamilyChannel("family:my-session");

        const count = messageBus.emitToFamily("50% complete");
        expect(count).toBe(2);
        expect(events).toHaveLength(2);

        // Both should be channel_message events to family channels
        const channels = events.map((e) => (e.data as any).channelId).sort();
        expect(channels).toEqual(["family:my-session", "family:parent-1"]);
        for (const e of events) {
            expect(e.event).toBe("channel_message");
            expect((e.data as any).message).toBe("50% complete");
        }
    });

    test("emitToFamily returns 0 when session has no family", () => {
        messageBus.setChannelEmitFn(() => true);
        // No family channels registered
        expect(messageBus.emitToFamily("lonely message")).toBe(0);
    });

    test("child session auto-registers parent's family channel", () => {
        // Simulate what remote.ts does for a child session
        const parentSessionId = "parent-abc";
        messageBus.addFamilyChannel(`family:${parentSessionId}`);

        expect(messageBus.isFamilyChannel(`family:${parentSessionId}`)).toBe(true);
        expect(messageBus.getFamilyChannels().size).toBe(1);
    });

    test("parent session auto-discovers family channel via membership event", () => {
        // Simulate what remote.ts does when a channel_membership event
        // arrives for a family: channel
        const channelId = "family:my-session-id";
        // Before: not tracked
        expect(messageBus.isFamilyChannel(channelId)).toBe(false);

        // channel_membership handler adds it
        if (channelId.startsWith("family:") && !messageBus.isFamilyChannel(channelId)) {
            messageBus.addFamilyChannel(channelId);
        }

        expect(messageBus.isFamilyChannel(channelId)).toBe(true);
    });

    test("emit works for mid-tree agent (both parent and child)", () => {
        const events: string[] = [];
        messageBus.setChannelEmitFn((_event, data) => {
            events.push((data as any).channelId);
            return true;
        });

        // Coordinator: child of supervisor, parent of workers
        messageBus.addFamilyChannel("family:supervisor-id"); // joined as child
        messageBus.addFamilyChannel("family:coordinator-id"); // joined as parent

        const count = messageBus.emitToFamily("progress update");
        expect(count).toBe(2);
        expect(events.sort()).toEqual(["family:coordinator-id", "family:supervisor-id"]);
    });
});
