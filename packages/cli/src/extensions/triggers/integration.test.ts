// ============================================================================
// integration.test.ts — Integration tests for the trigger routing flow
//
// Tests the trigger types, rendering, response parsing, and extension
// module state management without requiring a live relay connection.
// ============================================================================

import { describe, it, expect, beforeEach } from "bun:test";
import { renderTrigger, parseTriggerResponse, TRIGGER_RENDERERS } from "./registry.js";
import { trackReceivedTrigger, receivedTriggers } from "./extension.js";
import type { ConversationTrigger } from "./types.js";

// Duplicate trigger message parsing from UI package (can't cross-import packages)
const TRIGGER_PREFIX_RE = /^<!--\s*trigger:([\w-]+)\s*-->\n?/;
function parseTriggerMessage(text: string): { triggerId: string; body: string } | null {
    const match = text.match(TRIGGER_PREFIX_RE);
    if (!match) return null;
    return { triggerId: match[1], body: text.slice(match[0].length) };
}
function isTriggerMessage(text: string): boolean {
    return TRIGGER_PREFIX_RE.test(text);
}

function makeTrigger(overrides: Partial<ConversationTrigger> = {}): ConversationTrigger {
    return {
        type: "ask_user_question",
        sourceSessionId: "child-session-1",
        sourceSessionName: "worker-1",
        targetSessionId: "parent-session-1",
        payload: { question: "Which database?", options: ["PostgreSQL", "SQLite"] },
        deliverAs: "followUp",
        expectsResponse: true,
        triggerId: "trigger-abc-123",
        ts: "2026-03-13T18:00:00Z",
        ...overrides,
    };
}

describe("trigger routing flow", () => {
    beforeEach(() => {
        receivedTriggers.clear();
    });

    describe("render → parse cycle", () => {
        it("renders a trigger and the output can be parsed by the UI", () => {
            const trigger = makeTrigger();
            const rendered = renderTrigger(trigger);

            // UI can detect it's a trigger message
            expect(isTriggerMessage(rendered)).toBe(true);

            // UI can extract the trigger ID
            const parsed = parseTriggerMessage(rendered);
            expect(parsed).not.toBeNull();
            expect(parsed!.triggerId).toBe("trigger-abc-123");
            expect(parsed!.body).toContain("Which database?");
        });

        it("non-trigger messages are not detected", () => {
            expect(isTriggerMessage("Hello world")).toBe(false);
            expect(parseTriggerMessage("Just a regular message")).toBeNull();
        });
    });

    describe("received trigger tracking", () => {
        it("tracks a received trigger for response routing", () => {
            trackReceivedTrigger("trigger-1", "child-1", "ask_user_question");
            expect(receivedTriggers.has("trigger-1")).toBe(true);
            const entry = receivedTriggers.get("trigger-1")!;
            expect(entry.sourceSessionId).toBe("child-1");
            expect(entry.type).toBe("ask_user_question");
            expect(entry.trackedAt).toBeGreaterThan(0);
        });

        it("preserves original source when same triggerId is re-tracked (escalation)", () => {
            trackReceivedTrigger("trigger-1", "child-1", "ask_user_question");
            // Escalation re-delivers the same triggerId with the parent's session ID
            // (server overwrites sourceSessionId). The original child source must be kept.
            trackReceivedTrigger("trigger-1", "parent-1", "escalate");
            const entry = receivedTriggers.get("trigger-1")!;
            expect(entry.sourceSessionId).toBe("child-1");
            expect(entry.type).toBe("ask_user_question");
        });

        it("can delete a trigger after responding", () => {
            trackReceivedTrigger("trigger-1", "child-1", "ask_user_question");
            receivedTriggers.delete("trigger-1");
            expect(receivedTriggers.has("trigger-1")).toBe(false);
        });

        it("prunes stale entries when tracking new triggers", () => {
            // Manually insert a stale entry (older than TTL)
            receivedTriggers.set("stale-trigger", {
                sourceSessionId: "old-child",
                type: "ask_user_question",
                trackedAt: Date.now() - 15 * 60 * 1000, // 15 minutes ago (TTL is 10 min)
            });
            // Tracking a new trigger should prune the stale one
            trackReceivedTrigger("fresh-trigger", "new-child", "plan_review");
            expect(receivedTriggers.has("stale-trigger")).toBe(false);
            expect(receivedTriggers.has("fresh-trigger")).toBe(true);
        });
    });

    describe("all renderer types produce valid output", () => {
        for (const [type, renderer] of TRIGGER_RENDERERS) {
            it(`${type} renderer produces non-empty output`, () => {
                const trigger = makeTrigger({
                    type,
                    payload: type === "ask_user_question" ? { question: "Q?", options: ["A"] }
                        : type === "plan_review" ? { title: "Plan", steps: [{ title: "Step 1" }] }
                        : type === "session_complete" ? { summary: "Done" }
                        : type === "session_error" ? { message: "Error" }
                        : type === "escalate" ? { reason: "Help" }
                        : {},
                });
                const rendered = renderer.render(trigger);
                expect(rendered.length).toBeGreaterThan(0);
            });
        }
    });

    describe("response parsing", () => {
        it("session_complete: ack vs follow-up", () => {
            const trigger = makeTrigger({ type: "session_complete" });
            expect(parseTriggerResponse(trigger, "ok")).toEqual({ action: "ack" });
            expect(parseTriggerResponse(trigger, "Please fix tests")).toEqual({
                action: "followUp",
                message: "Please fix tests",
            });
        });

        it("plan_review: approve vs cancel vs edit", () => {
            const trigger = makeTrigger({ type: "plan_review" });
            expect(parseTriggerResponse(trigger, "Begin")).toEqual({ action: "approve" });
            expect(parseTriggerResponse(trigger, "cancel")).toEqual({ action: "cancel" });
            expect(parseTriggerResponse(trigger, "Add more tests please")).toEqual({
                action: "edit",
                feedback: "Add more tests please",
            });
        });
    });

    describe("error cases", () => {
        it("unknown trigger type renders fallback", () => {
            const trigger = makeTrigger({ type: "unknown_event", payload: { data: 42 } });
            const rendered = renderTrigger(trigger);
            expect(rendered).toContain("unknown trigger");
            expect(rendered).toContain("unknown_event");
        });

        it("unknown trigger type returns raw text from parseResponse", () => {
            const trigger = makeTrigger({ type: "unknown_event" });
            expect(parseTriggerResponse(trigger, "hello")).toBe("hello");
        });

        it("responding to non-existent trigger returns empty lookup", () => {
            expect(receivedTriggers.has("nonexistent")).toBe(false);
        });
    });
});
