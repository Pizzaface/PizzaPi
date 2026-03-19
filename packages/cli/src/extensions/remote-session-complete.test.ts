import { describe, it, expect } from "bun:test";

function simulateViewerSessionCompleteFollowUp(opts: { deliveryFails: boolean }) {
    const receivedTriggers = new Map<string, { sourceSessionId: string; type: string }>();
    receivedTriggers.set("trigger-1", { sourceSessionId: "child-1", type: "session_complete" });

    const listeners = new Map<string, Array<(data: any) => void>>();
    const socket = {
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
        },
    };

    const pending = receivedTriggers.get("trigger-1");
    if (!pending) throw new Error("missing pending trigger");

    const childId = pending.sourceSessionId;
    let failed = false;
    const onError = (err: { targetSessionId: string; error: string }) => {
        if (err.targetSessionId === childId) {
            failed = true;
            socket.off("session_message_error", onError);
        }
    };

    socket.on("session_message_error", onError);
    socket.emit("session_message", {
        targetSessionId: childId,
        message: "Please continue",
        deliverAs: "input",
    });

    socket.off("session_message_error", onError);
    if (!failed) {
        receivedTriggers.delete("trigger-1");
    }

    return receivedTriggers;
}

describe("remote escalated session_complete follow-up delivery", () => {
    it("keeps the trigger pending when delivery fails", () => {
        const receivedTriggers = simulateViewerSessionCompleteFollowUp({ deliveryFails: true });
        expect(receivedTriggers.has("trigger-1")).toBe(true);
    });

    it("clears the trigger when delivery succeeds", () => {
        const receivedTriggers = simulateViewerSessionCompleteFollowUp({ deliveryFails: false });
        expect(receivedTriggers.has("trigger-1")).toBe(false);
    });
});
