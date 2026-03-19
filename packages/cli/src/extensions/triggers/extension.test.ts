// ============================================================================
// extension.test.ts — Tests for the trigger extension's respond_to_trigger tool
//
// Verifies that acknowledging a session_complete trigger emits a
// cleanup_child_session event to the relay, and that followUp still works
// without emitting cleanup.
// ============================================================================

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { trackReceivedTrigger, receivedTriggers } from "./extension.js";

// ── Mock socket for capturing emitted events ─────────────────────────────────

interface EmittedEvent {
    event: string;
    data: unknown;
}

function createMockSocket(opts?: { failSessionMessage?: boolean }) {
    const emitted: EmittedEvent[] = [];
    const listeners = new Map<string, ((...args: any[]) => void)[]>();

    return {
        emitted,
        socket: {
            emit(event: string, data: any) {
                emitted.push({ event, data });
                if (event === "session_message" && opts?.failSessionMessage) {
                    for (const handler of listeners.get("session_message_error") ?? []) {
                        handler({ targetSessionId: data.targetSessionId, error: "Target session not found or not connected" });
                    }
                }
            },
            on(event: string, handler: (...args: any[]) => void) {
                const handlers = listeners.get(event) ?? [];
                handlers.push(handler);
                listeners.set(event, handlers);
            },
            off(event: string, handler: (...args: any[]) => void) {
                const handlers = listeners.get(event) ?? [];
                listeners.set(event, handlers.filter(h => h !== handler));
            },
            connected: true,
        },
        token: "test-token",
    };
}

// ── Simulated respond_to_trigger logic ───────────────────────────────────────
//
// We can't easily instantiate the full pi extension runtime in a unit test.
// Instead, we extract the core logic that respond_to_trigger executes for
// session_complete triggers and test it directly. This matches the actual
// implementation in extension.ts.

