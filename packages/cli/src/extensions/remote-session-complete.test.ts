import { describe, it, expect } from "bun:test";
import { sendSessionCompleteFollowUp } from "./remote/session-complete-followup.js";

async function simulateViewerSessionCompleteFollowUp(opts: { deliveryFails: boolean; disconnects?: boolean }) {
    const receivedTriggers = new Map<string, { sourceSessionId: string; type: string }>();
    receivedTriggers.set("trigger-1", { sourceSessionId: "child-1", type: "session_complete" });

    const listeners = new Map<string, Array<(data: any) => void>>();
    const socket = {
        connected: true,
        on(event: string, handler: (data: any) => void) {
            const handlers = listeners.get(event) ?? [];
            handlers.push(handler);
            listeners.set(event, handlers);
        },
        off(event: string, handler: (data: any) => void) {
            listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== handler));
        },
        emit(event: string, data: any) {
            if (event === "session_message" && opts.deliveryFails) {
                for (const handler of listeners.get("session_message_error") ?? []) {
                    handler({ targetSessionId: data.targetSessionId, error: "Target session not found or not connected" });
                }
            }
            if (event === "session_message" && opts.disconnects) {
                socket.connected = false;
                for (const handler of listeners.get("disconnect") ?? []) {
                    handler(undefined);
                }
            }
        },
    };

    const pending = receivedTriggers.get("trigger-1");
    if (!pending) throw new Error("missing pending trigger");

    const result = await sendSessionCompleteFollowUp({
        socket: socket as any,
        token: "relay-token",
        childSessionId: pending.sourceSessionId,
        message: "Please continue",
        timeoutMs: 5,
    });

    if (result.ok) {
        receivedTriggers.delete("trigger-1");
    }

    return receivedTriggers;
}

describe("remote escalated session_complete follow-up delivery", () => {
    it("keeps the trigger pending when delivery fails", async () => {
        const receivedTriggers = await simulateViewerSessionCompleteFollowUp({ deliveryFails: true });
        expect(receivedTriggers.has("trigger-1")).toBe(true);
    });

    it("clears the trigger when delivery succeeds", async () => {
        const receivedTriggers = await simulateViewerSessionCompleteFollowUp({ deliveryFails: false });
        expect(receivedTriggers.has("trigger-1")).toBe(false);
    });

    it("keeps the trigger pending when the relay disconnects before delivery settles", async () => {
        const receivedTriggers = await simulateViewerSessionCompleteFollowUp({ deliveryFails: false, disconnects: true });
        expect(receivedTriggers.has("trigger-1")).toBe(true);
    });
});
