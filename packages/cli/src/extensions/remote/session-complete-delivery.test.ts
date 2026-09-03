import { describe, expect, test } from "bun:test";
import { buildSessionCompleteTrigger } from "./session-complete-delivery.js";

describe("buildSessionCompleteTrigger", () => {
    test("builds a lifecycle:session_complete trigger for the parent", () => {
        const trigger = buildSessionCompleteTrigger({
            sourceSessionId: "child-1",
            targetSessionId: "parent-1",
            triggerId: "trigger-1",
            summary: "Done",
            exitReason: "completed",
        });

        expect(trigger).toMatchObject({
            type: "lifecycle:session_complete",
            sourceSessionId: "child-1",
            targetSessionId: "parent-1",
            triggerId: "trigger-1",
            deliverAs: "steer",
            expectsResponse: true,
            payload: {
                summary: "Done",
                exitCode: 0,
                exitReason: "completed",
            },
        });
        expect(typeof trigger.ts).toBe("string");
    });

    test("maps exit reasons to exit codes", () => {
        const killed = buildSessionCompleteTrigger({
            sourceSessionId: "c", targetSessionId: "p", triggerId: "t",
            summary: "s", exitReason: "killed",
        });
        expect(killed.payload.exitCode).toBe(130);

        const errored = buildSessionCompleteTrigger({
            sourceSessionId: "c", targetSessionId: "p", triggerId: "t",
            summary: "s", exitReason: "error",
        });
        expect(errored.payload.exitCode).toBe(1);
    });

    test("includes fullOutputPath when provided", () => {
        const trigger = buildSessionCompleteTrigger({
            sourceSessionId: "c", targetSessionId: "p", triggerId: "t",
            summary: "s", exitReason: "completed", fullOutputPath: "/tmp/out.md",
        });
        expect(trigger.payload.fullOutputPath).toBe("/tmp/out.md");
    });
});