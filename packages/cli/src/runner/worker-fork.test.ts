import { describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { extractUserMessageText, headlessFork, type ForkableSession } from "./worker-fork.js";

function buildSession() {
    const sm = SessionManager.inMemory("/tmp/fork-test");
    const firstUserId = sm.appendMessage({ role: "user", content: "first question" } as any);
    sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    } as any);
    const secondUserId = sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: "second question" }],
    } as any);
    sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "second answer" }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    } as any);

    const emitted: any[] = [];
    let aborted = false;
    const session: ForkableSession = {
        get sessionFile() {
            return sm.getSessionFile() ?? undefined;
        },
        sessionManager: sm,
        agent: { sessionId: sm.getSessionId(), state: { messages: sm.buildSessionContext().messages } },
        extensionRunner: {
            hasHandlers: () => true,
            emit: async (event: unknown) => {
                emitted.push(event);
                return undefined;
            },
        },
        abort: async () => {
            aborted = true;
        },
    };
    return { sm, session, firstUserId, secondUserId, emitted, wasAborted: () => aborted };
}

describe("headlessFork", () => {
    test("forks before a user message, truncating the transcript and returning its text", async () => {
        const { sm, session, secondUserId, emitted, wasAborted } = buildSession();
        const originalSessionId = sm.getSessionId();

        const result = await headlessFork(session, secondUserId);

        expect(result.cancelled).toBe(false);
        expect(result.selectedText).toBe("second question");
        expect(wasAborted()).toBe(true);
        // Transcript rewound to just the first exchange
        const roles = (session.agent.state.messages as any[]).map((m) => m.role);
        expect(roles).toEqual(["user", "assistant"]);
        // New session identity
        expect(sm.getSessionId()).not.toBe(originalSessionId);
        expect(session.agent.sessionId).toBe(sm.getSessionId());
        // Extensions notified with reason "fork"
        const switchEvent = emitted.find((e) => e.type === "session_switch");
        expect(switchEvent?.reason).toBe("fork");
    });

    test("forking at the first user message yields an empty session", async () => {
        const { session, firstUserId } = buildSession();

        const result = await headlessFork(session, firstUserId);

        expect(result.cancelled).toBe(false);
        expect(result.selectedText).toBe("first question");
        expect(session.agent.state.messages).toEqual([]);
    });

    test("session_before_fork can cancel", async () => {
        const { sm, session, secondUserId } = buildSession();
        const originalSessionId = sm.getSessionId();
        session.extensionRunner = {
            hasHandlers: () => true,
            emit: async () => ({ cancel: true }),
        };

        const result = await headlessFork(session, secondUserId);

        expect(result.cancelled).toBe(true);
        expect(sm.getSessionId()).toBe(originalSessionId);
    });

    test("rejects non-user entries and unknown ids", async () => {
        const { sm, session } = buildSession();
        const assistantEntry = sm
            .getEntries()
            .find((e: any) => e.type === "message" && e.message.role === "assistant") as any;

        expect(headlessFork(session, assistantEntry.id)).rejects.toThrow("Invalid entry ID");
        expect(headlessFork(session, "nonexistent")).rejects.toThrow("Invalid entry ID");
    });

    test("position 'at' keeps the entry (clone semantics)", async () => {
        const { sm, session, secondUserId } = buildSession();

        const result = await headlessFork(session, secondUserId, { position: "at" });

        expect(result.cancelled).toBe(false);
        const roles = (session.agent.state.messages as any[]).map((m) => m.role);
        expect(roles).toEqual(["user", "assistant", "user"]);
    });
});

describe("extractUserMessageText", () => {
    test("handles strings, text blocks, and non-text content", () => {
        expect(extractUserMessageText("plain")).toBe("plain");
        expect(
            extractUserMessageText([
                { type: "text", text: "a" },
                { type: "image", data: "..." },
                { type: "text", text: "b" },
            ]),
        ).toBe("ab");
        expect(extractUserMessageText(undefined)).toBe("");
    });
});
