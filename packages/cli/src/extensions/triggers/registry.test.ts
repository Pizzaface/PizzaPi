import { describe, it, expect } from "bun:test";
import { renderTrigger, parseTriggerResponse } from "./registry.js";
import type { ConversationTrigger } from "./types.js";

function makeTrigger(overrides: Partial<ConversationTrigger> = {}): ConversationTrigger {
    return {
        type: "ask_user_question",
        sourceSessionId: "child-abc-123",
        sourceSessionName: "my-child",
        targetSessionId: "parent-xyz",
        payload: {},
        deliverAs: "followUp",
        expectsResponse: true,
        triggerId: "trigger-001",
        ts: "2026-03-13T18:00:00Z",
        ...overrides,
    };
}

describe("renderTrigger", () => {
    it("prefixes output with trigger ID metadata comment", () => {
        const trigger = makeTrigger({ payload: { question: "Pick one", options: ["A", "B"] } });
        const result = renderTrigger(trigger);
        expect(result).toStartWith("<!-- trigger:trigger-001 -->");
    });

    describe("ask_user_question", () => {
        it("renders question and options", () => {
            const trigger = makeTrigger({
                type: "ask_user_question",
                payload: { question: "Which DB?", options: ["PostgreSQL", "SQLite"] },
            });
            const result = renderTrigger(trigger);
            expect(result).toContain('Child "my-child" asks:');
            expect(result).toContain("> Which DB?");
            expect(result).toContain("1. PostgreSQL");
            expect(result).toContain("2. SQLite");
            expect(result).toContain("respond_to_trigger");
            expect(result).toContain("trigger-001");
        });

        it("renders without options when none provided", () => {
            const trigger = makeTrigger({
                type: "ask_user_question",
                payload: { question: "What now?" },
            });
            const result = renderTrigger(trigger);
            expect(result).toContain("> What now?");
            expect(result).not.toContain("Options:");
        });
    });

    describe("plan_review", () => {
        it("renders plan title, steps, and instructions", () => {
            const trigger = makeTrigger({
                type: "plan_review",
                payload: {
                    title: "Refactor Auth",
                    steps: [
                        { title: "Extract middleware" },
                        { title: "Add tests", description: "Unit and integration" },
                    ],
                },
            });
            const result = renderTrigger(trigger);
            expect(result).toContain("## Refactor Auth");
            expect(result).toContain("1. Extract middleware");
            expect(result).toContain("2. Add tests");
            expect(result).toContain("Unit and integration");
            expect(result).toContain('action: "approve"');
        });

        it("renders with description", () => {
            const trigger = makeTrigger({
                type: "plan_review",
                payload: {
                    title: "Plan",
                    description: "Detailed description here",
                    steps: [],
                },
            });
            const result = renderTrigger(trigger);
            expect(result).toContain("Detailed description here");
        });
    });

    describe("session_complete", () => {
        it("renders completion summary", () => {
            const trigger = makeTrigger({
                type: "session_complete",
                payload: { summary: "All tests pass. Feature deployed." },
            });
            const result = renderTrigger(trigger);
            expect(result).toContain('Child "my-child" completed:');
            expect(result).toContain("All tests pass. Feature deployed.");
            // session_complete supports ack/followUp responses
            expect(result).toContain("respond_to_trigger");
            expect(result).toContain("ack");
            expect(result).toContain("followUp");
        });

        it("includes full output path when provided", () => {
            const trigger = makeTrigger({
                type: "session_complete",
                payload: { summary: "Truncated summary...", fullOutputPath: "/tmp/pizzapi-session-abc12345-output.md" },
            });
            const result = renderTrigger(trigger);
            expect(result).toContain("Truncated summary...");
            expect(result).toContain("/tmp/pizzapi-session-abc12345-output.md");
            expect(result).toContain("Full output saved to");
            expect(result).toContain("Read tool");
        });

        it("omits file path when not truncated", () => {
            const trigger = makeTrigger({
                type: "session_complete",
                payload: { summary: "Short result" },
            });
            const result = renderTrigger(trigger);
            expect(result).not.toContain("Full output saved to");
        });
    });

    describe("session_error", () => {
        it("renders error message from payload.message", () => {
            const trigger = makeTrigger({
                type: "session_error",
                payload: { message: "Build failed with exit code 1" },
            });
            const result = renderTrigger(trigger);
            expect(result).toContain("⚠️");
            expect(result).toContain("Build failed with exit code 1");
        });

        it("falls back to payload.error", () => {
            const trigger = makeTrigger({
                type: "session_error",
                payload: { error: "Timeout" },
            });
            const result = renderTrigger(trigger);
            expect(result).toContain("Timeout");
        });
    });

    describe("escalate", () => {
        it("renders escalation with reason", () => {
            const trigger = makeTrigger({
                type: "escalate",
                payload: { reason: "Parent cannot handle this" },
            });
            const result = renderTrigger(trigger);
            expect(result).toContain("🚨");
            expect(result).toContain("Parent cannot handle this");
            expect(result).toContain("human attention");
        });
    });

    describe("unknown type", () => {
        it("produces fallback with raw payload", () => {
            const trigger = makeTrigger({
                type: "custom_thing",
                payload: { foo: "bar" },
            });
            const result = renderTrigger(trigger);
            expect(result).toContain('unknown trigger "custom_thing"');
            expect(result).toContain('"foo":"bar"');
        });
    });

    it("uses sourceSessionId when sourceSessionName is missing", () => {
        const trigger = makeTrigger({
            type: "session_complete",
            sourceSessionName: undefined,
            sourceSessionId: "abcdefgh-1234",
            payload: { summary: "Done" },
        });
        const result = renderTrigger(trigger);
        expect(result).toContain('"abcdefgh"'); // first 8 chars
    });
});

