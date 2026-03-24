// ============================================================================
// new-session-cleanup.test.ts — Tests for trigger cleanup on /new (session switch)
//
// Verifies that clearAndCancelPendingTriggers():
//   1. Clears all entries from receivedTriggers
//   2. Sends cancel trigger_response to each child (with ack callback)
//   3. Returns the correct count and trigger IDs
//   4. Calls onConfirmed when the server acks the cancel (at-least-once delivery)
// ============================================================================

import { afterAll, describe, it, expect, beforeEach, mock } from "bun:test";
import { trackReceivedTrigger, receivedTriggers, clearAndCancelPendingTriggers } from "./extension.js";

// ── Mock the relay socket used by clearAndCancelPendingTriggers ──────────────
// The function calls getRelaySocket() from ../remote.js. We mock at the module
// level so the import inside extension.ts resolves to our mock.

type AckCallback = (result: { ok: boolean; error?: string }) => void;

let mockSocket: {
    emitted: Array<{ event: string; data: unknown; ack?: AckCallback }>;
    emit: (event: string, data: unknown, ack?: AckCallback) => void;
} | null = null;

let mockToken = "test-token-123";

// Mock getRelaySocket to return our mock
mock.module("../remote.js", () => ({
    getRelaySocket: () =>
        mockSocket
            ? { socket: mockSocket, token: mockToken }
            : null,
    getRelaySessionId: () => "parent-session-1",
}));

// Restore all module mocks after this file so they don't bleed into other
// test files running in the same worker process.
afterAll(() => mock.restore());

describe("clearAndCancelPendingTriggers", () => {
    beforeEach(() => {
        receivedTriggers.clear();
        const emitted: Array<{ event: string; data: unknown; ack?: AckCallback }> = [];
        mockSocket = {
            emitted,
            emit(event: string, data: unknown, ack?: AckCallback) {
                emitted.push({ event, data, ack });
            },
        };
    });

    it("clears all pending triggers", () => {
        trackReceivedTrigger("t1", "child-1", "ask_user_question");
        trackReceivedTrigger("t2", "child-2", "plan_review");
        trackReceivedTrigger("t3", "child-3", "session_complete");

        expect(receivedTriggers.size).toBe(3);

        const result = clearAndCancelPendingTriggers();

        expect(receivedTriggers.size).toBe(0);
        expect(result.cancelled).toBe(3);
        expect(result.sent).toHaveLength(3);
        expect(result.sent.map((x) => x.triggerId)).toContain("t1");
        expect(result.sent.map((x) => x.triggerId)).toContain("t2");
        expect(result.sent.map((x) => x.triggerId)).toContain("t3");
        expect(result.failed).toHaveLength(0);
    });

    it("sends cancel trigger_response to each child", () => {
        trackReceivedTrigger("t1", "child-1", "ask_user_question");
        trackReceivedTrigger("t2", "child-2", "plan_review");

        clearAndCancelPendingTriggers();

        expect(mockSocket!.emitted).toHaveLength(2);

        // Verify cancel responses
        for (const { event, data } of mockSocket!.emitted) {
            expect(event).toBe("trigger_response");
            const d = data as Record<string, unknown>;
            expect(d.token).toBe(mockToken);
            expect(d.action).toBe("cancel");
            expect(d.response).toContain("new session");
        }

        // Verify correct routing to children
        const targetIds = mockSocket!.emitted.map(
            (e) => (e.data as Record<string, unknown>).targetSessionId,
        );
        expect(targetIds).toContain("child-1");
        expect(targetIds).toContain("child-2");
    });

    it("attaches an ack callback to each emitted trigger_response", () => {
        trackReceivedTrigger("t1", "child-1", "ask_user_question");
        trackReceivedTrigger("t2", "child-2", "plan_review");

        clearAndCancelPendingTriggers();

        // Every emit should carry an ack callback so the server can confirm delivery.
        for (const emitRecord of mockSocket!.emitted) {
            expect(typeof emitRecord.ack).toBe("function");
        }
    });

    it("calls onConfirmed when server acks with ok:true", () => {
        trackReceivedTrigger("t1", "child-1", "ask_user_question");
        trackReceivedTrigger("t2", "child-2", "plan_review");

        const confirmed: Array<{ triggerId: string; childSessionId: string }> = [];
        clearAndCancelPendingTriggers((triggerId, childSessionId) => {
            confirmed.push({ triggerId, childSessionId });
        });

        // Simulate the server acking both cancels
        for (const { ack } of mockSocket!.emitted) {
            ack?.({ ok: true });
        }

        expect(confirmed).toHaveLength(2);
        expect(confirmed.map((c) => c.triggerId)).toContain("t1");
        expect(confirmed.map((c) => c.triggerId)).toContain("t2");
        expect(confirmed.find((c) => c.triggerId === "t1")?.childSessionId).toBe("child-1");
        expect(confirmed.find((c) => c.triggerId === "t2")?.childSessionId).toBe("child-2");
    });

    it("does NOT call onConfirmed when server acks with ok:false", () => {
        trackReceivedTrigger("t1", "child-1", "ask_user_question");

        const confirmed: Array<{ triggerId: string; childSessionId: string }> = [];
        clearAndCancelPendingTriggers((triggerId, childSessionId) => {
            confirmed.push({ triggerId, childSessionId });
        });

        // Simulate the server rejecting the cancel (delivery failure)
        for (const { ack } of mockSocket!.emitted) {
            ack?.({ ok: false, error: "session not found" });
        }

        // onConfirmed must NOT be called — the item stays in pendingCancellations for retry
        expect(confirmed).toHaveLength(0);
    });

    it("does NOT call onConfirmed when no ack fires (socket dropped)", () => {
        trackReceivedTrigger("t1", "child-1", "ask_user_question");

        const confirmed: Array<{ triggerId: string; childSessionId: string }> = [];
        clearAndCancelPendingTriggers((triggerId, childSessionId) => {
            confirmed.push({ triggerId, childSessionId });
        });

        // Don't call any ack — simulates socket dropping before ack arrives
        expect(confirmed).toHaveLength(0);
    });

    it("returns zero when no triggers are pending", () => {
        const result = clearAndCancelPendingTriggers();
        expect(result.cancelled).toBe(0);
        expect(result.sent).toHaveLength(0);
        expect(result.failed).toHaveLength(0);
        expect(mockSocket!.emitted).toHaveLength(0);
    });

    it("works gracefully when relay is not connected", () => {
        mockSocket = null; // simulate disconnected relay

        trackReceivedTrigger("t1", "child-1", "ask_user_question");
        trackReceivedTrigger("t2", "child-2", "session_complete");

        // Should not throw, should still clear triggers
        const result = clearAndCancelPendingTriggers();

        expect(result.cancelled).toBe(2);
        expect(result.sent).toHaveLength(0); // nothing sent due to disconnection
        expect(result.failed).toHaveLength(2); // both triggers marked as failed
        expect(receivedTriggers.size).toBe(0); // triggers cleared from map
    });

    it("includes the correct triggerId in each cancel response", () => {
        trackReceivedTrigger("trigger-abc", "child-1", "ask_user_question");
        trackReceivedTrigger("trigger-xyz", "child-2", "plan_review");

        clearAndCancelPendingTriggers();

        const triggerIds = mockSocket!.emitted.map(
            (e) => (e.data as Record<string, unknown>).triggerId,
        );
        expect(triggerIds).toContain("trigger-abc");
        expect(triggerIds).toContain("trigger-xyz");
    });
});
