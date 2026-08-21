import { beforeEach, describe, it, expect, mock } from "bun:test";

const finishedCalls: unknown[][] = [];
const needsInputCalls: unknown[][] = [];

let viewerCount: { kind: "count"; count: number } | { kind: "unknown" } = { kind: "count", count: 1 };
let visibleViewer = true;

mock.module("../../../push.js", () => ({
    notifyAgentFinished: (...args: unknown[]) => finishedCalls.push(args),
    notifyAgentNeedsInput: (...args: unknown[]) => needsInputCalls.push(args),
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
    getViewerCount: async () => viewerCount,
    hasVisibleViewer: async () => visibleViewer,
}));

const { checkPushNotifications, extractLastAssistantText } = await import("./push-tracker.js");

beforeEach(() => {
    finishedCalls.splice(0);
    needsInputCalls.splice(0);
    viewerCount = { kind: "count", count: 1 };
    visibleViewer = true;
});

describe("checkPushNotifications", () => {
    it("viewer connected + tab visible suppresses both web and native", async () => {
        viewerCount = { kind: "count", count: 1 };
        visibleViewer = true;

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
            { web: true, native: true },
        ]]);
    });

    it("viewer connected + tab hidden suppresses web only", async () => {
        viewerCount = { kind: "count", count: 1 };
        visibleViewer = false;

        await checkPushNotifications("sess-hidden", {
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
        });

        expect(finishedCalls).toEqual([[
            "user-connected",
            "sess-hidden",
            "Connected session",
            false,
            "done",
            { web: true, native: false },
        ]]);
    });

    it("no viewer at all suppresses neither", async () => {
        viewerCount = { kind: "count", count: 0 };
        visibleViewer = false;

        await checkPushNotifications("sess-empty", {
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
        });

        expect(finishedCalls).toEqual([[
            "user-connected",
            "sess-empty",
            "Connected session",
            false,
            "done",
            { web: false, native: false },
        ]]);
    });

    it("unknown viewer presence does not suppress web push", async () => {
        viewerCount = { kind: "unknown" };
        visibleViewer = false;

        await checkPushNotifications("sess-unknown", { type: "agent_end" });

        expect(finishedCalls[0]?.at(-1)).toEqual({ web: false, native: false });
    });

    it("plan_mode start produces a needs-input push with no option buttons", async () => {
        viewerCount = { kind: "count", count: 0 };
        visibleViewer = false;

        await checkPushNotifications("sess-plan", {
            type: "tool_execution_start",
            toolName: "plan_mode",
            toolCallId: "tc-1",
        });

        expect(needsInputCalls).toEqual([[
            "user-connected",
            "sess-plan",
            "Plan ready for review",
            "Connected session",
            undefined,
            undefined,
            false,
            { web: false, native: false },
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
