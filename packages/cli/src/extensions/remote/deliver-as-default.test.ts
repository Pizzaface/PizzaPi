/**
 * Regression coverage for fix/mcp-startup-session-limbo:
 *
 * When a worker's startup gate holds open longer than it takes the web UI
 * to accept a user message (typical with slow MCP startup), the input
 * handler in connection.ts awaits the gate before dispatching. If, in that
 * window, another message (e.g. the initial prompt) has already started
 * streaming, calling `sendUserMessage` without a deliverAs would throw
 * "Agent is already processing..." and drop the message silently.
 *
 * `resolveInputDeliverAs` is the small helper the handler calls to pick the
 * effective delivery mode. These tests pin that behavior:
 *
 *   - If the UI supplied a deliverAs, it always wins.
 *   - If it didn't and the agent is streaming, default to "followUp".
 *   - Otherwise, leave it undefined so idle-agent semantics apply.
 */
import { describe, expect, test } from "bun:test";
import { resolveInputDeliverAs } from "./connection.js";

describe("resolveInputDeliverAs", () => {
    test("returns requested mode verbatim when supplied", () => {
        expect(resolveInputDeliverAs("steer", false)).toBe("steer");
        expect(resolveInputDeliverAs("steer", true)).toBe("steer");
        expect(resolveInputDeliverAs("followUp", false)).toBe("followUp");
        expect(resolveInputDeliverAs("followUp", true)).toBe("followUp");
    });

    test("defaults to followUp when mode is missing and agent is active", () => {
        expect(resolveInputDeliverAs(undefined, true)).toBe("followUp");
    });

    test("leaves mode undefined when agent is idle and no mode was requested", () => {
        expect(resolveInputDeliverAs(undefined, false)).toBeUndefined();
    });
});
