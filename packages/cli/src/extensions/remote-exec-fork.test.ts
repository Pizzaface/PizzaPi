import { describe, expect, test } from "bun:test";
import { handleExecFromWeb, type ExecHandlerCallbacks } from "./remote-exec-handler.js";
import type { RemoteExecRequest } from "./remote-commands.js";

const callbacks: ExecHandlerCallbacks = {
    setModelFromWeb: async () => {},
    markSessionNameBroadcasted: () => {},
};

function buildRctx(overrides: Record<string, unknown> = {}) {
    const sent: any[] = [];
    const forwarded: any[] = [];
    const rctx: any = {
        pi: {},
        latestCtx: {
            sessionManager: {
                getEntries: () => [
                    { type: "message", id: "u1", message: { role: "user", content: "first question" } },
                    {
                        type: "message",
                        id: "a1",
                        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
                    },
                    {
                        type: "message",
                        id: "u2",
                        message: { role: "user", content: [{ type: "text", text: "second question" }] },
                    },
                    // Image-only user message has no text — excluded from fork list
                    { type: "message", id: "u3", message: { role: "user", content: [{ type: "image", data: "…" }] } },
                ],
            },
        },
        sendToWeb: (msg: unknown) => sent.push(msg),
        forwardEvent: (evt: unknown) => forwarded.push(evt),
        emitSessionActive: () => forwarded.push({ type: "session_active" }),
        buildHeartbeat: () => ({ type: "heartbeat" }),
        ...overrides,
    };
    return { rctx, sent, forwarded };
}

describe("exec get_fork_messages", () => {
    test("lists user messages with text", async () => {
        const { rctx, sent } = buildRctx();
        const req: RemoteExecRequest = { type: "exec", id: "1", command: "get_fork_messages" };

        await handleExecFromWeb(req, rctx, callbacks);

        expect(sent).toHaveLength(1);
        expect(sent[0].ok).toBe(true);
        expect(sent[0].result.messages).toEqual([
            { entryId: "u1", text: "first question" },
            { entryId: "u2", text: "second question" },
        ]);
    });

    test("errors without an active session", async () => {
        const { rctx, sent } = buildRctx({ latestCtx: null });

        await handleExecFromWeb({ type: "exec", id: "1", command: "get_fork_messages" }, rctx, callbacks);

        expect(sent[0].ok).toBe(false);
        expect(sent[0].error).toContain("No active session");
    });
});

describe("exec fork", () => {
    test("forks via pi.fork and pushes a fresh snapshot", async () => {
        const forkCalls: string[] = [];
        const { rctx, sent, forwarded } = buildRctx({
            pi: {
                fork: async (entryId: string) => {
                    forkCalls.push(entryId);
                    return { cancelled: false, selectedText: "second question" };
                },
            },
        });

        await handleExecFromWeb({ type: "exec", id: "1", command: "fork", entryId: "u2" }, rctx, callbacks);

        expect(forkCalls).toEqual(["u2"]);
        expect(sent[0].ok).toBe(true);
        expect(sent[0].result.text).toBe("second question");
        expect(forwarded.map((e: any) => e.type)).toEqual(["session_active", "heartbeat"]);
    });

    test("reports cancellation as an error", async () => {
        const { rctx, sent, forwarded } = buildRctx({
            pi: { fork: async () => ({ cancelled: true }) },
        });

        await handleExecFromWeb({ type: "exec", id: "1", command: "fork", entryId: "u2" }, rctx, callbacks);

        expect(sent[0].ok).toBe(false);
        expect(sent[0].error).toContain("cancelled");
        expect(forwarded).toHaveLength(0);
    });

    test("errors when pi.fork is unavailable or entryId missing", async () => {
        const { rctx, sent } = buildRctx();
        await handleExecFromWeb({ type: "exec", id: "1", command: "fork", entryId: "u2" }, rctx, callbacks);
        expect(sent[0].ok).toBe(false);
        expect(sent[0].error).toContain("not available");

        const { rctx: rctx2, sent: sent2 } = buildRctx({ pi: { fork: async () => ({ cancelled: false }) } });
        await handleExecFromWeb({ type: "exec", id: "2", command: "fork", entryId: "  " } as any, rctx2, callbacks);
        expect(sent2[0].ok).toBe(false);
        expect(sent2[0].error).toContain("entryId");
    });
});