async function simulateRespondToTrigger(
    params: { triggerId: string; response: string; action?: string },
    conn: ReturnType<typeof createMockSocket>,
): Promise<{ text: string } | null> {
    const pending = receivedTriggers.get(params.triggerId);
    if (!pending) {
        return { text: `Error: No pending trigger with ID ${params.triggerId}` };
    }

    // TTL check
    const TRIGGER_TTL_MS = 10 * 60 * 1000;
    if (Date.now() - pending.trackedAt > TRIGGER_TTL_MS) {
        receivedTriggers.delete(params.triggerId);
        return { text: `Error: Trigger ${params.triggerId} has expired` };
    }

    if (pending.type === "session_complete") {
        const action = params.action ?? "ack";
        if (action === "followUp") {
            const result = await new Promise<{ ok: boolean; text: string }>((resolve) => {
                const timeout = setTimeout(() => {
                    conn.socket.off("session_message_error", onError);
                    resolve({ ok: true, text: `Follow-up sent to child ${pending.sourceSessionId}` });
                }, 0);

                const onError = (err: { targetSessionId: string; error: string }) => {
                    if (err.targetSessionId === pending.sourceSessionId) {
                        clearTimeout(timeout);
                        conn.socket.off("session_message_error", onError);
                        resolve({ ok: false, text: `Error sending follow-up to child ${pending.sourceSessionId}: ${err.error}` });
                    }
                };
                conn.socket.on("session_message_error", onError);

                conn.socket.emit("session_message", {
                    token: conn.token,
                    targetSessionId: pending.sourceSessionId,
                    message: params.response,
                    deliverAs: "input",
                });
            });
            if (result.ok) {
                receivedTriggers.delete(params.triggerId);
            }
            return { text: result.text };
        }
        receivedTriggers.delete(params.triggerId);
        // ack — emit cleanup request (matches extension.ts implementation)
        conn.socket.emit("cleanup_child_session", {
            token: conn.token,
            childSessionId: pending.sourceSessionId,
        });
        return { text: `Acknowledged session completion from ${pending.sourceSessionId}` };
    }

    // Non-session_complete triggers
    conn.socket.emit("trigger_response", {
        token: conn.token,
        triggerId: params.triggerId,
        response: params.response,
        ...(params.action ? { action: params.action } : {}),
        targetSessionId: pending.sourceSessionId,
    });
    receivedTriggers.delete(params.triggerId);
    return { text: `Response sent for trigger ${params.triggerId}` };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("respond_to_trigger — session_complete cleanup", () => {
    beforeEach(() => {
        receivedTriggers.clear();
    });

    it("emits cleanup_child_session when acking a session_complete trigger", async () => {
        const conn = createMockSocket();
        trackReceivedTrigger("trigger-1", "child-session-abc", "session_complete");

        const result = await simulateRespondToTrigger(
            { triggerId: "trigger-1", response: "ok", action: "ack" },
            conn,
        );

        expect(result!.text).toContain("Acknowledged session completion from child-session-abc");

        // Verify cleanup event was emitted
        const cleanupEvents = conn.emitted.filter(e => e.event === "cleanup_child_session");
        expect(cleanupEvents).toHaveLength(1);
        expect(cleanupEvents[0].data).toEqual({
            token: "test-token",
            childSessionId: "child-session-abc",
        });

        // Trigger should be removed from tracking
        expect(receivedTriggers.has("trigger-1")).toBe(false);
    });

    it("defaults to ack action for session_complete when no action specified", async () => {
        const conn = createMockSocket();
        trackReceivedTrigger("trigger-2", "child-session-xyz", "session_complete");

        await simulateRespondToTrigger(
            { triggerId: "trigger-2", response: "acknowledged" },
            conn,
        );

        // Should still emit cleanup (default action is ack)
        const cleanupEvents = conn.emitted.filter(e => e.event === "cleanup_child_session");
        expect(cleanupEvents).toHaveLength(1);
        expect((cleanupEvents[0].data as any).childSessionId).toBe("child-session-xyz");
    });

    it("does NOT emit cleanup_child_session on followUp action", async () => {
        const conn = createMockSocket();
        trackReceivedTrigger("trigger-3", "child-session-follow", "session_complete");

        const result = await simulateRespondToTrigger(
            { triggerId: "trigger-3", response: "Please fix tests", action: "followUp" },
            conn,
        );

        expect(result!.text).toContain("Follow-up sent to child child-session-follow");

        // No cleanup event should be emitted
        const cleanupEvents = conn.emitted.filter(e => e.event === "cleanup_child_session");
        expect(cleanupEvents).toHaveLength(0);

        // Instead, a session_message should be emitted to resume the child
        const messageEvents = conn.emitted.filter(e => e.event === "session_message");
        expect(messageEvents).toHaveLength(1);
        expect((messageEvents[0].data as any).targetSessionId).toBe("child-session-follow");
        expect((messageEvents[0].data as any).message).toBe("Please fix tests");
        expect(receivedTriggers.has("trigger-3")).toBe(false);
    });

    it("keeps a session_complete followUp trigger pending when delivery fails", async () => {
        const conn = createMockSocket({ failSessionMessage: true });
        trackReceivedTrigger("trigger-3b", "child-session-follow", "session_complete");

        const result = await simulateRespondToTrigger(
            { triggerId: "trigger-3b", response: "Please fix tests", action: "followUp" },
            conn,
        );

        expect(result!.text).toContain("Error sending follow-up to child child-session-follow");
        expect(receivedTriggers.has("trigger-3b")).toBe(true);
    });

    it("does NOT emit cleanup for non-session_complete triggers", async () => {
        const conn = createMockSocket();
        trackReceivedTrigger("trigger-4", "child-session-plan", "plan_review");

        await simulateRespondToTrigger(
            { triggerId: "trigger-4", response: "looks good", action: "approve" },
            conn,
        );

        // No cleanup event
        const cleanupEvents = conn.emitted.filter(e => e.event === "cleanup_child_session");
        expect(cleanupEvents).toHaveLength(0);

        // Should emit trigger_response instead
        const responseEvents = conn.emitted.filter(e => e.event === "trigger_response");
        expect(responseEvents).toHaveLength(1);
    });

    it("returns error for non-existent trigger", async () => {
        const conn = createMockSocket();

        const result = await simulateRespondToTrigger(
            { triggerId: "nonexistent", response: "ok", action: "ack" },
            conn,
        );

        expect(result!.text).toContain("No pending trigger");
        expect(conn.emitted).toHaveLength(0);
    });

    it("returns error for expired trigger", async () => {
        const conn = createMockSocket();
        // Insert a trigger that's already expired (> 10 min old)
        receivedTriggers.set("expired-trigger", {
            sourceSessionId: "old-child",
            type: "session_complete",
            trackedAt: Date.now() - 15 * 60 * 1000,
        });

        const result = await simulateRespondToTrigger(
            { triggerId: "expired-trigger", response: "ok", action: "ack" },
            conn,
        );

        expect(result!.text).toContain("expired");
        expect(conn.emitted).toHaveLength(0);
        expect(receivedTriggers.has("expired-trigger")).toBe(false);
    });
});
