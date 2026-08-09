import { expect, test } from "bun:test";
import { notifyRelayTrigger, onRelayTrigger } from "./trigger-listeners.js";

test("relay trigger listeners unsubscribe cleanly", () => {
    const received: string[] = [];
    const unsubscribe = onRelayTrigger((trigger) => received.push(trigger.type));
    notifyRelayTrigger({ type: "session_complete" } as any);
    unsubscribe();
    notifyRelayTrigger({ type: "session_error" } as any);
    expect(received).toEqual(["session_complete"]);
});
