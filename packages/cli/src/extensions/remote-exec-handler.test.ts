/**
 * Unit tests for the set_queued_messages exec command.
 *
 * Verifies web UI queue edits actually mutate pi's pending follow-up queue
 * (previously they were cosmetic-only local UI state).
 */
import { describe, test, expect } from "bun:test";
import { handleExecFromWeb, type ExecHandlerCallbacks } from "./remote-exec-handler.js";
import type { RelayContext } from "./remote-types.js";

const callbacks: ExecHandlerCallbacks = {
    setModelFromWeb: async () => {},
    markSessionNameBroadcasted: () => {},
};

function makeRctx(pi: unknown) {
    const sent: unknown[] = [];
    const forwarded: unknown[] = [];
    const rctx = {
        pi,
        sendToWeb: (payload: unknown) => sent.push(payload),
        forwardEvent: (event: unknown) => forwarded.push(event),
        buildHeartbeat: () => ({ type: "heartbeat", queuedMessages: ["from-heartbeat"] }),
    } as unknown as RelayContext;
    return { rctx, sent, forwarded };
}

describe("set_queued_messages exec command", () => {
    test("replaces pi's follow-up queue and broadcasts a heartbeat", async () => {
        const replaced: string[][] = [];
        const { rctx, sent, forwarded } = makeRctx({
            replaceQueuedMessages: (messages: string[]) => replaced.push(messages),
        });

        await handleExecFromWeb(
            { type: "exec", id: "1", command: "set_queued_messages", messages: ["edited text", "  ", "second"] } as any,
            rctx,
            callbacks,
        );

        // Blank entries are filtered; order preserved.
        expect(replaced).toEqual([["edited text", "second"]]);
        expect(sent).toEqual([
            { type: "exec_result", id: "1", ok: true, command: "set_queued_messages", result: { queuedMessages: ["edited text", "second"] } },
        ]);
        expect(forwarded).toEqual([{ type: "heartbeat", queuedMessages: ["from-heartbeat"] }]);
    });

    test("empty array clears the queue", async () => {
        const replaced: string[][] = [];
        const { rctx, sent } = makeRctx({
            replaceQueuedMessages: (messages: string[]) => replaced.push(messages),
        });

        await handleExecFromWeb(
            { type: "exec", id: "2", command: "set_queued_messages", messages: [] } as any,
            rctx,
            callbacks,
        );

        expect(replaced).toEqual([[]]);
        expect((sent[0] as any).ok).toBe(true);
    });

    test("missing messages replies with an error", async () => {
        const { rctx, sent, forwarded } = makeRctx({
            replaceQueuedMessages: () => { throw new Error("should not be called"); },
        });

        await handleExecFromWeb(
            { type: "exec", id: "3", command: "set_queued_messages" } as any,
            rctx,
            callbacks,
        );

        expect((sent[0] as any).ok).toBe(false);
        expect(forwarded).toEqual([]);
    });

    test("replace failure surfaces as an exec error", async () => {
        const { rctx, sent, forwarded } = makeRctx({
            replaceQueuedMessages: () => { throw new Error("stale ctx"); },
        });

        await handleExecFromWeb(
            { type: "exec", id: "4", command: "set_queued_messages", messages: ["x"] } as any,
            rctx,
            callbacks,
        );

        expect((sent[0] as any).ok).toBe(false);
        expect((sent[0] as any).error).toContain("stale ctx");
        expect(forwarded).toEqual([]);
    });
});
