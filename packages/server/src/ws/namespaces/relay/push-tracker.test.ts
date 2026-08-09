import { beforeEach, describe, it, expect, mock } from "bun:test";

const finishedCalls: unknown[][] = [];

mock.module("../../../push.js", () => ({
    notifyAgentFinished: (...args: unknown[]) => finishedCalls.push(args),
    notifyAgentNeedsInput: () => {},
    notifyAgentError: () => {},
}));
mock.module("../../sio-state/index.js", () => ({
    setPushPendingQuestion: async () => {},
    clearPushPendingQuestion: async () => {},
    isLinkedChildForSuppression: async () => false,
}));
mock.module("../../sio-registry.js", () => ({
    getSharedSession: async () => ({
        userId: "user-connected",
        sessionName: "Connected session",
        parentSessionId: null,
        linkedParentId: null,
    }),
    getViewerCount: async () => 1,
}));

const { checkPushNotifications, extractLastAssistantText } = await import("./push-tracker.js");

beforeEach(() => finishedCalls.splice(0));

describe("checkPushNotifications", () => {
    it("keeps native delivery enabled when connected viewers suppress Web Push", async () => {
        await checkPushNotifications("sess-connected", {
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
        });

        expect(finishedCalls).toEqual([[
            "user-connected",
            "sess-connected",
            "Connected session",
            false,
            "done",
            true,
        ]]);
    });
});

describe("extractLastAssistantText", () => {
    it("returns the last assistant message's text", () => {
        const event = {
            type: "agent_end",
            messages: [
                { role: "user", content: [{ type: "text", text: "hi" }] },
                { role: "assistant", content: [{ type: "text", text: "first" }] },
                { role: "assistant", content: [{ type: "text", text: "final reply" }] },
            ],
        };
        expect(extractLastAssistantText(event)).toBe("final reply");
    });

    it("joins multiple text blocks and skips non-text content", () => {
        const event = {
            messages: [
                {
                    role: "assistant",
                    content: [
                        { type: "text", text: "part one" },
                        { type: "toolCall", id: "x" },
                        { type: "text", text: "part two" },
                    ],
                },
            ],
        };
        expect(extractLastAssistantText(event)).toBe("part one\npart two");
    });

    it("skips trailing assistant messages with no text (tool-only turns)", () => {
        const event = {
            messages: [
                { role: "assistant", content: [{ type: "text", text: "spoken" }] },
                { role: "assistant", content: [{ type: "toolCall", id: "x" }] },
            ],
        };
        expect(extractLastAssistantText(event)).toBe("spoken");
    });

    it("returns undefined when there are no messages or no assistant text", () => {
        expect(extractLastAssistantText({})).toBeUndefined();
        expect(extractLastAssistantText({ messages: [] })).toBeUndefined();
        expect(
            extractLastAssistantText({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
        ).toBeUndefined();
    });
});