describe("parseTriggerResponse", () => {
    describe("session_complete", () => {
        it("classifies 'ok' as ack", () => {
            const trigger = makeTrigger({ type: "session_complete" });
            expect(parseTriggerResponse(trigger, "ok")).toEqual({ action: "ack" });
        });

        it("classifies 'thanks' as ack", () => {
            const trigger = makeTrigger({ type: "session_complete" });
            expect(parseTriggerResponse(trigger, "Thanks!")).toEqual({ action: "ack" });
        });

        it("classifies 'lgtm' as ack", () => {
            const trigger = makeTrigger({ type: "session_complete" });
            expect(parseTriggerResponse(trigger, "LGTM")).toEqual({ action: "ack" });
        });

        it("classifies follow-up text as followUp", () => {
            const trigger = makeTrigger({ type: "session_complete" });
            const result = parseTriggerResponse(trigger, "Please also fix the tests") as any;
            expect(result.action).toBe("followUp");
            expect(result.message).toBe("Please also fix the tests");
        });
    });

    describe("plan_review", () => {
        it("classifies 'Begin' as approve", () => {
            const trigger = makeTrigger({ type: "plan_review" });
            expect(parseTriggerResponse(trigger, "Begin")).toEqual({ action: "approve" });
        });

        it("classifies 'cancel' as cancel", () => {
            const trigger = makeTrigger({ type: "plan_review" });
            expect(parseTriggerResponse(trigger, "cancel")).toEqual({ action: "cancel" });
        });

        it("classifies 'Begin with context' as approve", () => {
            const trigger = makeTrigger({ type: "plan_review" });
            expect(parseTriggerResponse(trigger, "Begin with context")).toEqual({ action: "approve" });
        });

        it("does not false-positive on words containing approval substrings", () => {
            const trigger = makeTrigger({ type: "plan_review" });
            // "go" was removed — words like "algorithm" or "not good" should not match
            const result = parseTriggerResponse(trigger, "the algorithm is wrong") as any;
            expect(result.action).toBe("edit");
        });

        it("classifies 'cancel the plan' as cancel", () => {
            const trigger = makeTrigger({ type: "plan_review" });
            expect(parseTriggerResponse(trigger, "cancel the plan")).toEqual({ action: "cancel" });
        });

        it("classifies other text as edit feedback", () => {
            const trigger = makeTrigger({ type: "plan_review" });
            const result = parseTriggerResponse(trigger, "Add more tests") as any;
            expect(result.action).toBe("edit");
            expect(result.feedback).toBe("Add more tests");
        });
    });

    describe("unknown type", () => {
        it("returns raw text", () => {
            const trigger = makeTrigger({ type: "unknown_type" });
            expect(parseTriggerResponse(trigger, "hello")).toBe("hello");
        });
    });
});
