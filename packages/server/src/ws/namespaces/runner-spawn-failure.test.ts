import { describe, expect, test } from "bun:test";
import { buildChildSpawnFailureEvent } from "./runner-spawn-failure";

describe("runner spawn failure event", () => {
    test("builds a typed session_complete failure for the parent", () => {
        const event = buildChildSpawnFailureEvent({
            sessionId: "child-1",
            parentSessionId: "parent-1",
            failure: { kind: "auth", detail: "unauthorized", exitCode: 1 },
        });

        expect(event.type).toBe("lifecycle:session_complete");
        expect(event.fireId).toBe("spawn-failure:child-1");
        expect(event.responseContract?.actions).toEqual(["ack", "followUp"]);
        expect(event.payload).toMatchObject({
            exitReason: "error",
            exitCode: 1,
            failure: { kind: "auth", detail: "unauthorized", exitCode: 1 },
        });
    });
});
