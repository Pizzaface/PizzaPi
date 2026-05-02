import { describe, expect, it } from "bun:test";
import { prepareBroadcastEvent } from "./sessions.js";

describe("prepareBroadcastEvent", () => {
    function messages(n: number): unknown[] {
        return Array.from({ length: n }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `Message ${i}`,
        }));
    }

    it("truncates non-chunked session_active with many messages to the tail", () => {
        const event = {
            type: "session_active" as const,
            state: {
                messages: messages(75),
                model: { provider: "anthropic", id: "claude" },
                sessionName: "Test",
            },
        };

        const result = prepareBroadcastEvent(event) as typeof event;

        expect(result.state.messages).toHaveLength(50);
        expect((result.state as any).totalMessages).toBe(75);
        expect((result.state as any).hasMore).toBe(true);
        expect((result.state as any).oldestLoadedIndex).toBe(25);
    });

    it("does not truncate when messages count is within tail size", () => {
        const event = {
            type: "session_active" as const,
            state: {
                messages: messages(30),
                model: { provider: "anthropic", id: "claude" },
            },
        };

        const result = prepareBroadcastEvent(event) as typeof event;

        expect(result.state.messages).toHaveLength(30);
        expect((result.state as any).totalMessages).toBe(30);
        expect((result.state as any).hasMore).toBe(false);
    });

    it("does not truncate chunked session_active events", () => {
        const event = {
            type: "session_active" as const,
            state: {
                messages: messages(100),
                chunked: true,
                snapshotId: "abc",
                totalMessages: 100,
            },
        };

        const result = prepareBroadcastEvent(event) as typeof event;

        expect(result.state.messages).toHaveLength(100);
        expect(result.state.chunked).toBe(true);
    });

    it("passes through non-session_active events unchanged", () => {
        const event = { type: "message_start", messageId: "msg-1" };
        const result = prepareBroadcastEvent(event);
        expect(result).toBe(event); // same reference
    });

    it("handles empty messages", () => {
        const event = {
            type: "session_active" as const,
            state: { messages: [] },
        };

        const result = prepareBroadcastEvent(event) as typeof event;
        expect(result.state.messages).toEqual([]);
        expect((result.state as any).hasMore).toBe(false);
    });

    it("tail contains the most recent messages (not the first)", () => {
        const event = {
            type: "session_active" as const,
            state: { messages: messages(100) },
        };

        const result = prepareBroadcastEvent(event) as typeof event;
        const msgs = result.state.messages as Array<{ content: string }>;
        expect(msgs[0].content).toBe("Message 50");
        expect(msgs[49].content).toBe("Message 99");
    });

    it("returns original reference for non-matching events (no unnecessary object creation)", () => {
        const event = { type: "message_end" };
        expect(prepareBroadcastEvent(event)).toBe(event);
    });

    it("handles boundary at exactly 50 messages", () => {
        const event = {
            type: "session_active" as const,
            state: { messages: messages(50) },
        };

        const result = prepareBroadcastEvent(event) as typeof event;
        expect(result.state.messages).toHaveLength(50);
        expect((result.state as any).hasMore).toBe(false);
        expect((result.state as any).totalMessages).toBe(50);
    });
});
