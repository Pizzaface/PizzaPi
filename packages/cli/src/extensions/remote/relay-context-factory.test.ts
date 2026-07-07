import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelayContext } from "./relay-context-factory.js";
import { createTriggerWaitManager } from "../trigger-wait-manager.js";
import { readSessionModelsCache, resetSessionModelsCacheMemo } from "../../session-models-cache.js";

function createSocketMock() {
    const listeners = new Map<string, Array<(data?: any) => void>>();
    const emitted: Array<{ event: string; data: any }> = [];

    return {
        connected: true,
        emitted,
        on(event: string, handler: (data?: any) => void) {
            const handlers = listeners.get(event) ?? [];
            handlers.push(handler);
            listeners.set(event, handlers);
        },
        off(event: string, handler: (data?: any) => void) {
            listeners.set(event, (listeners.get(event) ?? []).filter((fn) => fn !== handler));
        },
        emit(event: string, data: any, ack?: (result: { ok: boolean; error?: string }) => void) {
            emitted.push({ event, data });
            ack?.({ ok: true });
        },
        fire(event: string, data?: any) {
            for (const handler of listeners.get(event) ?? []) {
                handler(data);
            }
        },
    };
}

describe("getConfiguredModels session snapshot", () => {
    let tempHome: string;
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        tempHome = mkdtempSync(join(tmpdir(), "pizzapi-relay-models-"));
        process.env.HOME = tempHome;
        resetSessionModelsCacheMemo();
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        rmSync(tempHome, { recursive: true, force: true });
    });

    test("writes the live model list (incl. extension-registered providers) to the cache", () => {
        const rctx = createRelayContext({}, createTriggerWaitManager(), { lastBroadcastSessionName: null });
        rctx.latestCtx = {
            modelRegistry: {
                getAvailable: () => [
                    { provider: "claude-subscription", id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true, contextWindow: 200000 },
                ],
                hasConfiguredAuth: () => false,
            },
        } as any;

        const models = rctx.getConfiguredModels();
        expect(models).toHaveLength(1);
        expect(readSessionModelsCache()).toEqual([
            { provider: "claude-subscription", id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true, contextWindow: 200000 },
        ]);
    });
});

describe("createRelayContext child trigger delivery", () => {
    test("emitTriggerWithAck emits a child ask_user_question trigger and waits for relay ack", async () => {
        const rctx = createRelayContext({}, createTriggerWaitManager(), { lastBroadcastSessionName: null });
        const socket = createSocketMock();
        rctx.relay = { sessionId: "child-1", token: "relay-token", shareUrl: "", seq: 0, ackedSeq: 0 };
        rctx.sioSocket = socket as any;

        const result = await rctx.emitTriggerWithAck({
            type: "ask_user_question",
            sourceSessionId: "child-1",
            sourceSessionName: "Child",
            targetSessionId: "parent-1",
            payload: { question: "Continue?", options: ["Yes", "No"] },
            deliverAs: "followUp",
            expectsResponse: true,
            triggerId: "trigger-1",
            timeoutMs: 300_000,
            ts: new Date().toISOString(),
        });

        expect(result).toEqual({ ok: true });
        expect(socket.emitted).toHaveLength(1);
        expect(socket.emitted[0]).toMatchObject({
            event: "session_trigger",
            data: {
                token: "relay-token",
                trigger: {
                    type: "ask_user_question",
                    targetSessionId: "parent-1",
                    triggerId: "trigger-1",
                },
            },
        });
    });

    test("waitForTriggerResponse ignores unrelated session_message_error events", async () => {
        const rctx = createRelayContext({}, createTriggerWaitManager(), { lastBroadcastSessionName: null });
        const socket = createSocketMock();
        rctx.relay = { sessionId: "child-1", token: "relay-token", shareUrl: "", seq: 0, ackedSeq: 0 };
        rctx.sioSocket = socket as any;
        rctx.parentSessionId = "parent-1";

        const responsePromise = rctx.waitForTriggerResponse("trigger-1", 100);
        socket.fire("session_message_error", {
            targetSessionId: "parent-1",
            triggerId: "different-trigger",
            error: "Unrelated delivery failure",
        });
        socket.fire("trigger_response", {
            triggerId: "trigger-1",
            response: "Approved",
            action: "approve",
        });

        await expect(responsePromise).resolves.toEqual({
            response: "Approved",
            action: "approve",
            cancelled: false,
        });
    });
});
